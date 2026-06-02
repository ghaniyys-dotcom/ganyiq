-- db/migrations/004_create_events.sql
--
-- Tracks user interaction events for MVP analytics.
-- Write-only from the frontend (fire-and-forget POST /api/track).
-- Read-only from the analytics dashboard.
--
-- Data Model:
--   videos  1-N  analyses  1-N  moments
--                       |
--                       +-- events
--
-- Events are loosely associated with analyses (nullable FK) because
-- some event types (e.g. page_view on the landing page) occur before
-- an analysis exists.


-- Event Taxonomy (MVP)
--
-- Three event types in MVP:
--
--   timestamp_click - User clicked a moment's timestamp, triggering
--                     YouTube player seek. Primary engagement signal.
--                     metadata: { "seconds": 2042.5, "rank": 1, "tier": "elite" }
--
--   copy_timestamp  - User clicked Copy on a moment card. Stronger
--                     engagement signal — implies intent to use the
--                     timestamp in their editing workflow.
--                     metadata: { "timestamp": "34:02", "rank": 1, "tier": "elite" }
--
--   page_view       - User loaded the results page. Baseline for
--                     calculating click-through rates.
--                     metadata: { "referrer": "direct" | "bookmark" | "shared" }

-- Column Guide
--
-- id               UUID primary key. Auto-generated. Events are
--                  append-only — no row is ever updated or deleted.
--
-- analysis_id      Optional FK -> analyses(id). Nullable because
--                  page_view events may fire before analysis completes.
--                  When non-null, enables per-analysis engagement queries.
--
-- event_type       String identifier. Enforced by the API layer
--                  (lib/validators.ts), not a CHECK constraint, so
--                  new event types can be added without migrations.
--                  VARCHAR(50) allows future types like 'playlist_export',
--                  'feedback_rating', 'share_clip'.
--
-- metadata         Arbitrary JSONB payload for event-specific data.
--                  Flexibility avoids schema changes for new attributes.
--
-- ip_address       Client IP for anonymous aggregation. VARCHAR(45)
--                  accommodates IPv6. Enables "unique users per day"
--                  without user accounts.
--
-- created_at       Auto-set timestamp for time-series analytics.

-- Indexes
--
-- idx_events_analysis_id   (B-tree on analysis_id)
--     Per-analysis event aggregation. Without this index, every
--     results page load would seq-scan the table.
--
-- idx_events_type          (B-tree on event_type)
--     Per-type aggregation for tracking engagement trends.

-- MVP Analytics Usage
--
-- The events table powers 3 of the 8 MVP success metrics:
--
--   1. Timestamp Click Rate (>50% target)
--      Percentage of result-page views with at least one click.
--
--   2. Repeat Usage (>40% target)
--      Percentage of IPs with >1 analysis in a rolling 7-day window.
--
--   3. Processing Success Rate (>90% target)
--      From analyses.status, not events — but correlated.

-- Future Usage
--
--   Quality Signal:  Moments with more clicks = higher implicit quality.
--   Retention:       Clickers vs non-clickers return rate comparison.
--   Prioritization:  Low copy_timestamp rate = bad button placement.
--   Funnel:          page_view -> timestamp_click -> copy_timestamp -> revisit.

-- Storage Notes
--
-- Append-only. No UPDATE, no DELETE. Table only grows.
-- At 1000 analyses/week x ~5 events/analysis = ~5K rows/week.
-- At ~100 bytes/row = ~0.5MB/week. Neon free tier (0.5GB) holds ~2 years.


CREATE TABLE IF NOT EXISTS events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    analysis_id UUID REFERENCES analyses(id),
    event_type VARCHAR(50) NOT NULL,
    metadata JSONB,
    ip_address VARCHAR(45),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_events_analysis_id ON events(analysis_id);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);
