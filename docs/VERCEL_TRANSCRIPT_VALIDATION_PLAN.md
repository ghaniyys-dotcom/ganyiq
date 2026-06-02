# Vercel Transcript Validation Plan

> **Date:** 2026-06-02 12:40 WIB
> **Goal:** Determine whether transcript acquisition blocker is specific to DigitalOcean IP reputation
> **Method:** Deploy identical codebase to Vercel, test same 5 videos, compare results
> **Budget:** $0 (Vercel Hobby + Neon Free Tier)

---

## 1. Hypothesis

```
Null:  Vercel transcript acquisition fails → architecture problem, not IP
Alt:   Vercel transcript acquisition succeeds → DO IP reputation confirmed
```

---

## 2. Pre-Deployment Checklist

### Code Readiness

| Item | Status | Action |
|---|---|---|
| Build passes | ✅ Verified | `next build` compiles successfully |
| Routes defined | ✅ `/api/analyze`, `/api/health` | API-only deployment |
| `.gitignore` correct | ✅ `.env*`, `cookies.txt` excluded | No secrets in git |
| GitHub remote | ✅ `ghaniyys-dotcom/ganyiq.git` | Push latest code |
| Vercel config | ✅ `vercel.json` with `sin1` region | Singapore proximity |
| Cookie dependency | ✅ Not required for test | Will test WITHOUT cookies first |

### Environment Variables Required on Vercel

| Variable | Required? | Source | Purpose |
|---|---|---|---|
| `DATABASE_URL` | ✅ YES | Neon (see step 3) | Serverless PostgreSQL for cache + analytics |
| `OPENCODE_GO_API_KEY` | ✅ YES | Current `.env.local` | LLM analysis (DeepSeek V4 Flash) |
| `NEXT_PUBLIC_APP_URL` | ✅ YES | `https://ganyiq.vercel.app` | App URL for rate limiting |
| `RATE_LIMIT_PER_DAY` | ✅ YES | `10` | Rate limiting |
| `COOKIE_FILE` | ❌ NO | Not needed for IP test | Skip — test raw IP access |

### Total: 4 environment variables

---

## 3. Database: Neon Setup (Free Tier)

### Why Neon?

The current code uses `pg` Pool with `DATABASE_URL`. Vercel serverless functions need a reachable PostgreSQL. Neon is serverless PostgreSQL with a free tier.

### Setup Steps (Gany does this)

1. Go to https://neon.tech
2. Sign up with GitHub
3. Create project → name: `ganyiq`
4. Region: **Singapore** (ap-southeast-1)
5. Copy connection string:
   ```
   postgresql://ganyiq_owner:***@ep-xxxx.ap-southeast-1.aws.neon.tech/ganyiq?sslmode=require
   ```

### Migration Steps (I do this after DB is ready)

```bash
# From VPS: set Neon URL, run migrations
DATABASE_URL="postgresql://..." npx tsx /root/GANYIQ/db/migrate.ts
```

Or via Neon SQL Editor:
- Copy each file from `db/migrations/` sequentially:
  1. `001_create_videos.sql`
  2. `002_create_analyses.sql`
  3. `003_create_moments.sql`
  4. `004_create_events.sql`

---

## 4. Vercel Deployment Steps

### Step A: Push Latest Code (I do from VPS)

```bash
cd /root/GANYIQ
# Sync latest changes from /var/www/ganyiq (deployment has fixes)
rsync -av /var/www/ganyiq/lib/ /root/GANYIQ/lib/
rsync -av /var/www/ganyiq/app/ /root/GANYIQ/app/
rsync -av /var/www/ganyiq/db/ /root/GANYIQ/db/
cp /var/www/ganyiq/tsconfig.json /root/GANYIQ/tsconfig.json

# Verify build
cd /root/GANYIQ && npx next build

# Push to GitHub
git add -A
git commit -m "deploy: timeout safety + cookie fallback fix + timing logs"
git push origin main
```

### Step B: Vercel Project Setup (Gany does from browser)

1. Go to https://vercel.com
2. Login with GitHub
3. Dashboard → **Add New → Project**
4. Import repo: `ghaniyys-dotcom/ganyiq`
5. Configure project:

| Setting | Value |
|---|---|
| Framework Preset | Next.js (auto-detected) |
| Root Directory | `./` (default) |
| Build Command | `next build` (default) |
| Output Directory | `next start` (default) |
| Region | Singapore (sin1) |

6. Add Environment Variables:

| Key | Value | Environment |
|---|---|---|
| `DATABASE_URL` | `postgresql://...` from Neon | Production |
| `OPENCODE_GO_API_KEY` | Copy from `.env.local` | Production |
| `NEXT_PUBLIC_APP_URL` | `https://ganyiq.vercel.app` | Production |
| `RATE_LIMIT_PER_DAY` | `10` | Production |

7. Click **Deploy** 🚀

### Step C: Run DB Migrations (Gany or I do)

After deploy succeeds:

**Option 1: Via Vercel CLI**
```bash
npm i -g vercel
vercel login
vercel link --project ganyiq
vercel env pull .env.production
DATABASE_URL=$(grep DATABASE_URL .env.production) npx tsx db/migrate.ts
```

**Option 2: Via Neon SQL Editor**
Open Neon dashboard → SQL Editor → paste each migration file content

**Option 3: Via VPS (if DATABASE_URL is shared)**
```bash
DATABASE_URL="postgresql://..." npx tsx db/migrate.ts
```

### Step D: Verify Deployment

```bash
# Health check
curl https://ganyiq.vercel.app/api/health

# Test analysis
curl -X POST https://ganyiq.vercel.app/api/analyze \
  -H "Content-Type: application/json" \
  -d '{"url":"https://www.youtube.com/watch?v=ydE9TD6vhE8"}'
```

---

## 5. Test Plan: 5 Indonesian Videos

### Video Selection

| ID | Channel | Category | Video ID | DO Result |
|---|---|---|---|---|
| CON-02 | Raditya Dika | controversy | `ydE9TD6vhE8` | ❌ LOGIN_REQUIRED |
| BUS-01 | Fellexandro Ruby | business | `2QFV58h8BsU` | ❌ LOGIN_REQUIRED |
| MOT-01 | Mario Teguh Official | motivation | `y10GDKyPmfg` | ❌ LOGIN_REQUIRED |
| STL-01 | Curhat Bang | storytelling | `6AaD_80wh4g` | ❌ LOGIN_REQUIRED |
| FIN-02 | Deddy Corbuzier | finance | `E5ctwVEl4KM` | ❌ LOGIN_REQUIRED |

### Test Command

```bash
for vid in ydE9TD6vhE8 2QFV58h8BsU y10GDKyPmfg 6AaD_80wh4g E5ctwVEl4KM; do
  echo "=== $vid ==="
  curl -s -w "\nHTTP:%{http_code}\n" -X POST https://ganyiq.vercel.app/api/analyze \
    -H "Content-Type: application/json" \
    -d "{\"url\":\"https://www.youtube.com/watch?v=$vid\"}" \
    --max-time 60
  echo ""
done
```

### Expected Outcomes

| Scenario | DO VPS Result | Vercel Result | Conclusion |
|---|---|---|---|
| **Best case** | ❌ FAIL | ✅ SUCCESS | 🟢 **IP reputation confirmed** — DO IP blocked, Vercel IP allowed |
| **Worst case** | ❌ FAIL | ❌ FAIL | 🔴 **Architecture problem** — YouTube blocks all cloud IPs |
| **Partial** | ❌ FAIL | ⚠️ Some SUCCESS | 🟡 **Vercel IP partially blocked** — need proxy anyway |

### If Vercel Succeeds (Expected)

```
Root cause: DigitalOcean IP reputation
Solution: Deploy to Vercel permanently, or use residential proxy from DO
Cost savings: ~$5/month proxy NOT needed if Vercel works
```

### If Vercel Also Fails

```
Root cause: YouTube blocks ALL cloud provider IPs
Solution: Residential proxy or Whisper API regardless of hosting
Next step: Test residential proxy (~$5/month trial)
```

---

## 6. Cost Analysis

| Item | Cost | Who Pays |
|---|---|---|
| Vercel Hobby | Free | Auto (GitHub signup) |
| Neon Free Tier | Free (0.5GB) | Auto (GitHub signup) |
| Custom domain | Already owned (`ganys.me`) | Gany |
| **Total test cost** | **$0** | — |

---

## 7. Rollback Plan

If Vercel deployment causes issues:

1. Delete Vercel project (1 click in dashboard)
2. Stop Neon database (1 click)
3. No changes to current DO deployment (PM2 still running)
4. Revert git commit if needed

---

## 8. Quick Reference

### Time Estimate

| Step | Who | Time |
|---|---|---|
| Sync code + git push | Me | 5 min |
| Create Neon database | Gany | 5 min |
| Create Vercel project | Gany | 5 min |
| Set env vars on Vercel | Gany | 3 min |
| Run migrations | Either | 2 min |
| Test 5 videos | Either | 5 min |
| **Total** | — | **~25 min** |

### Support Commands

```bash
# Check Vercel deployment logs
vercel logs ganyiq.vercel.app

# Check build logs
vercel --prod

# Redeploy
git commit --allow-empty -m "redeploy" && git push origin main
```
