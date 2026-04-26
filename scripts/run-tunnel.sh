#!/bin/bash
# Run cloudflared tunnel using the user's config.
# Expects tunnel ID as first argument, or reads from ~/.cloudflared/config.yml.
# Resolves cloudflared via PATH so it works on Linux / Intel Mac / non-Homebrew installs.
CLOUDFLARED="$(command -v cloudflared)"
if [ -z "$CLOUDFLARED" ]; then
  echo "cloudflared not found on PATH. Install it (https://github.com/cloudflare/cloudflared) and retry." >&2
  exit 127
fi
exec "$CLOUDFLARED" tunnel --config "$HOME/.cloudflared/config.yml" run "$@"
