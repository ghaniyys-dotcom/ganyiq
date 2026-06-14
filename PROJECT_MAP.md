# GANYIQ — Project Map

## Frontend (Next.js App Router)

| File | Role |
|------|------|
| `app/page.tsx` | Single page — landing page, analysis progress, results display |
| `app/layout.tsx` | Root layout — CSS imports, Geist fonts, metadata |
| `app/globals.css` | All styles (~3600 lines). Dark theme, gold accent, Geist typography |

**API Routes:**

| Endpoint | File | Function |
|----------|------|----------|
| `POST /api/analyze` | `app/api/analyze/route.ts` | Start analysis — returns `{ id }` |
| `GET /api/analyze/[id]/status` | `app/api/analyze/[id]/status/route.ts` | Polling — returns progress + results |
| `GET /api/history` | `app/api/history/route.ts` | Recent analyses list |
| `GET /api/history/[id]` | `app/api/history/[id]/route.ts` | Single analysis details |
| `POST /api/clips/[id]` | `app/api/clips/[id]/route.ts` | Generate clip (delegates to worker) |
| `GET /api/health` | `app/api/health/route.ts` | Health check |
| Worker ops | `app/api/workers/` | Worker registration, heartbeat, job poll, job complete/fail |

## Engine (`lib/`)

| File | Function |
|------|----------|
| `analyze-pipeline.ts` | Pipeline orchestrator — coordinates all stages |
| `analyzer.ts` | LLM scoring per candidate (parallelized) |
| `candidate-extraction.ts` | Transcript segmentation → candidate moments |
| `multi-pass.ts` | Multi-dimensional verification (hook, storytelling, etc.) |
| `ranking.ts` | Score computation + boost logic (deterministic) |
| `title-generator.ts` | AI title generation (1 batched LLM call) |
| `score-spread.ts` | Post-ranking display score distribution fix |
| `export-strategy.ts` | Clip trim suggestions (dead air, weak intro detection) |
| `transcript-service.ts` | YouTube transcript fetching |
| `deepgram.ts` | Deepgram speech-to-text integration (fallback) |
| `youtube.ts` | YouTube metadata + cookies |
| `cookies.ts` | Cookie auth for yt-dlp |
| `speaker-enrich.ts` | Speaker detection enrichment |
| `genre-detector.ts` | Content genre classification |
| `prompt.ts` | LLM prompt templates |
| `zombie-cleanup.ts` | Cleanup stuck analyses on startup |

## Database (`db/`)

| File | Function |
|------|----------|
| `client.ts` | PostgreSQL Pool client with error handler |
| `migrate.ts` | Migration runner |
| `migrations/` | SQL migration files |

## Worker

| Path | Role | Platform |
|------|------|----------|
| `worker/` | Clip rendering + heartbeat | VPS-side |
| `worker-package/` | Clip rendering (no heartbeat) | PC-GANY (local machine) |

## Infrastructure

| File | Role |
|------|------|
| `deploy.sh` | Production deployment — rsync + build + restart |
| `infrastructure/nginx/ganyiq.conf` | Nginx reverse proxy config (reference copy) |
| `infrastructure/README.md` | Locations of original config files |

## External Services

- **OpenCode Go API** — LLM inference (deepseek-v4-flash)
- **Deepgram** — speech-to-text (fallback when YouTube transcript unavailable)
- **YouTube** — video metadata + transcript
- **PostgreSQL** — database (localhost:5432)
- **yt-dlp** — cookie-based video download for clip rendering
