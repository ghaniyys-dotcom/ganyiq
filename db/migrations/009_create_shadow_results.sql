-- 009: Create V2 shadow results table for Phase 3A shadow deployment.
--
-- Stores comparison artifacts for every processed video.
-- V1 remains production. V2 runs in parallel and stores here.
-- Feature flag V2_MULTI_GENERATOR_SHADOW controls whether shadow runs.

CREATE TABLE IF NOT EXISTS v2_shadow_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  analysis_id UUID REFERENCES analyses(id) ON DELETE CASCADE,
  video_id VARCHAR(20) NOT NULL,

  -- Source data
  v1_top_clips JSONB,                      -- V1's top clips (start, end, score, tier)
  fusion_top_clips JSONB,                  -- V2 Fusion top clips (generator, time, score)
  generator_attribution JSONB,             -- per-clip: which generator, internalScore, curvedScore
  candidate_counts JSONB,                  -- { hook: N, insight: N, emotion: N, auth: N }

  -- Metrics
  diversity_metrics JSONB,                 -- { avgScore, clusterCount, singletonCount, uniquenessRatio }
  dedup_metrics JSONB,                     -- { before, after, removedCount, removedReasons[] }
  cluster_metrics JSONB,                   -- { clusterCount, avgClusterSize, maxClusterSize }
  judge_score_summary JSONB,              -- { mean, min, max, std, p50, p90, p95 }

  -- Performance
  latency_ms INT,                          -- V2 total pipeline time
  generator_latency_ms JSONB,              -- per-generator latency

  -- Status
  pipeline_success BOOLEAN NOT NULL DEFAULT false,
  error_message TEXT,
  error_stage VARCHAR(50),                 -- which generator/stage failed

  -- Version tracking
  pipeline_version VARCHAR(20) DEFAULT '2.0.0',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_shadow_analysis ON v2_shadow_results(analysis_id);
CREATE INDEX idx_shadow_video ON v2_shadow_results(video_id);
CREATE INDEX idx_shadow_created ON v2_shadow_results(created_at DESC);
CREATE INDEX idx_shadow_success ON v2_shadow_results(pipeline_success);
