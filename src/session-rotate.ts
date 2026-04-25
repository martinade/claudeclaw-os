// Session transcript auto-rotation.
//
// The Claude Code SDK writes every turn of a session to a JSONL transcript at
// ~/.claude/projects/<slug>/<session-id>.jsonl. When that file grows large
// (26MB seen in production on 2026-04-23), `claude --resume <session>` takes
// minutes to rehydrate and often hangs long enough that AGENT_TIMEOUT_MS
// fires — the user's chat effectively breaks silently.
//
// This module sniffs the file size BEFORE the SDK is invoked. If over
// threshold, it nulls the session_id in the DB so a fresh Claude Code session
// starts on the next message. The old JSONL stays on disk untouched so past
// conversation is still recoverable.
//
// Gated by SESSION_ROTATE_THRESHOLD_MB (0 / unset = disabled).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PROJECT_ROOT, SESSION_ROTATE_THRESHOLD_MB } from './config.js';
import { clearSession } from './db.js';
import { logger } from './logger.js';

export interface RotationResult {
  rotated: boolean;
  reason?: 'disabled' | 'no-session' | 'file-missing' | 'under-threshold' | 'over-threshold';
  previousSizeBytes?: number;
  previousSessionId?: string;
  previousJsonlPath?: string;
  thresholdMb?: number;
}

/**
 * Compute the Claude Code JSONL path for a given session + cwd.
 * Claude Code slugs the absolute cwd with `/` → `-` and stores sessions at
 * ~/.claude/projects/<slug>/<session-id>.jsonl.
 */
export function sessionJsonlPath(sessionId: string, cwd: string): string {
  const absCwd = path.resolve(cwd);
  const slug = absCwd.replace(/\//g, '-');
  return path.join(os.homedir(), '.claude', 'projects', slug, `${sessionId}.jsonl`);
}

/**
 * If the session transcript is oversized, clear the DB session pointer so the
 * next query starts fresh. Returns a structured result either way.
 *
 * Callers should check `result.rotated` and (if true) surface a short notice
 * to the user per SESSION_ROTATE_NOTIFY.
 */
export function maybeRotateSession(params: {
  chatId: string;
  agentId?: string;
  sessionId: string | undefined;
  cwd?: string;
  /** Override the config default, for tests. */
  thresholdMb?: number;
}): RotationResult {
  const { chatId, agentId = 'main', sessionId, cwd } = params;
  const thresholdMb = params.thresholdMb ?? SESSION_ROTATE_THRESHOLD_MB;

  if (!thresholdMb || thresholdMb <= 0) {
    return { rotated: false, reason: 'disabled' };
  }
  if (!sessionId) {
    return { rotated: false, reason: 'no-session' };
  }

  const jsonlPath = sessionJsonlPath(sessionId, cwd ?? PROJECT_ROOT);
  let sizeBytes = 0;
  try {
    const stat = fs.statSync(jsonlPath);
    sizeBytes = stat.size;
  } catch {
    // File doesn't exist — session pointer is stale, clear it so we don't
    // keep asking the SDK to resume a session that's vanished.
    logger.warn({ chatId, agentId, sessionId, jsonlPath }, 'Session JSONL missing — clearing stale pointer');
    clearSession(chatId, agentId);
    return {
      rotated: true,
      reason: 'file-missing',
      previousSessionId: sessionId,
      previousJsonlPath: jsonlPath,
      thresholdMb,
    };
  }

  const thresholdBytes = thresholdMb * 1024 * 1024;
  if (sizeBytes < thresholdBytes) {
    return {
      rotated: false,
      reason: 'under-threshold',
      previousSizeBytes: sizeBytes,
      thresholdMb,
    };
  }

  logger.warn(
    { chatId, agentId, sessionId, sizeBytes, thresholdBytes, jsonlPath },
    'Session transcript over threshold — rotating',
  );
  clearSession(chatId, agentId);
  return {
    rotated: true,
    reason: 'over-threshold',
    previousSizeBytes: sizeBytes,
    previousSessionId: sessionId,
    previousJsonlPath: jsonlPath,
    thresholdMb,
  };
}

/**
 * Compose the user-facing notice when a rotation fires. Short, informative,
 * tells the user their context was reset and where the old transcript lives.
 */
export function rotationNotice(result: RotationResult): string {
  if (!result.rotated) return '';
  if (result.reason === 'file-missing') {
    return 'Started a fresh chat session — the previous one\'s transcript file was gone.';
  }
  const sizeMb = result.previousSizeBytes
    ? (result.previousSizeBytes / 1024 / 1024).toFixed(1)
    : '?';
  return `Started a fresh chat session — the previous one grew to ${sizeMb}MB and was slowing down responses. Old context saved in ${result.previousJsonlPath}.`;
}
