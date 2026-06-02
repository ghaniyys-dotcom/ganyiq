-- db/migrations/005_add_transcript_source.sql
--
-- Tracks where the transcript came from for monitoring and cost analysis.
-- Existing rows default to 'youtube' which is correct for all prior analyses.

ALTER TABLE analyses
ADD COLUMN IF NOT EXISTS transcript_source VARCHAR(20) DEFAULT 'youtube'
CHECK (transcript_source IN ('youtube', 'deepgram'));

COMMENT ON COLUMN analyses.transcript_source IS
  'Source of transcript: ''youtube'' (native InnerTube API) or ''deepgram'' (fallback via yt-dlp + Deepgram STT)';
