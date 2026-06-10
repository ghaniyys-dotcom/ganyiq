# GANYIQ Database Documentation
## Schema, Migrations, Indexes, Constraints

**Database:** Neon PostgreSQL (serverless, Singapore region)
**Connection:** `DATABASE_URL` env var, sslmode=require
**Client:** `@neondatabase/serverless` via `pg` pool

---

## Table of Contents

1. [Table: `videos`](#1-table-videos)
2. [Table: `analyses`](#2-table-analyses)
3. [Table: `moments`](#3-table-moments)
4. [Table: `events`](#4-table-events)
5. [Table: `workers`](#5-table-workers)
6. [Table: `jobs_queue`](#6-table-jobs_queue)
7. [Table: `clips_cache`](#7-table-clips_cache)
8. [Table: `_migrations`](#8-table-_migrations)
9. [Entity Relationships](#9-entity-relationships)
10. [Index Summary](#10-index-summary)
11. [Migration History](#11-migration-history)

---

## 1. Table: `videos`

Caches YouTube video metadata and transcript to avoid re-fetching.

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | UUID | PK, DEFAULT `gen_random_uuid()` | Primary key |
| `youtube_id` | VARCHAR(20) | UNIQUE NOT NULL | 11-char YouTube ID |
| `title` | TEXT | | Video title |
| `channel_name` | VARCHAR(255) | | Channel name |
| `duration_seconds` | INT | | Total length in seconds |
| `transcript` | JSONB | | Full transcript segments array |
| `fetched_at` | TIMESTAMPTZ | DEFAULT NOW() | When data was fetched |

**Indexes:**
- `idx_videos_youtube_id` — UNIQUE B-tree on `youtube_id`

**Relations:**
- `videos(1) ──→ analyses(N)` via `analyses.video_id`
- `videos(1) ──→ clips_cache(N)` via `clips_cache.video_id`

---

## 2. Table: `analyses`

Records every URL analysis submission. Central junction table.

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | UUID | PK, DEFAULT `gen_random_uuid()` | Primary key |
| `video_id` | UUID | NOT NULL, FK → `videos(id)` | Which video was analyzed |
| `ip_address` | VARCHAR(45) | | Client IP for rate limiting |
| `total_moments_found` | INT | | Number of moments returned |
| `processing_time_ms` | INT | | Pipeline wall-clock in ms |
| `llm_model` | VARCHAR(50) | DEFAULT `'gemini-2.0-flash'` | Model used for scoring |
| `prompt_version` | VARCHAR(20) | DEFAULT `'mvp-v1'` | Prompt template version |
| `raw_llm_response` | JSONB | | Full LLM response verbatim |
| `status` | VARCHAR(20) | DEFAULT `'completed'`, CHECK (`'pending'`, `'completed'`, `'failed'`) | Pipeline status |
| `error_message` | TEXT | | Error description when failed |
| `transcript_source` | VARCHAR(20) | DEFAULT `'youtube'`, CHECK (`'youtube'`, `'deepgram'`) | Added in migration 005 |
| `created_at` | TIMESTAMPTZ | DEFAULT NOW() | Submission timestamp |

**Indexes:**
- `idx_analyses_video_id` — B-tree on `video_id`
- `idx_analyses_created_at` — B-tree DESC on `created_at`

**Relations:**
- `analyses(N) ──→ videos(1)` via `video_id`
- `analyses(1) ──→ moments(N)` via `moments.analysis_id` (ON DELETE CASCADE)
- `analyses(1) ──→ events(N)` via `events.analysis_id`

**Size estimate:** ~200 bytes/row. At 1000 analyses/week → ~200KB/week.

---

## 3. Table: `moments`

Stores every ranked clip moment discovered by the analysis pipeline.

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | UUID | PK, DEFAULT `gen_random_uuid()` | Primary key |
| `analysis_id` | UUID | NOT NULL, FK → `analyses(id)` ON DELETE CASCADE | Parent analysis |
| `start_time` | NUMERIC(10,2) | NOT NULL | Clip start in seconds |
| `end_time` | NUMERIC(10,2) | NOT NULL | Clip end in seconds |
| `worth_clipping_score` | NUMERIC(5,2) | NOT NULL | Score 0.00-100.00 |
| `confidence` | VARCHAR(10) | NOT NULL, CHECK (`'high'`, `'medium'`, `'low'`) | LLM certainty |
| `dna_tags` | JSONB | NOT NULL | Array of up to 3 DNA tags |
| `reasoning` | TEXT | | Why this moment was chosen |
| `transcript_excerpt` | TEXT | | Extracted transcript text |
| `rank_position` | INT | | 1-based rank within analysis |
| `tier` | VARCHAR(10) | CHECK (`'elite'`, `'secondary'`) | Quality tier |

**Indexes:**
- `idx_moments_analysis_id` — B-tree on `analysis_id`
- `idx_moments_score` — B-tree DESC on `worth_clipping_score`

**Relations:**
- `moments(N) ──→ analyses(1)` via `analysis_id` (CASCADE on delete)

**Size estimate:** ~200 bytes/row. 10-15 rows per analysis.

---

## 4. Table: `events`

Tracks user interaction events for MVP analytics (append-only).

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | UUID | PK, DEFAULT `gen_random_uuid()` | Primary key |
| `analysis_id` | UUID | FK → `analyses(id)` | Nullable for pre-analysis events |
| `event_type` | VARCHAR(50) | NOT NULL | `timestamp_click`, `copy_timestamp`, `page_view` |
| `metadata` | JSONB | | Event-specific payload |
| `ip_address` | VARCHAR(45) | | Client IP |
| `created_at` | TIMESTAMPTZ | DEFAULT NOW() | Timestamp |

**Indexes:**
- `idx_events_analysis_id` — B-tree on `analysis_id`
- `idx_events_type` — B-tree on `event_type`

**Note:** Append-only. No UPDATE, no DELETE. Estimated ~5K rows/week at MVP scale.

---

## 5. Table: `workers`

Registered residential worker agents.

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | UUID | PK, DEFAULT `gen_random_uuid()` | Primary key |
| `worker_name` | VARCHAR(100) | UNIQUE NOT NULL | Human-friendly name |
| `version` | VARCHAR(20) | DEFAULT `'WORKER-v1.0.0'` | Worker agent version |
| `status` | VARCHAR(20) | DEFAULT `'offline'`, CHECK (`'online'`, `'offline'`) | Online/offline |
| `last_heartbeat` | TIMESTAMPTZ | | Last keepalive timestamp |
| `api_key_hash` | VARCHAR(64) | NOT NULL | SHA-256 of API key (hex) |
| `jobs_completed` | INTEGER | DEFAULT 0 | Lifetime completed jobs |
| `jobs_failed` | INTEGER | DEFAULT 0 | Lifetime failed jobs |
| `created_at` | TIMESTAMPTZ | DEFAULT NOW() | Registration timestamp |
| `updated_at` | TIMESTAMPTZ | DEFAULT NOW() | Last update timestamp |

**Note:** API key is returned **once** on registration. No way to recover — must re-register.

---

## 6. Table: `jobs_queue`

Durable job queue for worker tasks (transcript acquisition + clip rendering).

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | UUID | PK, DEFAULT `gen_random_uuid()` | Primary key |
| `youtube_id` | VARCHAR(20) | NOT NULL | YouTube video ID |
| `youtube_url` | TEXT | NOT NULL | Full YouTube URL |
| `job_type` | VARCHAR(20) | DEFAULT `'transcript'` | `'transcript'` or `'clip'` |
| `clip_params` | JSONB | | Clip parameters (start/end/renderMode) |
| `worker_id` | UUID | FK → `workers(id)` | Claiming worker |
| `claimed_at` | TIMESTAMPTZ | | When worker claimed |
| `status` | VARCHAR(20) | DEFAULT `'pending'`, CHECK (`'pending'`, `'claimed'`, `'completed'`, `'failed'`) | Job state |
| `result` | JSONB | | Completed result data |
| `error_message` | TEXT | | Error if failed |
| `transcript_source` | VARCHAR(20) | | Source of transcript |
| `confidence` | NUMERIC(4,3) | | Transcript confidence |
| `full_transcript` | TEXT | | Full text transcript |
| `duration_ms` | INTEGER | | Processing duration |
| `created_at` | TIMESTAMPTZ | DEFAULT NOW() | Creation timestamp |
| `updated_at` | TIMESTAMPTZ | DEFAULT NOW() | Last update |
| `completed_at` | TIMESTAMPTZ | | Completion timestamp |
| `retry_count` | INTEGER | DEFAULT 0 | Current retry number |
| `max_retries` | INTEGER | DEFAULT 3 | Maximum retry attempts |

**Indexes:**
- `idx_jobs_queue_poll` — Partial B-tree on `created_at` WHERE `status = 'pending' AND retry_count < max_retries`
- `idx_jobs_queue_stale` — Partial B-tree on `claimed_at` WHERE `status = 'claimed'`
- `idx_jobs_queue_youtube` — B-tree on `(youtube_id, status)`

---

## 7. Table: `clips_cache`

Rendered clip deduplication and storage.

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | UUID | PK, DEFAULT `gen_random_uuid()` | Primary key |
| `video_id` | UUID | NOT NULL, FK → `videos(id)` ON DELETE CASCADE | Source video |
| `start_time` | NUMERIC(10,2) | NOT NULL | Clip start in seconds |
| `end_time` | NUMERIC(10,2) | NOT NULL | Clip end in seconds |
| `filename` | VARCHAR(255) | NOT NULL | MP4 filename |
| `file_size_bytes` | INTEGER | | File size |
| `duration_seconds` | NUMERIC(5,1) | | Clip duration |
| `render_mode` | VARCHAR(10) | DEFAULT `'landscape'`, CHECK (`'landscape'`, `'vertical'`) | Output aspect ratio |
| `has_subtitles` | BOOLEAN | DEFAULT FALSE | Subtitle presence |
| `job_id` | UUID | FK → `jobs_queue(id)` | Source job |
| `created_at` | TIMESTAMPTZ | DEFAULT NOW() | Creation timestamp |

**Indexes:**
- `idx_clips_video_start_end_render` — UNIQUE B-tree on `(video_id, start_time, end_time, render_mode)` (cache dedup key)
- `idx_clips_video_id` — B-tree on `video_id`

---

## 8. Table: `_migrations`

Tracks applied database migrations (internal).

| Column | Type | Constraints | Description |
|---|---|---|---|
| `filename` | VARCHAR(255) | PK | Migration file name |
| `executed_at` | TIMESTAMPTZ | DEFAULT NOW() | When applied |

**Note:** Created by `db/migrate.ts`. Not idempotent via `CREATE TABLE IF NOT EXISTS` — all migration SQL uses `IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS` guards.

---

## 9. Entity Relationships

```
videos
  │
  ├──1:N── analyses (via video_id)
  │          │
  │          ├──1:N── moments (via analysis_id) → ON DELETE CASCADE
  │          │
  │          └──1:N── events (via analysis_id) → nullable
  │
  └──1:N── clips_cache (via video_id) → ON DELETE CASCADE
              │
              └──N:1── jobs_queue (via job_id) → nullable

workers
  │
  └──1:N── jobs_queue (via worker_id) → nullable

jobs_queue
  │
  ├──1:1── clips_cache (via job_id) → nullable
  │
  └──N:1── workers (via worker_id)
```

---

## 10. Index Summary

| Index Name | Table | Columns | Type | Purpose |
|---|---|---|---|---|
| `idx_videos_youtube_id` | videos | youtube_id | UNIQUE B-tree | Dedup + lookup |
| `idx_analyses_video_id` | analyses | video_id | B-tree | Analyses per video |
| `idx_analyses_created_at` | analyses | created_at | B-tree DESC | Recent analysis listing |
| `idx_moments_analysis_id` | moments | analysis_id | B-tree | Moments per analysis |
| `idx_moments_score` | moments | worth_clipping_score | B-tree DESC | Top moments query |
| `idx_events_analysis_id` | events | analysis_id | B-tree | Per-analysis events |
| `idx_events_type` | events | event_type | B-tree | Event type grouping |
| `idx_jobs_queue_poll` | jobs_queue | created_at | Partial B-tree | Worker polling (pending only) |
| `idx_jobs_queue_stale` | jobs_queue | claimed_at | Partial B-tree | Stale job recovery |
| `idx_jobs_queue_youtube` | jobs_queue | youtube_id, status | B-tree | Duplicate job detection |
| `idx_clips_video_start_end_render` | clips_cache | video_id, start_time, end_time, render_mode | UNIQUE B-tree | Cache dedup |
| `idx_clips_video_id` | clips_cache | video_id | B-tree | Clips per video |

---

## 11. Migration History

| # | File | Description |
|---|---|---|
| 001 | `001_create_videos.sql` | Video metadata + transcript cache (JSONB) |
| 002 | `002_create_analyses.sql` | Analysis records, FK to videos |
| 003 | `003_create_moments.sql` | Ranked moments, FK to analyses (CASCADE) |
| 004 | `004_create_events.sql` | User interaction events (analytics) |
| 005 | `005_add_transcript_source.sql` | ALTER analyses ADD transcript_source column |
| 006 | `006_create_jobs_queue.sql` | Workers table + jobs_queue |
| 007 | `007_create_clips_cache.sql` | Clips cache + job_type/clip_params on jobs_queue |
| 008 | `008_add_render_mode.sql` | Render mode column + updated cache unique index |

**Total: 8 migrations, creating 7 user tables + 1 internal table.**
