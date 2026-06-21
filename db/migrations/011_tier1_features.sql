-- Phase 1 — Tier 1 Features
-- Scene detection, visual quality scoring, viral moment detection, B-roll infrastructure

-- 1. Scenes table
CREATE TABLE IF NOT EXISTS scenes (
  id SERIAL PRIMARY KEY,
  analysis_id TEXT NOT NULL,
  video_id TEXT NOT NULL,
  scene_index INTEGER NOT NULL,
  start_time NUMERIC(10,3) NOT NULL,
  end_time NUMERIC(10,3) NOT NULL,
  duration NUMERIC(10,3) NOT NULL,
  score NUMERIC(5,4) DEFAULT 0,
  transition_type TEXT DEFAULT 'unknown',
  avg_brightness NUMERIC(5,4),
  avg_sharpness NUMERIC(5,4),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_scenes_analysis ON scenes (analysis_id);
CREATE INDEX IF NOT EXISTS idx_scenes_video ON scenes (video_id);

-- 2. Visual quality scores per moment
ALTER TABLE moments
ADD COLUMN IF NOT EXISTS visual_quality_score NUMERIC(4,1) DEFAULT NULL,
ADD COLUMN IF NOT EXISTS sharpness NUMERIC(5,4) DEFAULT NULL,
ADD COLUMN IF NOT EXISTS brightness NUMERIC(5,4) DEFAULT NULL,
ADD COLUMN IF NOT EXISTS exposure NUMERIC(5,4) DEFAULT NULL,
ADD COLUMN IF NOT EXISTS face_visibility NUMERIC(5,4) DEFAULT NULL,
ADD COLUMN IF NOT EXISTS blur_score NUMERIC(5,4) DEFAULT NULL;

-- 3. Viral moment scores per moment
ALTER TABLE moments
ADD COLUMN IF NOT EXISTS viral_score NUMERIC(4,1) DEFAULT NULL,
ADD COLUMN IF NOT EXISTS hook_strength NUMERIC(4,1) DEFAULT NULL,
ADD COLUMN IF NOT EXISTS surprise_level NUMERIC(4,1) DEFAULT NULL,
ADD COLUMN IF NOT EXISTS novelty_score NUMERIC(4,1) DEFAULT NULL,
ADD COLUMN IF NOT EXISTS emotional_intensity NUMERIC(4,1) DEFAULT NULL,
ADD COLUMN IF NOT EXISTS audience_relevance NUMERIC(4,1) DEFAULT NULL;

-- 4. B-roll table
CREATE TABLE IF NOT EXISTS broll_candidates (
  id SERIAL PRIMARY KEY,
  moment_id TEXT,
  analysis_id TEXT,
  clip_id TEXT,
  start_time NUMERIC(10,3) NOT NULL,
  end_time NUMERIC(10,3) NOT NULL,
  keyword TEXT NOT NULL,
  category TEXT,
  confidence NUMERIC(5,4) DEFAULT 0,
  suggested_query TEXT,
  overlay_mode TEXT DEFAULT 'fullscreen',
  duration NUMERIC(6,3) DEFAULT 3.0,
  source_type TEXT DEFAULT 'none',
  source_path TEXT DEFAULT '',
  status TEXT DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_broll_moment ON broll_candidates (moment_id);
CREATE INDEX IF NOT EXISTS idx_broll_analysis ON broll_candidates (analysis_id);
