# GANYIQ — Architectural Decisions

Every decision here was made deliberately. Read before making changes.

## Infrastructure

| # | Decision | Detail |
|---|----------|--------|
| 1 | **Production stays at `/var/www/ganyiq/`** | PM2 exec cwd. Nginx reverse proxy. 1.2G with clips. Never moved. Source → Prod via `deploy.sh` rsync. |
| 2 | **Source of truth is `/root/GANYIQ/`** | Single git repo. All development happens here. This is the headquarters. |
| 3 | **Deploy ONLY via `deploy.sh`** | Rsync → npm ci → next build → pm2 restart. Never edit production files directly. |
| 4 | **No symlinks between source and production** | Independent directories. Source → Prod via copy (rsync). |
| 5 | **Repository consolidation v4 (2026-06-10)** | All scattered files (audits, docs, backups, legacy) moved under `/root/GANYIQ/` for AI discoverability. |

## Frontend

| # | Decision | Detail |
|---|----------|--------|
| 6 | **`displayScore` is cosmetic only** | Post-ranking spread applied in API response layer (`app/api/analyze/[id]/status/route.ts`). DB `worthClippingScore` unchanged. Never use `displayScore` for backend logic. |
| 7 | **Single page application** | `app/page.tsx` handles landing page, analysis progress, and results display. No client-side routing. |
| 8 | **No Tailwind CSS** | All styles in `app/globals.css` (~3600 lines). Design tokens as CSS custom properties. Dark theme, gold accent, Geist typography. |
| 9 | **95/5 color rule** | 95% grayscale surfaces, 5% gold accent (`#e8c76a`). Gold only on: scores, CTAs, active states, elite badges. |

## Engine

| # | Decision | Detail |
|---|----------|--------|
| 10 | **Scoring is parallelized** | `Promise.allSettled` with concurrency 4 across candidate batches. Do NOT change to sequential. |
| 11 | **Ranking is deterministic** | No LLM calls in ranking path. Score = initial score + boosts (multi-pass, speaker, genre). Pure arithmetic. |
| 12 | **Title generation is batched** | 1 combined LLM call for all moments (down from 15 individual calls). Saves ~67% token cost. |
| 13 | **Combined multi-pass verification** | Single LLM call for all 5 verification dimensions (hook, storytelling, controversy, education, emotion). |
| 14 | **Score compression fix is display-only** | `score-spread.ts` adjusts display scores. Ranking order unchanged. Real DB scores untouched. |
| 15 | **No fake precision** | No decimal scores in UI. Qualitative labels (Strong/High/Medium/Low) for DNA profile levels. |

## Worker

| # | Decision | Detail |
|---|----------|--------|
| 16 | **Worker heartbeat must use async `exec()`** | `execSync` blocks the Node.js event loop, preventing `setInterval` heartbeat from firing. VPS marks worker stale after 5-15 min. Always use `exec()` with `sendHeartbeatNow()`. |
| 17 | **`worker/` vs `worker-package/` are two variants** | `worker/` (VPS-side) has heartbeat support. `worker-package/` (PC-GANY) does not. They diverged because the local machine doesn't need heartbeat. |
| 18 | **Clip rendering requires PC-GANY worker** | ffmpeg is NOT installed on the VPS. Rendering is delegated to the worker machine. |

## Database

| # | Decision | Detail |
|---|----------|--------|
| 19 | **Migrations are additive only** | Never delete or modify existing columns. Add new columns/tables only. |
| 20 | **No analysis-result cache** | Only transcript is cached (`videos.transcript`). Analysis results are always recomputed. |

## Security

| # | Decision | Detail |
|---|----------|--------|
| 21 | **No cookies in git repo** | `cookies.txt` and `.env.local` are in `.gitignore`. Real cookie file is at `/etc/ganyiq/youtube-cookies.txt`. |
| 22 | **Rate limiting at API level** | `RATE_LIMIT_PER_DAY=100` in `.env.local`. Enforced by `lib/rate-limit.ts`. |
