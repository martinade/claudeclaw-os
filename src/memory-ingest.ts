import { generateJsonResilient } from './llm.js';
import { cosineSimilarity, embedText } from './embeddings.js';
import { getMemoriesWithEmbeddings, saveStructuredMemoryAtomic, logToHiveMind } from './db.js';
import { logger } from './logger.js';

// Callback for notifying when a high-importance memory is created.
// Set by bot.ts to send a Telegram notification.
let onHighImportanceMemory: ((memoryId: number, summary: string, importance: number) => void) | null = null;

export function setHighImportanceCallback(cb: (memoryId: number, summary: string, importance: number) => void): void {
  onHighImportanceMemory = cb;
}

interface ExtractionResult {
  summary: string;
  entities: string[];
  topics: string[];
  importance: number;
}

interface CorrectionResult {
  is_correction: boolean;
  mistake: string;
  expected: string;
  category: string;
}

const EXTRACTION_PROMPT = `You are a memory extraction agent. Given a conversation exchange between a user and their AI assistant, decide if it contains information worth remembering LONG-TERM (weeks/months from now).

The bar is HIGH. Most exchanges should be skipped. Only extract if a future conversation would go noticeably worse without this memory.

SKIP (return {"skip": true}) if:
- The message is just an acknowledgment (ok, yes, no, got it, thanks, send it, do it)
- It's a command with no lasting context (/chatid, /help, checkpoint, convolife, etc)
- It's ephemeral task execution (send this email, check my calendar, read this message, draft a response, move these emails, fill out this form)
- The content is only relevant to this exact moment or this session
- It's a greeting or small talk with no substance
- It's a one-off action request like "shorten that", "generate 3 ideas", "look up X", "draft a reply"
- It's a correction of a typo or minor instruction adjustment
- It's asking for information or a status check ("how much did we make", "what's trending", "what time is it")
- The assistant is SUMMARIZING what it just did ("I sent the messages", "Here's what I moved", "Done, here's your inbox")
- The assistant is SUMMARIZING the session or recapping prior conversation. Session summaries are meta-information, not new facts.
- It's form-filling, application steps, or draft iteration that won't matter once the form is submitted
- It describes what the assistant sent/did/moved/drafted for the user (these are task logs, not memories)
- The exchange is about a specific person's one-time message or request that won't recur

EXTRACT only if the exchange reveals:
- User preferences or habits that apply GOING FORWARD (not just this one time)
- Decisions or policies (how to handle X from now on)
- Important relationships: WHO someone is and HOW the user relates to them (not what they said in one message)
- Corrections to the assistant's behavior (feedback on approach)
- Business rules or workflows that are STANDING RULES
- Recurring patterns or routines
- Technical preferences or architectural decisions

If extracting, return JSON:
{
  "skip": false,
  "summary": "1-2 sentence summary focused on the LASTING FACT, not the conversation. Write as a rule or fact, not a narrative.",
  "entities": ["entity1", "entity2"],
  "topics": ["topic1", "topic2"],
  "importance": 0.0-1.0
}

Importance guide:
- 0.8-1.0: Core identity, strong preferences, critical business rules, relationship dynamics
- 0.5-0.7: Useful context, standing project decisions, moderate preferences, workflow patterns
- 0.3-0.4: Borderline. If in doubt, skip. Only extract if you are confident this will matter in a future session.

User message: {USER_MESSAGE}
Assistant response: {ASSISTANT_RESPONSE}`;

// ── Correction Detection ────────────────────────────────────────────────────

// Cache the previous assistant response for correction detection
let previousAssistantResponse = '';
let sessionCorrectionCount = 0;

export function getSessionCorrectionCount(): number {
  return sessionCorrectionCount;
}

export function resetSessionCorrectionCount(): void {
  sessionCorrectionCount = 0;
}

const CORRECTION_REGEX = /\b(wrong|incorrect|no[,. !]|not what|already told|try again|fix (this|that|it)|that's not|I said|I meant|redo|undo|you (missed|forgot|didn't)|doesn't work|isn't right|not right|broken|still not)\b/i;

const CORRECTION_PROMPT = `Did the user correct or express frustration with the assistant's previous response? Analyze carefully.

Previous assistant response:
{PREV_RESPONSE}

User's reply:
{USER_MESSAGE}

If the user IS correcting the assistant or expressing dissatisfaction, return JSON:
{
  "is_correction": true,
  "mistake": "What the assistant did wrong (1 sentence)",
  "expected": "What the user actually wanted (1 sentence)",
  "category": "one of: wrong_answer, wrong_action, misunderstanding, not_done, bad_format, premature_claim"
}

If NOT a correction (just a normal follow-up, new question, or acknowledgment), return:
{ "is_correction": false, "mistake": "", "expected": "", "category": "" }`;

async function detectAndSaveCorrection(
  chatId: string,
  userMessage: string,
  agentId: string,
): Promise<void> {
  if (!previousAssistantResponse || userMessage.length < 10) return;

  // Quick regex pre-filter to avoid LLM calls on every message
  if (!CORRECTION_REGEX.test(userMessage)) return;

  try {
    const prompt = CORRECTION_PROMPT
      .replace('{PREV_RESPONSE}', previousAssistantResponse.slice(0, 1500))
      .replace('{USER_MESSAGE}', userMessage.slice(0, 1000));

    const result = await generateJsonResilient<CorrectionResult>(prompt, { timeoutMs: 15_000 });

    if (!result || !result.is_correction) return;

    sessionCorrectionCount++;

    const summary = `MISTAKE: ${result.mistake} EXPECTED: ${result.expected}`;
    const memoryId = saveStructuredMemoryAtomic(
      chatId,
      userMessage,
      summary,
      [],
      ['mistake-journal', 'self-improvement', result.category],
      0.85, // High importance — mistakes are valuable lessons
      [],
      'correction',
      agentId,
    );

    // Log to hive mind so other agents learn too
    try {
      logToHiveMind(agentId, chatId, 'self_correction', summary, JSON.stringify({
        category: result.category,
        mistake: result.mistake,
        expected: result.expected,
      }));
    } catch { /* non-fatal */ }

    logger.info(
      { chatId, memoryId, category: result.category, correction: sessionCorrectionCount },
      'Correction detected and saved to mistake journal',
    );
  } catch (err) {
    logger.debug({ err: (err as Error).message }, 'Correction detection failed (non-fatal)');
  }
}

// ── Main extraction ─────────────────────────────────────────────────────────

/**
 * Analyze a conversation turn and extract structured memory if warranted.
 * Called async (fire-and-forget) after the assistant responds.
 * Returns true if a memory was saved, false if skipped.
 */
export async function ingestConversationTurn(
  chatId: string,
  userMessage: string,
  assistantResponse: string,
  agentId = 'main',
): Promise<boolean> {
  // Run correction detection in parallel with extraction (both fire-and-forget)
  void detectAndSaveCorrection(chatId, userMessage, agentId).catch(() => {});

  // Hard filter: skip very short messages and commands
  if (userMessage.length <= 15 || userMessage.startsWith('/')) {
    previousAssistantResponse = assistantResponse.slice(0, 2000);
    return false;
  }

  try {
    const prompt = EXTRACTION_PROMPT
      .replace('{USER_MESSAGE}', userMessage.slice(0, 2000))
      .replace('{ASSISTANT_RESPONSE}', assistantResponse.slice(0, 2000));

    const result = await generateJsonResilient<ExtractionResult & { skip?: boolean }>(prompt);

    if (!result || result.skip) {
      previousAssistantResponse = assistantResponse.slice(0, 2000);
      return false;
    }

    // Validate required fields
    if (!result.summary || typeof result.importance !== 'number') {
      logger.warn({ result }, 'LLM extraction missing required fields');
      previousAssistantResponse = assistantResponse.slice(0, 2000);
      return false;
    }

    // Hard filter: only save memories with meaningful importance.
    if (result.importance < 0.5) {
      previousAssistantResponse = assistantResponse.slice(0, 2000);
      return false;
    }

    // Clamp importance to valid range
    const importance = Math.max(0, Math.min(1, result.importance));

    // Generate embedding early so we can check for duplicates before saving
    let embedding: number[] = [];
    try {
      const embeddingText = `${result.summary} ${(result.entities ?? []).join(' ')} ${(result.topics ?? []).join(' ')}`;
      embedding = await embedText(embeddingText);
    } catch (embErr) {
      logger.warn({ err: embErr }, 'Failed to generate embedding for duplicate check');
    }

    // Duplicate detection: skip if a very similar memory already exists
    if (embedding.length > 0) {
      const existing = getMemoriesWithEmbeddings(chatId);
      for (const mem of existing) {
        const sim = cosineSimilarity(embedding, mem.embedding);
        if (sim > 0.85) {
          logger.debug(
            { similarity: sim.toFixed(3), existingId: mem.id, newSummary: result.summary.slice(0, 60) },
            'Skipping duplicate memory',
          );
          previousAssistantResponse = assistantResponse.slice(0, 2000);
          return false;
        }
      }
    }

    const memoryId = saveStructuredMemoryAtomic(
      chatId,
      userMessage,
      result.summary,
      result.entities ?? [],
      result.topics ?? [],
      importance,
      embedding,
      'conversation',
      agentId,
    );

    // Notify on high-importance memories so the user can pin them
    if (importance >= 0.8 && onHighImportanceMemory) {
      try { onHighImportanceMemory(memoryId, result.summary, importance); } catch { /* non-fatal */ }
    }

    logger.info(
      { chatId, importance, memoryId, topics: result.topics, summary: result.summary.slice(0, 80) },
      'Memory ingested',
    );

    previousAssistantResponse = assistantResponse.slice(0, 2000);
    return true;
  } catch (err) {
    // LLM failure should never block the bot
    logger.error({ err }, 'Memory ingestion failed');
    previousAssistantResponse = assistantResponse.slice(0, 2000);
    return false;
  }
}
