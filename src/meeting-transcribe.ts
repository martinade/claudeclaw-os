/**
 * Meeting audio transcription module.
 *
 * Handles audio preprocessing (format conversion, duration detection) and
 * transcription via local whisper-cpp (preferred for long audio) with Groq
 * cloud fallback.
 */

import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

import { logger } from './logger.js';
import { readEnvFile } from './env.js';
import { transcribeAudio } from './voice.js';

const execFileAsync = promisify(execFile);

// ── Audio helpers ────────────────────────────────────────────────────────────

/**
 * Get audio duration in seconds via ffprobe.
 */
export async function getAudioDuration(filePath: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'quiet',
      '-show_entries', 'format=duration',
      '-of', 'csv=p=0',
      filePath,
    ]);
    return Math.round(parseFloat(stdout.trim()));
  } catch (err) {
    logger.warn({ err }, 'ffprobe failed, duration unknown');
    return 0;
  }
}

/**
 * Convert any audio format to 16kHz mono WAV (whisper-cpp requirement).
 * Returns path to the generated WAV file.
 */
export async function convertToWav(inputPath: string): Promise<string> {
  const ext = path.extname(inputPath);
  const wavPath = inputPath.replace(new RegExp(`${ext.replace('.', '\\.')}$`), '_whisper.wav');
  await execFileAsync('ffmpeg', [
    '-i', inputPath,
    '-ar', '16000',
    '-ac', '1',
    '-y',
    wavPath,
  ]);
  return wavPath;
}

// ── Transcription ────────────────────────────────────────────────────────────

/**
 * Transcribe a meeting audio file.
 *
 * For meetings (long audio), we prefer local whisper-cpp:
 * - No file size limits (Groq caps at 25MB)
 * - Free, runs on device
 * - Better accuracy on long-form audio
 *
 * Falls back to Groq Whisper if local isn't available.
 */
export async function transcribeMeeting(audioPath: string): Promise<{
  transcript: string;
  provider: 'whisper-cpp' | 'groq';
}> {
  const env = readEnvFile(['WHISPER_CPP_PATH', 'WHISPER_MODEL_PATH', 'GROQ_API_KEY']);
  const whisperPath = env.WHISPER_CPP_PATH || 'whisper-cpp';
  const modelPath = env.WHISPER_MODEL_PATH;

  // Prefer local whisper-cpp for meetings (no size limits, free)
  if (modelPath) {
    try {
      const transcript = await transcribeLocal(audioPath, whisperPath, modelPath);
      return { transcript, provider: 'whisper-cpp' };
    } catch (err) {
      logger.warn({ err }, 'Local whisper-cpp failed, trying Groq fallback');
    }
  }

  // Fallback: Groq cloud via voice.ts cascade
  if (env.GROQ_API_KEY) {
    const transcript = await transcribeAudio(audioPath);
    return { transcript, provider: 'groq' };
  }

  throw new Error(
    'No transcription provider available. Install whisper-cpp (brew install whisper-cpp) ' +
    'and set WHISPER_MODEL_PATH in .env, or set GROQ_API_KEY for cloud transcription.',
  );
}

/**
 * Local whisper-cpp (whisper-cli) transcription for long audio files.
 * whisper-cli supports mp3, ogg, wav, flac natively.
 * For other formats (m4a, webm, aac), convert to wav first via ffmpeg.
 */
async function transcribeLocal(
  audioPath: string,
  whisperPath: string,
  modelPath: string,
): Promise<string> {
  // Resolve ~ in model path
  const resolvedModel = modelPath.replace(/^~/, process.env.HOME || '');

  // whisper-cli supports mp3, ogg, wav, flac natively; convert others to wav
  const ext = path.extname(audioPath).toLowerCase();
  const nativeFormats = ['.mp3', '.ogg', '.wav', '.flac'];
  let inputPath = audioPath;
  let needsCleanup = false;

  if (!nativeFormats.includes(ext)) {
    inputPath = await convertToWav(audioPath);
    needsCleanup = true;
  }

  // whisper-cli --output-json writes to a file, so use --output-file with a temp path
  const outputBase = inputPath.replace(/\.[^.]+$/, '_transcript');
  const jsonOutputPath = outputBase + '.json';

  try {
    logger.info({ audioPath, model: path.basename(resolvedModel) }, 'Starting whisper-cli transcription');
    await execFileAsync(whisperPath, [
      '-m', resolvedModel,
      inputPath,
      '--output-json',
      '--output-file', outputBase,
      '--no-timestamps',
      '-l', 'auto',
      '-t', '8',          // Use 8 threads for faster processing on M-series
    ], { maxBuffer: 50 * 1024 * 1024, timeout: 30 * 60 * 1000 }); // 30 min timeout

    // Read the JSON output file
    if (!fs.existsSync(jsonOutputPath)) {
      throw new Error(`Whisper output file not found: ${jsonOutputPath}`);
    }
    const raw = fs.readFileSync(jsonOutputPath, 'utf-8');
    const result = JSON.parse(raw);
    const text = (result.transcription || [])
      .map((s: { text: string }) => s.text)
      .join(' ')
      .trim();

    if (!text) throw new Error('Whisper produced empty transcription');
    return text;
  } finally {
    // Clean up temp files
    if (needsCleanup) try { fs.unlinkSync(inputPath); } catch { /* ignore */ }
    try { fs.unlinkSync(jsonOutputPath); } catch { /* ignore */ }
  }
}

/**
 * Format seconds as human-readable duration string.
 */
export function formatDuration(seconds: number): string {
  if (seconds <= 0) return 'unknown';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  return `${m}m ${s}s`;
}
