/**
 * Ideas Pipeline -- AI processing stages.
 *
 * Stage 2: expandIdea   -- quick AI expansion (angles, scores, tags)
 * Stage 3: developIdea  -- deep structured development (MVP, risks, roadmap)
 * Stage 5: generateImplementationTasks -- concrete mission tasks from plan
 *
 * All functions use generateJsonResilient (3-tier cascade: Gemini -> Anthropic SDK -> Claude CLI).
 * Never throws. On failure, status reverts to the previous stage.
 */

import { logger } from '../logger.js';
import { getIdea, updateIdea, listBusinesses } from '../workspace-db.js';
import { generateJsonResilient } from '../llm.js';

// ── Stage 2: Quick AI Expansion ────────────────────────────────────────

interface ExpansionResult {
  angles: string[];
  market_context: string;
  cross_connections: string[];
  impact_score: number;
  effort_score: number;
  next_steps: string[];
  tags: string[];
  one_line_pitch: string;
}

export async function expandIdea(ideaId: number): Promise<boolean> {
  const idea = getIdea(ideaId);
  if (!idea) { logger.warn({ ideaId }, 'expandIdea: idea not found'); return false; }

  updateIdea(ideaId, { status: 'expanding' });

  // Gather workspace names for cross-connection context
  const workspaces = listBusinesses().map((b) => b.name);

  const prompt = `You are a startup advisor and innovation strategist. Analyze this idea and provide a structured expansion.

IDEA TITLE: ${idea.title}
IDEA DESCRIPTION: ${idea.raw_text}
${idea.source_url ? `SOURCE: ${idea.source_url}` : ''}

ACTIVE WORKSPACES/BUSINESSES: ${workspaces.join(', ')}

Return a JSON object with:
- "angles": array of exactly 3 different angles or approaches to this idea
- "market_context": brief market analysis or context (2-3 sentences)
- "cross_connections": array of potential connections to the listed workspaces/businesses (empty array if none)
- "impact_score": number 0-1 rating potential impact (1 = transformative)
- "effort_score": number 0-1 rating implementation effort (1 = massive effort)
- "next_steps": array of exactly 3 concrete next actions
- "tags": array of 2-5 category tags (lowercase, e.g. "defi", "marketing", "product")
- "one_line_pitch": single compelling sentence that captures the idea's value

Respond ONLY with valid JSON.`;

  const result = await generateJsonResilient<ExpansionResult>(prompt, { timeoutMs: 30_000 });

  if (!result) {
    logger.warn({ ideaId }, 'expandIdea: AI expansion failed, reverting to raw');
    updateIdea(ideaId, { status: 'raw' });
    return false;
  }

  // Format as markdown for developed_md
  const md = [
    `## AI Expansion`,
    '',
    `**Pitch:** ${result.one_line_pitch}`,
    '',
    `### Angles`,
    ...result.angles.map((a, i) => `${i + 1}. ${a}`),
    '',
    `### Market Context`,
    result.market_context,
    '',
    ...(result.cross_connections.length > 0 ? [
      `### Cross-Connections`,
      ...result.cross_connections.map((c) => `- ${c}`),
      '',
    ] : []),
    `### Next Steps`,
    ...result.next_steps.map((s) => `- [ ] ${s}`),
    '',
    `**Impact:** ${(result.impact_score * 10).toFixed(1)}/10 | **Effort:** ${(result.effort_score * 10).toFixed(1)}/10`,
  ].join('\n');

  updateIdea(ideaId, {
    developed_md: md,
    status: 'expanded',
    stage: 2,
    impact_score: Math.max(0, Math.min(1, result.impact_score)),
    effort_score: Math.max(0, Math.min(1, result.effort_score)),
    tags_json: (result.tags || []).slice(0, 5),
  });

  logger.info({ ideaId, impact: result.impact_score, effort: result.effort_score }, 'expandIdea: done');
  return true;
}

// ── Stage 3: Deep Structured Development ───────────────────────────────

interface DevelopmentResult {
  problem_statement: string;
  target_user: string;
  value_proposition: string;
  revenue_model: string;
  mvp_scope: string;
  resource_requirements: string;
  risks: string[];
  competitive_landscape: string;
  roadmap_90_days: string[];
  kill_criteria: string[];
}

export async function developIdea(ideaId: number): Promise<boolean> {
  const idea = getIdea(ideaId);
  if (!idea) { logger.warn({ ideaId }, 'developIdea: idea not found'); return false; }

  updateIdea(ideaId, { status: 'developing' });

  const prompt = `You are a senior product strategist. Take this idea and its initial expansion, then produce a deep structured development plan.

IDEA TITLE: ${idea.title}
IDEA DESCRIPTION: ${idea.raw_text}
${idea.source_url ? `SOURCE: ${idea.source_url}` : ''}

INITIAL AI EXPANSION:
${idea.developed_md}

Return a JSON object with:
- "problem_statement": clear articulation of the problem this solves (2-3 sentences)
- "target_user": who specifically benefits from this (be specific, not generic)
- "value_proposition": why this matters, what's unique about this approach
- "revenue_model": how this makes money or creates value (if applicable, otherwise "N/A - internal tool" etc.)
- "mvp_scope": minimum viable version that proves the concept (3-5 sentences)
- "resource_requirements": what's needed to build this (people, tools, money, time)
- "risks": array of 3-5 specific risks or failure modes
- "competitive_landscape": what exists already, how this differs
- "roadmap_90_days": array of 4-6 milestones for the first 90 days
- "kill_criteria": array of 2-3 specific conditions that would mean this idea should be abandoned

Be specific and actionable. No fluff. Respond ONLY with valid JSON.`;

  const result = await generateJsonResilient<DevelopmentResult>(prompt, { timeoutMs: 60_000 });

  if (!result) {
    logger.warn({ ideaId }, 'developIdea: AI development failed, reverting to expanded');
    updateIdea(ideaId, { status: 'expanded' });
    return false;
  }

  const md = [
    `## Development Plan`,
    '',
    `### Problem Statement`,
    result.problem_statement,
    '',
    `### Target User`,
    result.target_user,
    '',
    `### Value Proposition`,
    result.value_proposition,
    '',
    `### Revenue Model`,
    result.revenue_model,
    '',
    `### MVP Scope`,
    result.mvp_scope,
    '',
    `### Resource Requirements`,
    result.resource_requirements,
    '',
    `### Risks`,
    ...result.risks.map((r) => `- ${r}`),
    '',
    `### Competitive Landscape`,
    result.competitive_landscape,
    '',
    `### 90-Day Roadmap`,
    ...result.roadmap_90_days.map((m, i) => `${i + 1}. ${m}`),
    '',
    `### Kill Criteria`,
    ...result.kill_criteria.map((k) => `- ${k}`),
  ].join('\n');

  updateIdea(ideaId, {
    development_md: md,
    status: 'developed',
    stage: 3,
  });

  logger.info({ ideaId }, 'developIdea: done');
  return true;
}

// ── Stage 5: Implementation Task Generation ────────────────────────────

interface TaskSpec {
  title: string;
  prompt: string;
}

export async function generateImplementationTasks(ideaId: number): Promise<TaskSpec[]> {
  const idea = getIdea(ideaId);
  if (!idea) { logger.warn({ ideaId }, 'generateImplementationTasks: idea not found'); return []; }

  const prompt = `Based on this idea and its development plan, generate 3 concrete implementation tasks that can be delegated to an AI agent.

IDEA TITLE: ${idea.title}
IDEA DESCRIPTION: ${idea.raw_text}

EXPANSION:
${idea.developed_md}

DEVELOPMENT PLAN:
${idea.development_md}

DECISION NOTES: ${idea.decision_notes || 'Pursue'}

Return a JSON object with:
- "tasks": array of exactly 3 objects, each with:
  - "title": short task label (max 60 chars)
  - "prompt": detailed instructions for an AI agent to execute this task (include all necessary context, expected outputs, and success criteria)

Order tasks by priority (most important first). Be specific and actionable. Respond ONLY with valid JSON.`;

  const result = await generateJsonResilient<{ tasks: TaskSpec[] }>(prompt, { timeoutMs: 30_000 });
  return result?.tasks ?? [];
}
