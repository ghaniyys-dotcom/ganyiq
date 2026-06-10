-- 007_create_clips_cache.sql
--
-- Adds clip generation support:
--   1. job_type column to jobs_queue (transcript | clip)
--   2. clip_params JSONB for clip job parameters
--   3. clips_cache table for rendered clip deduplication
--
-- This migration is idempotent — safe to run multiple times.

-- ── 1. Add job_type to jobs_queue ────────────────────────────────────────
ALTER TABLE jobs_queue
  ADD COLUMN IF NOT EXISTS job_type VARCHAR(20) NOT NULL DEFAULT 'transcript';

ALTER TABLE jobs_queue
  ADD COLUMN IF NOT EXISTS clip_params JSONB;

-- ── 2. Create clips_cache table ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS clips_cache (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id UUID NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  start_time NUMERIC(10,2) NOT NULL,
  end_time NUMERIC(10,2) NOT NULL,
  filename VARCHAR(255) NOT NULL,
  file_size_bytes INTEGER,
  duration_seconds NUMERIC(5,1),
  has_subtitles BOOLEAN NOT NULL DEFAULT FALSE,
  job_id UUID REFERENCES jobs_queue(id),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Unique constraint prevents duplicate renders (cache key)
CREATE UNIQUE INDEX IF NOT EXISTS idx_clips_video_start_end
  ON clips_cache(video_id, start_time, end_time);

-- Index for listing clips by analysis (via video_id)
CREATE INDEX IF NOT EXISTS idx_clips_video_id
  ON clips_cache(video_id);
