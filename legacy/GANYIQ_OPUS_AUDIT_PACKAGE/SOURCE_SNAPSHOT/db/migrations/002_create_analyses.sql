-- db/migrations/002_create_analyses.sql
--
-- Records every URL analysis submission. Each row represents a single
-- run of the ganyIQ pipeline: receiving a YouTube URL, extracting the
-- transcript, sending it to the LLM, and returning ranked moments.
--
-- The analyses table is the central junction in the data model:
--   videos  1──N  analyses  1──N  moments
--                     │
--                     └── events
--
-- A video is fetched once (videos table) and may be analyzed multiple
-- times with different prompt versions, model upgrades, or by different
-- users (identified by IP in MVP). Each analysis produces 10-15 ranked
-- moments stored in the moments table.
--
-- ─── Column Guide ───────────────────────────────────────────────────────
--
-- id                 UUID primary key. Auto-generated. Referenced by
--                    moments.analysis_id as the foreign key, and by
--                    events.analysis_id for usage tracking.
--
-- video_id           Foreign key → videos(id). Establishes the N:1
--                    relationship. Every analysis belongs to exactly
--                    one video. Deletion of a video cascades to its
--                    analyses via ON DELETE CASCADE on moments but
--                    NOT on the analyses row itself (protected by
--                    RESTRICT — see note below).
--
-- ip_address         IPv4 or IPv6 of the requesting client. Stored as
--                    VARCHAR(45) to fit the maximum IPv6 string length
--                    (e.g. "2001:0db8:85a3:0000:0000:8a2e:0370:7334").
--                    Used for MVP rate limiting (max 5 analyses/day/IP)
--                    since the product has no user accounts yet.
--
-- total_moments_found Number of moments returned by the LLM for this
--                     analysis. Quick aggregate without JOINing the
--                     moments table. Stored at write time.
--
-- processing_time_ms Wall-clock duration of the full pipeline:
--                     transcript fetch → LLM call → JSON parse →
--                     validation → DB write. Used to monitor latency
--                     and detect regressions.
--
-- llm_model          Name of the LLM model used (e.g. "deepseek-v4-flash"
--                    or "gemini-2.0-flash"). Overridden at INSERT time
--                    by TARGET_MODEL from lib/prompt.ts. The DB default
--                    is never used in practice.
--
-- prompt_version     Semantic version string for the prompt template
--                    used (e.g. "mvp-v1", "v2.1"). Enables A/B testing
--                    and regression tracking: given the same transcript,
--                    different prompt versions should produce different
--                    (hopefully better) results.
--
-- raw_llm_response   The complete JSON response from the LLM, stored
--                    verbatim. This is the single most important column
--                    for debugging and dataset building:
--                      • Recover from parse failures without re-running
--                      • Retroactively extract data not stored at MVP time
--                      • Compare prompt versions on the same transcript
--                      • Feed the Viral DNA Dataset (V2) without re-analyzing
--
-- status             Pipeline status: 'pending' (analysis started),
--                    'completed' (success), or 'failed' (error).
--                    Default is 'completed' because MVP runs synchronously;
--                    'pending' becomes relevant when async queues are
--                    added in V2. Constrained by CHECK to prevent typos.
--
-- error_message      Human-readable error description when status is
--                    'failed'. NULL when status is 'completed' or
--                    'pending'. Examples: "TRANSCRIPT_UNAVAILABLE",
--                    "LLM returned unparseable JSON".
--
-- created_at         Auto-set timestamp recording when the analysis
--                    was submitted. Indexed DESC for reverse-chronological
--                    listing (analysis history, admin panel).
--
-- ─── Indexes ─────────────────────────────────────────────────────────────
--
-- idx_analyses_video_id   (B-tree on video_id)
--                         Speeds up "show all analyses for this video",
--                         used when displaying analysis history per video
--                         or comparing prompt version results.
--
-- idx_analyses_created_at (B-tree DESC on created_at)
--                         Powers the "recent analyses" query:
--                           SELECT * FROM analyses
--                           ORDER BY created_at DESC
--                           LIMIT 20;
--                         Essential for the MVP admin panel and for
--                         monitoring pipeline health over time.
--
-- ─── Expected Query Patterns ─────────────────────────────────────────────
--
-- 1. Lookup by ID (GET /api/analyze/:id):
--      SELECT a.*, v.youtube_id, v.title, v.channel_name
--      FROM analyses a
--      JOIN videos v ON v.id = a.video_id
--      WHERE a.id = $1;
--    → Indexed by PK.
--
-- 2. Rate limit check (POST /api/analyze):
--      SELECT COUNT(*) FROM analyses
--      WHERE ip_address = $1
--        AND created_at > NOW() - INTERVAL '1 day';
--    → No dedicated index yet. For MVP scale (<1000 rows/day) a
--      sequential scan is acceptable. If rate-limit queries become
--      a bottleneck in V2, add a composite index on (ip_address, created_at).
--
-- 3. Recent analyses (history / monitoring):
--      SELECT * FROM analyses
--      ORDER BY created_at DESC
--      LIMIT 20;
--    → Covered by idx_analyses_created_at DESC.
--
-- 4. All analyses for a video (prompt comparison):
--      SELECT * FROM analyses
--      WHERE video_id = $1
--      ORDER BY created_at DESC;
--    → Covered by idx_analyses_video_id.
--
-- 5. Failed analysis debugging:
--      SELECT * FROM analyses
--      WHERE status = 'failed'
--      ORDER BY created_at DESC;
--    → Sequential scan at MVP scale. Add index on status if failure
--      rate monitoring becomes a regular task in V2.
--
-- ─── Foreign Key Design ─────────────────────────────────────────────────
--
-- video_id REFERENCES videos(id)
--   → ON DELETE RESTRICT (default). A video with existing analyses
--     cannot be deleted without first removing its analyses. This is
--     intentional: analyses are permanent records. If we ever need
--     to clean up, we do it explicitly.
--
--   → The moments table uses ON DELETE CASCADE so deleting an analysis
--     automatically removes its moments (the typical cleanup pattern).


CREATE TABLE IF NOT EXISTS analyses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    video_id UUID NOT NULL REFERENCES videos(id),
    ip_address VARCHAR(45),
    total_moments_found INT,
    processing_time_ms INT,
    llm_model VARCHAR(50) DEFAULT 'gemini-2.0-flash',
    prompt_version VARCHAR(20) DEFAULT 'mvp-v1',
    raw_llm_response JSONB,
    status VARCHAR(20) DEFAULT 'completed'
        CHECK (status IN ('pending', 'completed', 'failed')),
    error_message TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_analyses_video_id ON analyses(video_id);
CREATE INDEX IF NOT EXISTS idx_analyses_created_at ON analyses(created_at DESC);
