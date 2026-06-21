-- 012_transcript_providers.sql
-- Add transcript provider tracking + speaker-face mapping table
--
-- Requirements:
--   - transcript_provider (which provider served the transcript)
--   - speaker_count (how many speakers detected)
--   - provider_latency_ms (how long provider took)
--   - provider_fallback_reason (why fallback was needed)
--   - speaker_face_mapping table

-- 1. Add provider tracking columns to analyses table
ALTER TABLE analyses
  ADD COLUMN IF NOT EXISTS transcript_provider TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS speaker_count INTEGER DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS provider_latency_ms INTEGER DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS provider_fallback_reason TEXT DEFAULT NULL;

COMMENT ON COLUMN analyses.transcript_provider IS 'Which provider served the transcript: youtube, deepgram, vibevoice, fasterwhisper, worker';
COMMENT ON COLUMN analyses.speaker_count IS 'Number of unique speakers detected in diarization';
COMMENT ON COLUMN analyses.provider_latency_ms IS 'Latency in ms for the transcript provider';
COMMENT ON COLUMN analyses.provider_fallback_reason IS 'Why the primary provider failed and fallback was used';

-- 2. Create speaker_face_mappings table
CREATE TABLE IF NOT EXISTS speaker_face_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  analysis_id UUID NOT NULL REFERENCES analyses(id) ON DELETE CASCADE,
  speaker_id TEXT NOT NULL,
  face_id INTEGER NOT NULL,
  confidence NUMERIC(5,4) NOT NULL DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

  -- Each speaker can be mapped to multiple faces (but only one primary)
  -- Each face can be mapped to multiple speakers (different times)
  UNIQUE (analysis_id, speaker_id, face_id)
);

CREATE INDEX IF NOT EXISTS idx_speaker_face_mappings_analysis
  ON speaker_face_mappings(analysis_id);
CREATE INDEX IF NOT EXISTS idx_speaker_face_mappings_speaker
  ON speaker_face_mappings(analysis_id, speaker_id);
CREATE INDEX IF NOT EXISTS idx_speaker_face_mappings_face
  ON speaker_face_mappings(analysis_id, face_id);

COMMENT ON TABLE speaker_face_mappings IS 'Maps speaker labels from diarization to face IDs from face-tracker';
COMMENT ON COLUMN speaker_face_mappings.speaker_id IS 'Speaker label (e.g. "Speaker 0", "Speaker 1")';
COMMENT ON COLUMN speaker_face_mappings.face_id IS 'Face tracking ID from face-tracker';
COMMENT ON COLUMN speaker_face_mappings.confidence IS 'Confidence of this mapping (0-1)';

-- 3. Add transcript provider config columns to videos table (optional, for audit)
ALTER TABLE videos
  ADD COLUMN IF NOT EXISTS transcript_provider TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS provider_latency_ms INTEGER DEFAULT NULL;

COMMENT ON COLUMN videos.transcript_provider IS 'Provider used for the original transcript acquisition';
COMMENT ON COLUMN videos.provider_latency_ms IS 'Provider latency for the original transcript acquisition';
