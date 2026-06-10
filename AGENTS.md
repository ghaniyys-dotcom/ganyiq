# GANYIQ — AI Agent Context

## What is GANYIQ

AI-powered clip discovery engine. Analyzes long-form YouTube videos, identifies 15 most clip-worthy moments. Deterministic ranking (no LLM), parallel scoring.

## Stack

| Component | Technology |
|-----------|------------|
| Frontend | Next.js 16.2.7 (App Router) |
| Styling | Plain CSS — `app/globals.css`, no Tailwind |
| Font | Geist (Google Fonts) |
| Database | PostgreSQL (localhost:5432) — `pg` + `@neondatabase/serverless` |
| LLM | deepseek-v4-flash via OpenCode Go (`@google/genai`) |
| STT | Deepgram nova-2, language `id` (fallback) |
| Video | yt-dlp + ffmpeg (workers only — not on VPS) |
| Runtime | PM2 + Nginx — port 3003, `ganyiq.ganys.me` |

## Sources of Truth

- **Source code:** `/root/GANYIQ/` — single git repo
- **Production:** `/var/www/ganyiq/` — PM2 cwd, ~1.2G runtime data
- **Config:** `.env.local` (dev), `.env.example` (template)

**Never edit production directly.** Always deploy via `deploy.sh`.

## Commands

| Action | Run this |
|--------|----------|
| Dev server | `npm run dev` |
| Production build | `npm run build` |
| TypeScript check | `npx tsc --noEmit` |
| Run migration | `npx tsx db/migrate.ts` |
| Run script | `npx tsx scripts/<name>.ts` |
| VPS worker | `cd worker && npx tsx index.ts` |
| PC-GANY worker | `cd worker-package && npx tsx index.ts` |

**No tests, linter, or formatter configured.** Type check is the only verification.

## Environment

Required in `.env.local`:
- `DATABASE_URL` — PostgreSQL connection string
- `OPENCODE_GO_API_KEY` — LLM API key
- `RATE_LIMIT_PER_DAY` — default 100
- `NEXT_PUBLIC_APP_URL` — default `http://localhost:3000`

## TypeScript

- `@/*` path alias maps to project root
- Strict mode enabled; target ES2017
- Main `tsconfig.json` excludes `scripts/`, `proof/`, `eval/`, `worker/`, `legacy/` from typecheck
- `worker/` and `worker-package/` each have their own `tsconfig.json` and `package.json` — independent TS projects

## Frontend

- Single page app: all UI in `app/page.tsx` (`'use client'`), all styles in `app/globals.css`
- Dark theme, gold accent `#e2c266`. 95/5 rule: 95% grayscale, 5% gold (scores, CTAs, active states, badges)
- No Tailwind, no client-side routing. Geist Sans + Geist Mono from Google Fonts
- Design tokens: `--surface-page`, `--accent`, `--shadow-*`, `--radius-*`, `--transition-*`

## API Routes

| Endpoint | File | Purpose |
|----------|------|---------|
| `POST /api/analyze` | `app/api/analyze/route.ts` | Start analysis → returns `{ id }` (202) |
| `GET /api/analyze/[id]/status` | `.../status/route.ts` | Poll progress + results (2s polling) |
| `GET /api/history` | `app/api/history/route.ts` | Recent analyses |
| `GET /api/health` | `app/api/health/route.ts` | Health check (DB connectivity) |
| `POST /api/clips/[id]` | `app/api/clips/[id]/route.ts` | Generate clip (delegates to worker) |
| Worker ops | `app/api/workers/` | Register, heartbeat, job poll, complete/fail |

## Engine (`lib/`) — Pipeline Order

1. `candidate-extraction.ts` — transcript → candidate moments (deterministic)
2. `analyzer.ts` — LLM scoring (parallel, concurrency 4 via `Promise.allSettled`)
3. `multi-pass.ts` — 1 combined LLM call covering 5 verification dimensions
4. `ranking.ts` — final score computation (deterministic — NO LLM calls)
5. `title-generator.ts` — AI titles (1 batched LLM call, fire-and-forget)
6. `score-spread.ts` — display-only score spread (DB `worthClippingScore` unchanged)
7. `analyze-pipeline.ts` — orchestrator, coordinates all stages, updates DB

## Workers

Two variants in separate TS projects:
- `worker/` (VPS-side) — has heartbeat via `sendHeartbeatNow()` every 60s
- `worker-package/` (PC-GANY, local machine) — no heartbeat (legacy variant)

**Cli:** Heartbeat uses async `exec()`. `execSync` blocks the Node event loop, preventing `setInterval` from firing — VPS marks worker stale after 5-15 min.
**Cli:** ffmpeg is NOT on the VPS. Clip rendering requires the PC-GANY worker.

## Deploy

```bash
bash deploy.sh                        # Full: rsync → npm ci → build → restart
bash deploy.sh --quick                # Restart only (static/style changes)
bash deploy.sh --rollback HEAD~1      # Rollback + full build
```

Post-deploy check: `curl https://ganyiq.ganys.me/api/health`

## Hard Rules (do not violate)

1. **Never edit `/var/www/ganyiq/` directly** — always use `deploy.sh`
2. **Never change DB schema** without additive migration (no drops/modifications)
3. **Never modify production `.env.local`** without backup and approval
4. **Never change Nginx config** without testing on staging first
5. **Never remove `displayScore` cosmetic layer** — real scores in DB are unchanged
6. **Never put LLM calls in ranking path** — ranking must stay deterministic pure arithmetic
7. **Always use async `exec()` for worker commands** — `execSync` blocks heartbeat
8. **Always deploy via `deploy.sh`** — never scp or manual rsync
9. **Never commit secrets** — `.env.local`, `cookies.txt` gitignored; real cookies at `/etc/ganyiq/youtube-cookies.txt`
