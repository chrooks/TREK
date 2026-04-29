# TREK — Local Trial & Minimum Self-Host Recipe

A two-stage guide: try it locally first, then deploy for real once you're sold.

---

## Stage 1 — Try it locally

Goal: get TREK running on your Mac in 2 minutes so you and your girlfriend can poke at it on the same Wi-Fi network.

### Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) installed and running

### Steps

1. Create a working folder anywhere (e.g. `~/trek-local`):
   ```bash
   mkdir ~/trek-local && cd ~/trek-local
   ```

2. Generate an encryption key and save it. You only need this once:
   ```bash
   openssl rand -hex 32
   ```
   Copy the output. Paste it into the `docker-compose.yml` below in place of `REPLACE_ME`.

3. Create `docker-compose.yml`:
   ```yaml
   services:
     trek:
       image: mauriceboe/trek:latest
       container_name: trek
       ports:
         - "3000:3000"
       environment:
         - ENCRYPTION_KEY=REPLACE_ME
         - ADMIN_EMAIL=you@example.com
         - ADMIN_PASSWORD=changeme123
       volumes:
         - ./data:/app/data
         - ./uploads:/app/uploads
       restart: unless-stopped
   ```

4. Start it:
   ```bash
   docker compose up -d
   ```

5. Open http://localhost:3000 and log in with the email/password from step 3.

### Try it from your phone (same Wi-Fi)

Find your Mac's local IP:
```bash
ipconfig getifaddr en0
```

On your phone (must be on the same Wi-Fi), open `http://<that-ip>:3000`.

Caveat: iOS will **not** let you "Add to Home Screen" as a real PWA over plain HTTP. For local trial, just use it in the browser. PWA install requires HTTPS, which means Stage 2.

### Stop / wipe / restart

```bash
docker compose down            # stop, keep data
docker compose up -d           # start again
docker compose down -v         # stop + delete data (or just `rm -rf data uploads`)
docker compose pull && docker compose up -d   # update to latest version
```

Your trips and uploads live in `./data` and `./uploads` next to the compose file.

---

## Stage 2 — Deploy for real (once you're sold)

Goal: TREK reachable at `https://trek.yourdomain.com` from anywhere, installable as a PWA on both phones.

### What you'll need

- A **domain name** (~$12/yr — Namecheap, Cloudflare Registrar, Porkbun)
- A **VPS** (~$5/mo — [Hetzner CX22](https://www.hetzner.com/cloud) is the boring right answer; DigitalOcean / Linode / Vultr also fine)

### Steps

1. **Provision the VPS.** Pick Ubuntu 24.04. SSH in as root.

2. **Point your domain at the VPS.** In your domain registrar's DNS panel, add an A record:
   - Name: `trek` (so the full hostname becomes `trek.yourdomain.com`)
   - Value: the VPS's public IP
   - TTL: default

3. **Install Docker** on the VPS:
   ```bash
   curl -fsSL https://get.docker.com | sh
   ```

4. **Create the project folder:**
   ```bash
   mkdir -p /opt/trek && cd /opt/trek
   ```

5. **Create `docker-compose.yml`:**
   ```yaml
   services:
     trek:
       image: mauriceboe/trek:latest
       container_name: trek
       expose:
         - "3000"
       environment:
         - NODE_ENV=production
         - ENCRYPTION_KEY=REPLACE_ME           # openssl rand -hex 32
         - APP_URL=https://trek.yourdomain.com
         - FORCE_HTTPS=true
         - TRUST_PROXY=1
         - ADMIN_EMAIL=you@example.com
         - ADMIN_PASSWORD=changeme-then-rotate
         - TZ=America/New_York                 # your timezone
       volumes:
         - ./data:/app/data
         - ./uploads:/app/uploads
       restart: unless-stopped
       networks:
         - web

     caddy:
       image: caddy:2-alpine
       container_name: caddy
       ports:
         - "80:80"
         - "443:443"
       volumes:
         - ./Caddyfile:/etc/caddy/Caddyfile:ro
         - caddy_data:/data
         - caddy_config:/config
       restart: unless-stopped
       networks:
         - web

   networks:
     web:

   volumes:
     caddy_data:
     caddy_config:
   ```

6. **Create `Caddyfile`** (next to the compose file):
   ```
   trek.yourdomain.com {
       reverse_proxy trek:3000
   }
   ```
   Caddy auto-fetches a Let's Encrypt cert the first time someone hits the domain. WebSockets work out of the box.

7. **Boot it:**
   ```bash
   docker compose up -d
   ```

8. **Visit `https://trek.yourdomain.com`.** Log in. Change the admin password immediately.

9. **Install as PWA** on both phones: open the URL in Safari → Share → Add to Home Screen.

### Updating

```bash
cd /opt/trek
docker compose pull && docker compose up -d
```

Data in `./data` and `./uploads` is untouched.

### Backups

In TREK's Admin Panel: enable scheduled backups, or trigger manual ones. The DB itself is at `/opt/trek/data/travel.db` — copy that file off the box periodically (rsync, restic, whatever) and you're safe.

---

## When to skip Stage 2

If you only need it for one trip and don't care about PWA install or remote access, Stage 1 plus a [Tailscale](https://tailscale.com/) network between your devices is enough — Tailscale gives both phones a private route to your Mac without exposing anything publicly. No domain, no VPS, no certs.
