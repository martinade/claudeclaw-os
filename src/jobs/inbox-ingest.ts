import { extract } from '@extractus/article-extractor';

import { generateContent, parseJsonResponse } from '../gemini.js';
import { logger } from '../logger.js';
import { createInboxItem, type InboxItem } from '../workspace-db.js';

export interface IngestInput {
  /** Free-form text or URL. If the text looks like a URL, we try to extract. */
  raw_text?: string;
  /** Explicit source URL (takes precedence over parsing raw_text for a URL). */
  source_url?: string;
  /** Workspace business id; null = cross-business. */
  business_id: string | null;
}

interface ExtractedArticle {
  title: string;
  content: string;
  url: string;
}

/**
 * Best-effort URL extraction using @extractus/article-extractor. Returns
 * the cleaned article on success, or null if extraction fails (non-HTML,
 * paywalled, or network error). Callers must handle the null case by
 * persisting the raw URL + user-supplied text.
 */
async function extractArticle(url: string): Promise<ExtractedArticle | null> {
  try {
    const article = await extract(url);
    if (!article || !article.content) return null;
    // article.content is HTML; strip tags down to plain text.
    const text = String(article.content)
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return {
      title: article.title || 'Untitled',
      content: text.slice(0, 8000),
      url,
    };
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err, url }, 'inbox-ingest: article extraction failed');
    return null;
  }
}

function looksLikeUrl(s: string): string | null {
  const match = s.trim().match(/^(https?:\/\/\S+)$/i);
  return match ? match[1] : null;
}

interface InboxSummary {
  summary: string;
  action_items: string[];
  tags: string[];
}

/**
 * Summarise an article + extract action items and tags. Runs a single
 * Gemini call returning JSON. Falls back to the raw text with no summary
 * if Gemini fails.
 */
async function summarise(text: string, sourceUrl: string | null): Promise<InboxSummary> {
  if (!text || text.length < 40) {
    return { summary: text.trim().slice(0, 500), action_items: [], tags: [] };
  }
  const prompt = [
    'You are an inbox triage assistant. Read the text below and return JSON with these fields:',
    '- summary: 2-4 sentence neutral summary (no AI clichés, no em dashes)',
    '- action_items: array of short concrete actions this warrants (0-5 items). Empty array if none.',
    '- tags: array of 1-3 lowercase topic tags',
    '',
    'Return JSON only, no prose, no code fences.',
    '',
    sourceUrl ? `Source URL: ${sourceUrl}` : '',
    '',
    'Text:',
    text.slice(0, 6000),
  ].filter(Boolean).join('\n');
  try {
    const resp = await generateContent(prompt);
    const parsed = parseJsonResponse<InboxSummary>(resp);
    if (parsed && typeof parsed.summary === 'string') {
      return {
        summary: parsed.summary.trim().slice(0, 2000),
        action_items: Array.isArray(parsed.action_items) ? parsed.action_items.slice(0, 5).map(String) : [],
        tags: Array.isArray(parsed.tags) ? parsed.tags.slice(0, 3).map((t) => String(t).toLowerCase()) : [],
      };
    }
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, 'inbox-ingest: summarise failed');
  }
  return { summary: text.slice(0, 500), action_items: [], tags: [] };
}

/**
 * Full ingest pipeline. URL extraction → summary → persistence. Returns
 * the created inbox_items row. Safe to call from the dashboard API or
 * from bot.ts when the user forwards a message.
 */
export async function ingestItem(input: IngestInput): Promise<InboxItem> {
  const explicitUrl = (input.source_url || '').trim();
  const rawText = (input.raw_text || '').trim();
  const parsedUrl = !explicitUrl && rawText ? looksLikeUrl(rawText) : null;
  const url = explicitUrl || parsedUrl || '';

  let summary = '';
  let actionItems: string[] = [];
  let tags: string[] = [];
  let bodyText = rawText;

  if (url) {
    const article = await extractArticle(url);
    if (article) {
      bodyText = article.content;
      const sum = await summarise(article.content, url);
      summary = `${article.title}\n\n${sum.summary}`.trim();
      actionItems = sum.action_items;
      tags = sum.tags;
    } else if (rawText) {
      const sum = await summarise(rawText, url);
      summary = sum.summary;
      actionItems = sum.action_items;
      tags = sum.tags;
    }
  } else if (rawText) {
    const sum = await summarise(rawText, null);
    summary = sum.summary;
    actionItems = sum.action_items;
    tags = sum.tags;
  }

  return createInboxItem({
    business_id: input.business_id,
    source_type: url ? 'url' : 'text',
    source_url: url,
    raw_text: bodyText.slice(0, 12000),
    summary,
    action_items: actionItems,
    tags,
  });
}
