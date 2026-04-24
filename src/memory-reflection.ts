/**
 * Daily Reflection + Weekly Deep Consolidation
 *
 * The continuous learning loop — reviews each day's work, extracts wins/losses/patterns,
 * saves learned behaviors to core_memory (auto-injected into every future conversation),
 * creates proactive follow-ups, and produces weekly strategic insights.
 */
import fs from 'fs';
import path from 'path';

import { agentObsidianConfig, ALLOWED_CHAT_ID } from './config.js';
import {
  getConsolidationsSince,
  getConversationsSince,
  getMemoriesBySource,
  getMemoriesCreatedSince,
  getMemorySourceEffectiveness,
  getSessionSummariesSince,
  getSessionTokenStats,
  getSkillUsageSince,
  saveStructuredMemoryAtomic,
} from './db.js';
import { readEnvFile } from './env.js';
import { generateJsonResilient } from './llm.js';
import { logger } from './logger.js';
import { upsertCoreMemory } from './workspace-db.js';

// ── Types ──────────────────────────────────────────────────────────────────

interface DailyReflectionResult {
  wins: string[];
  losses: string[];
  patterns: string[];
  improvements: string[];
  key_learnings: string[];
  commitments: Array<{
    what: string;
    due: string;
    context: string;
  }>;
  daily_summary: string;
}

interface WeeklyReflectionResult {
  strategic_insights: string[];
  recurring_wins: string[];
  recurring_problems: string[];
  evolution: string;
  recommendations: string[];
  weekly_summary: string;
}

// ── Obsidian helper ────────────────────────────────────────────────────────

function writeReflectionNote(content: string, title: string, folder: string): string | null {
  const config = agentObsidianConfig;
  if (!config?.vault) return null;

  const vaultPath = config.vault.replace(/^~/, process.env.HOME || '');
  const folderPath = path.join(vaultPath, folder);
  fs.mkdirSync(folderPath, { recursive: true });

  const safeTitle = title.replace(/[/\\:*?"<>|]/g, '-').slice(0, 120);
  let finalPath = path.join(folderPath, `${safeTitle}.md`);
  if (fs.existsSync(finalPath)) {
    finalPath = path.join(folderPath, `${safeTitle}-${Date.now()}.md`);
  }
  fs.writeFileSync(finalPath, content, 'utf-8');
  return finalPath;
}

// ── Telegram notification ──────────────────────────────────────────────────

async function notifyTelegram(message: string): Promise<void> {
  try {
    const env = readEnvFile(['TELEGRAM_BOT_TOKEN']);
    const token = env.TELEGRAM_BOT_TOKEN;
    if (!token || !ALLOWED_CHAT_ID) return;

    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: ALLOWED_CHAT_ID, text: message, parse_mode: 'HTML' }),
    });
  } catch { /* non-fatal */ }
}

// ── Daily Reflection ───────────────────────────────────────────────────────

export async function runDailyReflection(chatId: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const since = now - 24 * 60 * 60; // 24 hours ago
  const today = new Date().toISOString().slice(0, 10);

  logger.info({ chatId, today }, 'Starting daily reflection');

  // Check if already ran today
  const existing = getMemoriesBySource(chatId, 'daily_reflection', now - 12 * 60 * 60);
  if (existing.length > 0) {
    logger.info('Daily reflection already ran today, skipping');
    return;
  }

  // ── Gather data ──────────────────────────────────────────────────────
  const conversations = getConversationsSince(chatId, since);
  const memories = getMemoriesCreatedSince(chatId, since);
  const sessionSummaries = getSessionSummariesSince(since);
  const consolidations = getConsolidationsSince(chatId, since);
  const skillStats = getSkillUsageSince(since);
  const tokenStats = getSessionTokenStats(since);

  // If nothing happened today, skip
  if (conversations.length < 4) {
    logger.info({ turns: conversations.length }, 'Too few conversations for daily reflection');
    return;
  }

  // Condense conversations to key exchanges (cap at 40 turns, 200 chars each)
  const convoHighlights = conversations
    .slice(-40)
    .map((t) => `[${t.agent_id}] ${t.role}: ${t.content.slice(0, 200)}`)
    .join('\n');

  const memoriesSummary = memories
    .map((m) => `- [${m.source}] ${m.summary}`)
    .join('\n') || 'No memories extracted today.';

  const sessionSummaryText = sessionSummaries
    .map((s) => `- ${s.summary} (${s.turn_count} turns, $${s.total_cost.toFixed(3)})`)
    .join('\n') || 'No session summaries.';

  const consolidationText = consolidations
    .map((c) => `- ${c.insight}`)
    .join('\n') || 'No consolidation insights.';

  const skillText = skillStats.length > 0
    ? skillStats.map((s) => `- ${s.skill_id}: ${s.successes}/${s.uses} success (${s.total_tokens} tokens)`).join('\n')
    : 'No skills used.';

  const costText = `Turns: ${tokenStats.total_turns}, Cost: $${tokenStats.total_cost.toFixed(3)}, Compactions: ${tokenStats.compactions}`;

  // Count corrections
  const corrections = memories.filter((m) => m.source === 'correction');

  // ── Build prompt ─────────────────────────────────────────────────────
  const prompt = `You are a personal growth and operations analyst reviewing a day's activity for a personal AI assistant system called ClaudeClaw. Analyze today's work and extract actionable lessons.

Date: ${today}

Session stats: ${costText}
Corrections/mistakes: ${corrections.length}

Session summaries:
${sessionSummaryText}

Memories extracted today:
${memoriesSummary}

Consolidation insights:
${consolidationText}

Skills used:
${skillText}

Conversation highlights (last 24h):
${convoHighlights}

Analyze this day and return JSON:
{
  "wins": ["things that went well — specific, actionable observations"],
  "losses": ["things that went poorly or could be improved — be specific about what happened"],
  "patterns": ["recurring themes or behaviors observed"],
  "improvements": ["specific actionable rules for the assistant to follow going forward — write each as an imperative rule like 'Always verify X before Y'"],
  "key_learnings": ["important new facts or context learned about the user today"],
  "commitments": [{"what": "follow-up task", "due": "YYYY-MM-DD or 'soon'", "context": "why"}],
  "daily_summary": "2-3 sentence overview of the day"
}

Be specific and actionable. Generic observations like "communication was good" are useless. Focus on concrete patterns and rules.`;

  const result = await generateJsonResilient<DailyReflectionResult>(prompt, { timeoutMs: 120_000 });

  if (!result || !result.daily_summary) {
    logger.warn('Daily reflection produced no result');
    return;
  }

  // ── Save memories ────────────────────────────────────────────────────
  const savedIds: number[] = [];

  // Save each improvement as a memory
  for (const item of (result.improvements || []).slice(0, 5)) {
    const id = saveStructuredMemoryAtomic(
      chatId, '', item, [], ['daily-reflection', 'improvement', today],
      0.75, [], 'daily_reflection', 'main',
    );
    savedIds.push(id);
  }

  // Save patterns as higher-importance memories
  for (const item of (result.patterns || []).slice(0, 3)) {
    const id = saveStructuredMemoryAtomic(
      chatId, '', item, [], ['daily-reflection', 'pattern', today],
      0.8, [], 'daily_reflection', 'main',
    );
    savedIds.push(id);
  }

  // Save key learnings
  for (const item of (result.key_learnings || []).slice(0, 3)) {
    const id = saveStructuredMemoryAtomic(
      chatId, '', item, [], ['daily-reflection', 'learning', today],
      0.7, [], 'daily_reflection', 'main',
    );
    savedIds.push(id);
  }

  // Save daily summary
  saveStructuredMemoryAtomic(
    chatId, '', result.daily_summary, [], ['daily-reflection', 'summary', today],
    0.7, [], 'daily_reflection', 'main',
  );

  // ── Save learned behaviors to core_memory (auto-injected Layer 1) ──
  let ruleCount = 0;
  for (const improvement of (result.improvements || []).slice(0, 5)) {
    // Only save if it reads like a concrete rule
    if (improvement.length > 20) {
      upsertCoreMemory({
        business_id: null,
        key: `learned_${today}_${ruleCount}`,
        value: improvement,
        category: 'learned_behavior',
      });
      ruleCount++;
    }
  }

  // ── Schedule follow-ups from commitments ─────────────────────────────
  for (const commitment of (result.commitments || []).slice(0, 3)) {
    if (!commitment.what || !commitment.due) continue;
    try {
      const { execFileSync } = await import('child_process');
      const { PROJECT_ROOT } = await import('./config.js');
      const cliPath = path.join(PROJECT_ROOT, 'dist', 'schedule-cli.js');

      // Parse due date for cron. If "soon", schedule for tomorrow 9am
      let cronExpr = '0 9 * * *'; // default: next day 9am
      const dueMatch = commitment.due.match(/(\d{4})-(\d{2})-(\d{2})/);
      if (dueMatch) {
        const [, , month, day] = dueMatch;
        cronExpr = `0 9 ${parseInt(day)} ${parseInt(month)} *`;
      }

      const followUpPrompt = `Follow up: ${commitment.what}. Context: ${commitment.context}. Check if this has been done and offer help if needed.`;
      execFileSync('node', [cliPath, 'create', followUpPrompt, cronExpr], {
        timeout: 10_000,
        stdio: 'pipe',
      });
      logger.info({ commitment: commitment.what, due: commitment.due }, 'Follow-up scheduled');
    } catch (err) {
      logger.debug({ err: (err as Error).message }, 'Failed to schedule follow-up (non-fatal)');
    }
  }

  // ── Write Obsidian note ──────────────────────────────────────────────
  const obsidianContent = `---
type: daily-reflection
date: ${today}
corrections: ${corrections.length}
memories_extracted: ${memories.length}
rules_created: ${ruleCount}
---

# Daily Reflection - ${today}

## Summary
${result.daily_summary}

## Wins
${(result.wins || []).map((w) => `- ${w}`).join('\n') || '- None noted'}

## Losses
${(result.losses || []).map((l) => `- ${l}`).join('\n') || '- None noted'}

## Patterns
${(result.patterns || []).map((p) => `- ${p}`).join('\n') || '- None noted'}

## Improvements (Learned Behaviors)
${(result.improvements || []).map((i) => `- ${i}`).join('\n') || '- None noted'}

## Key Learnings
${(result.key_learnings || []).map((k) => `- ${k}`).join('\n') || '- None noted'}

## Commitments
${(result.commitments || []).map((c) => `- [ ] ${c.what} (due: ${c.due}) - ${c.context}`).join('\n') || '- None'}

## Stats
- Conversations: ${conversations.length} turns
- Memories extracted: ${memories.length}
- Corrections: ${corrections.length}
- Cost: $${tokenStats.total_cost.toFixed(3)}
`;

  writeReflectionNote(obsidianContent, `${today} Daily Reflection`, 'Reflections');

  // ── Telegram notification ────────────────────────────────────────────
  const wins = (result.wins || []).slice(0, 2).map((w) => `  + ${w}`).join('\n');
  const losses = (result.losses || []).slice(0, 2).map((l) => `  - ${l}`).join('\n');
  const telegramMsg = `<b>Daily Reflection - ${today}</b>\n\n${result.daily_summary}\n\n<b>Wins:</b>\n${wins || '  (none)'}\n\n<b>Areas to improve:</b>\n${losses || '  (none)'}\n\n<b>Rules learned:</b> ${ruleCount} | <b>Corrections:</b> ${corrections.length}`;

  await notifyTelegram(telegramMsg);

  logger.info(
    { today, memories: savedIds.length, rules: ruleCount, commitments: (result.commitments || []).length },
    'Daily reflection complete',
  );
}

// ── Weekly Deep Consolidation ──────────────────────────────────────────────

export async function runWeeklyDeepConsolidation(chatId: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const weekAgo = now - 7 * 24 * 60 * 60;
  const today = new Date().toISOString().slice(0, 10);

  logger.info({ chatId, today }, 'Starting weekly deep consolidation');

  // Check if already ran this week
  const existing = getMemoriesBySource(chatId, 'weekly_reflection', now - 5 * 24 * 60 * 60);
  if (existing.length > 0) {
    logger.info('Weekly consolidation already ran this week, skipping');
    return;
  }

  // ── Gather data ──────────────────────────────────────────────────────
  const dailyReflections = getMemoriesBySource(chatId, 'daily_reflection', weekAgo);
  const consolidations = getConsolidationsSince(chatId, weekAgo);
  const sessionSummaries = getSessionSummariesSince(weekAgo);
  const corrections = getMemoriesBySource(chatId, 'correction', weekAgo);
  const tokenStats = getSessionTokenStats(weekAgo);
  const sourceEffectiveness = getMemorySourceEffectiveness(chatId);

  // Behavioral fingerprinting data
  const conversations = getConversationsSince(chatId, weekAgo);

  if (dailyReflections.length === 0 && conversations.length < 10) {
    logger.info('Not enough data for weekly consolidation');
    return;
  }

  // ── Compute behavioral patterns ──────────────────────────────────────
  const hourCounts: Record<number, number> = {};
  let totalUserMsgLen = 0;
  let userMsgCount = 0;
  const agentCounts: Record<string, number> = {};

  for (const turn of conversations) {
    const hour = new Date(turn.created_at * 1000).getHours();
    hourCounts[hour] = (hourCounts[hour] || 0) + 1;
    if (turn.role === 'user') {
      totalUserMsgLen += turn.content.length;
      userMsgCount++;
    }
    agentCounts[turn.agent_id] = (agentCounts[turn.agent_id] || 0) + 1;
  }

  const peakHours = Object.entries(hourCounts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3)
    .map(([h]) => `${h}:00`)
    .join(', ');

  const avgMsgLen = userMsgCount > 0 ? Math.round(totalUserMsgLen / userMsgCount) : 0;

  const behavioralData = `Peak activity hours: ${peakHours}
Average user message length: ${avgMsgLen} chars
Most active agents: ${Object.entries(agentCounts).sort(([, a], [, b]) => b - a).map(([a, c]) => `${a}(${c})`).join(', ')}
Total corrections this week: ${corrections.length}`;

  // ── Build prompt ─────────────────────────────────────────────────────
  const dailyText = dailyReflections
    .map((m) => `- ${m.summary}`)
    .join('\n') || 'No daily reflections available.';

  const consolidationText = consolidations
    .map((c) => `- ${c.insight}`)
    .join('\n') || 'No consolidation insights.';

  const sessionText = sessionSummaries
    .map((s) => `- ${s.summary}`)
    .join('\n') || 'No session summaries.';

  const effectivenessText = sourceEffectiveness
    .map((s) => `- ${s.source}: ${s.count} memories, avg salience ${s.avg_salience.toFixed(2)}, avg importance ${s.avg_importance.toFixed(2)}`)
    .join('\n') || 'No memory source data.';

  const prompt = `You are a strategic analyst performing a weekly review of a personal AI assistant system called ClaudeClaw. Synthesize the past week into strategic insights.

Week ending: ${today}
Total turns: ${tokenStats.total_turns}, Cost: $${tokenStats.total_cost.toFixed(3)}, Compactions: ${tokenStats.compactions}

Behavioral data:
${behavioralData}

Daily reflections:
${dailyText}

Consolidation insights:
${consolidationText}

Session summaries:
${sessionText}

Memory source effectiveness (which types are most useful):
${effectivenessText}

Return JSON:
{
  "strategic_insights": ["high-level patterns or trends across the week"],
  "recurring_wins": ["things consistently done well"],
  "recurring_problems": ["issues that keep coming up — be specific"],
  "evolution": "How has the user's workflow/priorities evolved this week? (2-3 sentences)",
  "recommendations": ["concrete changes to make next week — imperative rules"],
  "weekly_summary": "3-5 sentence executive summary of the week"
}`;

  const result = await generateJsonResilient<WeeklyReflectionResult>(prompt, { timeoutMs: 120_000 });

  if (!result || !result.weekly_summary) {
    logger.warn('Weekly consolidation produced no result');
    return;
  }

  // ── Save strategic insights as high-importance memories ───────────────
  for (const insight of (result.strategic_insights || []).slice(0, 5)) {
    saveStructuredMemoryAtomic(
      chatId, '', insight, [], ['weekly-reflection', 'strategic-insight', today],
      0.9, [], 'weekly_reflection', 'main',
    );
  }

  // Save weekly summary
  saveStructuredMemoryAtomic(
    chatId, '', result.weekly_summary, [], ['weekly-reflection', 'summary', today],
    0.85, [], 'weekly_reflection', 'main',
  );

  // ── Update behavioral fingerprint in core_memory ─────────────────────
  upsertCoreMemory({
    business_id: null,
    key: 'peak_activity_hours',
    value: peakHours,
    category: 'user_pattern',
  });

  const commStyle = avgMsgLen < 50 ? 'Brief commands' : avgMsgLen < 150 ? 'Moderate detail' : 'Detailed instructions';
  upsertCoreMemory({
    business_id: null,
    key: 'communication_style',
    value: `${commStyle} (avg ${avgMsgLen} chars)`,
    category: 'user_pattern',
  });

  // ── Prune/merge learned behaviors ────────────────────────────────────
  // Weekly review: promote recommendations to learned behaviors, cap at 20 total
  let ruleCount = 0;
  for (const rec of (result.recommendations || []).slice(0, 3)) {
    if (rec.length > 20) {
      upsertCoreMemory({
        business_id: null,
        key: `weekly_rule_${today}_${ruleCount}`,
        value: rec,
        category: 'learned_behavior',
      });
      ruleCount++;
    }
  }

  // ── Write Obsidian note ──────────────────────────────────────────────
  const obsidianContent = `---
type: weekly-reflection
week_ending: ${today}
total_turns: ${tokenStats.total_turns}
total_cost: ${tokenStats.total_cost.toFixed(3)}
corrections: ${corrections.length}
---

# Weekly Review - Week ending ${today}

## Summary
${result.weekly_summary}

## Evolution
${result.evolution}

## Strategic Insights
${(result.strategic_insights || []).map((i) => `- ${i}`).join('\n') || '- None'}

## Recurring Wins
${(result.recurring_wins || []).map((w) => `- ${w}`).join('\n') || '- None'}

## Recurring Problems
${(result.recurring_problems || []).map((p) => `- ${p}`).join('\n') || '- None'}

## Recommendations
${(result.recommendations || []).map((r) => `- ${r}`).join('\n') || '- None'}

## Behavioral Fingerprint
- Peak hours: ${peakHours}
- Communication style: ${commStyle} (avg ${avgMsgLen} chars)
- Most active agents: ${Object.entries(agentCounts).sort(([, a], [, b]) => b - a).map(([a, c]) => `${a}(${c})`).join(', ')}

## Memory Source Effectiveness
${effectivenessText}

## Stats
- Total turns: ${tokenStats.total_turns}
- Total cost: $${tokenStats.total_cost.toFixed(3)}
- Compactions: ${tokenStats.compactions}
- Corrections: ${corrections.length}
`;

  writeReflectionNote(obsidianContent, `${today} Weekly Review`, 'Reflections/Weekly');

  // ── Telegram notification ────────────────────────────────────────────
  const insights = (result.strategic_insights || []).slice(0, 2).map((i) => `  - ${i}`).join('\n');
  const problems = (result.recurring_problems || []).slice(0, 2).map((p) => `  - ${p}`).join('\n');
  const telegramMsg = `<b>Weekly Intelligence Brief - ${today}</b>\n\n${result.weekly_summary}\n\n<b>Key insights:</b>\n${insights || '  (none)'}\n\n<b>Watch out for:</b>\n${problems || '  (none)'}\n\nTurns: ${tokenStats.total_turns} | Cost: $${tokenStats.total_cost.toFixed(3)} | Corrections: ${corrections.length}`;

  await notifyTelegram(telegramMsg);

  logger.info(
    { today, insights: (result.strategic_insights || []).length, rules: ruleCount },
    'Weekly deep consolidation complete',
  );
}
