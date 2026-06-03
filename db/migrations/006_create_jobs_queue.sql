-- db/migrations/006_create_jobs_queue.sql
--
-- Durable job queue for residential-worker transcript acquisition.
--
-- Workers table: registered worker agents (PC-GANY, LAPTOP-GANY, etc.)
-- jobs_queue table: YouTube transcript jobs for remote workers to claim.

-- -----------------------------------------------------------------------
-- 1. Workers table
-- -----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS workers (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_name     VARCHAR(100) NOT NULL UNIQUE,
  version         VARCHAR(20)  NOT NULL DEFAULT 'WORKER-v1.0.0',
  status          VARCHAR(20)  NOT NULL DEFAULT 'offline'
                  CHECK (status IN ('online', 'offline')),
  last_heartbeat  TIMESTAMPTZ,
  api_key_hash    VARCHAR(64)  NOT NULL,
  jobs_completed  INTEGER      NOT NULL DEFAULT 0,
  jobs_failed     INTEGER      NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE workers IS 'Registered residential worker agents for transcript acquisition';
COMMENT ON COLUMN workers.api_key_hash IS 'SHA-256 hash of worker API key (hex, 64 chars)';
COMMENT ON COLUMN workers.status IS 'online = heartbeat within 5 min, offline = stale';

-- -----------------------------------------------------------------------
-- 2. jobs_queue table
-- -----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS jobs_queue (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  youtube_id        VARCHAR(20)  NOT NULL,
  youtube_url       TEXT         NOT NULL,
  worker_id         UUID         REFERENCES workers(id),
  claimed_at        TIMESTAMPTZ,
  status            VARCHAR(20)  NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'claimed', 'completed', 'failed')),
  result            JSONB,
  error_message     TEXT,
  transcript_source VARCHAR(20),
  confidence        NUMERIC(4,3),
  full_transcript   TEXT,
  duration_ms       INTEGER,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  completed_at      TIMESTAMPTZ,
  retry_count       INTEGER      NOT NULL DEFAULT 0,
  max_retries       INTEGER      NOT NULL DEFAULT 3
);

COMMENT ON TABLE jobs_queue IS 'YouTube transcript jobs for residential workers to claim and process';

-- Index for atomic polling (pending jobs sorted by age)
CREATE INDEX IF NOT EXISTS idx_jobs_queue_poll
  ON jobs_queue (created_at)
  WHERE status = 'pending' AND retry_count < max_retries;

-- Index for stale job detection (claimed jobs past heartbeat window)
CREATE INDEX IF NOT EXISTS idx_jobs_queue_stale
  ON jobs_queue (claimed_at)
  WHERE status = 'claimed';

-- Index for dedup check (find existing job for a video)
CREATE INDEX IF NOT EXISTS idx_jobs_queue_youtube
  ON jobs_queue (youtube_id, status);
