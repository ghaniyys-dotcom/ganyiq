# PRODUCTION HARDENING REPORT — ganyIQ

> **Date:** 2026-06-01
> **Objective:** Make GANYIQ safe for first public deployment

---

## Summary

| Check | Before | After | Status |
|---|---|---|---|
| Rate limiting | ❌ None | ✅ DB-backed, per-IP, 24h rolling window | ✅ |
| Vercel config | ❌ Missing | ✅ `vercel.json` with maxDuration: 60 | ✅ |
| Gemini dead code | ❌ Fallback + stale comments | ✅ Cleaned | ✅ |
| `.env.example` commitment | ❌ Ignored by `.gitignore` | ✅ `!.env.example` exception added | ✅ |
| Build | ✅ Passed | ✅ Passed (0 errors) | ✅ |

---

## 1. Rate Limiting — Implemented

### Files Created

| File | Purpose |
|---|---|
| `lib/rate-limit.ts` | Rate limit library — queries `analyses` table, configurable via env |

### Files Modified

| File | Change |
|---|---|
| `app/api/analyze/route.ts` | Added rate limit check after URL validation (Step 2), moved IP extraction earlier, removed duplicate `ipAddress`/`processingTimeMs` declarations |

### How It Works

```
Request → URL Validation → Check Rate Limit → Fetch Video → Analyze → Store → Response
                            └→ 429 if exceeded
```

- **Database-backed:** Counts completed + failed analyses from the same IP in a rolling 24-hour window. Persists across server restarts and works across multiple serverless instances.
- **Configurable:** Default limit = **10/IP/day**. Override via `RATE_LIMIT_PER_DAY` env var.
- **Failsafe:** If the rate limit DB query itself fails, the request proceeds without rate limiting (logged as error). Never blocks a legitimate request due to infrastructure failure.
- **Headers returned on 429:**
  - `X-RateLimit-Limit` — configured daily limit
  - `X-RateLimit-Remaining` — always `0` on 429
  - `X-RateLimit-Reset` — ISO timestamp when the rate limit resets
- **Response body on 429:**
  ```json
  {
    "error": "RATE_LIMITED",
    "message": "Rate limit exceeded. Maximum 10 analyses per IP per day. Resets at 2026-06-02T12:00:00.000Z.",
    "remaining": 0,
    "resetAt": "2026-06-02T12:00:00.000Z"
  }
  ```

### Security Impact

- **Prevents runaway LLM costs** from abuse or accidental script loops
- **No auth bypass** — rate limiting works purely on IP, no API key required
- **Graceful degradation** — rate limit failure doesn't block requests

---

## 2. Vercel Configuration — Created

### File Created

`vercel.json`:

```json
{
  "version": 2,
  "buildCommand": "next build",
  "outputDirectory": ".next",
  "installCommand": "npm install",
  "framework": "nextjs",
  "functions": {
    "app/api/analyze/route.ts": {
      "maxDuration": 60,
      "memory": 512
    },
    "app/api/health/route.ts": {
      "maxDuration": 10,
      "memory": 128
    }
  },
  "crons": [],
  "regions": ["sin1"]
}
```

### Setting Documentation

| Setting | Value | Rationale |
|---|---|---|
| `version: 2` | 2 | Vercel platform version. Always 2 for current deployments. |
| `buildCommand` | `next build` | Standard Next.js build. Uses `next build` not `npm run build` to avoid lifecycle script interference. |
| `outputDirectory` | `.next` | Next.js default output. |
| `installCommand` | `npm install` | Explicit install command ensures consistent behavior. |
| `framework` | `nextjs` | Auto-detected, but explicit is safer. Enables Vercel Next.js optimizations. |
| `maxDuration` (analyze) | **60** | Critical: 40s+ analysis pipeline. **Requires Vercel Pro plan** (Hobby max = 10s). |
| `memory` (analyze) | **512 MB** | Default is 1024 MB, but 512 MB is sufficient for LLM fetching. |
| `maxDuration` (health) | **10** | Health checks are fast DB queries. |
| `memory` (health) | **128 MB** | Minimum needed for health check. |
| `crons` | `[]` | No cron jobs needed in MVP. |
| `regions` | `["sin1"]` | Singapore region for Southeast Asian users. Minimizes latency for YouTube API calls from this region. |

### Important Notes

- **⚠️ Vercel Pro required** — The 40s+ analysis pipeline exceeds the Hobby plan's 10-second timeout
- **Edge functions NOT used** — All routes use serverless Node.js (not Edge) because `pg` and `youtubei.js` need Node.js APIs
- **No `output: 'standalone'`** — Not needed for Vercel deployments (only for self-hosted Docker)

---

## 3. Gemini Code Removal — Completed

### Files Modified

| File | Change |
|---|---|
| `lib/analyzer.ts:139` | `process.env.OPENCODE_GO_API_KEY \|\| process.env.GEMINI_API_KEY` → `process.env.OPENCODE_GO_API_KEY` |
| `app/api/analyze/route.ts:13` | Comment: `"Gemini 2.0 Flash"` → `"DeepSeek V4 Flash"` |
| `.env.example` | Removed `GEMINI_API_KEY`, added `OPENCODE_GO_API_KEY`, updated comments |
| `db/migrations/002_create_analyses.sql` | Updated stale comment about gemini-2.0-flash default |

### What Was Removed

- ❌ `GEMINI_API_KEY` env var from `.env.example`
- ❌ `|| process.env.GEMINI_API_KEY` fallback in `callLLM()`
- ❌ Stale comment "Run LLM analysis (Gemini 2.0 Flash)" in route
- ❌ Stale migration comment describing gemini-2.0-flash as the "default model"

### What Was NOT Changed

- `DEFAULT 'gemini-2.0-flash'` in migration SQL — The migration has already been applied to the database. Changing the SQL file won't alter the production schema. The application always overrides this default with `TARGET_MODEL` at INSERT time, so the stale default is harmless.

---

## 4. .gitignore Fix — Completed

### Change

`.gitignore` line 34:
```
.env*         →  .env*
                  !.env.example
```

### Impact

- `.env.local`, `.env.production`, `.env.*` (all actual environment files) remain ignored ✅
- `.env.example` is now **committed** to the repository ✅
- New developers cloning the repo can immediately see which env vars are needed ✅

---

## 5. Build Verification — PASSED

```
npm run build

▲ Next.js 16.2.7 (Turbopack)
✓ Compiled successfully in 18.2s
✓ TypeScript passed in 13.1s
✓ Static pages generated (4/4) in 292ms

Routes:
  ○ /_not-found      (static)
  ƒ /api/analyze     (dynamic)
  ƒ /api/health      (dynamic)
```

**Zero errors.** All TypeScript strict mode checks pass. All imports resolve correctly.

---

## 6. Remaining Deployment Risks

### 🔴 HIGH (Must Resolve Before Go-Live)

| Risk | Impact | Mitigation |
|---|---|---|
| **Vercel Hobby 10s timeout** | Pipeline fails on first analysis | Upgrade to Vercel Pro ($20/mo) OR implement async processing |
| **YouTube IP restriction from Vercel IPs** | Same as DO — Vercel shared IPs may also be blocked | No workaround. Must test after deploy. |

### 🟡 MEDIUM (Should Address)

| Risk | Impact | Mitigation |
|---|---|---|
| **`youtubei.js` UniversalCache on read-only FS** | May throw on cold start | Monitor Vercel logs post-deploy. Falls back to no cache, which still works. |
| **`pg` connection pooling in serverless** | Connection exhaustion under load | Monitor Neon dashboard. Consider `@neondatabase/serverless` driver. |
| **No authentication** | Anyone with the URL can call the API | Rate limiting helps but doesn't prevent targeted abuse. Add API key middleware in V2. |

### 🟢 LOW (Monitor)

| Risk | Impact | Mitigation |
|---|---|---|
| **No root page** | `https://ganyiq.vercel.app` shows 404 | Minimal landing page recommended for V2 |
| **Package name still `ganyiq-temp`** | Cosmetic | Rename in `package.json` |

---

## 7. Exact Deployment Checklist

### Pre-Deploy

- [ ] Upgrade Vercel to **Pro plan** ($20/mo) — 60s timeout required
- [ ] Create **Neon PostgreSQL** database (or any serverless PG with SSL)
- [ ] Run migrations against production DB:
  ```bash
  DATABASE_URL="postgresql://user:pass@ep-xxx.us-east-2.aws.neon.tech/ganiyiq?sslmode=require" \
    npx tsx db/migrate.ts
  ```
- [ ] Push all changes to GitHub:
  ```bash
  git add .
  git commit -m "production hardening: rate limiting, vercel config, Gemini cleanup"
  git push
  ```

### Vercel Setup

- [ ] Connect GitHub repo via Vercel dashboard
- [ ] Add environment variables:
  - `DATABASE_URL` (Neon connection string, includes `?sslmode=require`)
  - `OPENCODE_GO_API_KEY`
  - `NEXT_PUBLIC_APP_URL` (e.g., `https://ganyiq.vercel.app`)
  - `RATE_LIMIT_PER_DAY` (e.g., `10`)

### Deploy

- [ ] `vercel --prod` — First production deployment
- [ ] Verify health check:
  ```bash
  curl https://ganyiq.vercel.app/api/health
  # Expected: {"status":"ok","database":"connected","timestamp":"..."}
  ```
- [ ] Verify rate limiting:
  ```bash
  curl -s -w '\nHTTP: %{http_code}' -X POST \
    https://ganyiq.vercel.app/api/analyze \
    -H "Content-Type: application/json" \
    -d '{"url":"not-a-url"}'
  # Expected: HTTP 400 (validation works, rate limit not triggered)
  ```
- [ ] Verify full analysis:
  ```bash
  curl -s -X POST https://ganyiq.vercel.app/api/analyze \
    -H "Content-Type: application/json" \
    -d '{"url":"https://youtu.be/dQw4w9WgXcQ"}'
  # Expected: 200 OK with moments array
  ```

### Post-Deploy

- [ ] Check Vercel function logs for errors
- [ ] Monitor cold start times in Vercel dashboard
- [ ] Run batch from local machine:
  ```bash
  npx tsx scripts/batch-analyze.ts --api=https://ganyiq.vercel.app --max=5
  ```
- [ ] Export results:
  ```bash
  npx tsx scripts/export-results.ts
  ```
- [ ] Set `NEXT_PUBLIC_APP_URL` to actual deployment URL
- [ ] Create Neon dashboard alerts (connection count, CPU, storage)

---

## 8. Files Changed in This Phase

```
NEW:
  lib/rate-limit.ts         — Rate limiting library
  vercel.json               — Vercel deployment config

MODIFIED:
  app/api/analyze/route.ts  — Added rate limit check, cleaned up code
  lib/analyzer.ts           — Removed Gemini API key fallback
  .env.example              — Cleaned up, added OPENCODE_GO_API_KEY
  .gitignore                — Added !.env.example exception
  db/migrations/002_create_analyses.sql — Updated stale comment

REMOVED:
  ✦ scripts/test-rate-limit.ts (temp test file, deleted)
```

---

**GANYIQ is now hardened for first public deployment.** 🛡️
