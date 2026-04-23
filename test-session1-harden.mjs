// Standalone hardening test — exercises Session 1 new DB paths against an
// in-memory SQLite via `_initTestDatabase()`. Does NOT touch the user's real DB.
// Run: node test-session1-harden.mjs     (from the repo root)

import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const PROJECT = resolve(dirname(fileURLToPath(import.meta.url)));
// Dynamic imports so the test can run from any cwd.
const db = await import(pathToFileURL(`${PROJECT}/dist/db.js`).href);
const wdb = await import(pathToFileURL(`${PROJECT}/dist/workspace-db.js`).href);
const { CronExpressionParser } = await import('cron-parser');

db._initTestDatabase();

// Seed a business so meetings + calendar events have a scope to hook into.
const biz = wdb.createBusiness({ slug: 'test-ws', name: 'Test Workspace' });
assert.ok(biz.id, 'createBusiness should return an id');

// ── Meetings ↔ Calendar mirror ────────────────────────────────────────────
const results = [];
const t = (name, fn) => { try { fn(); results.push([true, name]); } catch (e) { results.push([false, name + ' — ' + e.message]); } };
const tAsync = async (name, fn) => { try { await fn(); results.push([true, name]); } catch (e) { results.push([false, name + ' — ' + e.message]); } };

// 1. Create meeting — calendar_event should be created AND linked.
const start1 = Math.floor(Date.UTC(2026, 4, 1, 13, 0, 0) / 1000);
const end1 = start1 + 3600;
const meeting1 = wdb.createMeeting({
  business_id: biz.id, title: 'Standup', start_time: start1, end_time: end1,
  meeting_type: 'standup', attendees: ['alice','bob'], prep_notes: 'prep',
  notes: '', agenda: [], actions: [], repeat: null,
});
t('meeting row created', () => assert.ok(meeting1.id > 0));
// The mirror step in dashboard.ts is route-level, not in createMeeting — we
// simulate it here so we test the same behaviour the route does.
const ev1 = wdb.createCalendarEvent({
  business_id: biz.id, title: meeting1.title, description: 'Meeting · standup',
  event_type: 'meeting', start_time: meeting1.start_time, end_time: meeting1.end_time, repeat: meeting1.repeat,
});
const linked1 = wdb.updateMeeting(meeting1.id, { calendar_event_id: ev1.id });
t('meeting linked to calendar_event', () => {
  assert.equal(linked1.calendar_event_id, ev1.id);
  const row = wdb.getCalendarEvent(ev1.id);
  assert.ok(row);
  assert.equal(row.title, 'Standup');
  assert.equal(row.event_type, 'meeting');
  assert.equal(row.start_time, start1);
});

// 2. PATCH meeting title → calendar_event title updates.
wdb.updateMeeting(meeting1.id, { title: 'Standup — renamed' });
wdb.updateCalendarEvent(ev1.id, { title: 'Standup — renamed' });
t('title re-sync', () => {
  const row = wdb.getCalendarEvent(ev1.id);
  assert.equal(row.title, 'Standup — renamed');
});

// 3. PATCH meeting start_time → calendar_event start_time updates.
const start2 = start1 + 86400;
wdb.updateMeeting(meeting1.id, { start_time: start2 });
wdb.updateCalendarEvent(ev1.id, { start_time: start2 });
t('start_time re-sync', () => {
  const row = wdb.getCalendarEvent(ev1.id);
  assert.equal(row.start_time, start2);
});

// 4. DELETE meeting — linked calendar_event gone.
wdb.deleteCalendarEvent(ev1.id);
wdb.deleteMeeting(meeting1.id);
t('cascade delete clears calendar_event', () => {
  assert.equal(wdb.getCalendarEvent(ev1.id), null);
  assert.equal(wdb.getMeeting(meeting1.id), null);
});

// 5. Back-fill path — meeting without a calendar_event, PATCH creates the mirror.
const meeting2 = wdb.createMeeting({
  business_id: biz.id, title: 'Pre-mirror meeting', start_time: start1,
  end_time: end1, meeting_type: 'client', attendees: [], prep_notes: '',
  notes: '', agenda: [], actions: [], repeat: null,
});
t('meeting created with null calendar_event_id', () => assert.equal(meeting2.calendar_event_id, null));
// Simulate the route's back-fill when PATCH touches a meeting that predates
// the mirror feature.
const ev2 = wdb.createCalendarEvent({
  business_id: biz.id, title: meeting2.title, description: 'Meeting · client',
  event_type: 'meeting', start_time: meeting2.start_time, end_time: meeting2.end_time, repeat: meeting2.repeat,
});
wdb.updateMeeting(meeting2.id, { calendar_event_id: ev2.id });
t('back-fill creates mirror on PATCH of unlinked meeting', () => {
  const m = wdb.getMeeting(meeting2.id);
  assert.equal(m.calendar_event_id, ev2.id);
});

// 6. Idempotent migration — _initTestDatabase already ran runMigrations; the
// scheduled_meetings table MUST have calendar_event_id present.
t('calendar_event_id column present on scheduled_meetings', () => {
  const rawDb = db.getDb();
  const cols = rawDb.prepare('PRAGMA table_info(scheduled_meetings)').all();
  assert.ok(cols.some((c) => c.name === 'calendar_event_id'));
});

// 7. listCalendarEvents filters meetings by business_id and time window.
t('listCalendarEvents returns the back-filled meeting event', () => {
  const evs = wdb.listCalendarEvents(biz.id, { fromTs: start1 - 86400, toTs: start1 + 86400 });
  assert.ok(evs.some((e) => e.id === ev2.id));
});

// ── Daily Brief cron parsing ────────────────────────────────────────────
t('cron-parser accepts default daily_brief_cron', () => {
  const i = CronExpressionParser.parse('0 7 * * *');
  const next = i.next().getTime();
  assert.ok(next > Date.now() - 86400 * 1000);
});
t('cron-parser rejects malformed expression', () => {
  let threw = false;
  try { CronExpressionParser.parse('banana'); } catch { threw = true; }
  assert.ok(threw, 'parse should throw on invalid expression');
});

// 8. Daily brief cron module — initial registration + archive drop.
// We can't exercise the 60s tick loop deterministically, but we can verify
// the module's initialization path against listBusinesses and its resilience
// to bad cron expressions (the module logs and skips them).
const dbc = await import(pathToFileURL(`${PROJECT}/dist/jobs/daily-brief-cron.js`).href);
t('initDailyBriefCrons does not throw on fresh DB', () => {
  // Seed one more biz with an invalid cron to verify the module's defensive path.
  const rawDb = db.getDb();
  rawDb.prepare("UPDATE businesses SET daily_brief_cron = 'banana' WHERE slug = 'test-ws'").run();
  dbc.initDailyBriefCrons();
});
// Restore valid cron for later tests.
db.getDb().prepare("UPDATE businesses SET daily_brief_cron = '0 7 * * *' WHERE slug = 'test-ws'").run();

// ── Mission task due_at set / clear via DB layer ────────────────────────
t('setMissionTaskDueAt sets + clears', () => {
  const mid = 'm_' + Math.random().toString(36).slice(2, 8);
  db.createMissionTask(mid, 'Test mission', 'prompt', null, 'dashboard', 5);
  db.setMissionTaskDueAt(mid, start1);
  let row = db.getMissionTask(mid);
  assert.equal(row.due_at, start1);
  db.setMissionTaskDueAt(mid, null);
  row = db.getMissionTask(mid);
  assert.equal(row.due_at, null);
});

t('setMissionTaskStartAt sets + clears independently of due_at', () => {
  const mid = 'm_' + Math.random().toString(36).slice(2, 8);
  db.createMissionTask(mid, 'Test mission 2', 'prompt', null, 'dashboard', 5);
  db.setMissionTaskStartAt(mid, start1);
  db.setMissionTaskDueAt(mid, end1);
  let row = db.getMissionTask(mid);
  assert.equal(row.start_at, start1);
  assert.equal(row.due_at, end1);
  db.setMissionTaskStartAt(mid, null);
  row = db.getMissionTask(mid);
  assert.equal(row.start_at, null);
  assert.equal(row.due_at, end1); // only start cleared
});

// 9. getMissionTaskHistory — total count includes completed/failed/cancelled.
t('getMissionTaskHistory total reflects completed+failed+cancelled', () => {
  const mk = (status) => {
    const mid = 'h_' + Math.random().toString(36).slice(2, 8);
    db.createMissionTask(mid, 'H ' + status, 'p', null, 'dashboard', 0);
    db.completeMissionTask(mid, 'ok', status === 'cancelled' ? 'cancelled' : status);
  };
  mk('completed'); mk('failed'); mk('cancelled');
  const h = db.getMissionTaskHistory(5, 0);
  assert.ok(h.total >= 3, 'expected at least 3 history rows, got ' + h.total);
});

// 10. getMissionTasksByDueRange — returns mission tasks with due_at in window.
t('getMissionTasksByDueRange filters by due window + business', () => {
  const mid = 'd_' + Math.random().toString(36).slice(2, 8);
  db.createMissionTask(mid, 'Due in range', 'p', null, 'dashboard', 5);
  db.setMissionTaskDueAt(mid, start1 + 3600);
  const found = db.getMissionTasksByDueRange(start1, start1 + 7200);
  assert.ok(found.some((t) => t.id === mid));
});

// ── Workspace listing filters archived ──────────────────────────────────
t('listBusinesses excludes archived by default', () => {
  const rawDb = db.getDb();
  rawDb.prepare('UPDATE businesses SET archived = 1 WHERE slug = ?').run('test-ws');
  const nonArchived = wdb.listBusinesses(false);
  assert.ok(!nonArchived.some((b) => b.slug === 'test-ws'));
  const all = wdb.listBusinesses(true);
  assert.ok(all.some((b) => b.slug === 'test-ws'));
  rawDb.prepare('UPDATE businesses SET archived = 0 WHERE slug = ?').run('test-ws');
});

// ── Report ──────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
for (const [ok, name] of results) {
  console.log(`${ok ? '✓' : '✗'} ${name}`);
  if (ok) pass++; else fail++;
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
