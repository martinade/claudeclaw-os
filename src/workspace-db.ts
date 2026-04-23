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
  importance: string | null;
  category: string | null;
  title: string | null;
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
  template_key: string | null;
  type: string | null;
  title: string;
  content_md: string;
  status: string;
  variables_json: string;
  created_at: number;
  updated_at: number;
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
  opts: { status?: string; importance?: string; category?: string; source_type?: string; query?: string; limit?: number } = {},
  db?: Database.Database,
): InboxItem[] {
  const d = resolveDb(db);
  const limit = Math.max(1, Math.min(500, opts.limit ?? 200));
  const where: string[] = ['business_id IS ?'];
  const params: unknown[] = [businessId];
  if (opts.status) { where.push('status = ?'); params.push(opts.status); }
  if (opts.importance) { where.push('importance = ?'); params.push(opts.importance); }
  if (opts.category) { where.push('category = ?'); params.push(opts.category); }
  if (opts.source_type) { where.push('source_type = ?'); params.push(opts.source_type); }
  if (opts.query) {
    where.push('(title LIKE ? OR summary LIKE ? OR raw_text LIKE ?)');
    const q = '%' + opts.query.replace(/[%_]/g, '\\$&') + '%';
    params.push(q, q, q);
  }
  const sql = `SELECT * FROM inbox_items WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ${limit}`;
  return d.prepare(sql).all(...params) as InboxItem[];
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
    importance?: string | null;
    category?: string | null;
    title?: string | null;
  },
  db?: Database.Database,
): InboxItem {
  const d = resolveDb(db);
  const res = d.prepare(
    `INSERT INTO inbox_items
     (business_id, source_type, source_url, raw_text, summary, action_items_json, tags_json, status, importance, category, title)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'unread', ?, ?, ?)`,
  ).run(
    input.business_id,
    input.source_type ?? 'text',
    input.source_url ?? '',
    input.raw_text,
    input.summary ?? '',
    JSON.stringify(input.action_items ?? []),
    JSON.stringify(input.tags ?? []),
    input.importance ?? null,
    input.category ?? null,
    input.title ?? null,
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
  const now = Math.floor(Date.now() / 1000);
  const res = d.prepare(
    `INSERT INTO documents (business_id, template_id, title, content_md, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(input.business_id, input.template_id, input.title, input.content_md, now);
  return d.prepare('SELECT * FROM documents WHERE id = ?').get(res.lastInsertRowid) as DocumentRow;
}

// ── Full document CRUD (Phase 2) ────────────────────────────────────

export interface DocumentCreateInput {
  business_id: string | null;
  title: string;
  content_md: string;
  type?: string | null;
  status?: string;
  template_id?: number | null;
  template_key?: string | null;
  variables?: Record<string, string> | null;
}

export interface DocumentUpdateInput {
  title?: string;
  content_md?: string;
  type?: string | null;
  status?: string;
  template_id?: number | null;
  template_key?: string | null;
  variables?: Record<string, string> | null;
  business_id?: string | null;
}

export function listDocuments(
  businessId: string | null,
  opts: { type?: string; status?: string; limit?: number } = {},
  db?: Database.Database,
): DocumentRow[] {
  const d = resolveDb(db);
  const where: string[] = ['business_id IS ?'];
  const params: unknown[] = [businessId];
  if (opts.type) { where.push('type = ?'); params.push(opts.type); }
  if (opts.status) { where.push('status = ?'); params.push(opts.status); }
  const limit = Math.max(1, Math.min(500, opts.limit ?? 100));
  const sql = `SELECT * FROM documents WHERE ${where.join(' AND ')} ORDER BY updated_at DESC LIMIT ${limit}`;
  return d.prepare(sql).all(...params) as DocumentRow[];
}

export function getDocument(id: number, db?: Database.Database): DocumentRow | null {
  const d = resolveDb(db);
  return (d.prepare('SELECT * FROM documents WHERE id = ?').get(id) as DocumentRow | undefined) ?? null;
}

export function createDocument(input: DocumentCreateInput, db?: Database.Database): DocumentRow {
  const d = resolveDb(db);
  const now = Math.floor(Date.now() / 1000);
  const res = d.prepare(
    `INSERT INTO documents (business_id, template_id, template_key, type, title, content_md, status, variables_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.business_id,
    input.template_id ?? null,
    input.template_key ?? null,
    input.type ?? null,
    input.title,
    input.content_md,
    input.status ?? 'draft',
    JSON.stringify(input.variables ?? {}),
    now,
    now,
  );
  return getDocument(Number(res.lastInsertRowid), d)!;
}

export function updateDocument(id: number, patch: DocumentUpdateInput, db?: Database.Database): DocumentRow | null {
  const d = resolveDb(db);
  const existing = getDocument(id, d);
  if (!existing) return null;
  const cols: string[] = [];
  const values: unknown[] = [];
  const map: Array<[keyof DocumentUpdateInput, string, (v: unknown) => unknown]> = [
    ['title',         'title',          (v) => v],
    ['content_md',    'content_md',     (v) => v],
    ['type',          'type',           (v) => v],
    ['status',        'status',         (v) => v],
    ['template_id',   'template_id',    (v) => v],
    ['template_key',  'template_key',   (v) => v],
    ['business_id',   'business_id',    (v) => v],
    ['variables',     'variables_json', (v) => JSON.stringify(v ?? {})],
  ];
  for (const [key, col, xform] of map) {
    if (patch[key] !== undefined) { cols.push(`${col} = ?`); values.push(xform(patch[key])); }
  }
  if (cols.length === 0) return existing;
  const now = Math.floor(Date.now() / 1000);
  cols.push('updated_at = ?');
  values.push(now);
  d.prepare(`UPDATE documents SET ${cols.join(', ')} WHERE id = ?`).run(...values, id);
  return getDocument(id, d);
}

export function deleteDocument(id: number, db?: Database.Database): void {
  resolveDb(db).prepare('DELETE FROM documents WHERE id = ?').run(id);
}

export function countDocuments(businessId: string | null, db?: Database.Database): number {
  const d = resolveDb(db);
  const row = d.prepare('SELECT COUNT(*) AS n FROM documents WHERE business_id IS ?').get(businessId) as { n: number };
  return row.n;
}

// ── Calendar events (Phase 4a) ──────────────────────────────────────

export type CalendarEventType =
  | 'appointment'
  | 'deadline'
  | 'task'
  | 'meeting'
  | 'recurring';

export interface CalendarEventRow {
  id: number;
  business_id: string | null;
  title: string;
  description: string;
  event_type: string;
  start_time: number;
  end_time: number | null;
  repeat: string | null;
  created_at: number;
  updated_at: number;
}

export interface CalendarEventInput {
  business_id: string | null;
  title: string;
  description?: string;
  event_type?: CalendarEventType;
  start_time: number;
  end_time?: number | null;
  repeat?: string | null;
}

export function listCalendarEvents(
  businessId: string | null,
  range: { fromTs: number; toTs: number },
  opts: { includeGlobal?: boolean } = {},
  db?: Database.Database,
): CalendarEventRow[] {
  const d = resolveDb(db);
  const includeGlobal = opts.includeGlobal ?? true;
  const sql = businessId === null || !includeGlobal
    ? 'SELECT * FROM calendar_events WHERE business_id IS ? AND start_time >= ? AND start_time < ? ORDER BY start_time ASC'
    : 'SELECT * FROM calendar_events WHERE (business_id = ? OR business_id IS NULL) AND start_time >= ? AND start_time < ? ORDER BY start_time ASC';
  return d.prepare(sql).all(businessId, range.fromTs, range.toTs) as CalendarEventRow[];
}

export function getCalendarEvent(id: number, db?: Database.Database): CalendarEventRow | null {
  const d = resolveDb(db);
  return (d.prepare('SELECT * FROM calendar_events WHERE id = ?').get(id) as CalendarEventRow | undefined) ?? null;
}

export function createCalendarEvent(input: CalendarEventInput, db?: Database.Database): CalendarEventRow {
  const d = resolveDb(db);
  const now = Math.floor(Date.now() / 1000);
  const res = d.prepare(
    `INSERT INTO calendar_events (business_id, title, description, event_type, start_time, end_time, repeat, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.business_id,
    input.title,
    input.description ?? '',
    input.event_type ?? 'appointment',
    input.start_time,
    input.end_time ?? null,
    input.repeat ?? null,
    now,
    now,
  );
  return getCalendarEvent(Number(res.lastInsertRowid), d)!;
}

export function updateCalendarEvent(
  id: number,
  patch: Partial<Omit<CalendarEventRow, 'id' | 'created_at' | 'updated_at'>>,
  db?: Database.Database,
): CalendarEventRow | null {
  const d = resolveDb(db);
  const cols: string[] = [];
  const values: unknown[] = [];
  const editable = ['title', 'description', 'event_type', 'start_time', 'end_time', 'repeat', 'business_id'] as const;
  for (const k of editable) {
    if (patch[k] !== undefined) { cols.push(`${k} = ?`); values.push(patch[k]); }
  }
  if (cols.length === 0) return getCalendarEvent(id, d);
  const now = Math.floor(Date.now() / 1000);
  cols.push('updated_at = ?');
  values.push(now);
  d.prepare(`UPDATE calendar_events SET ${cols.join(', ')} WHERE id = ?`).run(...values, id);
  return getCalendarEvent(id, d);
}

export function deleteCalendarEvent(id: number, db?: Database.Database): void {
  resolveDb(db).prepare('DELETE FROM calendar_events WHERE id = ?').run(id);
}

// ── Scheduled meetings (Phase 4d) ───────────────────────────────────

export interface ScheduledMeetingRow {
  id: number;
  business_id: string | null;
  title: string;
  start_time: number;
  end_time: number | null;
  meeting_type: string;
  attendees_json: string;
  prep_notes: string;
  notes: string;
  agenda_json: string;
  actions_json: string;
  repeat: string | null;
  archived: number;
  calendar_event_id: number | null;
  created_at: number;
  updated_at: number;
}

export interface MeetingInput {
  business_id: string | null;
  title: string;
  start_time: number;
  end_time?: number | null;
  meeting_type?: string;
  attendees?: string[];
  prep_notes?: string;
  notes?: string;
  agenda?: Array<{ text: string; completed: boolean }>;
  actions?: Array<{ text: string; completed: boolean; push_to_tasks: boolean }>;
  repeat?: string | null;
}

export function listMeetings(
  businessId: string | null,
  opts: { includeArchived?: boolean } = {},
  db?: Database.Database,
): ScheduledMeetingRow[] {
  const d = resolveDb(db);
  const where = opts.includeArchived
    ? 'business_id IS ?'
    : 'business_id IS ? AND archived = 0';
  return d.prepare(
    `SELECT * FROM scheduled_meetings WHERE ${where} ORDER BY start_time ASC`,
  ).all(businessId) as ScheduledMeetingRow[];
}

export function getMeeting(id: number, db?: Database.Database): ScheduledMeetingRow | null {
  const d = resolveDb(db);
  return (d.prepare('SELECT * FROM scheduled_meetings WHERE id = ?').get(id) as ScheduledMeetingRow | undefined) ?? null;
}

export function createMeeting(input: MeetingInput, db?: Database.Database): ScheduledMeetingRow {
  const d = resolveDb(db);
  const now = Math.floor(Date.now() / 1000);
  const res = d.prepare(
    `INSERT INTO scheduled_meetings
     (business_id, title, start_time, end_time, meeting_type, attendees_json, prep_notes, notes, agenda_json, actions_json, repeat, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.business_id,
    input.title,
    input.start_time,
    input.end_time ?? null,
    input.meeting_type ?? 'standup',
    JSON.stringify(input.attendees ?? []),
    input.prep_notes ?? '',
    input.notes ?? '',
    JSON.stringify(input.agenda ?? []),
    JSON.stringify(input.actions ?? []),
    input.repeat ?? null,
    now,
    now,
  );
  return getMeeting(Number(res.lastInsertRowid), d)!;
}

export function updateMeeting(
  id: number,
  patch: {
    title?: string;
    start_time?: number;
    end_time?: number | null;
    meeting_type?: string;
    attendees?: string[];
    prep_notes?: string;
    notes?: string;
    agenda?: Array<{ text: string; completed: boolean }>;
    actions?: Array<{ text: string; completed: boolean; push_to_tasks: boolean }>;
    repeat?: string | null;
    archived?: number;
    business_id?: string | null;
    calendar_event_id?: number | null;
  },
  db?: Database.Database,
): ScheduledMeetingRow | null {
  const d = resolveDb(db);
  const cols: string[] = [];
  const values: unknown[] = [];
  const xform: Record<string, (v: unknown) => unknown> = {
    attendees: (v) => JSON.stringify(v ?? []),
    agenda: (v) => JSON.stringify(v ?? []),
    actions: (v) => JSON.stringify(v ?? []),
  };
  const colMap: Record<string, string> = {
    attendees: 'attendees_json',
    agenda: 'agenda_json',
    actions: 'actions_json',
  };
  for (const key of Object.keys(patch) as Array<keyof typeof patch>) {
    if (patch[key] === undefined) continue;
    const col = colMap[key as string] ?? (key as string);
    const x = xform[key as string];
    cols.push(`${col} = ?`);
    values.push(x ? x(patch[key]) : patch[key]);
  }
  if (cols.length === 0) return getMeeting(id, d);
  const now = Math.floor(Date.now() / 1000);
  cols.push('updated_at = ?');
  values.push(now);
  d.prepare(`UPDATE scheduled_meetings SET ${cols.join(', ')} WHERE id = ?`).run(...values, id);
  return getMeeting(id, d);
}

export function deleteMeeting(id: number, db?: Database.Database): void {
  resolveDb(db).prepare('DELETE FROM scheduled_meetings WHERE id = ?').run(id);
}
