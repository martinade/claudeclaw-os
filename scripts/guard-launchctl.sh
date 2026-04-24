#!/bin/bash
# PreToolUse hook for Claude Code.
#
# Blocks Bash commands that would terminate this ClaudeClaw launchd service
# (`com.claudeclaw.*`). When the agent subprocess runs `launchctl stop`,
# `launchctl bootout`, `launchctl kickstart`, `launchctl unload`, or
# `launchctl bootstrap` against its own label, launchd sends SIGTERM to the
# main Node process — killing the parent of the very shell the command is
# running in, which kills the agent mid-response and drops the user's chat.
#
# Reads PreToolUse JSON on stdin. Exit 0 to allow, exit 2 + stderr to deny.

set -euo pipefail

payload="$(cat)"

tool_name="$(printf '%s' "$payload" | /usr/bin/python3 -c 'import sys,json
try:
  d=json.load(sys.stdin); print(d.get("tool_name",""))
except Exception:
  pass' 2>/dev/null || true)"

if [ "$tool_name" != "Bash" ]; then
  exit 0
fi

cmd="$(printf '%s' "$payload" | /usr/bin/python3 -c 'import sys,json
try:
  d=json.load(sys.stdin); print(d.get("tool_input",{}).get("command",""))
except Exception:
  pass' 2>/dev/null || true)"

# Destructive verbs that take a label or plist argument. `list`, `print`, `blame`
# are read-only and stay allowed.
if printf '%s' "$cmd" | /usr/bin/grep -Eiq 'launchctl[[:space:]]+(stop|bootout|kickstart|unload|bootstrap|kill|remove)[^|&;]*com\.claudeclaw'; then
  cat >&2 <<'EOF'
BLOCKED by guard-launchctl.sh: this command would terminate the ClaudeClaw
launchd service (com.claudeclaw.*) — which is the parent process you are
running inside of. Running it here kills you mid-response and drops the
user's chat session.

Safe alternatives when you need the service to restart:

  # Detached, runs AFTER you exit so you finish your turn first:
  nohup bash -c 'sleep 3; launchctl kickstart -k gui/$(id -u)/com.claudeclaw.app' \
    </dev/null >/dev/null 2>&1 &
  disown || true

  # Or tell the user to run this from their own terminal:
  #   launchctl kickstart -k gui/$(id -u)/com.claudeclaw.app

Read-only launchctl commands (list, print, blame) are still allowed.
EOF
  exit 2
fi

exit 0
