# GANYIQ — Architecture

## System Flow

```
User (Browser)
    │
    ▼
Frontend — app/page.tsx
    │ POST /api/analyze
    ▼
Analyze API — app/api/analyze/route.ts
    │
    ▼
analyze-pipeline.ts (orchestrator)
    │
    ├── 1. Transcript Acquisition
    │       ├── YouTube transcript API (primary)
    │       └── Deepgram STT (fallback)
    │
    ├── 2. Candidate Extraction (candidate-extraction.ts)
    │       Segmen transkrip → candidate moments with timestamps
    │
    ├── 3. LLM Scoring (analyzer.ts)
    │       Parallelized with Promise.allSettled (concurrency 4)
    │       Each candidate → score 0-100 + DNA tags + reasoning
    │
    ├── 4. Multi-Pass Verification (multi-pass.ts)
    │       1 combined LLM call covering all 5 dimensions:
    │       hookPower, storytelling, controversy, education, emotion
    │       + cross-pass reinforcement
    │
    ├── 5. Ranking (ranking.ts)
    │       Deterministic (no LLM calls):
    │       initial score + multi-pass bonus + speaker boost + genre boost
    │       → final worthClippingScore (capped at 100)
    │
    ├── 6. DB Storage
    │       INSERT moments, UPDATE analysis status
    │
    └── 7. Title Generation (title-generator.ts)
            1 combined LLM call for all moments (fire-and-forget)
            Cached in moments.suggested_titles (JSONB)
    
    │ (polling every 2s)
    ▼
Frontend — GET /api/analyze/[id]/status
    │
    ├── Progress → live-intel cards
    ├── Results → moments array (with displayScore applied)
    └── Error → error display with retry
```

## Key Design Decisions

| Decision | Detail |
|----------|--------|
| **Scoring is parallel** | `Promise.allSettled` with concurrency 4 across 3 batches |
| **Ranking is deterministic** | No LLM calls — pure arithmetic on scores + boosts |
| **Titles are batched** | 1 combined LLM call for all moments (was 15 separate calls) |
| **displayScore is cosmetic** | Post-ranking spread applied only in API response. DB stored `worthClippingScore` unchanged |
| **Production is separate** | Source at `/root/GANYIQ/`, runtime at `/var/www/ganyiq/`. Deploy via rsync |

## Database (PostgreSQL)

**Core tables:**
- `analyses` — analysis runs (id, video_id, status, timestamps)
- `moments` — scored clip candidates (rank, score, dna_tags, transcript, suggested_titles)
- `videos` — video metadata (title, channel, transcript cache)
- `events` — usage analytics

**Key fields on `moments`:**
- `worth_clipping_score` — real score (0-100). This is the source of truth.
- `rank_position` — rank after sorting by score
- `dna_tags` — text[] of category tags
- `suggested_titles` — JSONB cache of AI-generated titles
- `transcript_excerpt` — snippet of transcript for this moment
- `reasoning` — LLM reasoning for the score

## Production Architecture

```
                         ┌──────────────┐
                         │  Cloudflare   │
                         │  DNS          │
                         └──────┬───────┘
                                │ ganyiq.ganys.me
                         ┌──────▼───────┐
                         │    Nginx     │ (port 443 → 3003)
                         │  (SSL term)  │
                         └──────┬───────┘
                                │ proxy_pass
                         ┌──────▼───────┐
                         │  Next.js     │
                         │  (port 3003) │
                         │  PM2 managed │
                         └──────┬───────┘
                                │
                         ┌──────▼───────┐
                         │  PostgreSQL  │
                         │  (port 5432) │
                         └──────────────┘
```

## Deployment Flow

```
/root/GANYIQ/          bash deploy.sh          /var/www/ganyiq/
(source)               ──────────────────►     (production)
  app/                 rsync -av --delete        app/
  lib/                                           lib/
  db/                                            db/
  public/                                        public/
  package.json                                   package.json
                       npx next build            .next/
                       pm2 restart               (serving on :3003)
```
