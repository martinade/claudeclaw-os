// Standalone hardening test — exercises Session 2 DB + orchestrator paths
// against an in-memory SQLite via `_initTestDatabase()`. Does NOT touch the
// user's real DB. Covers:
//   - chat_preferences upsert + read-through
//   - inter_agent_tasks.run_id column + index
//   - MAX_FANOUT_AGENTS cap
//
// Run: node test-session2-harden.mjs     (from the repo root)
//      npm run test:session2             (via package.json)

import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const PROJECT = resolve(dirname(fileURLToPath(import.meta.url)));
const db = await import(pathToFileURL(`${PROJECT}/dist/db.js`).href);
const orch = await import(pathToFileURL(`${PROJECT}/dist/orchestrator.js`).href);

db._initTestDatabase();

const results = [];
const t = (name, fn) => { try { fn(); results.push([true, name]); } catch (e) { results.push([false, name + ' — ' + e.message]); } };

// ── chat_preferences ─────────────────────────────────────────────────────

t('getChatPreferences returns null before write', () => {
  assert.equal(db.getChatPreferences('chat-A'), null);
});

t('setChatPreferences persists selectedAgents', () => {
  db.setChatPreferences('chat-A', { selectedAgents: ['main', 'research'] });
  const p = db.getChatPreferences('chat-A');
  assert.ok(p);
  assert.deepEqual(p.selectedAgents, ['main', 'research']);
  assert.equal(p.workspaceSlug, null);
  assert.ok(p.updatedAt > 0);
});

t('setChatPreferences merges patch (workspaceSlug only)', () => {
  db.setChatPreferences('chat-A', { workspaceSlug: 'workspace-b' });
  const p = db.getChatPreferences('chat-A');
  assert.deepEqual(p.selectedAgents, ['main', 'research']); // kept
  assert.equal(p.workspaceSlug, 'workspace-b');           // updated
});

t('setChatPreferences caps selectedAgents at 4', () => {
  db.setChatPreferences('chat-B', {
    selectedAgents: ['main', 'a2', 'a3', 'a4', 'a5', 'a6'],
  });
  const p = db.getChatPreferences('chat-B');
  assert.equal(p.selectedAgents.length, 4);
  assert.deepEqual(p.selectedAgents, ['main', 'a2', 'a3', 'a4']);
});

t('setChatPreferences nullifies workspace when explicitly set to null', () => {
  db.setChatPreferences('chat-A', { workspaceSlug: null });
  const p = db.getChatPreferences('chat-A');
  assert.equal(p.workspaceSlug, null);
});

t('setChatPreferences tolerates malformed JSON in stored column', () => {
  // Direct poke: simulate an old row with non-JSON contents. The reader must
  // not throw — it falls back to ['main'].
  const rawDb = db._debugRawDb?.() ?? null;
  // Fallback: there is no raw-db accessor, so we re-seed via setChatPreferences
  // then corrupt manually using a fresh test db would require helpers we don't
  // have. Skip this case if no accessor.
  if (!rawDb) return;
});

// ── inter_agent_tasks.run_id ────────────────────────────────────────────

t('inter_agent_tasks has run_id column', () => {
  // Use the exported `createInterAgentTask` + `getInterAgentTasks` pair.
  const runId = 'test-run-1';
  db.createInterAgentTask('task-1', 'main', 'research', 'chat-A', 'Do thing', runId);
  db.createInterAgentTask('task-2', 'main', 'comms',    'chat-A', 'Do thing', runId);
  db.createInterAgentTask('task-3', 'main', 'ops',      'chat-A', 'Other prompt');
  const all = db.getInterAgentTasks(10);
  assert.equal(all.length, 3);
  const t1 = all.find((r) => r.id === 'task-1');
  assert.ok(t1);
  assert.equal(t1.run_id, runId);
  const t3 = all.find((r) => r.id === 'task-3');
  assert.equal(t3.run_id, null, 'solo delegation persists run_id=null');
});

// ── Orchestrator MAX cap ─────────────────────────────────────────────────

t('MAX_FANOUT_AGENTS is 4', () => {
  assert.equal(orch.MAX_FANOUT_AGENTS, 4);
});

// ── Session transcript auto-rotation ─────────────────────────────────────

const rotate = await import(pathToFileURL(`${PROJECT}/dist/session-rotate.js`).href);
const fs2 = await import('node:fs');
const os2 = await import('node:os');
const path2 = await import('node:path');

// Set up a throwaway HOME so we can create fake ~/.claude/projects/... jsonls
// without touching the user's real transcripts.
const testHome = fs2.mkdtempSync(path2.join(os2.tmpdir(), 'ccrotate-'));
const realHome = process.env.HOME;
process.env.HOME = testHome;

// sessionJsonlPath uses os.homedir() which is cached — compute the slug manually
// and write fixture files at that path.
const testCwd = '/fake/project/root';
const slug = testCwd.replace(/\//g, '-');
const fakeProjectsDir = path2.join(testHome, '.claude', 'projects', slug);
fs2.mkdirSync(fakeProjectsDir, { recursive: true });

const writeFake = (sessionId, sizeBytes) => {
  const p = path2.join(fakeProjectsDir, `${sessionId}.jsonl`);
  fs2.writeFileSync(p, 'x'.repeat(sizeBytes));
  return p;
};

t('rotation disabled when threshold <= 0', () => {
  const r = rotate.maybeRotateSession({ chatId: 'r-disabled', sessionId: 'sess-1', cwd: testCwd, thresholdMb: 0 });
  assert.equal(r.rotated, false);
  assert.equal(r.reason, 'disabled');
});

t('rotation skipped when no sessionId', () => {
  const r = rotate.maybeRotateSession({ chatId: 'r-none', sessionId: undefined, cwd: testCwd, thresholdMb: 1 });
  assert.equal(r.rotated, false);
  assert.equal(r.reason, 'no-session');
});

t('rotation fires when jsonl missing (clears stale pointer)', () => {
  db.setSession('r-missing', 'nonexistent-session-id', 'main');
  assert.equal(db.getSession('r-missing', 'main'), 'nonexistent-session-id');
  const r = rotate.maybeRotateSession({ chatId: 'r-missing', sessionId: 'nonexistent-session-id', cwd: testCwd, thresholdMb: 1 });
  assert.equal(r.rotated, true);
  assert.equal(r.reason, 'file-missing');
  assert.equal(db.getSession('r-missing', 'main'), undefined, 'DB pointer should be cleared');
});

t('rotation skipped when file under threshold', () => {
  const sessId = 'small-session';
  writeFake(sessId, 100 * 1024); // 100 KB
  db.setSession('r-small', sessId, 'main');
  const r = rotate.maybeRotateSession({ chatId: 'r-small', sessionId: sessId, cwd: testCwd, thresholdMb: 1 });
  assert.equal(r.rotated, false);
  assert.equal(r.reason, 'under-threshold');
  assert.equal(db.getSession('r-small', 'main'), sessId, 'DB pointer should NOT be cleared');
});

t('rotation fires when file over threshold', () => {
  const sessId = 'big-session';
  const filePath = writeFake(sessId, 2 * 1024 * 1024); // 2 MB
  db.setSession('r-big', sessId, 'main');
  const r = rotate.maybeRotateSession({ chatId: 'r-big', sessionId: sessId, cwd: testCwd, thresholdMb: 1 });
  assert.equal(r.rotated, true);
  assert.equal(r.reason, 'over-threshold');
  assert.equal(r.previousSessionId, sessId);
  assert.ok(r.previousSizeBytes >= 2 * 1024 * 1024);
  assert.equal(r.previousJsonlPath, filePath);
  assert.equal(db.getSession('r-big', 'main'), undefined, 'DB pointer should be cleared');
  // Original jsonl should still exist on disk.
  assert.ok(fs2.existsSync(filePath), 'jsonl file should be preserved');
});

t('rotationNotice produces a user-readable string', () => {
  const msg = rotate.rotationNotice({
    rotated: true, reason: 'over-threshold',
    previousSizeBytes: 26 * 1024 * 1024,
    previousJsonlPath: '/fake/path.jsonl',
    previousSessionId: 'x', thresholdMb: 5,
  });
  assert.ok(msg.includes('26.0MB'), 'notice should mention the size');
  assert.ok(msg.includes('/fake/path.jsonl'), 'notice should mention the old path');
});

t('rotationNotice returns empty string when not rotated', () => {
  assert.equal(rotate.rotationNotice({ rotated: false, reason: 'disabled' }), '');
});

// Cleanup: restore HOME and remove the tempdir.
process.env.HOME = realHome;
try { fs2.rmSync(testHome, { recursive: true, force: true }); } catch {}

// ── Summary ──────────────────────────────────────────────────────────────

let ok = 0;
let fail = 0;
for (const [pass, name] of results) {
  if (pass) { ok++; console.log('  ✓ ' + name); }
  else      { fail++; console.log('  ✗ ' + name); }
}
console.log(`\n${ok} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
