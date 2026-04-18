import { Api } from 'grammy';

import { ALLOWED_CHAT_ID, DAILY_BRIEF_TZ, TELEGRAM_BOT_TOKEN } from '../config.js';
import { getDb } from '../db.js';
import { generateContent } from '../gemini.js';
import { logger } from '../logger.js';
import {
  type Business,
  listCoreMemory,
  listIdeas,
  listPriorities,
} from '../workspace-db.js';

interface MissionTaskLite { id: string; title: string; status: string; created_at: number }
interface ScheduledTaskLite { id: string; prompt: string; schedule: string; next_run: number }

function fetchMissionTasks(bizId: string | null): MissionTaskLite[] {
  const db = getDb();
  if (bizId === null) {
    return db.prepare(
      "SELECT id, title, status, created_at FROM mission_tasks WHERE status IN ('queued','in_progress','completed','failed') AND created_at > ? ORDER BY created_at DESC",
    ).all(Math.floor(Date.now() / 1000) - 86400 * 2) as MissionTaskLite[];
  }
  return db.prepare(
    "SELECT id, title, status, created_at FROM mission_tasks WHERE (business_id = ? OR business_id IS NULL) AND status IN ('queued','in_progress','completed','failed') AND created_at > ? ORDER BY created_at DESC",
  ).all(bizId, Math.floor(Date.now() / 1000) - 86400 * 2) as MissionTaskLite[];
}

function fetchUpcomingScheduled(bizId: string | null): ScheduledTaskLite[] {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const horizon = now + 86400;
  if (bizId === null) {
    return db.prepare(
      "SELECT id, prompt, schedule, next_run FROM scheduled_tasks WHERE status = 'active' AND next_run BETWEEN ? AND ? ORDER BY next_run ASC LIMIT 20",
    ).all(now, horizon) as ScheduledTaskLite[];
  }
  return db.prepare(
    "SELECT id, prompt, schedule, next_run FROM scheduled_tasks WHERE (business_id = ? OR business_id IS NULL) AND status = 'active' AND next_run BETWEEN ? AND ? ORDER BY next_run ASC LIMIT 20",
  ).all(bizId, now, horizon) as ScheduledTaskLite[];
}

export interface BriefOptions {
  /** If true, skip the LLM call and return the raw digest. Useful for tests. */
  raw?: boolean;
  /** Override where the brief gets sent. Defaults to ALLOWED_CHAT_ID. */
  chatId?: string;
  /** Skip Telegram delivery (for dry runs). */
  skipDeliver?: boolean;
}

export interface BriefResult {
  sent: boolean;
  text: string;
  sourceCounts: { priorities: number; missions: number; upcoming: number; facts: number; ideas: number };
}

/**
 * Run the daily brief for a single workspace. Aggregates priorities, recent
 * mission tasks, upcoming scheduled tasks, pinned core memory, and recent
 * ideas; calls Gemini for a chief-of-staff summary; sends to Telegram.
 *
 * This job reads from workspace-scoped tables and delivers via a standalone
 * grammy Api instance. It does NOT touch bot.ts speech composition — per
 * the V1 hard constraint preserving the comms/speech architecture.
 */
export async function runDailyBrief(
  business: Business,
  opts: BriefOptions = {},
): Promise<BriefResult> {
  const bizId = business.is_global ? null : business.id;
  const [priorities, missions, upcoming, core, ideas] = [
    listPriorities(bizId, { includeDone: false }),
    fetchMissionTasks(bizId),
    fetchUpcomingScheduled(bizId),
    listCoreMemory(bizId, { includeGlobal: !business.is_global }),
    listIdeas(bizId),
  ];

  const lines: string[] = [];
  lines.push(`${business.icon_emoji} ${business.name} — Daily Brief`);
  lines.push(new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: DAILY_BRIEF_TZ }));
  lines.push('');

  if (priorities.length > 0) {
    lines.push('Top priorities:');
    for (const p of priorities.slice(0, 7)) lines.push(`  • ${p.text}`);
    lines.push('');
  }

  const openMissions = missions.filter((m) => m.status === 'queued' || m.status === 'in_progress');
  if (openMissions.length > 0) {
    lines.push('Open mission tasks:');
    for (const m of openMissions.slice(0, 8)) lines.push(`  • [${m.status}] ${m.title}`);
    lines.push('');
  }

  if (upcoming.length > 0) {
    lines.push('Scheduled (next 24h):');
    for (const t of upcoming.slice(0, 8)) {
      const when = new Date(t.next_run * 1000).toLocaleString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: DAILY_BRIEF_TZ });
      lines.push(`  • ${when} — ${t.prompt.slice(0, 80)}`);
    }
    lines.push('');
  }

  if (ideas.length > 0) {
    const recent = ideas.slice(0, 5);
    lines.push('Recent ideas:');
    for (const i of recent) lines.push(`  • ${i.title}`);
    lines.push('');
  }

  const digest = lines.join('\n');
  const sourceCounts = {
    priorities: priorities.length,
    missions: openMissions.length,
    upcoming: upcoming.length,
    facts: core.length,
    ideas: ideas.length,
  };

  if (opts.raw) {
    return { sent: false, text: digest, sourceCounts };
  }

  const nothing = priorities.length === 0 && openMissions.length === 0 && upcoming.length === 0 && ideas.length === 0;
  let finalText: string;
  if (nothing) {
    finalText = `${business.icon_emoji} ${business.name}: no mission-control updates today. Calm waters.`;
  } else {
    const pinned = core.slice(0, 8).map((c) => `- ${c.key}: ${c.value}`).join('\n') || '(none)';
    const prompt = [
      `You are the chief of staff for the ${business.name} workspace. Produce a tight daily brief from the raw digest below.`,
      'Rules:',
      '- Plain text, no markdown headers, no code fences.',
      '- Keep every line short enough for Telegram.',
      '- Start with a one-line summary, then short sections (What\'s hot, Next 24h, Watch-outs).',
      '- No em dashes. No AI clichés. Do not restate facts verbatim — synthesise.',
      '- End with one concrete suggestion for today.',
      '',
      'Pinned facts for context (do not repeat them unless they affect today):',
      pinned,
      '',
      'Raw digest:',
      digest,
    ].join('\n');
    try {
      const resp = await generateContent(prompt);
      finalText = resp.trim() || digest;
    } catch (err) {
      logger.warn({ err, business: business.slug }, 'daily-brief: Gemini failed, sending raw digest');
      finalText = digest;
    }
  }

  if (opts.skipDeliver) return { sent: false, text: finalText, sourceCounts };

  const target = opts.chatId || ALLOWED_CHAT_ID;
  if (!target || !TELEGRAM_BOT_TOKEN) {
    logger.warn({ business: business.slug }, 'daily-brief: no chat id / bot token, not sending');
    return { sent: false, text: finalText, sourceCounts };
  }

  const api = new Api(TELEGRAM_BOT_TOKEN);
  const numericChat = parseInt(target, 10);
  await api.sendMessage(numericChat, finalText);
  logger.info({ business: business.slug, sent: true }, 'daily-brief: delivered');
  return { sent: true, text: finalText, sourceCounts };
}
