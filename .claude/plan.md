# Self-Healing Watchdog — Production Implementation Plan

## Problem Statement

The ClaudeClaw system suffers from recurring unresponsiveness where the process is technically alive (HTTP server responds, PID exists, launchd thinks it's healthy) but the bot is functionally brain-dead — returning empty responses, "Done.", or silently dropping Telegram messages. launchd only restarts on crashes (exit code != 0), so it can't detect or recover from these zombie states. The user has had to manually diagnose and restart the system multiple times.

## Design Principles

1. **Zero API cost** — Pure bash + SQLite + HTTP health checks. No LLM calls.
2. **External to the bot process** — The watchdog runs as a separate launchd service so it can monitor and restart the bot even when the bot's event loop is deadlocked.
3. **Layered health checks** — From cheap/fast (is the process alive?) to deep (is it actually processing messages?).
4. **Conservative recovery** — Escalating interventions: session clear → process restart → full service reload. Never jump to the nuclear option.
5. **Observable** — Logs everything to a dedicated log file. Sends Telegram alerts on interventions (using direct curl, not through the bot).
6. **Idempotent** — Safe to run on any interval. Multiple runs in quick succession don't cause harm.

## Architecture

```
┌─────────────────────────────────────────────┐
│  launchd: com.claudeclaw.watchdog           │
│  Runs: every 2 minutes (StartInterval: 120) │
│  Script: scripts/watchdog.sh                │
└─────────┬───────────────────────────────────┘
          │
          ▼
  ┌───────────────────┐
  │ Layer 1: Process   │  Is the PID alive? Is port 3141 responding?
  │ Liveness           │  Cost: ~0ms (kill -0, curl)
  └───────┬───────────┘
          │ PASS
          ▼
  ┌───────────────────┐
  │ Layer 2: HTTP      │  Does /api/health return 200 with valid JSON?
  │ Health             │  Is telegramConnected = true?
  └───────┬───────────┘
          │ PASS
          ▼
  ┌───────────────────┐
  │ Layer 3: Heartbeat │  Has the bot processed a message in the last N minutes?
  │ Freshness          │  (Query conversation_log for recent activity)
  └───────┬───────────┘
          │ PASS
          ▼
  ┌───────────────────┐
  │ Layer 4: Stuck     │  Is the processing flag stuck on for > 10 minutes?
  │ Processing         │  (Query /api/health or state directly)
  └───────────────────┘
```

## Health Check Layers (Detail)

### Layer 1: Process Liveness
- Read PID from `store/claudeclaw.pid`
- `kill -0 $PID` — is the process alive?
- `curl -sf -o /dev/null -w '%{http_code}' --max-time 5 http://localhost:3141/` — does the HTTP server respond?
- **Failure action**: If PID is dead AND port is unresponsive, log it and let launchd handle the restart (it should already be restarting). If launchd hasn't restarted after 30s, force-load the plist.

### Layer 2: HTTP Health
- `curl -sf --max-time 5 "http://localhost:${PORT}/api/health?token=${TOKEN}&chatId=${CHAT_ID}"` — returns JSON
- Parse `telegramConnected` field — must be `true`
- **Failure action**: If HTTP responds but `telegramConnected` is false, the bot started but grammY polling failed. Send SIGTERM to trigger a clean restart.

### Layer 3: Heartbeat Freshness
- Query SQLite: `SELECT MAX(created_at) FROM conversation_log WHERE agent_id='main'`
- Compare to current time. If no message in the last 30 minutes during waking hours (8am-midnight), flag as potentially stale.
- **Important**: This is an advisory check, not an automatic action. Some quiet periods are normal (user is sleeping, away, etc.). We only act on this if COMBINED with other signals (e.g., Layer 2 shows telegramConnected=true but Layer 3 shows no activity for 2+ hours AND there are pending messages).
- This layer is intentionally conservative — it logs a warning but does NOT auto-restart by itself.

### Layer 4: Stuck Processing Detection
- Query `/api/health` or directly check the DB: is `processing = true` for longer than 10 minutes?
- Alternative: check `token_usage` for the current session — if the last entry is > 15 min old but `processing` was never cleared, the agent call is hung.
- **Failure action**: Abort the stuck query by sending a request to `/api/chat/abort`, wait 10s. If still stuck, SIGTERM the process.

## Recovery Actions (Escalation Ladder)

Each action is only taken if the previous level failed to resolve:

| Level | Action | When | Method |
|-------|--------|------|--------|
| 0 | Log only | Any warning-level signal | Append to watchdog log |
| 1 | Abort stuck query | Processing stuck > 10 min | `curl POST /api/chat/abort` |
| 2 | Clear stale session | Session has 2+ compactions or is > 24h old with no recent activity | `sqlite3 DELETE FROM sessions WHERE ...` |
| 3 | Graceful restart | telegramConnected=false, or HTTP unresponsive but PID alive | `kill -TERM $PID` (launchd restarts it) |
| 4 | Force restart | Process survived SIGTERM for > 15s | `kill -9 $PID` |
| 5 | Plist reload | No process at all and launchd hasn't restarted | `launchctl kickstart -k gui/$(id -u)/com.claudeclaw.app` |

## Cooldown & Circuit Breaker

- **Cooldown file**: `/tmp/claudeclaw-watchdog-last-action` stores the timestamp of the last intervention
- **Minimum 5 minutes between restarts** — prevents restart loops
- **Max 5 restarts per hour** — tracked in a simple counter file `/tmp/claudeclaw-watchdog-restarts`
- If the circuit breaker trips (5 restarts in an hour), the watchdog sends a Telegram alert: "Watchdog circuit breaker tripped — bot has restarted 5 times in the last hour. Manual investigation required." and stops intervening until the counter resets.

## Implementation: Single Bash Script

### File: `scripts/watchdog.sh`

A single, self-contained bash script (~150 lines). No Node.js, no npm, no dependencies beyond curl, sqlite3, and standard Unix tools (all pre-installed on macOS).

**Why bash, not Node?**
- Zero startup overhead (Node takes 200-500ms to start, bash is instant)
- Can't be affected by the same Node.js event loop issues that might be killing the bot
- Works even if `node_modules` is corrupted or Node is broken
- sqlite3 CLI is always available on macOS
- curl is always available
- Truly zero cost — no API calls, no LLM, no external services

### File: `launchd/com.claudeclaw.watchdog.plist`

A launchd plist that runs the watchdog on a fixed interval:

```xml
<key>Label</key><string>com.claudeclaw.watchdog</string>
<key>ProgramArguments</key>
<array>
  <string>/bin/bash</string>
  <string>__PROJECT_DIR__/scripts/watchdog.sh</string>
</array>
<key>StartInterval</key><integer>120</integer>   <!-- Every 2 minutes -->
<key>WorkingDirectory</key><string>__PROJECT_DIR__</string>
<key>StandardOutPath</key><string>/tmp/claudeclaw-watchdog.log</string>
<key>StandardErrorPath</key><string>/tmp/claudeclaw-watchdog.log</string>
<key>RunAtLoad</key><true/>
<key>EnvironmentVariables</key>
<dict>
  <key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin</string>
  <key>HOME</key><string>__HOME__</string>
</dict>
```

Key design choices:
- `StartInterval: 120` (every 2 minutes) — frequent enough to catch issues quickly, infrequent enough to be invisible
- Log path in `/tmp/` — compliant with the launchd spaces-in-paths rule
- No `KeepAlive` — this is a periodic job, not a daemon. launchd fires it on schedule and it exits.
- Separate from the main bot process — can't be killed by the same issue that kills the bot

## Sub-Agent Monitoring

The watchdog also checks sub-agents (comms, research, etc.):
- Reads `store/agent-*.pid` files
- For each, does `kill -0 $PID`
- If a sub-agent's PID is dead but its plist exists in `~/Library/LaunchAgents/`, logs a warning (launchd should restart it)
- If the sub-agent has been dead for > 5 minutes (PID file mtime), sends a Telegram alert

## Telegram Alerting

The watchdog sends alerts directly via curl (not through the bot, which might be the thing that's broken):

```bash
curl -sf -X POST "https://api.telegram.org/bot${TOKEN}/sendMessage" \
  -d chat_id="${CHAT_ID}" \
  -d text="${MESSAGE}" \
  -d parse_mode="HTML"
```

Alert levels:
- **Info** (no alert): Routine health checks passing
- **Warning** (Telegram): Session cleared, stuck query aborted
- **Critical** (Telegram): Process restarted, circuit breaker tripped

## Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `scripts/watchdog.sh` | **CREATE** | The main watchdog bash script (~150 lines) |
| `launchd/com.claudeclaw.watchdog.plist` | **CREATE** | launchd plist for periodic execution |
| `scripts/install-launchd.sh` | **MODIFY** | Add watchdog plist to the install script |

No TypeScript changes. No changes to the bot itself. The watchdog is 100% external.

## Testing Plan

1. **Unit test each layer**: Run the script manually and verify each health check layer works:
   - Kill the bot, confirm Layer 1 detects it
   - Start bot without Telegram token, confirm Layer 2 catches telegramConnected=false
   - Set processing flag, confirm Layer 4 detects stuck state
2. **Circuit breaker test**: Simulate 5 rapid restarts, confirm the breaker trips and sends alert
3. **Cooldown test**: Trigger a restart, run watchdog again within 5 min, confirm it skips
4. **Sub-agent test**: Kill comms agent PID, confirm watchdog detects and alerts
5. **Production verification**: Install the plist, watch `/tmp/claudeclaw-watchdog.log` for 10 minutes, confirm clean passes every 2 minutes
