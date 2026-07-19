# TREK — repo instructions

## This is a fork

`origin` is **`chrooks/TREK`**, a fork of the upstream project **`liketrek/TREK`**.

- **All issues, PRs, and tracker work go to `chrooks/TREK`.** Never open an issue
  or PR against `liketrek/TREK` unless Chris explicitly says he is contributing
  something upstream.
- `gh` has bitten us here: it once resolved this directory to the **parent**
  repo and published three feature requests to the upstream project by mistake.
  `gh repo set-default chrooks/TREK` is now configured, but **verify the target
  before any `gh issue`/`gh pr` write** — `gh repo set-default --view`, or pass
  `-R chrooks/TREK` explicitly.
- Upstream auto-closes feature-request issues with a bot pointing at their
  Discussions. If you see that bot reply, you published to the wrong repo.
- Issues were disabled on the fork by default (GitHub does that for forks) and
  have since been enabled.

## Dev server

**Never hand out `localhost` URLs.** This repo is worked on over remote SSH —
Chris's browser runs on a different machine than the code. A `localhost` link is
useless to him.

Start the dev stack with:

```
scripts/dev-hestia.sh          # start (or restart)
scripts/dev-hestia.sh stop     # stop
```

It runs the API on **3101** and Vite on **5273**, bound to `0.0.0.0`, detached
via `setsid` so it outlives the terminal and this session. Logs and pidfiles go
to `server/data/logs/dev-*.{log,pid}`. The script prints the reachable address
on success and fails loudly if either service does not answer within 30s.

Dev login (local dev database only, not a real credential):
`admin@trek.local` / `trekdev`

The seeder generates a **random** admin password on first run and prints it once
to the server log. If login fails on a fresh database, that is why — reset the
hash rather than hunting for the printed value.

Two traps this script exists to avoid, both of which cost us a debugging cycle:

- **Vite silently falls back to the next free port** when its port is taken, then
  prints a cheerful startup banner for an address you were not told about. The
  script passes `--strictPort` so it fails instead of lying.
- **Killing the npm wrapper leaves the node process holding the port.** The
  script `setsid`s each service and kills the whole process group (`kill -- -PID`).
  If you ever kill a dev process by hand, check the port is actually free after.

Ports are deliberately off the defaults (3001/5173) because other services on
this box already claim those. `TREK_API_PORT` / `TREK_DEV_PORT` override them
for Playwright runs too.

## Prod server

Trek also runs as a **real service** on this box, at
`/srv/compose/trek/`, fronted by Caddy. It holds Chris's actual trip data.

- It runs `trek:local`, an image **built from this repo**:
  `docker build -t trek:local .` then `docker compose up -d` from
  `/srv/compose/trek/`.
- **Never restart, rebuild, or `docker compose down` the prod service without
  asking.** Building the image is safe and does not affect the running
  container; swapping the container is the part that needs a green light.
- Never point dev tooling at `/srv/compose/trek/data` — the dev stack uses the
  repo-local `server/data/travel.db`, and they must stay separate.
- No router ports are ever opened. Exposure is Caddy on the LAN, Tailscale for
  private remote, or a Cloudflare Tunnel for genuinely public access.

## Verification

Work that changes runtime behavior is not done until the flow has been driven in
a browser against the dev stack — a passing typecheck or unit test is not proof.
Playwright specs live under the server workspace (`npm run test:e2e`).
