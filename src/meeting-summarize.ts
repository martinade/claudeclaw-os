/**
 * Meeting summarization and note formatting module.
 *
 * Takes a transcript and produces structured meeting notes via Claude Haiku
 * (primary) or Gemini Flash (fallback), formatted as Obsidian-compatible Markdown.
 */

import fs from 'fs';
import path from 'path';

import Anthropic from '@anthropic-ai/sdk';
import { generateContent, parseJsonResponse } from './gemini.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import { formatDuration } from './meeting-transcribe.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface ActionItem {
  task: string;
  owner: string | null;
  deadline: string | null;
}

export interface MeetingSummary {
  title: string;
  attendees: string[];
  summary: string;
  keyDecisions: string[];
  actionItems: ActionItem[];
  topics: string[];
}

// ── Summarization ────────────────────────────────────────────────────────────

const MEETING_SUMMARY_PROMPT = `You are a meeting notes assistant. Given a transcript of a meeting, extract structured information.

Return a JSON object with this exact schema:
{
  "title": "Short descriptive title for this meeting (5-10 words)",
  "attendees": ["Name1", "Name2"],
  "summary": "3-5 sentence executive summary of what was discussed and decided",
  "keyDecisions": ["Decision 1", "Decision 2"],
  "actionItems": [
    {"task": "What needs to be done", "owner": "Who is responsible or null", "deadline": "When or null"}
  ],
  "topics": ["Topic1", "Topic2"]
}

Rules:
- For attendees, extract names mentioned in the transcript. If none are detectable, return an empty array.
- For action items, only include concrete tasks with clear next steps. Not vague intentions.
- If an owner is not explicitly assigned, set owner to null.
- If a deadline is not mentioned, set deadline to null.
- Keep the summary focused on outcomes and decisions, not a play-by-play.
- For topics, use 2-5 short labels.
- Return ONLY valid JSON, no markdown fences or extra text.

TRANSCRIPT:
`;

/**
 * Summarize a meeting transcript.
 * Primary: Claude Haiku 4.5 (fast, cheap, works with claude login OAuth).
 * Fallback: Gemini 2.0 Flash.
 * Last resort: basic fallback with no AI.
 */
export async function summarizeMeeting(transcript: string): Promise<MeetingSummary> {
  const maxChars = 100_000;
  const trimmed = transcript.length > maxChars
    ? transcript.slice(0, maxChars) + '\n\n[TRANSCRIPT TRUNCATED - showing first ' + Math.round(maxChars / 1000) + 'k characters]'
    : transcript;

  // Try Claude Haiku first
  try {
    const result = await summarizeWithHaiku(trimmed);
    if (result) return result;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'Claude Haiku summarization failed, trying Gemini');
  }

  // Fallback: Gemini
  try {
    const prompt = MEETING_SUMMARY_PROMPT + trimmed;
    const raw = await generateContent(prompt);
    const result = parseJsonResponse<MeetingSummary>(raw);
    if (result) return result;
    logger.error({ raw: raw.slice(0, 500) }, 'Failed to parse Gemini meeting summary');
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'Gemini summarization also failed');
  }

  // Last resort: no-AI fallback
  return fallbackSummary(transcript);
}

/**
 * Summarize via Claude Haiku 4.5.
 * Uses ANTHROPIC_API_KEY if available, otherwise spawns via claude CLI
 * which inherits the claude login OAuth session.
 */
async function summarizeWithHaiku(transcript: string): Promise<MeetingSummary | null> {
  const env = readEnvFile(['ANTHROPIC_API_KEY']);
  const apiKey = env.ANTHROPIC_API_KEY;

  if (apiKey) {
    // Direct SDK call (fast path)
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: 'haiku',
      max_tokens: 2048,
      messages: [{ role: 'user', content: MEETING_SUMMARY_PROMPT + transcript }],
    });
    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    if (!text) return null;
    return parseJsonResponse<MeetingSummary>(text);
  }

  // No API key - use claude CLI which has OAuth from `claude login`
  // Pipe the prompt via stdin since it can be very long
  const { spawn } = await import('child_process');

  const prompt = MEETING_SUMMARY_PROMPT + transcript + '\n\nReturn ONLY the JSON object, nothing else.';

  const result = await new Promise<string>((resolve, reject) => {
    const proc = spawn('claude', [
      '--model', 'haiku',
      '--output-format', 'text',
      '--max-turns', '1',
    ], { stdio: ['pipe', 'pipe', 'pipe'], timeout: 60_000 });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.on('close', (code) => {
      if (code === 0 && stdout.trim()) resolve(stdout.trim());
      else reject(new Error(stderr || `claude exited with code ${code}`));
    });
    proc.on('error', reject);
    proc.stdin.write(prompt);
    proc.stdin.end();
  });

  if (!result) return null;
  return parseJsonResponse<MeetingSummary>(result);
}

/**
 * Basic fallback summary when no AI provider is available.
 * Extracts a title from the first ~100 chars and returns the raw transcript.
 */
function fallbackSummary(transcript: string): MeetingSummary {
  const firstSentence = transcript.slice(0, 150).split(/[.!?]/)[0]?.trim() || 'Meeting Notes';
  const title = firstSentence.length > 60 ? firstSentence.slice(0, 57) + '...' : firstSentence;

  return {
    title,
    attendees: [],
    summary: 'Auto-summary unavailable. Full transcript is saved below.',
    keyDecisions: [],
    actionItems: [],
    topics: [],
  };
}

// ── Markdown formatting ──────────────────────────────────────────────────────

/**
 * Format meeting summary + transcript as Obsidian-compatible Markdown.
 */
export function formatMeetingNote(
  summary: MeetingSummary,
  transcript: string,
  metadata: {
    audioPath: string;
    durationSec: number;
    date: string;
    provider: string;
  },
): string {
  const lines: string[] = [
    '---',
    'type: meeting-notes',
    `created: ${metadata.date}`,
    `duration: ${formatDuration(metadata.durationSec)}`,
    `source: ${path.basename(metadata.audioPath)}`,
    `transcription: ${metadata.provider}`,
    `topics: [${summary.topics.map(t => `"${t}"`).join(', ')}]`,
    '---',
    '',
    `# ${summary.title}`,
    '',
  ];

  if (summary.attendees.length > 0) {
    lines.push('## Attendees', '');
    for (const a of summary.attendees) lines.push(`- ${a}`);
    lines.push('');
  }

  lines.push('## Summary', '', summary.summary, '');

  if (summary.keyDecisions.length > 0) {
    lines.push('## Key Decisions', '');
    for (const d of summary.keyDecisions) lines.push(`- ${d}`);
    lines.push('');
  }

  if (summary.actionItems.length > 0) {
    lines.push('## Action Items', '');
    for (const ai of summary.actionItems) {
      const owner = ai.owner ? ` @${ai.owner}` : '';
      const deadline = ai.deadline ? ` (by ${ai.deadline})` : '';
      lines.push(`- [ ] ${ai.task}${owner}${deadline}`);
    }
    lines.push('');
  }

  lines.push(
    '## Full Transcript',
    '',
    '<details>',
    '<summary>Click to expand full transcript</summary>',
    '',
    transcript,
    '',
    '</details>',
    '',
  );

  return lines.join('\n');
}

// ── Obsidian writer ──────────────────────────────────────────────────────────

/**
 * Save a meeting note to the Obsidian vault.
 * Creates the target folder if it doesn't exist.
 * Returns the file path on success, null if no vault configured.
 */
export function saveToObsidian(
  content: string,
  title: string,
  vaultPath: string,
  folder = 'Meeting Notes',
): string | null {
  if (!vaultPath) return null;

  const folderPath = path.join(vaultPath, folder);
  fs.mkdirSync(folderPath, { recursive: true });

  // Sanitize title for filesystem
  const safeTitle = title.replace(/[/\\:*?"<>|]/g, '-').slice(0, 120);
  const filename = `${safeTitle}.md`;
  let finalPath = path.join(folderPath, filename);

  // Avoid overwriting existing notes
  if (fs.existsSync(finalPath)) {
    const timestamp = Date.now();
    finalPath = path.join(folderPath, `${safeTitle}-${timestamp}.md`);
  }

  fs.writeFileSync(finalPath, content, 'utf-8');
  return finalPath;
}
