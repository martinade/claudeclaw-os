import { EventEmitter } from 'node:events';
import { logger } from './logger.js';

// ── Bot info (set once from onStart, read by dashboard) ─────────────

let _botUsername = '';
let _botName = '';

export function setBotInfo(username: string, name: string): void {
  _botUsername = username;
  _botName = name;
}

export function getBotInfo(): { username: string; name: string } {
  return { username: _botUsername, name: _botName };
}

// ── Telegram connection state ────────────────────────────────────────

let _telegramConnected = false;

export function getTelegramConnected(): boolean {
  return _telegramConnected;
}

export function setTelegramConnected(v: boolean): void {
  _telegramConnected = v;
}

// ── Chat event bus (SSE broadcasting) ────────────────────────────────

export interface ChatEvent {
  type:
    | 'user_message'
    | 'assistant_message'
    | 'processing'
    | 'progress'
    | 'error'
    | 'hive_mind'
    // Session 2 — Command Centre multi-agent fan-out:
    | 'fanout_start'      // emitted when delegateToAgents begins
    | 'agent_message'     // per-agent labelled response bubble
    | 'fanout_complete';  // aggregate cost/latency summary
  chatId: string;
  agentId?: string;
  content?: string;
  source?: 'telegram' | 'dashboard';
  description?: string;
  processing?: boolean;
  timestamp: number;
  // Fan-out fields — populated only on fanout_* / agent_message events
  runId?: string;
  agents?: string[];
  durationMs?: number;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  status?: 'completed' | 'failed';
}

export const chatEvents = new EventEmitter();
chatEvents.setMaxListeners(20);

export function emitChatEvent(event: Omit<ChatEvent, 'timestamp'>): void {
  const full: ChatEvent = { ...event, timestamp: Date.now() };
  chatEvents.emit('chat', full);
}

// ── Processing state ─────────────────────────────────────────────────

let _processing = false;
let _processingChatId = '';
let _processingStartedAt = 0;

export function setProcessing(chatId: string, v: boolean): void {
  _processing = v;
  _processingChatId = v ? chatId : '';
  _processingStartedAt = v ? Date.now() : 0;
  emitChatEvent({ type: 'processing', chatId, processing: v });
}

export function getIsProcessing(): { processing: boolean; chatId: string; startedAt: number } {
  return { processing: _processing, chatId: _processingChatId, startedAt: _processingStartedAt };
}

// ── Active query abort ──────────────────────────────────────────────

const _activeAbort = new Map<string, AbortController>();

export function setActiveAbort(chatId: string, ctrl: AbortController | null): void {
  if (ctrl) _activeAbort.set(chatId, ctrl);
  else _activeAbort.delete(chatId);
}

export function abortActiveQuery(chatId: string, reason?: string): boolean {
  const ctrl = _activeAbort.get(chatId);
  if (ctrl) {
    ctrl.abort();
    _activeAbort.delete(chatId);
    // Log which path triggered the abort so we can distinguish user /stop,
    // dashboard button click, etc. in the bot log.
    logger.info({ chatId, reason: reason ?? 'unknown' }, 'Active query aborted');
    return true;
  }
  return false;
}
