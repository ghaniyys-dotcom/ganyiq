-- db/migrations/008_add_render_mode.sql
--
-- Adds render_mode column (landscape | vertical) to:
--   1. jobs_queue  — stored inside clip_params JSONB as renderMode
--   2. clips_cache — dedicated column for persistent storage
--
-- This enables the Vertical Shorts (9:16) mode while preserving
-- backward compatibility: NULL/absent defaults to 'landscape'.

-- ── 1. Add render_mode to clips_cache ─────────────────────────────────────
ALTER TABLE clips_cache
  ADD COLUMN IF NOT EXISTS render_mode VARCHAR(10) NOT NULL DEFAULT 'landscape'
  CHECK (render_mode IN ('landscape', 'vertical'));

COMMENT ON COLUMN clips_cache.render_mode IS
  'Output aspect ratio: landscape (16:9) or vertical (9:16 shorts)';

-- ── 2. Update unique constraint to include render_mode ────────────────────
-- Drop the old unique index that didn't include render_mode
DROP INDEX IF EXISTS idx_clips_video_start_end;

-- Recreate with render_mode so same clip in two orientations can coexist
CREATE UNIQUE INDEX IF NOT EXISTS idx_clips_video_start_end_render
  ON clips_cache(video_id, start_time, end_time, render_mode);

COMMENT ON INDEX idx_clips_video_start_end_render IS
  'Cache dedup key now includes render_mode — same moment can be cached as both landscape and vertical';
