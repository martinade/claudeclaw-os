import { CronExpressionParser } from 'cron-parser';

import { logger } from '../logger.js';
import { type Business, listBusinesses } from '../workspace-db.js';
import { runDailyBrief } from './daily-brief.js';

interface CronState {
  nextFire: number;
  running: boolean;
  lastError?: string;
}

const state = new Map<string, CronState>();

function computeNext(cron: string, from: number = Math.floor(Date.now() / 1000)): number | null {
  try {
    const interval = CronExpressionParser.parse(cron, { currentDate: new Date(from * 1000) });
    return Math.floor(interval.next().getTime() / 1000);
  } catch (err) {
    logger.warn({ err: (err as Error).message, cron }, 'daily-brief-cron: invalid cron expression');
    return null;
  }
}

function refreshState(businesses: Business[]): void {
  const activeSlugs = new Set<string>();
  const now = Math.floor(Date.now() / 1000);
  for (const biz of businesses) {
    if (biz.is_global || biz.archived) continue;
    activeSlugs.add(biz.slug);
    if (!state.has(biz.slug)) {
      const next = computeNext(biz.daily_brief_cron, now);
      if (next !== null) {
        state.set(biz.slug, { nextFire: next, running: false });
        logger.info({ slug: biz.slug, cron: biz.daily_brief_cron, nextFire: next }, 'daily-brief-cron: registered');
      }
    }
  }
  // Drop state for businesses that were archived or removed.
  for (const slug of Array.from(state.keys())) {
    if (!activeSlugs.has(slug)) state.delete(slug);
  }
}

async function tick(): Promise<void> {
  const businesses = listBusinesses(false);
  refreshState(businesses);
  const now = Math.floor(Date.now() / 1000);
  for (const biz of businesses) {
    if (biz.is_global || biz.archived) continue;
    const s = state.get(biz.slug);
    if (!s || s.running || now < s.nextFire) continue;
    s.running = true;
    const next = computeNext(biz.daily_brief_cron, now + 1) ?? (now + 86400);
    try {
      logger.info({ slug: biz.slug }, 'daily-brief-cron: firing');
      const result = await runDailyBrief(biz);
      logger.info({ slug: biz.slug, sent: result.sent, counts: result.sourceCounts }, 'daily-brief-cron: done');
      s.lastError = undefined;
    } catch (err) {
      s.lastError = (err as Error).message;
      logger.error({ err, slug: biz.slug }, 'daily-brief-cron: failed');
    } finally {
      s.nextFire = next;
      s.running = false;
    }
  }
}

/**
 * Register a recurring check that fires `runDailyBrief(business)` when each
 * workspace's `daily_brief_cron` is due. Safe to call multiple times — existing
 * state is preserved so a restart doesn't double-fire.
 *
 * Only call this from the main process; sub-agent processes should not send
 * daily briefs.
 */
export function initDailyBriefCrons(): void {
  try {
    const businesses = listBusinesses(false);
    refreshState(businesses);
  } catch (err) {
    logger.error({ err }, 'daily-brief-cron: initial registration failed');
    return;
  }
  setInterval(() => { void tick(); }, 60_000);
  logger.info({ registered: state.size }, 'Daily Brief crons scheduled');
}
