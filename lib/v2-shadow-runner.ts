// ============================================================================
// lib/v2-shadow-runner.ts — Phase 3A Shadow Deployment Runner
// ============================================================================
//
// Runs the complete V2 Fusion pipeline in shadow mode alongside V1.
// Stores comparison artifacts in `v2_shadow_results` table.
// NEVER propagates errors to the user — always reports gracefully.
// ============================================================================

import { query } from '@/db/client';
import { HookGenerator } from '@/lib/multi-generator/hook-generator';
import { InsightGenerator } from '@/lib/multi-generator/insight-generator';
import { EmotionGenerator } from '@/lib/multi-generator/emotion-generator';
import { AuthorityGenerator } from '@/lib/multi-generator/authority-generator';
import { dedupPool, computePairOverlap } from '@/lib/multi-generator/diversity';
import type { TranscriptSegment, GeneratorCandidate } from '@/lib/types';
import type { GeneratorConfig, GeneratorResult, PoolConstraints, DedupResult } from '@/lib/multi-generator/types';
import { DEFAULT_POOL_CONSTRAINTS } from '@/lib/multi-generator/types';

// ─── Config ──────────────────────────────────────────────────────────────

const BASE_CONFIG: GeneratorConfig = {
  strategy: 'hook',
  maxRawCandidates: 15,
  localTopK: 5,
  minDuration: 15,
  maxDuration: 60,
  allowOverlap: false,
};

const POOL: PoolConstraints = { ...DEFAULT_POOL_CONSTRAINTS, maxDedupedCandidates: 25 };

// ─── Simulated Judge V2 ─────────────────────────────────────────────────

interface JudgeScore { curvedScore: number; hook: number; coherence: number; connection: number; trend: number; }

function judgeCandidate(c: GeneratorCandidate): JudgeScore {
  const gen = c.candidateId.split('_')[0];
  const base = c.metadata.internalScore / 100;
  let h = 0, co = 0, cn = 0, t = 0;
  switch (gen) {
    case 'hook': h = base * 8 + 1; co = base * 5 + 2; cn = base * 4 + 2; t = base * 3 + 1; break;
    case 'insight': h = base * 3 + 1; co = base * 7 + 2; cn = base * 4 + 2; t = base * 5 + 1; break;
    case 'emotion': h = base * 5 + 1; co = base * 4 + 2; cn = base * 8 + 1; t = base * 5 + 1; break;
    case 'auth': h = base * 4 + 1; co = base * 6 + 2; cn = base * 3 + 1; t = base * 6 + 2; break;
    default: h = base * 5 + 2; co = base * 5 + 2; cn = base * 5 + 2; t = base * 5 + 2;
  }
  h = Math.max(0, Math.min(10, h)); co = Math.max(0, Math.min(10, co)); cn = Math.max(0, Math.min(10, cn)); t = Math.max(0, Math.min(10, t));
  const raw = h + co + cn + t;
  return { curvedScore: Math.round(2.817 * raw + 7.490), hook: Math.round(h * 10) / 10, coherence: Math.round(co * 10) / 10, connection: Math.round(cn * 10) / 10, trend: Math.round(t * 10) / 10 };
}

// ─── V2 Shadow Runner ──────────────────────────────────────────────────

export interface ShadowResult {
  success: boolean;
  videoId: string;
  analysisId: string | null;
  error?: string;
  errorStage?: string;
  latencyMs: number;
  candidateCounts: Record<string, number>;
  fusionTop5: Array<{
    generator: string;
    startTime: number;
    endTime: number;
    internalScore: number;
    curvedScore: number;
    signals: string[];
  }>;
  v1Top5?: Array<{
    startTime: number;
    endTime: number;
    score: number;
    tier: string;
    text: string;
  }>;
}

/**
 * Run V2 fusion pipeline in shadow mode.
 * Silent on errors — always returns a ShadowResult.
 * Never throws.
 */
export async function runShadowPipeline(
  videoId: string,
  transcript: TranscriptSegment[],
  analysisId?: string | null,
  v1Moments?: Array<{ startTime: number; endTime: number; worthClippingScore: number; tier: string; transcriptExcerpt: string }>,
): Promise<ShadowResult> {
  const startWall = Date.now();

  const result: ShadowResult = {
    success: false,
    videoId,
    analysisId: analysisId ?? null,
    latencyMs: 0,
    candidateCounts: { hook: 0, insight: 0, emotion: 0, auth: 0 },
    fusionTop5: [],
  };

  try {
    // 1. Set up generators
    const generators = [
      { name: 'hook', gen: new HookGenerator() },
      { name: 'insight', gen: new InsightGenerator() },
      { name: 'emotion', gen: new EmotionGenerator() },
      { name: 'auth', gen: new AuthorityGenerator() },
    ];

    // 2. Run all generators with error isolation
    const allTop: GeneratorCandidate[] = [];
    const genLatency: Record<string, number> = {};

    for (const { name, gen } of generators) {
      const genStart = Date.now();
      try {
        const r = await gen.generate(transcript, videoId, BASE_CONFIG);
        allTop.push(...r.topCandidates);
        result.candidateCounts[name] = r.rawCount;
        genLatency[name] = Date.now() - genStart;
      } catch (err: any) {
        result.candidateCounts[name] = 0;
        genLatency[name] = Date.now() - genStart;
        // Generator failure is non-fatal — others still contribute
      }
    }

    // 3. Check if any candidates were produced
    if (allTop.length === 0) {
      result.latencyMs = Date.now() - startWall;
      result.error = 'All generators returned 0 candidates';
      result.errorStage = 'generation';
      return result;
    }

    // 4. Dedup + diversity
    let dedup: DedupResult;
    try {
      dedup = dedupPool(allTop, POOL);
    } catch (err: any) {
      result.latencyMs = Date.now() - startWall;
      result.error = `Dedup failed: ${err.message}`;
      result.errorStage = 'dedup';
      return result;
    }

    // 5. Judge V2 (simulated)
    let judged: Array<{ c: GeneratorCandidate; j: JudgeScore }>;
    try {
      judged = dedup.survivors.map(c => ({ c, j: judgeCandidate(c) }));
      judged.sort((a, b) => b.j.curvedScore - a.j.curvedScore);
    } catch (err: any) {
      result.latencyMs = Date.now() - startWall;
      result.error = `Judge V2 failed: ${err.message}`;
      result.errorStage = 'judge';
      return result;
    }

    // 6. Build fusion top 5
    const top5 = judged.slice(0, 5);
    result.fusionTop5 = top5.map(({ c, j }) => ({
      generator: c.candidateId.split('_')[0],
      startTime: c.startTime,
      endTime: c.endTime,
      internalScore: c.metadata.internalScore,
      curvedScore: j.curvedScore,
      signals: c.metadata.triggerSignals,
    }));

    // 7. Build V1 comparison
    if (v1Moments && v1Moments.length > 0) {
      result.v1Top5 = v1Moments
        .sort((a, b) => b.worthClippingScore - a.worthClippingScore)
        .slice(0, 5)
        .map(m => ({
          startTime: m.startTime,
          endTime: m.endTime,
          score: m.worthClippingScore,
          tier: m.tier,
          text: m.transcriptExcerpt,
        }));
    }

    // 8. Mark success and persist to DB
    result.latencyMs = Date.now() - startWall;
    result.success = true;
    try {
      await persistShadowResult(result, dedup, judged.map(j => j.j.curvedScore), genLatency);
    } catch (err: any) {
      console.error(`[SHADOW] DB persist failed for ${videoId}: ${err.message}`);
      // Non-fatal — pipeline success is about generation, not storage
    }

    return result;

  } catch (err: any) {
    result.latencyMs = Date.now() - startWall;
    result.error = `Pipeline error: ${err.message}`;
    result.errorStage = 'pipeline';
    return result;
  }
}

// ─── DB Persistence ────────────────────────────────────────────────────

async function persistShadowResult(
  result: ShadowResult,
  dedup: DedupResult,
  allCurvedScores: number[],
  genLatency: Record<string, number>,
): Promise<void> {
  // Compute judge score summary
  const scores = result.fusionTop5.map(f => f.curvedScore);
  const sorted = [...scores].sort((a, b) => a - b);

  const judgeSummary = {
    mean: scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0,
    min: scores.length > 0 ? Math.min(...scores) : 0,
    max: scores.length > 0 ? Math.max(...scores) : 0,
    p50: sorted.length > 0 ? sorted[Math.floor(sorted.length * 0.5)] : 0,
    p90: sorted.length > 0 ? sorted[Math.floor(sorted.length * 0.9)] : 0,
    p95: sorted.length > 0 ? sorted[Math.floor(sorted.length * 0.95)] : 0,
  };

  // Diversity metrics
  const diversityMetrics = {
    avgDiversityScore: dedup.stats.avgDiversityScore,
    clusterCount: dedup.stats.clusterCount,
    singletonCount: dedup.stats.singletonCount,
    uniquenessRatio: dedup.stats.singletonCount / Math.max(1, dedup.stats.clusterCount),
  };

  // Dedup metrics
  const dedupMetrics = {
    before: dedup.stats.before,
    after: dedup.stats.after,
    removedCount: dedup.stats.removedCount,
    removedReasons: dedup.removed.map(r => r.reason),
  };

  // Cluster metrics
  const clusterSizes = dedup.clusters.map(c => c.clips.length);
  const clusterMetrics = {
    clusterCount: dedup.clusters.length,
    avgClusterSize: clusterSizes.length > 0 ? clusterSizes.reduce((a, b) => a + b, 0) / clusterSizes.length : 0,
    maxClusterSize: clusterSizes.length > 0 ? Math.max(...clusterSizes) : 0,
  };

  // Candidate counts
  const candidateCounts = {
    hook: result.candidateCounts.hook || 0,
    insight: result.candidateCounts.insight || 0,
    emotion: result.candidateCounts.emotion || 0,
    auth: result.candidateCounts.auth || 0,
  };

  // Fusion attribution
  const attribution = result.fusionTop5.map(f => ({
    generator: f.generator,
    startTime: f.startTime,
    endTime: f.endTime,
    internalScore: f.internalScore,
    curvedScore: f.curvedScore,
    signals: f.signals,
  }));

  await query(
    `INSERT INTO v2_shadow_results
      (analysis_id, video_id, v1_top_clips, fusion_top_clips,
       generator_attribution, candidate_counts, diversity_metrics,
       dedup_metrics, cluster_metrics, judge_score_summary,
       latency_ms, generator_latency_ms, pipeline_success,
       error_message, error_stage)
     VALUES ($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6::jsonb,
             $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb,
             $11, $12::jsonb, $13, $14, $15)`,
    [
      result.analysisId,
      result.videoId,
      result.v1Top5 ? JSON.stringify(result.v1Top5) : null,
      JSON.stringify(result.fusionTop5),
      JSON.stringify(attribution),
      JSON.stringify(candidateCounts),
      JSON.stringify(diversityMetrics),
      JSON.stringify(dedupMetrics),
      JSON.stringify(clusterMetrics),
      JSON.stringify(judgeSummary),
      result.latencyMs,
      JSON.stringify(genLatency),
      result.success,
      result.error || null,
      result.errorStage || null,
    ],
  );
}
