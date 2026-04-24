#!/bin/bash
# Session 2 endpoint auth + response verification.
# Assumes the bot is already running on $DASHBOARD_PORT.
# Usage: bash scripts/session2-endpoint-check.sh
set -u
ROOT="$(git rev-parse --show-toplevel 2>/dev/null || (cd "$(dirname "$0")/.." && pwd))"
set -a; source "$ROOT/.env"; set +a
CHAT_ID="${ALLOWED_CHAT_ID:?ALLOWED_CHAT_ID not set in .env}"
TOKEN="${DASHBOARD_TOKEN:?DASHBOARD_TOKEN not set in .env}"
PORT="${DASHBOARD_PORT:-3141}"
BASE="http://localhost:$PORT"
# Placeholder used in assertion names to keep the real token out of stdout.
Q_DISPLAY="?token=***"
Q_REAL="?token=$TOKEN"

# Preflight: if the dashboard isn't listening, skip cleanly (exit 0) so this
# script is safe in CI where no bot is running. Real failures still fail hard.
if ! curl -s -o /dev/null --connect-timeout 2 "$BASE/" 2>/dev/null; then
  echo "Dashboard not reachable at $BASE — skipping endpoint check."
  echo "Start the bot with 'npm start' (or kickstart the launchd agent) and re-run."
  exit 0
fi

PASS=0
FAIL=0
FAILS=()

assert_code() {
  local name="$1" expected="$2" actual="$3"
  # Scrub token from any path that slipped into the name.
  name="${name//$TOKEN/***}"
  if [ "$actual" = "$expected" ]; then
    printf "  ✓ %-60s %s\n" "$name" "$actual"
    PASS=$((PASS+1))
  else
    printf "  ✗ %-60s expected=%s got=%s\n" "$name" "$expected" "$actual"
    FAIL=$((FAIL+1))
    FAILS+=("$name (expected $expected, got $actual)")
  fi
}

code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
body() { curl -s "$@"; }

echo "=== Auth enforcement — every route should reject bad tokens ==="
for route in \
  "/" \
  "/api/health" \
  "/api/info" \
  "/api/agents" \
  "/api/chat/preferences?chatId=$CHAT_ID" \
  "/api/chat/history?chatId=$CHAT_ID" \
  "/api/mission/tasks" \
  "/api/mission/tasks/xxxx" \
  "/api/priorities" \
  "/api/workspaces" \
  "/api/core-memory" \
  "/api/calendar/events" \
  "/api/memories" \
  "/api/tokens" \
  "/api/audit" \
  "/api/security/status"
do
  assert_code "GET $route  no-token" 401 "$(code "$BASE$route")"
  assert_code "GET $route  bad-token" 401 "$(code "$BASE$route?token=WRONG")"
done

echo ""
echo "=== POST endpoints — auth rejection ==="
for route in \
  "/api/chat/send" \
  "/api/chat/fanout" \
  "/api/chat/abort" \
  "/api/mission/tasks" \
  "/api/mission/tasks/auto-assign-all" \
  "/api/priorities" \
  "/api/core-memory" \
  "/api/workspaces"
do
  assert_code "POST $route  no-token" 401 "$(code -X POST -H 'Content-Type: application/json' -d '{}' "$BASE$route")"
  assert_code "POST $route  bad-token" 401 "$(code -X POST -H 'Content-Type: application/json' -d '{}' "$BASE$route?token=WRONG")"
done

echo ""
echo "=== PUT/PATCH/DELETE — auth rejection ==="
assert_code "PUT /api/chat/preferences  no-token" 401 "$(code -X PUT -d '{}' "$BASE/api/chat/preferences?chatId=$CHAT_ID")"
assert_code "PATCH /api/agents/model  no-token" 401 "$(code -X PATCH -d '{}' "$BASE/api/agents/model")"
assert_code "DELETE /api/mission/tasks/xxxx  no-token" 401 "$(code -X DELETE "$BASE/api/mission/tasks/xxxx")"

echo ""
echo "=== Valid-token reads — should return 200 ==="
for route in \
  "/?chatId=$CHAT_ID" \
  "/api/health" \
  "/api/info" \
  "/api/agents" \
  "/api/tokens" \
  "/api/audit" \
  "/api/security/status" \
  "/api/chat/preferences&chatId=$CHAT_ID" \
  "/api/chat/history&chatId=$CHAT_ID" \
  "/api/mission/tasks" \
  "/api/mission/history" \
  "/api/priorities" \
  "/api/quick-links" \
  "/api/core-memory" \
  "/api/workspaces" \
  "/api/calendar/events" \
  "/api/memories&chatId=$CHAT_ID" \
  "/api/memories/pinned&chatId=$CHAT_ID" \
  "/api/documents" \
  "/api/ideas" \
  "/api/decisions" \
  "/api/inbox" \
  "/api/meetings" \
  "/api/meeting-notes" \
  "/api/templates" \
  "/api/daily-brief/preview&workspaceSlug=personal" \
  "/api/warroom/agents" \
  "/api/warroom/voices" \
  "/api/warroom/meetings" \
  "/api/warroom/pin" \
  "/api/hive-mind" \
  "/api/tasks" \
  "/api/meet/sessions" \
  "/api/calendar" \
  "/api/agents/templates"
do
  # Routes already containing ? use the token as the leading query param;
  # routes containing & use it after a base path.
  if [[ "$route" == *"&"* ]]; then
    base="${route%%&*}"
    rest="${route#*&}"
    url="$BASE$base$Q_REAL&$rest"
    display="GET $base$Q_DISPLAY&$rest"
  elif [[ "$route" == *"?"* ]]; then
    url="$BASE${route//?/$Q_REAL&}"
    # Replace only the first ? with $Q_REAL&, rest of route stays.
    display="GET ${route/\?/$Q_DISPLAY&}"
    url="$BASE${route/\?/$Q_REAL&}"
  else
    url="$BASE$route$Q_REAL"
    display="GET $route$Q_DISPLAY"
  fi
  assert_code "$display" 200 "$(code "$url")"
done

echo ""
echo "=== Session 2 — chat_preferences round-trip ==="
INITIAL=$(body "$BASE/api/chat/preferences$Q_REAL&chatId=$CHAT_ID")
echo "  initial: $INITIAL"

UPSERT=$(body -X PUT -H 'Content-Type: application/json' \
  -d '{"selectedAgents":["main","comms"],"workspaceSlug":"personal"}' \
  "$BASE/api/chat/preferences$Q_REAL&chatId=$CHAT_ID")
echo "  upsert:  $UPSERT"

READBACK=$(body "$BASE/api/chat/preferences$Q_REAL&chatId=$CHAT_ID")
echo "  read:    $READBACK"

if echo "$READBACK" | grep -q '"comms"' && echo "$READBACK" | grep -q '"personal"'; then
  assert_code "chat_preferences round-trip persists both fields" 200 200
else
  assert_code "chat_preferences round-trip persists both fields" 200 000
fi

OVERCAP=$(body -X PUT -H 'Content-Type: application/json' \
  -d '{"selectedAgents":["main","comms","content","ops","research","extra6"]}' \
  "$BASE/api/chat/preferences$Q_REAL&chatId=$CHAT_ID")
echo "  overcap: $OVERCAP"
CAP_COUNT=$(echo "$OVERCAP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('selectedAgents',[])))" 2>/dev/null || echo "?")
if [ "$CAP_COUNT" = "4" ]; then
  assert_code "selectedAgents capped at 4 (MAX_FANOUT_AGENTS)" 4 4
else
  assert_code "selectedAgents capped at 4 (MAX_FANOUT_AGENTS)" 4 "$CAP_COUNT"
fi

# Restore pre-test state.
body -X PUT -H 'Content-Type: application/json' \
  -d "$INITIAL" \
  "$BASE/api/chat/preferences$Q_REAL&chatId=$CHAT_ID" > /dev/null

echo ""
echo "=== Session 2 — mission tasks with run_id scoping ==="
MLIST=$(body "$BASE/api/mission/tasks$Q_REAL")
echo "$MLIST" | python3 -c "import sys,json; d=json.load(sys.stdin); assert isinstance(d.get('tasks'), list); print('  OK tasks array present, len=', len(d['tasks']))" \
  && PASS=$((PASS+1)) \
  || { echo "  ✗ tasks array missing"; FAIL=$((FAIL+1)); FAILS+=("mission/tasks schema"); }

RUN_SCOPED=$(code "$BASE/api/mission/tasks$Q_REAL&runId=nonexistent-run-id")
assert_code "GET /api/mission/tasks$Q_DISPLAY&runId=..." 200 "$RUN_SCOPED"

echo ""
echo "=== Session 2 — fanout endpoint validation ==="
FANOUT_EMPTY=$(code -X POST -H 'Content-Type: application/json' -d '{}' "$BASE/api/chat/fanout$Q_REAL")
assert_code "POST /api/chat/fanout  empty body" 400 "$FANOUT_EMPTY"

FANOUT_NOMSG=$(code -X POST -H 'Content-Type: application/json' -d '{"agents":["main"]}' "$BASE/api/chat/fanout$Q_REAL")
assert_code "POST /api/chat/fanout  no message" 400 "$FANOUT_NOMSG"

FANOUT_NOAGT=$(code -X POST -H 'Content-Type: application/json' -d '{"message":"hi"}' "$BASE/api/chat/fanout$Q_REAL")
assert_code "POST /api/chat/fanout  no agents" 400 "$FANOUT_NOAGT"

echo ""
echo "=== Summary ==="
echo "  PASS: $PASS"
echo "  FAIL: $FAIL"
if [ "$FAIL" -gt 0 ]; then
  echo ""
  echo "  Failures:"
  for f in "${FAILS[@]}"; do echo "    - $f"; done
  exit 1
fi
exit 0
