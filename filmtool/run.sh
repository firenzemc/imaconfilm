#!/usr/bin/env bash
# Launch the filmtool service, reachable across the tailnet (use the Tailscale IP).
#   ./run.sh            -> http://<tailscale-ip>:8790/
# Stop with Ctrl-C.
set -e
cd "$(dirname "$0")"
PORT="${PORT:-8790}"
TSIP="$(tailscale ip -4 2>/dev/null | head -1)"
echo "filmtool -> http://${TSIP:-localhost}:${PORT}/  (also http://localhost:${PORT}/)"
exec uv run uvicorn server:app --host 0.0.0.0 --port "${PORT}"
