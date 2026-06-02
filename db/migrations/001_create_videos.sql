-- db/migrations/001_create_videos.sql
--
-- Caches YouTube video metadata and transcript to avoid re-fetching
-- the same video on repeated analyses. This table is the foundation:
-- every analysis (analyses table, migration 002) references exactly
-- one row here via video_id.
--
-- The unique constraint on youtube_id guarantees that repeated
-- submissions of the same URL reuse the cached transcript instead
-- of making redundant network calls to YouTube's API.
--
-- ─── Column Guide ───────────────────────────────────────────────────────
--
-- id                 UUID primary key. Auto-generated via gen_random_uuid()
--                    so there is no sequential ID guessing. Referenced by
--                    analyses.video_id as the foreign key.
--
-- youtube_id         The 11-character YouTube video identifier (e.g.
--                    "dQw4w9WgXcQ"). Extracted from the watch URL by
--                    lib/validators.ts. Marked UNIQUE so the application
--                    can safely INSERT … ON CONFLICT DO NOTHING.
--
-- title              Video title as returned by the InnerTube / YouTube
--                    Data API. Stored as TEXT; no length limit enforced
--                    because YouTube titles vary.
--
-- channel_name       Human-readable channel name (e.g. "Deddy Corbuzier").
--                    VARCHAR(255) covers the vast majority of YouTube
--                    channel names.
--
-- duration_seconds   Total video length in seconds. Used by the frontend
--                    for display ("98 min") and by the scoring logic for
--                    clip density calculations.
--
-- transcript         Full transcript stored as JSONB. Each element is a
--                    segment object: { start: number, duration: number,
--                    text: string }. JSONB preserves the structured
--                    format from the extraction pipeline and allows
--                    PostgreSQL to index specific paths in the future
--                    (e.g. GIN indexes for full-text search within
--                    transcripts).
--
-- fetched_at         Auto-set timestamp (NOW()) recording when the video
--                    data was fetched and stored. Used for cache expiry
--                    decisions when re-fetching transcripts.
--
-- ─── Timestamp Strategy ──────────────────────────────────────────────────
--
-- Only fetched_at is present. There is no updated_at because MVP videos
-- are written once and never updated; stale data is re-fetched into a
-- new row (or the cache is invalidated manually). If the product later
-- needs a refresh mechanism, an updated_at column can be added via a
-- future migration without breaking existing data.
--
-- ─── Indexes ─────────────────────────────────────────────────────────────
--
-- idx_videos_youtube_id  (UNIQUE B-tree on youtube_id)
--                        Speeds up lookups by video ID and enforces the
--                        deduplication constraint. This index is used by
--                        the api/analyze endpoint when checking whether
--                        a video's transcript is already cached.
--
-- ─── Connection to Future Tables ────────────────────────────────────────
--
-- videos          1──N  analyses         (via analyses.video_id)
--                    Each video can be analyzed many times (different
--                    prompt versions, model upgrades, re-analysis by
--                    different users). The analyses table stores the
--                    per-analysis metadata.
--
-- analyses        1──N  moments          (via moments.analysis_id)
--                    Each analysis produces 10-15 ranked moments. The
--                    moments table stores score, DNA tags, reasoning.
--
-- This architecture keeps video data tokenization-independent —
-- the raw JSONB transcript is fetched once and re-used across
-- prompt/model iterations.


CREATE TABLE IF NOT EXISTS videos (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    youtube_id VARCHAR(20) UNIQUE NOT NULL,
    title TEXT,
    channel_name VARCHAR(255),
    duration_seconds INT,
    transcript JSONB,
    fetched_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_videos_youtube_id ON videos(youtube_id);
