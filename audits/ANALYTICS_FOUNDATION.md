# ANALYTICS_FOUNDATION.md — Event Tracking Proposal

**Date:** 2026-06-10
**Status:** Proposal only — not implemented

---

## Rationale

GANYIQ currently has **zero user analytics**. We know:
- Total analyses in DB: 119
- Total unique videos: 31
- Total clips rendered: 23

But we don't know:
- How many unique users?
- How many analyses per user?
- What's the cache hit rate per user?
- What's the clip generation success rate?
- What's the failure rate by stage?
- Average time per stage?

## Proposed Event Schema

### Table: `events`

Already exists — but stores analysis state transitions, not user events.

```sql
-- Existing structure (from migration):
CREATE TABLE events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  analysis_id UUID REFERENCES analyses(id),
  event_type VARCHAR(50) NOT NULL,
  event_data JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

### Proposed new events

#### Client-side events (logged via POST /api/events)

```
analysis_started     — User submitted URL
analysis_completed   — Frontend received results
analysis_failed      — Frontend hit error state
cache_hit            — Analysis returned from cache (< 1s)
cache_miss           — Full pipeline triggered
clip_generated       — MP4 download successful
clip_failed          — MP4 generation failed
page_loaded          — Page render complete
error_encountered    — Any client-side error
```

#### Event data schema

```json
{
  "analysis_started": {
    "videoId": "string",
    "videoTitle": "string",
    "videoDuration": "number",
    "source": "youtube_url|history|example",
    "userAgent": "string"
  },
  "analysis_completed": {
    "analysisId": "uuid",
    "totalMoments": "number",
    "processingTimeMs": "number",
    "stageBreakdown": {
      "fetchTranscript": "ms",
      "extractCandidates": "ms",
      "llmScoring": "ms",
      "multiPass": "ms",
      "ranking": "ms",
      "storing": "ms"
    },
    "isCached": "boolean"
  },
  "analysis_failed": {
    "analysisId": "uuid",
    "stage": "string",
    "errorCode": "string",
    "errorMessage": "string",
    "processingTimeMs": "number"
  },
  "clip_generated": {
    "analysisId": "uuid",
    "momentIndex": "number",
    "renderMode": "landscape|vertical",
    "fileSizeBytes": "number",
    "renderTimeMs": "number",
    "isCached": "boolean"
  },
  "clip_failed": {
    "analysisId": "uuid",
    "momentIndex": "number",
    "renderMode": "landscape|vertical",
    "errorMessage": "string"
  }
}
```

### Server-side auto-logged events

These can be generated from existing data without client instrumentation:

```
cache_hit    — On POST /api/analyze when cached=true
cache_miss   — On POST /api/analyze when cached=false
analysis_stage — Stage transitions (already logged in analyses.progress_stage)
```

## Table Design

No new tables needed. Reuse existing `events` table with:
- `event_type` VARCHAR(50) — indexes well
- `event_data` JSONB — schema-flexible
- `analysis_id` UUID — links to analyses for context
- `created_at` TIMESTAMPTZ — time-series queries

### Index recommendation
```sql
CREATE INDEX idx_events_type_time ON events(event_type, created_at DESC);
CREATE INDEX idx_events_analysis ON events(analysis_id);
```

## Storage Growth Estimate

| Volume | Events per analysis | Rows per month | Storage |
|--------|-------------------|----------------|---------|
| 100 analyses/day | 5 events each | ~15,000 rows/mo | ~15 MB |
| 500 analyses/day | 5 events each | ~75,000 rows/mo | ~75 MB |
| 2,000 analyses/day | 5 events each | ~300,000 rows/mo | ~300 MB |

**Impact:** Negligible. Current DB is 12MB for 119 analyses + 31 videos + 1,785 moments.

## Quick Wins (No Code Changes)

### What we can already answer from existing data:

| Question | Answer source |
|----------|--------------|
| Total analyses | `SELECT count(*) FROM analyses` |
| Completed rate | `SELECT status, count(*) FROM analyses GROUP BY status` |
| Avg processing time | `SELECT avg(processing_time_ms) FROM analyses WHERE status='completed'` |
| Cache opportunity | `SELECT count(DISTINCT video_id) FROM analyses WHERE status='completed'` |
| Most analyzed video | `SELECT video_id, count(*) FROM analyses GROUP BY video_id ORDER BY count DESC` |
| Clip success rate | `SELECT status, count(*) FROM jobs_queue WHERE job_type='clip' GROUP BY status` |
| Daily analysis count | `SELECT created_at::date, count(*) FROM analyses GROUP BY 1 ORDER BY 1` |
| Stage bottleneck | Already in PM2 logs via `[PROFILE]` timestamps |

## Implementation Proposal

### Phase 1 (no code, start now)
- Add daily cron to aggregate existing data
- Log key metrics to a `daily_stats` table

### Phase 2 (low code, 1 hour)
- Add `client_ip` fingerprinting to POST /api/analyze (already exists: `ip_address`)
- Log cache_hit/cache_miss events to `events` table

### Phase 3 (medium code, 2-3 hours)
- Client-side POST /api/events for user-facing actions
- Dashboard page showing usage stats

---

**Proposal complete. Ready for implementation when prioritized.**
