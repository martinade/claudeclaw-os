// AI-generated document content via the Anthropic Messages API.
// Kept separate from src/agent.ts (which uses the Claude Agent SDK for
// interactive chat sessions) — Documents generation is a one-shot synchronous
// call, not a tool-using agent loop, so the bare Messages API is the right
// surface and avoids spinning up a session per generation.

import Anthropic from '@anthropic-ai/sdk';

import { logger } from '../logger.js';
import { listBusinesses, type Business } from '../workspace-db.js';

// Hard caps defend against accidental runaway prompts and runaway token spend.
const MAX_PROMPT_CHARS = 4_000;
const MAX_CONTEXT_CHARS = 8_000;
const MAX_OUTPUT_TOKENS = 4_096;
const REQUEST_TIMEOUT_MS = 45_000;

export interface DocAiInput {
  prompt: string;
  businessSlug?: string | null;
  context?: string;
}

export interface DocAiResult {
  markdown: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

function buildWorkspaceCatalog(): string {
  try {
    const all = listBusinesses(false);
    const nonGlobal = all.filter((b: Business) => !b.is_global);
    if (nonGlobal.length === 0) return '';
    return nonGlobal
      .map((b) => `- ${b.name}${b.brief_md ? ': ' + b.brief_md.slice(0, 140) : ''}`)
      .join('\n');
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, 'doc-ai: workspace catalog lookup failed');
    return '';
  }
}

function buildSystemPrompt(target: Business | null): string {
  const catalog = buildWorkspaceCatalog();
  const targetLine = target
    ? `Target workspace: ${target.name}${target.brief_md ? ' — ' + target.brief_md.slice(0, 220) : ''}`
    : 'Target workspace: cross-business (no single brand voice)';
  return [
    'You are a professional business document writer.',
    'Produce clean, professional Markdown output. Use proper heading hierarchy (# ## ###), bold for key terms, and tables where they aid clarity.',
    'Do NOT include code fences, HTML, or any preamble. Output ONLY the document content in plain Markdown, ready to save.',
    'Avoid em dashes. Avoid AI cliches ("I hope this finds you well", "in today\'s fast-paced world", etc.). Write like a grounded professional.',
    '',
    catalog ? 'Workspaces in this portfolio:' : '',
    catalog,
    '',
    targetLine,
  ].filter(Boolean).join('\n');
}

export async function generateDocumentMarkdown(input: DocAiInput): Promise<DocAiResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    // Speak clearly: a silent empty doc would be a worse product than a blunt error.
    const err = new Error('AI generation requires ANTHROPIC_API_KEY. Set it in .env to enable document generation.');
    (err as Error & { code?: string }).code = 'ANTHROPIC_API_KEY_MISSING';
    throw err;
  }

  const prompt = (input.prompt || '').trim().slice(0, MAX_PROMPT_CHARS);
  const context = (input.context || '').trim().slice(0, MAX_CONTEXT_CHARS);
  if (!prompt) {
    const err = new Error('prompt is required');
    (err as Error & { code?: string }).code = 'INVALID_INPUT';
    throw err;
  }

  // Resolve target workspace for the system prompt. Missing slug is fine.
  let target: Business | null = null;
  if (input.businessSlug && input.businessSlug !== 'cross-business') {
    try {
      const all = listBusinesses(false);
      target = all.find((b) => b.slug === input.businessSlug) ?? null;
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : err }, 'doc-ai: workspace lookup failed, falling back to generic tone');
    }
  }

  const userParts: string[] = [`Request: ${prompt}`];
  if (context) userParts.push(`Additional context:\n${context}`);
  const userMessage = userParts.join('\n\n');

  const client = new Anthropic({ apiKey });

  // AbortController enforces the server-side timeout even if the Anthropic
  // SDK's own retries would otherwise extend the wall-clock wait.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  const model = 'claude-sonnet-4-6';

  try {
    const response = await client.messages.create(
      {
        model,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: buildSystemPrompt(target),
        messages: [{ role: 'user', content: userMessage }],
      },
      { signal: controller.signal },
    );
    const textBlocks = response.content.filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text');
    const markdown = textBlocks.map((b) => b.text).join('\n').trim();
    if (!markdown) throw new Error('Anthropic returned an empty document');
    return {
      markdown,
      model: response.model,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    };
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      const timeout = new Error(`Document generation timed out after ${Math.round(REQUEST_TIMEOUT_MS / 1000)}s`);
      (timeout as Error & { code?: string }).code = 'TIMEOUT';
      throw timeout;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
