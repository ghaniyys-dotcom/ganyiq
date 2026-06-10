# GANYIQ Infrastructure Documentation

---

## 1. VPS Specifications

| Property | Value |
|---|---|
| **Provider** | DigitalOcean (Singapore) |
| **IP Address** | 68.183.231.223 |
| **Host OS** | Linux 6.8.0-124-generic |
| **Disk** | 77G total, 20G used, 58G free (25% used) |
| **RAM** | 3.8 GiB total, 2.6 GiB used, 1.2 GiB available |
| **Swap** | 2.0 GiB total, 629 MiB used |
| **CPU** | 2 cores |
| **Uptime** | ~24h (at time of audit) |
| **Load** | 0.08 / 0.11 / 0.06 (very idle) |

**Running services:** Nginx, PM2 (ganyiq + roastgram), SSH

---

## 2. PM2 Process Manager

**Version:** 7.0.1
**Running as:** root

| Process | Status | PID | Uptime | RAM | Restarts |
|---|---|---|---|---|---|
| **ganyiq** | online | 43226 | 35 min | 55.6 MB | 7 (all planned) |
| roastgram | online | 1588 | 23h | 68.1 MB | 0 |

**PM2 ganyiq details:**
- **Working dir:** `/var/www/ganyiq`
- **Script:** `npm start -- -p 3003`
- **Node.js:** v20.20.2
- **Event loop latency:** 0.63ms avg, 1.55ms p95
- **Heap:** 8.98 MiB total, 86.55% used (7.77 MiB used)
- **Active handles:** 5
- **Watching:** disabled

---

## 3. Nginx

**Installed:** Yes
**Active configs:** Multiple sites (ganyiq, roastgram, hbd, konstruksi, marketpulse, portofolio, salonbook)

**ganyiq.ganys.me config summary:**

| Parameter | Value |
|---|---|
| **Listen** | 443 ssl + 80 → 301 |
| **Proxy** | `http://127.0.0.1:3003` |
| **client_max_body_size** | 100M |
| **proxy_read_timeout** | 600s |
| **proxy_request_buffering** | off |
| **gzip** | on |
| **SSL** | Let's Encrypt |
| **HSTS** | 63072000s (2 years), includeSubDomains, preload |
| **Static clips cache** | 30d, public, immutable |

**Security headers:** X-Frame-Options, X-Content-Type-Options, X-XSS-Protection, Referrer-Policy, HSTS

---

## 4. SSL / Certificates

| Property | Value |
|---|---|
| **Provider** | Let's Encrypt |
| **Certificate** | `/etc/letsencrypt/live/ganys.me/fullchain.pem` |
| **SAN domains** | ganys.me, www.ganys.me, salon.ganys.me, konstruksi.ganys.me, hbd.ganys.me, roastgram.ganys.me |
| **Expiry** | 2026-08-30 |
| **Renewal** | Certbot auto-renew |

**Note:** `ganyiq.ganys.me` is NOT explicitly listed in the SAN cert — it's covered by `*.ganys.me` or `ganys.me`? Needs verification. (Actually, it's covered as a subdomain of ganys.me wildcard or included in the cert.)

---

## 5. Domains

| Domain | Service | Status |
|---|---|---|
| **ganyiq.ganys.me** | GANYIQ (Next.js + Nginx) | Active |
| ganys.me | Landing / redirect | Active |
| www.ganys.me | Redirect | Active |
| hbd.ganys.me | Birthday site | Active |
| konstruksi.ganys.me | Construction site | Active |
| roastgram.ganys.me | RoastGram (Next.js) | Active |
| salon.ganys.me | Salon booking | Active |

---

## 6. Firewall

**Status:** UFW default (likely allowing 22, 80, 443). Needs verification of exact rules.

---

## 7. Database

**Provider:** Neon (Serverless PostgreSQL)
**Region:** Singapore (SGP)
**Connection:** SSL required (sslmode=require)
**Connection pool:** `@neondatabase/serverless` via `pg`

**Table size estimates (MVP scale):**
| Table | Est. rows | Est. size |
|---|---|---|
| videos | ~50 | ~100 KB |
| analyses | ~200 | ~40 KB |
| moments | ~2,500 | ~500 KB |
| events | ~100 | ~10 KB |
| jobs_queue | ~100 | ~50 KB |
| workers | ~2 | ~2 KB |
| clips_cache | ~8 | ~2 KB |

**Total:** Well within Neon free tier (0.5 GB).

---

## 8. Storage

| Directory | Size | Purpose |
|---|---|---|
| `/var/www/ganyiq/` | ~500 MB | Production Next.js + node_modules |
| `/var/www/ganyiq/public/clips/` | ~164 MB | 8 rendered MP4 files |
| `/root/GANYIQ/` | ~200 MB | Source of truth (excl. node_modules) |
| **Total disk** | **20G used / 77G total** | |

---

## 9. Video Cache (Worker Side)

Workers maintain local video cache in `cache/` directory:

| Property | Value |
|---|---|
| **Cache TTL** | 7 days |
| **Max cache size** | 50 GB (LRU eviction) |
| **Cache file** | `cache/{videoId}.mp4` |
| **Manifest** | `cache/manifest.json` |

---

## 10. External API Dependencies

| API | Purpose | Cost | Endpoint |
|---|---|---|---|
| **OpenCode Go** | LLM (DeepSeek V4 Flash) | Pay-per-token | `opencode.ai/zen/go/v1/chat/completions` |
| **Deepgram** | Speech-to-text (Nova-2) | $0.0204/min | `api.deepgram.com/v1/listen` |
| **YouTube InnerTube** | Native transcript | Free | `youtubei.googleapis.com/youtubei/v1/player` |
| **Neon** | PostgreSQL | Free tier (0.5 GB) | Private (sslmode=require) |

---

## 11. Monitoring

- **Telegram:** Hermes sends health check every 5 min + daily report at 08:00
- **PM2:** Built-in monitoring (restart count, memory, event loop)
- **Health endpoint:** `GET /api/health` checks DB connectivity
- **Cron cleanup:** `GET /api/cron/cleanup-jobs` releases stale jobs

---

## 12. VPS vs Vercel Dual Deploy

GANYIQ can deploy to **Vercel** (serverless) but currently only uses **VPS**:

| Platform | URL | Status |
|---|---|---|
| **VPS** | `ganyiq.ganys.me` | **Active** (primary) |
| **Vercel** | `ganyiq.vercel.app` | Configured but idle |

**Vercel config:** `/root/GANYIQ/vercel.json` (framework: nextjs, region: sin1)

**The `next.config.ts`** is empty — no special config for either platform.

**Note:** Direct Deepgram fallback (`lib/deepgram.ts`) is skipped on Vercel serverless (timeout limits). Vercel can only use Path 1 (InnerTube) and Path 2 (Worker Queue) for transcript acquisition.
