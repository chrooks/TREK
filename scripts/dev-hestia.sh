#!/usr/bin/env bash
# Dev stack: API on 3101, Vite on 5273 bound to all interfaces so it is
# reachable over the machine's own network address rather than only localhost.
# Survives the terminal that started it; logs and pids land in server/data/logs/.
#
# Usage: scripts/dev-hestia.sh [stop]
set -euo pipefail
cd "$(dirname "$0")/.."

LOG_DIR="$PWD/server/data/logs"
mkdir -p "$LOG_DIR"

stop() {
  for name in dev-api dev-web; do
    if [[ -f "$LOG_DIR/$name.pid" ]]; then
      # setsid made the pid a session/group leader, so -pid kills the whole
      # tree (npm wrapper AND the actual node server holding the port).
      kill -- "-$(cat "$LOG_DIR/$name.pid")" 2>/dev/null && echo "stopped $name"
    fi
    rm -f "$LOG_DIR/$name.pid"
  done
}

if [[ "${1:-}" == "stop" ]]; then stop; exit 0; fi

stop
npm run build --workspace=shared >"$LOG_DIR/dev-shared.log" 2>&1

PORT=3101 setsid npm run dev --workspace=server >"$LOG_DIR/dev-api.log" 2>&1 &
echo $! >"$LOG_DIR/dev-api.pid"

(cd client && TREK_API_PORT=3101 TREK_DEV_PORT=5273 setsid npx vite --host 0.0.0.0 --strictPort >"$LOG_DIR/dev-web.log" 2>&1 &
echo $! >"$LOG_DIR/dev-web.pid")

for _ in $(seq 1 30); do
  web=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:5273/ || true)
  api=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:3101/api/auth/me || true)
  if [[ "$web" == 200 && "$api" != 000 ]]; then
    # Print the reachable address rather than localhost — this box is worked on
    # over remote SSH, so the browser is never on the same machine.
    host=$(tailscale ip -4 2>/dev/null | head -1 || hostname -I | awk '{print $1}')
    echo "up: http://${host}:5273 (api $api)"
    exit 0
  fi
  sleep 1
done
echo "did not come up — check $LOG_DIR/dev-*.log" >&2
exit 1
