#!/bin/bash
# ─────────────────────────────────────────────────────────────────
# ClaudeClaw Self-Healing Watchdog
# ─────────────────────────────────────────────────────────────────
# Runs every 2 minutes via launchd (com.claudeclaw.watchdog).
# Pure bash — zero API cost, zero Node dependency.
#
# Health check layers:
#   1. Process liveness  (PID alive + port responding)
#   2. HTTP health       (/api/health returns 200, telegramConnected=true)
#   3. Stuck processing  (processing flag stuck > 10 min)
#   4. Sub-agent checks  (PID files for comms, research, etc.)
#
# Recovery escalation:
#   L1: Abort stuck query   →  POST /api/chat/abort
#   L2: Graceful restart    →  kill -TERM (launchd restarts)
#   L3: Force kill          →  kill -9
#   L4: Plist kickstart     →  launchctl kickstart
#
# Circuit breaker: max 5 restarts/hour, 5 min cooldown between actions.
# ─────────────────────────────────────────────────────────────────

set -euo pipefail

# ── Resolve project root ──
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
STORE_DIR="$PROJECT_DIR/store"
ENV_FILE="$PROJECT_DIR/.env"

# ── Timestamp helper ──
now() { date +%s; }
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1"; }

# ── Load .env ──
if [ ! -f "$ENV_FILE" ]; then
  log "FATAL: .env not found at $ENV_FILE"
  exit 0  # exit 0 so launchd doesn't think we crashed
fi

env_val() { grep -E "^${1}=" "$ENV_FILE" | head -1 | cut -d'=' -f2- | tr -d '"' | tr -d "'"; }

TELEGRAM_TOKEN="$(env_val TELEGRAM_BOT_TOKEN)"
CHAT_ID="$(env_val ALLOWED_CHAT_ID)"
DASH_TOKEN="$(env_val DASHBOARD_TOKEN)"
DASH_PORT="$(env_val DASHBOARD_PORT)"
DASH_PORT="${DASH_PORT:-3141}"

if [ -z "$TELEGRAM_TOKEN" ] || [ -z "$CHAT_ID" ]; then
  log "FATAL: TELEGRAM_BOT_TOKEN or ALLOWED_CHAT_ID not set"
  exit 0
fi

# ── State files ──
COOLDOWN_FILE="/tmp/claudeclaw-watchdog-cooldown"
RESTART_LOG="/tmp/claudeclaw-watchdog-restarts"
STUCK_FILE="/tmp/claudeclaw-watchdog-stuck-since"

# ── Constants ──
COOLDOWN_SEC=300          # 5 minutes between interventions
MAX_RESTARTS_PER_HOUR=5
STUCK_THRESHOLD_SEC=600   # 10 minutes
SIGTERM_WAIT_SEC=15
MAIN_PID_FILE="$STORE_DIR/claudeclaw.pid"
MAIN_PLIST_LABEL="com.claudeclaw.app"

# ── Telegram alert (direct curl, bypasses the bot) ──
alert() {
  local level="$1"  # INFO | WARN | CRIT
  local msg="$2"
  local prefix=""
  case "$level" in
    WARN) prefix="⚠️ <b>Watchdog Warning</b>";;
    CRIT) prefix="🚨 <b>Watchdog Alert</b>";;
    *)    return;;  # INFO = no Telegram alert, log only
  esac
  log "ALERT [$level]: $msg"
  curl -sf -X POST "https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage" \
    -d chat_id="${CHAT_ID}" \
    -d text="${prefix}%0A${msg}" \
    -d parse_mode="HTML" > /dev/null 2>&1 || true
}

# ── Circuit breaker ──
check_circuit_breaker() {
  local now_ts
  now_ts="$(now)"
  local hour_ago=$(( now_ts - 3600 ))

  # Create restart log if missing
  touch "$RESTART_LOG"

  # Prune entries older than 1 hour
  local tmp
  tmp=$(mktemp)
  awk -v cutoff="$hour_ago" '$1 >= cutoff' "$RESTART_LOG" > "$tmp"
  mv "$tmp" "$RESTART_LOG"

  local count
  count=$(wc -l < "$RESTART_LOG" | tr -d ' ')

  if [ "$count" -ge "$MAX_RESTARTS_PER_HOUR" ]; then
    alert "CRIT" "Circuit breaker tripped — ${count} restarts in the last hour. Manual investigation required. Watchdog backing off."
    return 1
  fi
  return 0
}

# ── Cooldown check ──
in_cooldown() {
  if [ ! -f "$COOLDOWN_FILE" ]; then
    return 1  # not in cooldown
  fi
  local last_action
  last_action=$(cat "$COOLDOWN_FILE" 2>/dev/null || echo "0")
  local elapsed=$(( $(now) - last_action ))
  if [ "$elapsed" -lt "$COOLDOWN_SEC" ]; then
    log "In cooldown (${elapsed}s / ${COOLDOWN_SEC}s). Skipping intervention."
    return 0
  fi
  return 1
}

# ── Record an intervention ──
record_intervention() {
  local now_ts
  now_ts="$(now)"
  echo "$now_ts" > "$COOLDOWN_FILE"
  echo "$now_ts" >> "$RESTART_LOG"
}

# ── Read PID from file ──
read_pid() {
  local pidfile="$1"
  if [ ! -f "$pidfile" ]; then
    echo ""
    return
  fi
  local pid
  pid=$(cat "$pidfile" 2>/dev/null | tr -d '[:space:]')
  if [[ "$pid" =~ ^[0-9]+$ ]]; then
    echo "$pid"
  else
    echo ""
  fi
}

# ── Check if PID is alive ──
pid_alive() {
  local pid="$1"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

# ── Graceful restart (SIGTERM, then wait, then SIGKILL) ──
graceful_restart() {
  local pid="$1"
  local reason="$2"

  if in_cooldown; then return; fi
  if ! check_circuit_breaker; then return; fi

  alert "CRIT" "Restarting main bot (PID ${pid}).%0AReason: ${reason}"
  record_intervention

  # SIGTERM first
  if pid_alive "$pid"; then
    log "Sending SIGTERM to $pid"
    kill -TERM "$pid" 2>/dev/null || true

    # Wait for graceful shutdown
    local waited=0
    while [ "$waited" -lt "$SIGTERM_WAIT_SEC" ] && pid_alive "$pid"; do
      sleep 1
      waited=$((waited + 1))
    done

    # Force kill if still alive
    if pid_alive "$pid"; then
      log "Process $pid survived SIGTERM for ${SIGTERM_WAIT_SEC}s, sending SIGKILL"
      kill -9 "$pid" 2>/dev/null || true
      sleep 2
    fi
  fi

  # launchd should auto-restart via KeepAlive.SuccessfulExit=false
  # Verify it comes back within 30s
  sleep 5
  local new_pid
  new_pid="$(read_pid "$MAIN_PID_FILE")"
  if pid_alive "$new_pid" && [ "$new_pid" != "$pid" ]; then
    log "New process started: PID $new_pid"
  else
    log "launchd hasn't restarted yet, attempting kickstart"
    launchctl kickstart -k "gui/$(id -u)/$MAIN_PLIST_LABEL" 2>/dev/null || true
  fi
}

# ── Abort a stuck query ──
abort_stuck_query() {
  local port="$1"
  local token="$2"
  log "Aborting stuck query via /api/chat/abort"
  local resp
  resp=$(curl -sf --max-time 5 -X POST \
    "http://localhost:${port}/api/chat/abort?token=${token}&chatId=${CHAT_ID}" 2>/dev/null || echo "FAIL")
  if [ "$resp" = "FAIL" ]; then
    log "Abort request failed"
    return 1
  fi
  log "Abort response: $resp"
  # Clear stuck tracking
  rm -f "$STUCK_FILE"
  return 0
}


# ═══════════════════════════════════════════════════════════════
# MAIN HEALTH CHECK SEQUENCE
# ═══════════════════════════════════════════════════════════════

log "── Watchdog tick ──"

# ── Layer 1: Process Liveness ──
MAIN_PID="$(read_pid "$MAIN_PID_FILE")"

if [ -z "$MAIN_PID" ]; then
  log "L1: No PID file found at $MAIN_PID_FILE"
  # Check if port is responding (process may have lost its PID file)
  # Use -w to get HTTP code — any response (even 401) means the server is alive
  PORT_CODE=$(curl -s --max-time 5 -o /dev/null -w "%{http_code}" "http://localhost:${DASH_PORT}/" 2>/dev/null || echo "000")
  if [ "$PORT_CODE" != "000" ]; then
    log "L1: Port $DASH_PORT is responding despite no PID file. Process is alive."
  else
    log "L1: No PID file and port unresponsive. launchd should handle restart."
    # Check if launchd knows about the service
    if ! launchctl print "gui/$(id -u)/$MAIN_PLIST_LABEL" &>/dev/null; then
      alert "CRIT" "Main bot service not loaded in launchd. Manual plist load required."
    else
      # Give launchd 30s before intervening
      sleep 5
      MAIN_PID="$(read_pid "$MAIN_PID_FILE")"
      if [ -z "$MAIN_PID" ] || ! pid_alive "$MAIN_PID"; then
        if ! in_cooldown && check_circuit_breaker; then
          alert "CRIT" "Main bot dead and launchd hasn't restarted. Kickstarting."
          record_intervention
          launchctl kickstart -k "gui/$(id -u)/$MAIN_PLIST_LABEL" 2>/dev/null || true
        fi
      fi
    fi
  fi
  # Either way, we can't do deeper checks without a running process
  log "── Watchdog tick complete ──"
  exit 0
fi

if ! pid_alive "$MAIN_PID"; then
  log "L1: PID $MAIN_PID is dead (stale PID file). launchd should restart."
  # Clean up stale PID file
  rm -f "$MAIN_PID_FILE"
  sleep 5
  MAIN_PID="$(read_pid "$MAIN_PID_FILE")"
  if [ -z "$MAIN_PID" ] || ! pid_alive "$MAIN_PID"; then
    if ! in_cooldown && check_circuit_breaker; then
      alert "CRIT" "Main bot PID stale and launchd hasn't restarted. Kickstarting."
      record_intervention
      launchctl kickstart -k "gui/$(id -u)/$MAIN_PLIST_LABEL" 2>/dev/null || true
    fi
  fi
  log "── Watchdog tick complete ──"
  exit 0
fi

log "L1: PID $MAIN_PID alive"

# Quick port check — any HTTP response (even 401) means the server is alive
PORT_CODE=$(curl -s --max-time 5 -o /dev/null -w "%{http_code}" "http://localhost:${DASH_PORT}/" 2>/dev/null || echo "000")
if [ "$PORT_CODE" = "000" ]; then
  log "L1: Port $DASH_PORT not responding despite PID alive. Process may be starting up or hung."
  # Give it one more chance (it might be mid-startup)
  sleep 10
  PORT_CODE=$(curl -s --max-time 5 -o /dev/null -w "%{http_code}" "http://localhost:${DASH_PORT}/" 2>/dev/null || echo "000")
  if [ "$PORT_CODE" = "000" ]; then
    log "L1: Port still unresponsive. Restarting."
    graceful_restart "$MAIN_PID" "HTTP server not responding on port $DASH_PORT"
  fi
  log "── Watchdog tick complete ──"
  exit 0
fi

log "L1: Port $DASH_PORT responding"

# ── Layer 2: HTTP Health ──
HEALTH_JSON=$(curl -sf --max-time 5 \
  "http://localhost:${DASH_PORT}/api/health?token=${DASH_TOKEN}&chatId=${CHAT_ID}" 2>/dev/null || echo "FAIL")

if [ "$HEALTH_JSON" = "FAIL" ]; then
  log "L2: /api/health request failed (HTTP error or timeout)"
  # Port responds but health endpoint doesn't — possible auth issue or partial startup
  log "── Watchdog tick complete ──"
  exit 0
fi

# Parse telegramConnected (lightweight JSON parsing without jq)
TG_CONNECTED=$(echo "$HEALTH_JSON" | grep -o '"telegramConnected":[a-z]*' | cut -d':' -f2)

if [ "$TG_CONNECTED" != "true" ]; then
  log "L2: telegramConnected=$TG_CONNECTED (expected true)"
  # Bot is up but Telegram polling isn't connected — needs restart
  if ! in_cooldown; then
    graceful_restart "$MAIN_PID" "telegramConnected=$TG_CONNECTED — Telegram polling failed"
  fi
  log "── Watchdog tick complete ──"
  exit 0
fi

log "L2: telegramConnected=true, health OK"

# ── Layer 3: Stuck Processing Detection ──
# Check if the bot has been "processing" for too long
# We track this with a local state file rather than querying the API for processing state,
# because the /api/health doesn't expose the processing flag directly.
# Instead, we check the SSE endpoint or use a simpler heuristic:
# query the DB for the last token_usage entry timestamp vs the session's updated_at.

# Check if DB exists and is readable
DB_FILE="$STORE_DIR/claudeclaw.db"
if [ -f "$DB_FILE" ]; then
  # Get the last activity timestamp (most recent token_usage entry for main agent)
  LAST_ACTIVITY=$(sqlite3 "$DB_FILE" \
    "SELECT MAX(created_at) FROM token_usage WHERE agent_id='main';" 2>/dev/null || echo "0")
  LAST_ACTIVITY="${LAST_ACTIVITY:-0}"

  NOW_TS="$(now)"

  if [ "$LAST_ACTIVITY" -gt 0 ]; then
    IDLE_SEC=$(( NOW_TS - LAST_ACTIVITY ))
    log "L3: Last activity ${IDLE_SEC}s ago"

    # Check for stuck processing: if the session has a very recent updated_at but
    # token_usage hasn't logged a new entry in > 10 minutes, something might be hung.
    # We use a two-phase detection: first tick marks "stuck since", second tick acts.
    if [ "$IDLE_SEC" -gt "$STUCK_THRESHOLD_SEC" ]; then
      # Check if the bot thinks it's processing by trying the abort endpoint
      # (it returns { ok: false, reason: "not processing" } if nothing is stuck)
      PROCESSING_CHECK=$(curl -sf --max-time 5 \
        "http://localhost:${DASH_PORT}/api/chat/abort?token=${DASH_TOKEN}&chatId=${CHAT_ID}" \
        -X POST 2>/dev/null || echo "")

      if echo "$PROCESSING_CHECK" | grep -q '"ok":true'; then
        # The bot WAS processing and we just aborted it
        log "L3: Bot was stuck processing for ${IDLE_SEC}s. Aborted successfully."
        alert "WARN" "Aborted stuck query (processing for ${IDLE_SEC}s)."
        rm -f "$STUCK_FILE"
      else
        # Not currently processing, just idle — this is normal
        log "L3: Bot idle for ${IDLE_SEC}s (not stuck, just quiet)"
      fi
    else
      rm -f "$STUCK_FILE"
    fi
  else
    log "L3: No token_usage data yet"
  fi

  # ── Bonus: Session compaction check ──
  # If the current session has 3+ compactions, it's degraded — clear it proactively
  SESSION_ID=$(sqlite3 "$DB_FILE" \
    "SELECT session_id FROM sessions WHERE chat_id='${CHAT_ID}' AND agent_id='main';" 2>/dev/null || echo "")

  if [ -n "$SESSION_ID" ]; then
    COMPACTION_COUNT=$(sqlite3 "$DB_FILE" \
      "SELECT COUNT(*) FROM compaction_events WHERE session_id='${SESSION_ID}';" 2>/dev/null || echo "0")

    if [ "$COMPACTION_COUNT" -ge 3 ]; then
      log "L3: Session $SESSION_ID has $COMPACTION_COUNT compactions — clearing stale session"
      sqlite3 "$DB_FILE" \
        "DELETE FROM sessions WHERE chat_id='${CHAT_ID}' AND agent_id='main';" 2>/dev/null || true
      alert "WARN" "Auto-cleared stale session (${COMPACTION_COUNT} compactions). Next message starts fresh."
    fi
  fi
else
  log "L3: Database not found at $DB_FILE — skipping DB checks"
fi

# ── Layer 4: Sub-Agent Health ──
for pidfile in "$STORE_DIR"/agent-*.pid; do
  [ -f "$pidfile" ] || continue
  agent_name=$(basename "$pidfile" .pid | sed 's/^agent-//')
  agent_pid="$(read_pid "$pidfile")"

  if [ -z "$agent_pid" ] || ! pid_alive "$agent_pid"; then
    # Check how long the PID file has been stale
    if [ -f "$pidfile" ]; then
      file_age=$(( $(now) - $(stat -f %m "$pidfile" 2>/dev/null || echo "$(now)") ))
      if [ "$file_age" -gt 300 ]; then
        log "L4: Agent '$agent_name' dead for ${file_age}s (PID file stale)"
        alert "WARN" "Sub-agent <b>${agent_name}</b> has been dead for ${file_age}s. Check launchd."
        # Clean up the stale PID file so we don't alert every tick
        rm -f "$pidfile"
      else
        log "L4: Agent '$agent_name' PID stale (${file_age}s) — launchd may still be restarting"
      fi
    fi
  else
    log "L4: Agent '$agent_name' alive (PID $agent_pid)"
  fi
done

log "── Watchdog tick complete (all checks passed) ──"
exit 0
