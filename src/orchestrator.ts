import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { runAgent, UsageInfo } from './agent.js';
import { loadAgentConfig, listAgentIds, resolveAgentClaudeMd } from './agent-config.js';
import { PROJECT_ROOT } from './config.js';
import { logToHiveMind, createInterAgentTask, completeInterAgentTask } from './db.js';
import { logger } from './logger.js';
import { buildMemoryContext } from './memory.js';

// ── Types ────────────────────────────────────────────────────────────

export interface DelegationResult {
  agentId: string;
  text: string | null;
  usage: UsageInfo | null;
  taskId: string;
  durationMs: number;
}

/** Max agents allowed in a single fan-out (UI + server enforced). */
export const MAX_FANOUT_AGENTS = 4;

export interface FanoutResult {
  runId: string;
  results: Array<DelegationResult & { status: 'completed' | 'failed'; error?: string }>;
  totalDurationMs: number;
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
}

export interface AgentInfo {
  id: string;
  name: string;
  description: string;
}

// ── Registry ─────────────────────────────────────────────────────────

/** Cache of available agents loaded at startup. */
let agentRegistry: AgentInfo[] = [];

/** Default timeout for a delegated task (5 minutes). */
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Initialize the orchestrator by scanning `agents/` for valid configs.
 * Safe to call even if no agents are configured — the registry will be empty.
 */
export function initOrchestrator(): void {
  const ids = listAgentIds();
  agentRegistry = [];

  for (const id of ids) {
    try {
      const config = loadAgentConfig(id);
      agentRegistry.push({
        id,
        name: config.name,
        description: config.description,
      });
    } catch (err) {
      // Agent config is broken (e.g. missing token) — skip it but warn
      logger.warn({ agentId: id, err }, 'Skipping agent — config load failed');
    }
  }

  logger.info(
    { agents: agentRegistry.map((a) => a.id) },
    'Orchestrator initialized',
  );
}

/** Return all agents that were successfully loaded. */
export function getAvailableAgents(): AgentInfo[] {
  return [...agentRegistry];
}

// ── Delegation ───────────────────────────────────────────────────────

/**
 * Parse a user message for delegation syntax.
 *
 * Supported forms:
 *   @agentId: prompt text
 *   @agentId prompt text   (only if agentId is a known agent)
 *   /delegate agentId prompt text
 *
 * Returns `{ agentId, prompt }` or `null` if no delegation detected.
 */
export function parseDelegation(
  message: string,
): { agentId: string; prompt: string } | null {
  // /delegate agentId prompt
  const cmdMatch = message.match(
    /^\/delegate\s+(\S+)\s+([\s\S]+)/i,
  );
  if (cmdMatch) {
    return { agentId: cmdMatch[1], prompt: cmdMatch[2].trim() };
  }

  // @agentId: prompt
  const atMatch = message.match(
    /^@(\S+?):\s*([\s\S]+)/,
  );
  if (atMatch) {
    return { agentId: atMatch[1], prompt: atMatch[2].trim() };
  }

  // @agentId prompt (only for known agents to avoid false positives)
  const atMatchNoColon = message.match(
    /^@(\S+)\s+([\s\S]+)/,
  );
  if (atMatchNoColon) {
    const candidate = atMatchNoColon[1];
    if (agentRegistry.some((a) => a.id === candidate)) {
      return { agentId: candidate, prompt: atMatchNoColon[2].trim() };
    }
  }

  return null;
}

/**
 * Delegate a task to another agent. Runs the agent's Claude Code session
 * in-process (same Node.js process) with the target agent's cwd and
 * system prompt.
 *
 * The delegation is logged to both `inter_agent_tasks` and `hive_mind`.
 *
 * @param agentId    Target agent identifier (must exist in agents/)
 * @param prompt     The task to delegate
 * @param chatId     Telegram chat ID (for DB tracking)
 * @param fromAgent  The requesting agent's ID (usually 'main')
 * @param onProgress Optional callback for status updates
 * @param timeoutMs  Maximum execution time (default 5 min)
 */
export async function delegateToAgent(
  agentId: string,
  prompt: string,
  chatId: string,
  fromAgent: string,
  onProgress?: (msg: string) => void,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  runId?: string,
): Promise<DelegationResult> {
  const agent = agentRegistry.find((a) => a.id === agentId);
  if (!agent) {
    const available = agentRegistry.map((a) => a.id).join(', ') || '(none)';
    throw new Error(
      `Agent "${agentId}" not found. Available: ${available}`,
    );
  }

  const taskId = crypto.randomUUID();
  const start = Date.now();

  // Record the task (run_id groups multi-agent fan-outs; undefined for solo delegations)
  createInterAgentTask(taskId, fromAgent, agentId, chatId, prompt, runId);
  logToHiveMind(
    fromAgent,
    chatId,
    'delegate',
    `Delegated to ${agentId}: ${prompt.slice(0, 100)}`,
  );

  onProgress?.(`Delegating to ${agent.name}...`);

  try {
    // Load agent config to get its system prompt and MCP allowlist
    const agentConfig = loadAgentConfig(agentId);
    const claudeMdPath = resolveAgentClaudeMd(agentId);
    let systemPrompt = '';
    if (claudeMdPath) {
      try {
        systemPrompt = fs.readFileSync(claudeMdPath, 'utf-8');
      } catch {
        // No CLAUDE.md for this agent — that's fine
      }
    }

    // Build memory context for the delegated agent
    const { contextText: memCtx } = await buildMemoryContext(chatId, prompt, agentId);

    // Build the delegated prompt with agent role context + memory
    const contextParts: string[] = [];
    if (systemPrompt) {
      contextParts.push(`[Agent role — follow these instructions]\n${systemPrompt}\n[End agent role]`);
    }
    if (memCtx) {
      contextParts.push(memCtx);
    }
    contextParts.push(prompt);
    const fullPrompt = contextParts.join('\n\n');

    // Create an AbortController with timeout
    const abortCtrl = new AbortController();
    const timer = setTimeout(() => abortCtrl.abort(), timeoutMs);

    try {
      const result = await runAgent(
        fullPrompt,
        undefined, // fresh session for each delegation
        () => {}, // no typing indicator needed for sub-delegation
        undefined, // no progress callback for inner agent
        undefined, // use default model
        abortCtrl,
        undefined, // no streaming for delegation
        agentConfig.mcpServers,
      );

      clearTimeout(timer);

      const durationMs = Date.now() - start;
      completeInterAgentTask(taskId, 'completed', result.text);
      logToHiveMind(
        agentId,
        chatId,
        'delegate_result',
        `Completed delegation from ${fromAgent}: ${(result.text ?? '').slice(0, 120)}`,
      );

      onProgress?.(
        `${agent.name} completed (${Math.round(durationMs / 1000)}s)`,
      );

      return {
        agentId,
        text: result.text,
        usage: result.usage,
        taskId,
        durationMs,
      };
    } catch (innerErr) {
      clearTimeout(timer);
      throw innerErr;
    }
  } catch (err) {
    const durationMs = Date.now() - start;
    const errMsg = err instanceof Error ? err.message : String(err);
    completeInterAgentTask(taskId, 'failed', errMsg);
    logToHiveMind(
      agentId,
      chatId,
      'delegate_error',
      `Delegation from ${fromAgent} failed: ${errMsg.slice(0, 120)}`,
    );
    throw err;
  }
}

// ── Multi-agent fan-out ──────────────────────────────────────────────

/**
 * Fan out a single prompt to multiple agents in parallel. Each agent runs its
 * own delegation concurrently; the shared `run_id` groups them in
 * `inter_agent_tasks` for later aggregation. Capped at MAX_FANOUT_AGENTS.
 *
 * The returned promise resolves once every agent has either finished or
 * errored — no agent failure short-circuits the others.
 *
 * @param agentIds       Target agents (deduped, filtered to registered, truncated to cap)
 * @param prompt         The shared task prompt
 * @param chatId         Telegram chat ID (for DB tracking)
 * @param fromAgent      Requesting agent (usually 'main')
 * @param onAgentStart   Fires as soon as a given agent's delegation is kicked off
 * @param onAgentSettle  Fires when one agent finishes (success or failure) — lets the
 *                       dashboard render each bubble as soon as it lands instead of
 *                       waiting for the slowest agent.
 */
export async function delegateToAgents(
  agentIds: string[],
  prompt: string,
  chatId: string,
  fromAgent: string,
  onAgentStart?: (agentId: string) => void,
  onAgentSettle?: (
    result: DelegationResult & { status: 'completed' | 'failed'; error?: string },
  ) => void,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<FanoutResult> {
  // Normalise: dedupe, drop unknown, cap at MAX
  const registered = new Set(agentRegistry.map((a) => a.id));
  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const id of agentIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    if (!registered.has(id)) continue;
    deduped.push(id);
    if (deduped.length >= MAX_FANOUT_AGENTS) break;
  }

  if (deduped.length === 0) {
    const available = [...registered].join(', ') || '(none)';
    throw new Error(`No registered agents in fan-out. Available: ${available}`);
  }

  const runId = crypto.randomUUID();
  const start = Date.now();

  logger.info(
    { runId, agents: deduped, promptLen: prompt.length },
    'Fan-out delegation started',
  );

  const settled = await Promise.allSettled(
    deduped.map(async (agentId) => {
      onAgentStart?.(agentId);
      const res = await delegateToAgent(
        agentId,
        prompt,
        chatId,
        fromAgent,
        undefined, // no per-agent progress string — the UI renders bubbles directly
        timeoutMs,
        runId,
      );
      const done = { ...res, status: 'completed' as const };
      onAgentSettle?.(done);
      return done;
    }),
  );

  const results: FanoutResult['results'] = [];
  let totalCostUsd = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  for (let i = 0; i < settled.length; i++) {
    const s = settled[i];
    const agentId = deduped[i];
    if (s.status === 'fulfilled') {
      results.push(s.value);
      totalCostUsd += s.value.usage?.totalCostUsd ?? 0;
      totalInputTokens += s.value.usage?.inputTokens ?? 0;
      totalOutputTokens += s.value.usage?.outputTokens ?? 0;
    } else {
      const err = s.reason instanceof Error ? s.reason.message : String(s.reason);
      const failed = {
        agentId,
        text: null,
        usage: null,
        taskId: '',
        durationMs: 0,
        status: 'failed' as const,
        error: err,
      };
      results.push(failed);
      onAgentSettle?.(failed);
    }
  }

  const totalDurationMs = Date.now() - start;
  logger.info(
    { runId, totalDurationMs, results: results.map((r) => ({ id: r.agentId, status: r.status })) },
    'Fan-out delegation complete',
  );

  return {
    runId,
    results,
    totalDurationMs,
    totalCostUsd,
    totalInputTokens,
    totalOutputTokens,
  };
}
