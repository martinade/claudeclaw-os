import type Database from 'better-sqlite3';

import { getDb } from './db.js';

// ── Types ────────────────────────────────────────────────────────────

export interface Business {
  id: string;
  slug: string;
  name: string;
  color_hex: string;
  icon_emoji: string;
  brief_md: string;
  system_prompt_addendum: string;
  telegram_hashtag: string;
  monthly_budget_usd: number;
  daily_brief_cron: string;
  is_global: number;
  archived: number;
  created_at: number;
}

export interface CoreMemoryRow {
  id: number;
  business_id: string | null;
  key: string;
  value: string;
  category: string;
  updated_at: number;
}

export interface PriorityRow {
  id: number;
  business_id: string | null;
  text: string;
  position: number;
  done: number;
  updated_at: number;
}

export interface QuickLinkRow {
  id: number;
  business_id: string | null;
  label: string;
  icon: string;
  url: string;
  position: number;
}

export interface IdeaRow {
  id: number;
  business_id: string | null;
  title: string;
  raw_text: string;
  developed_md: string;
  source_url: string;
  created_at: number;
}

export interface DecisionRow {
  id: number;
  business_id: string | null;
  text: string;
  rationale: string;
  alternatives: string;
  created_at: number;
}

export interface InboxItem {
  id: number;
  business_id: string | null;
  source_type: string;
  source_url: string;
  raw_text: string;
  summary: string;
  action_items_json: string;
  tags_json: string;
  status: string;
  created_at: number;
}

export interface DocumentTemplate {
  id: number;
  business_id: string | null;
  name: string;
  doc_type: string;
  body_md: string;
  variables_json: string;
  created_at: number;
}

export interface DocumentRow {
  id: number;
  business_id: string | null;
  template_id: number | null;
  title: string;
  content_md: string;
  created_at: number;
}

// ── Helpers ──────────────────────────────────────────────────────────

function resolveDb(override?: Database.Database): Database.Database {
  return override ?? getDb();
}

function nextPosition(
  db: Database.Database,
  table: 'priorities' | 'quick_links',
  businessId: string | null,
): number {
  const row = db
    .prepare(`SELECT COALESCE(MAX(position), -1) + 1 AS next FROM ${table} WHERE business_id IS ?`)
    .get(businessId) as { next: number };
  return row.next;
}

// ── Businesses ───────────────────────────────────────────────────────

export function listBusinesses(includeArchived = false, db?: Database.Database): Business[] {
  const d = resolveDb(db);
  const sql = includeArchived
    ? 'SELECT * FROM businesses ORDER BY is_global DESC, created_at ASC'
    : 'SELECT * FROM businesses WHERE archived = 0 ORDER BY is_global DESC, created_at ASC';
  return d.prepare(sql).all() as Business[];
}

export function getBusinessBySlug(slug: string, db?: Database.Database): Business | null {
  const d = resolveDb(db);
  return (d.prepare('SELECT * FROM businesses WHERE slug = ?').get(slug) as Business | undefined) ?? null;
}

export function getBusinessById(id: string, db?: Database.Database): Business | null {
  const d = resolveDb(db);
  return (d.prepare('SELECT * FROM businesses WHERE id = ?').get(id) as Business | undefined) ?? null;
}

export function createBusiness(
  input: {
    slug: string;
    name: string;
    color_hex?: string;
    icon_emoji?: string;
    brief_md?: string;
    system_prompt_addendum?: string;
    telegram_hashtag?: string;
    monthly_budget_usd?: number;
    daily_brief_cron?: string;
  },
  db?: Database.Database,
): Business {
  const d = resolveDb(db);
  const id = `biz_${input.slug.replace(/[^a-z0-9]/gi, '').toLowerCase()}_${Math.random().toString(36).slice(2, 8)}`;
  const now = Math.floor(Date.now() / 1000);
  d.prepare(
    `INSERT INTO businesses (id, slug, name, color_hex, icon_emoji, brief_md, system_prompt_addendum, telegram_hashtag, monthly_budget_usd, daily_brief_cron, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.slug,
    input.name,
    input.color_hex ?? '#FFD700',
    input.icon_emoji ?? '🏢',
    input.brief_md ?? '',
    input.system_prompt_addendum ?? '',
    input.telegram_hashtag ?? '',
    input.monthly_budget_usd ?? 0,
    input.daily_brief_cron ?? '0 7 * * *',
    now,
  );
  return getBusinessById(id, d)!;
}

export function updateBusiness(
  id: string,
  patch: Partial<Omit<Business, 'id' | 'created_at' | 'is_global'>>,
  db?: Database.Database,
): Business | null {
  const d = resolveDb(db);
  const existing = getBusinessById(id, d);
  if (!existing) return null;
  const editable: Array<keyof typeof patch> = [
    'slug', 'name', 'color_hex', 'icon_emoji', 'brief_md',
    'system_prompt_addendum', 'telegram_hashtag', 'monthly_budget_usd',
    'daily_brief_cron', 'archived',
  ];
  const cols = editable.filter((k) => patch[k] !== undefined);
  if (cols.length === 0) return existing;
  const setSql = cols.map((k) => `${k} = ?`).join(', ');
  const values = cols.map((k) => patch[k]);
  d.prepare(`UPDATE businesses SET ${setSql} WHERE id = ?`).run(...values, id);
  return getBusinessById(id, d);
}

export function archiveBusiness(id: string, db?: Database.Database): void {
  const d = resolveDb(db);
  const b = getBusinessById(id, d);
  if (!b || b.is_global) return;
  d.prepare('UPDATE businesses SET archived = 1 WHERE id = ?').run(id);
}

// ── Core memory (tier-1) ─────────────────────────────────────────────

export function listCoreMemory(
  businessId: string | null,
  opts: { category?: string; includeGlobal?: boolean } = {},
  db?: Database.Database,
): CoreMemoryRow[] {
  const d = resolveDb(db);
  const includeGlobal = opts.includeGlobal ?? true;
  let sql = 'SELECT * FROM core_memory WHERE ';
  const params: unknown[] = [];
  if (businessId === null || !includeGlobal) {
    sql += 'business_id IS ? ';
    params.push(businessId);
  } else {
    sql += '(business_id = ? OR business_id IS NULL) ';
    params.push(businessId);
  }
  if (opts.category) {
    sql += 'AND category = ? ';
    params.push(opts.category);
  }
  sql += 'ORDER BY updated_at DESC';
  return d.prepare(sql).all(...params) as CoreMemoryRow[];
}

export function upsertCoreMemory(
  input: { id?: number; business_id: string | null; key: string; value: string; category?: string },
  db?: Database.Database,
): CoreMemoryRow {
  const d = resolveDb(db);
  const now = Math.floor(Date.now() / 1000);
  if (input.id) {
    d.prepare(
      'UPDATE core_memory SET key = ?, value = ?, category = ?, business_id = ?, updated_at = ? WHERE id = ?',
    ).run(input.key, input.value, input.category ?? 'fact', input.business_id, now, input.id);
    return d.prepare('SELECT * FROM core_memory WHERE id = ?').get(input.id) as CoreMemoryRow;
  }
  const res = d.prepare(
    'INSERT INTO core_memory (business_id, key, value, category, updated_at) VALUES (?, ?, ?, ?, ?)',
  ).run(input.business_id, input.key, input.value, input.category ?? 'fact', now);
  return d.prepare('SELECT * FROM core_memory WHERE id = ?').get(res.lastInsertRowid) as CoreMemoryRow;
}

export function deleteCoreMemory(id: number, db?: Database.Database): void {
  resolveDb(db).prepare('DELETE FROM core_memory WHERE id = ?').run(id);
}

// ── Priorities ───────────────────────────────────────────────────────

export function listPriorities(
  businessId: string | null,
  opts: { includeDone?: boolean } = {},
  db?: Database.Database,
): PriorityRow[] {
  const d = resolveDb(db);
  const sql = opts.includeDone
    ? 'SELECT * FROM priorities WHERE business_id IS ? ORDER BY done ASC, position ASC, id ASC'
    : 'SELECT * FROM priorities WHERE business_id IS ? AND done = 0 ORDER BY position ASC, id ASC';
  return d.prepare(sql).all(businessId) as PriorityRow[];
}

export function createPriority(
  businessId: string | null,
  text: string,
  db?: Database.Database,
): PriorityRow {
  const d = resolveDb(db);
  const pos = nextPosition(d, 'priorities', businessId);
  const now = Math.floor(Date.now() / 1000);
  const res = d.prepare(
    'INSERT INTO priorities (business_id, text, position, done, updated_at) VALUES (?, ?, ?, 0, ?)',
  ).run(businessId, text, pos, now);
  return d.prepare('SELECT * FROM priorities WHERE id = ?').get(res.lastInsertRowid) as PriorityRow;
}

export function updatePriority(
  id: number,
  patch: Partial<Pick<PriorityRow, 'text' | 'position' | 'done'>>,
  db?: Database.Database,
): PriorityRow | null {
  const d = resolveDb(db);
  const cols = (['text', 'position', 'done'] as const).filter((k) => patch[k] !== undefined);
  if (cols.length === 0) return (d.prepare('SELECT * FROM priorities WHERE id = ?').get(id) as PriorityRow) ?? null;
  const setSql = cols.map((k) => `${k} = ?`).join(', ');
  const values = cols.map((k) => patch[k]);
  const now = Math.floor(Date.now() / 1000);
  d.prepare(`UPDATE priorities SET ${setSql}, updated_at = ? WHERE id = ?`).run(...values, now, id);
  return (d.prepare('SELECT * FROM priorities WHERE id = ?').get(id) as PriorityRow) ?? null;
}

export function deletePriority(id: number, db?: Database.Database): void {
  resolveDb(db).prepare('DELETE FROM priorities WHERE id = ?').run(id);
}

// ── Quick links ──────────────────────────────────────────────────────

export function listQuickLinks(businessId: string | null, db?: Database.Database): QuickLinkRow[] {
  const d = resolveDb(db);
  return d.prepare(
    'SELECT * FROM quick_links WHERE business_id IS ? ORDER BY position ASC, id ASC',
  ).all(businessId) as QuickLinkRow[];
}

export function createQuickLink(
  businessId: string | null,
  input: { label: string; url: string; icon?: string },
  db?: Database.Database,
): QuickLinkRow {
  const d = resolveDb(db);
  const pos = nextPosition(d, 'quick_links', businessId);
  const res = d.prepare(
    'INSERT INTO quick_links (business_id, label, icon, url, position) VALUES (?, ?, ?, ?, ?)',
  ).run(businessId, input.label, input.icon ?? '🔗', input.url, pos);
  return d.prepare('SELECT * FROM quick_links WHERE id = ?').get(res.lastInsertRowid) as QuickLinkRow;
}

export function updateQuickLink(
  id: number,
  patch: Partial<Pick<QuickLinkRow, 'label' | 'url' | 'icon' | 'position'>>,
  db?: Database.Database,
): QuickLinkRow | null {
  const d = resolveDb(db);
  const cols = (['label', 'url', 'icon', 'position'] as const).filter((k) => patch[k] !== undefined);
  if (cols.length === 0) return (d.prepare('SELECT * FROM quick_links WHERE id = ?').get(id) as QuickLinkRow) ?? null;
  const setSql = cols.map((k) => `${k} = ?`).join(', ');
  const values = cols.map((k) => patch[k]);
  d.prepare(`UPDATE quick_links SET ${setSql} WHERE id = ?`).run(...values, id);
  return (d.prepare('SELECT * FROM quick_links WHERE id = ?').get(id) as QuickLinkRow) ?? null;
}

export function deleteQuickLink(id: number, db?: Database.Database): void {
  resolveDb(db).prepare('DELETE FROM quick_links WHERE id = ?').run(id);
}

// ── Ideas ────────────────────────────────────────────────────────────

export function listIdeas(businessId: string | null, db?: Database.Database): IdeaRow[] {
  const d = resolveDb(db);
  return d.prepare(
    'SELECT * FROM ideas WHERE business_id IS ? ORDER BY created_at DESC',
  ).all(businessId) as IdeaRow[];
}

export function createIdea(
  businessId: string | null,
  input: { title: string; raw_text: string; source_url?: string },
  db?: Database.Database,
): IdeaRow {
  const d = resolveDb(db);
  const res = d.prepare(
    'INSERT INTO ideas (business_id, title, raw_text, source_url) VALUES (?, ?, ?, ?)',
  ).run(businessId, input.title, input.raw_text, input.source_url ?? '');
  return d.prepare('SELECT * FROM ideas WHERE id = ?').get(res.lastInsertRowid) as IdeaRow;
}

// ── Decisions ────────────────────────────────────────────────────────

export function listDecisions(businessId: string | null, db?: Database.Database): DecisionRow[] {
  const d = resolveDb(db);
  return d.prepare(
    'SELECT * FROM decisions WHERE business_id IS ? ORDER BY created_at DESC',
  ).all(businessId) as DecisionRow[];
}

export function createDecision(
  businessId: string | null,
  input: { text: string; rationale?: string; alternatives?: string[] },
  db?: Database.Database,
): DecisionRow {
  const d = resolveDb(db);
  const res = d.prepare(
    'INSERT INTO decisions (business_id, text, rationale, alternatives) VALUES (?, ?, ?, ?)',
  ).run(
    businessId,
    input.text,
    input.rationale ?? '',
    JSON.stringify(input.alternatives ?? []),
  );
  return d.prepare('SELECT * FROM decisions WHERE id = ?').get(res.lastInsertRowid) as DecisionRow;
}

// ── Inbox items ──────────────────────────────────────────────────────

export function listInboxItems(
  businessId: string | null,
  opts: { status?: string; limit?: number } = {},
  db?: Database.Database,
): InboxItem[] {
  const d = resolveDb(db);
  const limit = opts.limit ?? 100;
  if (opts.status) {
    return d.prepare(
      'SELECT * FROM inbox_items WHERE business_id IS ? AND status = ? ORDER BY created_at DESC LIMIT ?',
    ).all(businessId, opts.status, limit) as InboxItem[];
  }
  return d.prepare(
    'SELECT * FROM inbox_items WHERE business_id IS ? ORDER BY created_at DESC LIMIT ?',
  ).all(businessId, limit) as InboxItem[];
}

export function createInboxItem(
  input: {
    business_id: string | null;
    source_type?: string;
    source_url?: string;
    raw_text: string;
    summary?: string;
    action_items?: string[];
    tags?: string[];
  },
  db?: Database.Database,
): InboxItem {
  const d = resolveDb(db);
  const res = d.prepare(
    `INSERT INTO inbox_items (business_id, source_type, source_url, raw_text, summary, action_items_json, tags_json, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'unread')`,
  ).run(
    input.business_id,
    input.source_type ?? 'text',
    input.source_url ?? '',
    input.raw_text,
    input.summary ?? '',
    JSON.stringify(input.action_items ?? []),
    JSON.stringify(input.tags ?? []),
  );
  return d.prepare('SELECT * FROM inbox_items WHERE id = ?').get(res.lastInsertRowid) as InboxItem;
}

export function updateInboxStatus(id: number, status: string, db?: Database.Database): void {
  resolveDb(db).prepare('UPDATE inbox_items SET status = ? WHERE id = ?').run(status, id);
}

// ── Document templates + documents ───────────────────────────────────

export function listDocumentTemplates(businessId: string | null, db?: Database.Database): DocumentTemplate[] {
  const d = resolveDb(db);
  return d.prepare(
    'SELECT * FROM document_templates WHERE business_id IS ? OR business_id IS NULL ORDER BY name ASC',
  ).all(businessId) as DocumentTemplate[];
}

export function createDocumentTemplate(
  input: {
    business_id: string | null;
    name: string;
    doc_type?: string;
    body_md: string;
    variables?: Array<{ key: string; label: string }>;
  },
  db?: Database.Database,
): DocumentTemplate {
  const d = resolveDb(db);
  const res = d.prepare(
    `INSERT INTO document_templates (business_id, name, doc_type, body_md, variables_json)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    input.business_id,
    input.name,
    input.doc_type ?? 'pdf',
    input.body_md,
    JSON.stringify(input.variables ?? []),
  );
  return d.prepare('SELECT * FROM document_templates WHERE id = ?').get(res.lastInsertRowid) as DocumentTemplate;
}

export function saveRenderedDocument(
  input: { business_id: string | null; template_id: number | null; title: string; content_md: string },
  db?: Database.Database,
): DocumentRow {
  const d = resolveDb(db);
  const res = d.prepare(
    'INSERT INTO documents (business_id, template_id, title, content_md) VALUES (?, ?, ?, ?)',
  ).run(input.business_id, input.template_id, input.title, input.content_md);
  return d.prepare('SELECT * FROM documents WHERE id = ?').get(res.lastInsertRowid) as DocumentRow;
}
