/**
 * Resilient LLM utility — all memory pipeline callers use this instead of
 * calling Gemini directly. Cascade: Gemini → Anthropic SDK → Claude CLI → null.
 *
 * Never throws. Returns null if all providers fail.
 */
import { logger } from './logger.js';

// ── Text generation ────────────────────────────────────────────────────────

export async function generateTextResilient(
  prompt: string,
  opts: { timeoutMs?: number; model?: string } = {},
): Promise<string | null> {
  const timeout = opts.timeoutMs ?? 60_000;

  // ── Try 1: Gemini (fast, free tier, JSON mode) ──
  try {
    const { generateContent } = await import('./gemini.js');
    const raw = await Promise.race([
      generateContent(prompt, opts.model),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Gemini timeout')), timeout),
      ),
    ]);
    if (raw && raw.trim()) {
      logger.info('[LLM] Gemini succeeded');
      return raw;
    }
  } catch (err) {
    logger.info({ err: (err as Error).message }, '[LLM] Gemini failed, trying Anthropic SDK');
  }

  // ── Try 2: Anthropic SDK (if ANTHROPIC_API_KEY is set) ──
  try {
    const { readEnvFile } = await import('./env.js');
    const env = readEnvFile(['ANTHROPIC_API_KEY']);
    const apiKey = env.ANTHROPIC_API_KEY;
    if (apiKey) {
      const Anthropic = (await import('@anthropic-ai/sdk')).default;
      const client = new Anthropic({ apiKey });
      const response = await client.messages.create({
        model: 'claude-3-5-haiku-latest',
        max_tokens: 4096,
        messages: [{ role: 'user', content: prompt }],
      });
      const text = response.content
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map((b) => b.text)
        .join('');
      if (text.trim()) {
        logger.info('[LLM] Anthropic SDK (Haiku) succeeded');
        return text.trim();
      }
    } else {
      logger.info('[LLM] No ANTHROPIC_API_KEY, skipping SDK tier');
    }
  } catch (err) {
    logger.info({ err: (err as Error).message }, '[LLM] Anthropic SDK failed, trying Claude CLI');
  }

  // ── Try 3: Claude CLI via stdin (OAuth, always available) ──
  try {
    const { spawn } = await import('child_process');
    const result = await new Promise<string>((resolve, reject) => {
      const proc = spawn('claude', [
        '--model', 'haiku',
        '--output-format', 'text',
        '--max-turns', '1',
      ], { stdio: ['pipe', 'pipe', 'pipe'], timeout });

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
    if (result) {
      logger.info('[LLM] Claude CLI (Haiku) succeeded');
      return result;
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message }, '[LLM] All providers failed');
  }

  return null;
}

// ── JSON generation ────────────────────────────────────────────────────────

export async function generateJsonResilient<T>(
  prompt: string,
  opts: { timeoutMs?: number } = {},
): Promise<T | null> {
  const { parseJsonResponse } = await import('./gemini.js');
  const timeout = opts.timeoutMs ?? 60_000;

  // ── Try 1: Gemini (has responseMimeType: application/json built in) ──
  try {
    const { generateContent } = await import('./gemini.js');
    const raw = await Promise.race([
      generateContent(prompt),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Gemini timeout')), timeout),
      ),
    ]);
    if (raw && raw.trim()) {
      const parsed = parseJsonResponse<T>(raw);
      if (parsed !== null) {
        logger.info('[LLM-JSON] Gemini succeeded');
        return parsed;
      }
    }
  } catch (err) {
    logger.info({ err: (err as Error).message }, '[LLM-JSON] Gemini failed, trying Anthropic SDK');
  }

  // For non-Gemini providers, append JSON instruction to the prompt
  const jsonPrompt = prompt + '\n\nReturn ONLY valid JSON, nothing else. No markdown fences, no explanations.';

  // ── Try 2: Anthropic SDK ──
  try {
    const { readEnvFile } = await import('./env.js');
    const env = readEnvFile(['ANTHROPIC_API_KEY']);
    const apiKey = env.ANTHROPIC_API_KEY;
    if (apiKey) {
      const Anthropic = (await import('@anthropic-ai/sdk')).default;
      const client = new Anthropic({ apiKey });
      const response = await client.messages.create({
        model: 'claude-3-5-haiku-latest',
        max_tokens: 4096,
        messages: [{ role: 'user', content: jsonPrompt }],
      });
      const text = response.content
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map((b) => b.text)
        .join('');
      if (text.trim()) {
        const parsed = parseJsonResponse<T>(text.trim());
        if (parsed !== null) {
          logger.info('[LLM-JSON] Anthropic SDK (Haiku) succeeded');
          return parsed;
        }
      }
    } else {
      logger.info('[LLM-JSON] No ANTHROPIC_API_KEY, skipping SDK tier');
    }
  } catch (err) {
    logger.info({ err: (err as Error).message }, '[LLM-JSON] Anthropic SDK failed, trying CLI');
  }

  // ── Try 3: Claude CLI via stdin ──
  try {
    const { spawn } = await import('child_process');
    const result = await new Promise<string>((resolve, reject) => {
      const proc = spawn('claude', [
        '--model', 'haiku',
        '--output-format', 'text',
        '--max-turns', '1',
      ], { stdio: ['pipe', 'pipe', 'pipe'], timeout });

      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
      proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
      proc.on('close', (code) => {
        if (code === 0 && stdout.trim()) resolve(stdout.trim());
        else reject(new Error(stderr || `claude exited with code ${code}`));
      });
      proc.on('error', reject);
      proc.stdin.write(jsonPrompt);
      proc.stdin.end();
    });
    if (result) {
      const parsed = parseJsonResponse<T>(result);
      if (parsed !== null) {
        logger.info('[LLM-JSON] Claude CLI (Haiku) succeeded');
        return parsed;
      }
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message }, '[LLM-JSON] All providers failed');
  }

  return null;
}
