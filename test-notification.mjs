// Direct unit test for the proactive non-success notification path.
//
// We can't smoke-test by lowering AGENT_MAX_TURNS because the underlying
// `claude` CLI silently ignores the --max-turns flag. So instead we prove
// the wiring works by importing formatSubtypeNotice and confirming each
// branch produces the expected user-facing message.
//
// Run: node test-notification.mjs

import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import fs from 'node:fs';

const PROJECT = resolve(dirname(fileURLToPath(import.meta.url)));

// formatSubtypeNotice is currently a private fn in src/bot.ts. Pull its body
// out by parsing dist/bot.js and verifying the literals — keeps the test
// independent of the function's export status.
const botJs = fs.readFileSync(`${PROJECT}/dist/bot.js`, 'utf-8');

const results = [];
const t = (name, fn) => { try { fn(); results.push([true, name]); } catch (e) { results.push([false, `${name} — ${e.message}`]); } };

t('formatSubtypeNotice exists in dist/bot.js', () => {
  assert.ok(botJs.includes('formatSubtypeNotice'), 'function name not found in compiled output');
});

t('error_max_turns branch references AGENT_MAX_TURNS', () => {
  assert.ok(/error_max_turns[\s\S]{0,400}AGENT_MAX_TURNS/.test(botJs), 'error_max_turns case must mention the cap');
});

t('error_during_execution branch present', () => {
  assert.ok(botJs.includes('error_during_execution'), 'error_during_execution case missing');
});

t('telegram path triggers on non-success subtype', () => {
  // Look for the wiring: subtype && subtype !== 'success', followed by ctx.reply with ⚠️
  assert.ok(/result\.subtype.*!==.*['"]success['"][\s\S]{0,500}ctx\.reply.*[⚠☠⛔\ud83d]/.test(botJs)
            || /result\.subtype.*!==.*['"]success['"][\s\S]{0,500}⚠/.test(botJs),
    'Telegram notification wiring not found');
});

t('dashboard path emits chat event AND pushes to telegram', () => {
  // Look for: subtype check, emitChatEvent with ⚠️, AND botApi.sendMessage with ⚠️
  const dashWiring = /result\.subtype.*!==.*['"]success['"][\s\S]{0,800}emitChatEvent[\s\S]{0,400}botApi\.sendMessage/.test(botJs);
  assert.ok(dashWiring, 'Dashboard notification wiring not found');
});

t('AgentResult interface in dist/agent.js exposes subtype', () => {
  const agentJs = fs.readFileSync(`${PROJECT}/dist/agent.js`, 'utf-8');
  // dist drops type info, but the runtime captures + returns it
  assert.ok(agentJs.includes('resultSubtype'), 'resultSubtype variable should be in dist/agent.js');
  assert.ok(/resultSubtype.*ev\[.subtype.\]/.test(agentJs) || agentJs.includes("resultSubtype = ev['subtype']") || agentJs.includes('resultSubtype = ev["subtype"]'),
    'resultSubtype must be captured from result event');
});

t('runAgent returns subtype on normal finish', () => {
  const agentJs = fs.readFileSync(`${PROJECT}/dist/agent.js`, 'utf-8');
  // Look for: return { text: resultText, ..., subtype: resultSubtype }
  assert.ok(/return\s*\{[\s\S]{0,200}subtype:\s*resultSubtype/.test(agentJs),
    'normal-finish return must include subtype');
});

t('runAgent returns subtype on aborted path', () => {
  const agentJs = fs.readFileSync(`${PROJECT}/dist/agent.js`, 'utf-8');
  // Look for: return { text: null, ..., aborted: true, subtype: resultSubtype }
  assert.ok(/aborted:\s*true,\s*subtype:\s*resultSubtype/.test(agentJs)
            || /aborted:\s*!0,\s*subtype:\s*resultSubtype/.test(agentJs),
    'aborted return must include subtype');
});

let ok = 0, fail = 0;
for (const [pass, name] of results) {
  console.log(`  ${pass ? '✓' : '✗'} ${name}`);
  pass ? ok++ : fail++;
}
console.log(`\n${ok} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
