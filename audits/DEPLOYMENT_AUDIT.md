# DEPLOYMENT AUDIT — ganyIQ

> **Audit Date:** 2026-06-01
> **Target Platform:** Vercel (serverless)
> **Build Status:** ✅ **PASS** — `npm install` (0 errors) + `npm run build` (0 errors)
> **Routes Detected:** `/_not-found`, `ƒ /api/analyze`, `ƒ /api/health`

---

## 1. ENVIRONMENT VARIABLES

### Required for Production

| Variable | Status | Notes |
|---|---|---|
| `DATABASE_URL` | ❌ MISSING | Needed for production PostgreSQL (Neon) |
| `OPENCODE_GO_API_KEY` | ❌ MISSING | Needed for LLM inference |
| `NEXT_PUBLIC_APP_URL` | ❌ NOT SET | Currently defaults to `http://localhost:3000` in `.env.example` |

### Cleanup Needed

| Variable | Issue | Action |
|---|---|---|
| `GEMINI_API_KEY` | **Dead code** — project migrated to DeepSeek V4 Flash, but `.env.example` still lists it and `lib/analyzer.ts:139` falls back to it via `process.env.OPENCODE_GO_API_KEY \|\| process.env.GEMINI_API_KEY`. If only `GEMINI_API_KEY` is set, the call goes to OpenCode Go with wrong key → cryptic error. | Remove from `.env.example` + remove fallback from `analyzer.ts` |
| `RATE_LIMIT_PER_DAY` | **Declared but unused** — exists in `.env.example` but no code reads `process.env.RATE_LIMIT_PER_DAY`. Rate limiting is not implemented anywhere. | Either implement or remove from `.env.example` |

### .env.example Outdated

- Still says "# Database (Neon)" → project uses **local PostgreSQL** via `pg` Pool, not Neon
- Still references `GEMINI_API_KEY`
- `NEXT_PUBLIC_APP_URL=http://localhost:3000` needs production URL
- Missing `OPENCODE_GO_API_KEY` entry

### Security Risk

- `.gitignore` uses `.env*` which **also ignores `.env.example`** — the example file won't be committed. Fix: add `!.env.example` exception after the `.env*` line.

---

## 2. HARDCODED LOCALHOST REFERENCES

| File | Line | Issue | Severity |
|---|---|---|---|
| `scripts/batch-analyze.ts` | 41 | `API_BASE = getArg('api', 'http://localhost:3000')` — hardcoded default for local dev | **⚠️ Won't work on Vercel without `--api` flag** |
| `scripts/export-results.ts` | — | Direct DB import from `db/client` — only runs from local machine, not deployable | ✅ Acceptable (dev tool) |
| `.env.example` | 11 | `NEXT_PUBLIC_APP_URL=http://localhost:3000` | ✅ Template, must be overridden |

---

## 3. PRODUCTION SECURITY RISKS

### 🔴 HIGH — No Rate Limiting

- `POST /api/analyze` has **zero protection** against abuse
- Any client can call it unlimited times → costs money per LLM call
- `RATE_LIMIT_PER_DAY=5` declared in `.env.example` but **never implemented**
- **Fix:** Add middleware or in-route IP-based rate limiting before deployment

### 🟡 MEDIUM — No CORS Configuration

- No `middleware.ts` or `next.config` headers
- Browser-based clients from different origins could be blocked
- For API-only MVP this is acceptable, but if a web frontend is planned, CORS is needed

### 🟡 MEDIUM — No Auth / API Key Protection

- Anyone who discovers the URL can call `/api/analyze` freely
- Consider basic API key auth for MVP (via middleware)

### 🟢 LOW — `x-forwarded-for` IP Extraction

- `lib/analyze/route.ts:208` uses `x-forwarded-for` header — this is correct for Vercel but can be spoofed
- Acceptable for MVP (used only for tracking, not auth)

---

## 4. VERCEL COMPATIBILITY ISSUES

### 🔴 CRITICAL — Migration Runner Won't Run on Vercel

- `db/migrate.ts:34` uses `parse(process.argv[1]).dir` + `readdirSync` + `readFileSync` to load SQL files — these all rely on filesystem access
- Vercel serverless functions have **read-only filesystem** (except `/tmp`)
- **Migrations must be run externally** (locally against production DB, or as a GitHub Action)
- **Fix:** Document manual migration process. Do NOT add migration to `vercel-build` — build-time env vars ≠ runtime env vars

### 🔴 CRITICAL — Long Pipeline Timeout Risk

- Phase 4.6 confirmed analysis takes **40+ seconds** (single call to DeepSeek V4 Flash)
- Vercel Hobby plan timeout: **10 seconds** → **WILL FAIL**
- Vercel Pro plan timeout: **60 seconds** → **MARGINAL** (some analyses may exceed)
- **Fix:** Upgrade to Pro ($20/mo) OR restructure to async (submit → poll pattern)

### 🟡 MEDIUM — `youtubei.js` UniversalCache in Serverless

- `lib/youtube.ts:258` uses `Innertube.create({ cache: new UniversalCache(true) })`
- `UniversalCache` tries to create disk-based cache directory
- Vercel serverless functions have **read-only filesystem**
- May cause errors on cold starts. **Workaround:** Accept degraded cache performance or use memory-only mode

### 🟡 MEDIUM — `pg` Driver on Serverless

- `db/client.ts` uses `pg` Pool with TCP connections
- Works on Vercel Node.js serverless (not edge) but connection pooling needs care
- **Recommendation:** Use `@neondatabase/serverless` with HTTP connection for Neon, or configure proper pool sizing
- Standard `pg` Pool creates persistent connections — serverless functions may exhaust connection limits

### 🟢 LOW — No `vercel.json`

- No deployment configuration file exists
- Vercel auto-detects Next.js but won't know Node.js version, region, or function settings
- **Fix:** Create minimal `vercel.json`

---

## 5. POSTGRESQL COMPATIBILITY

Current: **Local PostgreSQL** via `pg` Pool (`db/client.ts`)

### For Vercel Production

| Concern | Status | Detail |
|---|---|---|
| SSL/TLS | ⚠️ | Local PG doesn't require SSL. Neon requires `sslmode=require`. `db/client.ts` doesn't specify SSL config. |
| Connection pooling | ⚠️ | `pg` Pool manages its own pool. In serverless, each invocation may try to create new connections. Need `@neondatabase/serverless` or a pooler like PgBouncer. |
| Extension availability | ✅ | All migrations use standard PostgreSQL — no extensions required |

### Migration Strategy

```bash
# Run against production DB from local machine:
DATABASE_URL="postgresql://user:pass@ep-xxx.us-east-2.aws.neon.tech/ganyiq?sslmode=require" \
  npx tsx db/migrate.ts
```

---

## 6. BUILD-TIME ISSUES

### ✅ Passed — Zero Errors

```
npm install   → 0 errors (96 packages, 2 moderate vulns — non-blocking)
npm run build → 0 errors (17.4s compile, 10.6s TypeScript, 317ms static generation)
```

### Minor Observations

| Issue | Detail |
|---|---|
| Package name | `package.json` still says `"name": "ganyiq-temp"` — should be `"name": "ganyiq"` |
| Boilerplate shell | `app/layout.tsx` still has "Create Next App" metadata — unused but harmless for API-only app |
| `globals.css` | Exists but unused by any route — can be deleted for leaner deploy |

---

## 7. RUNTIME ISSUES (on Vercel)

### Predicted Failures

| Scenario | Likelihood | Root Cause |
|---|---|---|
| First analysis request | **HIGH** | Cold start + youtubei.js cache init + 40s pipeline = Hobby plan timeout (10s) |
| Migration on deploy | **HIGH** | `readdirSync` on serverless filesystem fails |
| Analytics endpoint missing | **MEDIUM** | No `events` tracking endpoint (`POST /api/track` referenced in migration 004 but never built) |
| YouTube fetch from Vercel IP | **MEDIUM** | Vercel shared IPs may also be rate-limited by YouTube (different from DO IP) |

### Tools That Won't Work on Vercel

| Tool | Reason |
|---|---|
| `scripts/batch-analyze.ts` | Targets `localhost:3000`, must be run locally |
| `scripts/export-results.ts` | Direct DB import — local only |
| `db/migrate.ts` | Filesystem-dependent — local only |

---

## 8. CODE QUALITY OBSERVATIONS

### Import Aliases

- All imports use `@/` prefix (`@/lib/types`, `@/db/client`, etc.) ✅
- `tsconfig.json` has correct paths config ✅

### Dead Code

- `GEMINI_API_KEY` fallback in `analyzer.ts:139` — should be removed
- `globals.css` — imported in layout but unused by any route
- `app/layout.tsx` Geist font setup — unused for API-only app

### Migrations Hardcoded to "gemini-2.0-flash" Default

- `db/migrations/002_create_analyses.sql:148` — `DEFAULT 'gemini-2.0-flash'` is stale
- Doesn't break anything (overridden at INSERT time by `TARGET_MODEL`) but confusing

---

## 9. REQUIRED CHANGES BEFORE DEPLOYMENT

### 🔴 Must Fix Before Go-Live

1. **Rate limiting** — Implement IP-based rate limiting on `POST /api/analyze`
2. **Environment variables** — Set `DATABASE_URL`, `OPENCODE_GO_API_KEY`, `NEXT_PUBLIC_APP_URL` in Vercel
3. **Remove Gemini fallback** — `process.env.OPENCODE_GO_API_KEY || process.env.GEMINI_API_KEY` → just `OPENCODE_GO_API_KEY`
4. **Determine timeout strategy** — Either upgrade to Vercel Pro (60s) or implement async processing
5. **Run migrations against production DB** — Before deploy, run `npx tsx db/migrate.ts` pointing to Neon

### 🟡 Should Fix Before Go-Live

6. **Create `vercel.json`** — Minimal config with Node.js version and function timeout
7. **Fix `.gitignore`** — Add `!.env.example` exception so template is committed
8. **Update `.env.example`** — Remove Gemini, add `OPENCODE_GO_API_KEY`, fix "Neon" → "PostgreSQL"
9. **Remove `globals.css` import** from `layout.tsx` (or delete the file entirely)
10. **Rename package** in `package.json`: `"ganyiq-temp"` → `"ganyiq"`

### 🟢 Nice-to-Have

11. **Add `page.tsx` root** — Simple landing page so `https://ganyiq.vercel.app` doesn't show 404
12. **Add `middleware.ts`** — Security headers + CORS + basic rate limiting
13. **Clean `app/layout.tsx`** — Remove Geist fonts, update metadata title/description
14. **Update migration 002 default** — Change `DEFAULT 'gemini-2.0-flash'` to `'deepseek-v4-flash'`

---

## 10. DEPLOYMENT CHECKLIST

### Pre-Deploy

- [ ] Create **Neon PostgreSQL** database (or any serverless PG)
- [ ] Run `DATABASE_URL=<production-url> npx tsx db/migrate.ts` — verify all 5 tables
- [ ] Set environment variables in Vercel dashboard:
  - `DATABASE_URL` (Neon connection string with `?sslmode=require`)
  - `OPENCODE_GO_API_KEY`
  - `NEXT_PUBLIC_APP_URL` (e.g., `https://ganyiq.vercel.app`)
- [ ] Remove `GEMINI_API_KEY` fallback from `lib/analyzer.ts`
- [ ] Add `!.env.example` to `.gitignore`
- [ ] Update `.env.example` to reflect production requirements
- [ ] Create minimal `vercel.json`:
  ```json
  {
    "functions": {
      "api/analyze/route.ts": {
        "maxDuration": 60
      }
    }
  }
  ```
- [ ] Push to GitHub repository

### Deploy

- [ ] `vercel connect` — Link GitHub repo
- [ ] `vercel env add` — Add all 3 production environment variables
- [ ] `vercel --prod` — First deploy
- [ ] Verify: `curl https://ganyiq.vercel.app/api/health` → 200 OK
- [ ] Verify: `curl -X POST https://ganyiq.vercel.app/api/analyze -H "Content-Type: application/json" -d '{"url":"https://youtu.be/dQw4w9WgXcQ"}'` — runs successfully

### Post-Deploy

- [ ] Check Vercel function logs for errors
- [ ] Monitor cold start time
- [ ] Run `npx tsx scripts/batch-analyze.ts --api=https://ganyiq.vercel.app --max=5` to test batch pipeline
- [ ] Verify database writes in Neon dashboard
- [ ] Run `npx tsx scripts/export-results.ts` locally to confirm data export works

---

## 11. VERDICT

| Criterion | Status | Notes |
|---|---|---|
| Build passes | ✅ | 0 errors |
| TypeScript strict | ✅ | strict mode enabled, no errors |
| Dependencies up to date | ✅ | 96 packages, 2 moderate vulns (non-blocking) |
| DB schema complete | ✅ | 5 tables, 4 migrations applied |
| API routes functional | ✅ | health + analyze endpoints verified |
| Vercel compatible | ⚠️ | **Timeout is the blocker** — 40s+ analysis exceeds Hobby 10s limit |
| Production ready | ❌ | **Cannot deploy without addressing rate limiting + timeout** |
| Security hardened | ❌ | No rate limiting, no auth, no CORS |

### Recommendation

**Deploy after these 4 fixes:**

1. Upgrade to **Vercel Pro** ($20/mo) or implement async processing — 40s pipeline won't work on Hobby
2. Remove Gemini key fallback from `analyzer.ts`
3. Add `!.env.example` to `.gitignore`
4. Create `vercel.json` with `maxDuration: 60`

The project architecture is sound. Build is clean. Code quality is good. The deployment blockers are operational, not architectural.
