# GANYIQ Deployment Documentation

---

## 1. Architecture Overview

GANYIQ uses a **two-location deployment model**:

```
┌─────────────────────────────────────────────────────────┐
│  /root/GANYIQ/                                          │
│  (Source of Truth)            ┌──────────────────────┐  │
│  ┌────────────────────┐       │  Git Repository      │  │
│  │  Code development   │       │  (origin/main)       │  │
│  │  Git operations     │──────►│  GitHub remote       │  │
│  │  File staging       │       └──────────────────────┘  │
│  └────────┬───────────┘                                   │
│           │                                                │
│           │ deploy.sh (rsync)                              │
│           ▼                                                │
│  ┌──────────────────────────────────────────────────┐     │
│  │  /var/www/ganyiq/                                 │     │
│  │  (Production — served by PM2)                     │     │
│  │  ┌────────────────────────────────────────────┐   │     │
│  │  │  npm ci → next build → pm2 restart         │   │     │
│  │  │  Nginx proxy → port 3003                    │   │     │
│  │  │  Serves: API (15 routes) + UI + clips/     │   │     │
│  │  └────────────────────────────────────────────┘   │     │
│  └──────────────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────────┘
```

### Why two directories?

| Aspect | `/root/GANYIQ/` | `/var/www/ganyiq/` |
|---|---|---|
| Role | Development source of truth | Production runtime |
| Git | Full git repository | Git mirror (deploy via rsync) |
| `.env.local` | Development credentials | Production credentials |
| `node_modules` | Installed as needed | Installed during deploy |
| `.next/` | Build artifacts | Build artifacts (rebuilt) |
| `public/clips/` | Empty (no rendered clips) | Contains actual clips (excluded from rsync) |
| Changes | Direct edits via Hermes / manual | Only updated via `deploy.sh` |

---

## 2. `deploy.sh` Script

**Location:** `/root/GANYIQ/deploy.sh`

### Usage

```bash
# Full deploy: sync, build, restart
bash deploy.sh

# Quick deploy: sync only, no build
bash deploy.sh --quick

# Build only (at target, no rsync)
bash deploy.sh --build

# Rollback one commit
bash deploy.sh --rollback HEAD~1
```

### Full Deploy Flow

```bash
#!/bin/bash
TARGET="/var/www/ganyiq"
SOURCE="/root/GANYIQ"

# 1. RSYNC from source to target
rsync -avz --delete \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude '.next' \
  --exclude '.env*' \
  --exclude '*tsbuildinfo' \
  --exclude 'cookies.txt' \
  --exclude 'public/clips' \
  $SOURCE/ $TARGET/

# 2. Install production dependencies
cd $TARGET
npm ci

# 3. Build Next.js
npx next build

# 4. Restart PM2
pm2 restart ganyiq

# 5. Health check
sleep 5
curl -s http://localhost:3003/api/health || {
  echo "Health check failed!"
  exit 1
}
```

### Rsync Excludes

| Excluded Path | Reason |
|---|---|
| `.git/` | Production doesn't need git history |
| `node_modules/` | Re-installed via `npm ci` for correct platform |
| `.next/` | Rebuilt for production environment |
| `.env*` | Different credentials per environment |
| `*tsbuildinfo` | Build cache, irrelevant |
| `cookies.txt` | YouTube auth tokens differ per environment |
| `public/clips/` | Rendered clips already on production (would be deleted by `--delete`) |

---

## 3. PM2 Configuration

**Process name:** `ganyiq`

**Command:** `/var/www/ganyiq $ npm start -- -p 3003`

**PM2 Details:**
| Property | Value |
|---|---|
| Status | online |
| PID | 43226 |
| Uptime | 35 min (at time of audit) |
| Restarts | 7 |
| Memory | 55.6 MB |
| CPU | 0% |
| Event loop | 0.63ms avg, 1.55ms p95 |
| Node.js | v20.20.2 |
| Active handles | 5 |

**Startup:** PM2 daemon (`v7.0.1`) auto-starts via systemd or init.d.

---

## 4. Nginx Configuration

**Domain:** `ganyiq.ganys.me`
**Proxy target:** `http://127.0.0.1:3003`
**SSL:** Let's Encrypt (Certbot), SAN cert covers ganys.me + 5 subdomains

### Key Nginx Settings

```nginx
server {
    listen 443 ssl;
    server_name ganyiq.ganys.me;

    # SSL
    ssl_certificate /etc/letsencrypt/live/ganys.me/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/ganys.me/privkey.pem;

    client_max_body_size 100M;        # Large upload support
    proxy_read_timeout 600;           # 10min for long ops
    proxy_request_buffering off;      # Streaming uploads
    gzip on;                          # Compression

    # Static clips - long cache
    location /clips/ {
        alias /var/www/ganyiq/public/clips/;
        expires 30d;
        add_header Cache-Control "public, immutable";
    }

    # Proxy to Next.js
    location / {
        proxy_pass http://127.0.0.1:3003;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_cache_bypass $http_upgrade;
    }

    # Security headers
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload";
}
```

**HTTP→HTTPS redirect:** Standard 301 redirect from port 80.

**Other sites on same nginx:** `default`, `hbd.ganys.me`, `konstruksi.ganys.me`, `marketpulse.ganys.me`, `portofolio-gany.ganys.me`, `roastgram.ganys.me`, `salonbook.ganys.me`

---

## 5. Build Process

```bash
# Dependencies
npm ci                           # Clean install (respects lockfile)

# Build
npx next build                   # Produces .next/ directory

# Start
npm start -- -p 3003             # Next.js on port 3003
```

**Next.js config:** Minimal (empty `nextConfig`). No custom webpack, no image optimization, no rewrites.

---

## 6. Health Check & Monitoring

- After deploy: `curl http://localhost:3003/api/health`
- Database probe: `SELECT 1` via Neon PostgreSQL pool
- PM2 monitoring: `pm2 monit` / `pm2 show ganyiq`
- Telegram monitoring: Hermes cron job (every 5 min + daily 08:00)

---

## 7. Deployment Frequency & History

Deploy is **manual** (not CI/CD). The developer:
1. Edits source at `/root/GANYIQ/`
2. Runs `bash deploy.sh` (or `--quick`)
3. Confirms health check passes

**Common deploy scenarios:**
- Fix bug → edit → `bash deploy.sh --quick`
- Add feature → edit → test → `bash deploy.sh`
- Rollback bad deploy → `bash deploy.sh --rollback HEAD~1`

**Note:** Production (`/var/www/ganyiq`) is **several commits behind** source (`/root/GANYIQ`) as of 2026-06-07. The latest V2.4A-opt face tracking improvements have NOT been deployed.

---

## 8. Environment Variables

| Variable | Prod Value | Purpose |
|---|---|---|
| `DATABASE_URL` | (Neon PostgreSQL) | Database connection |
| `DEEPGRAM_API_KEY` | (secret) | Speech-to-text API |
| `GEMINI_API_KEY` | (secret) | Gemini AI API |
| `NEXT_PUBLIC_APP_URL` | `https://ganyiq.vercel.app` | Public URL reference |
| `OPENCODE_GO_API_KEY` | (secret) | LLM API key |
| `RATE_LIMIT_PER_DAY` | `10` | IP rate limit |

---

## 9. Source vs Production Differences

As of 2026-06-07:

| File | Source (`/root/GANYIQ`) | Production (`/var/www/ganyiq`) |
|---|---|---|
| `worker/face-tracker.ts` | CONFIDENCE_LOCK_THRESHOLD = 0.25 | CONFIDENCE_LOCK_THRESHOLD = 0.6 |
| `worker-package/face-tracker.ts` | Same drift | Same drift |
| `cookies.txt` | Dev YouTube cookies | Prod YouTube cookies |
| `public/clips/` | Empty | 8 rendered files (~164MB) |
| `tsconfig.tsbuildinfo` | Build artifact | Build artifact (differs) |

**Production is on commit `3bbf1f3`; source has `fcebf14` (latest).**
