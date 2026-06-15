/**
 * eval/multi-generator/benchmark-types.ts — Generator Benchmark Framework
 *
 * Defines metrics and types for Phase 2.3 generator benchmarking.
 * Every generator must track these metrics during evaluation.
 */

import type { GeneratorEvalMetrics, GeneratorStrategy } from '../../lib/multi-generator/types';

export type { GeneratorEvalMetrics };
export type { GeneratorStrategy };

/**
 * Report from a single generator benchmark run.
 * Aggregates metrics across multiple video transcripts.
 */
export interface GeneratorBenchmarkReport {
  /** Generator strategy evaluated. */
  strategy: GeneratorStrategy;
  /** How many videos were used in the benchmark. */
  nVideos: number;
  /** Aggregated metrics. */
  metrics: GeneratorEvalMetrics;
  /** Per-video breakdown for analysis. */
  perVideo: Array<{
    videoId: string;
    videoTitle: string;
    candidateCount: number;
    topKCount: number;
    overlapWithJudgeV2: number;
    durationMs: number;
  }>;
  /** Did this generator pass the Phase 2 gate? */
  passedGate: boolean;
  /** Human-readable assessment. */
  assessment: string;
}

/**
 * Gate criteria for a generator to pass to the next phase.
 * A generator PASSES if ALL metrics meet minimum thresholds.
 */
export const GENERATOR_GATE_CRITERIA = {
  /** Minimum precision: at least 20% of top K appear in Judge V2 final top N. */
  minPrecision: 0.2,
  /** Minimum average candidates produced per run. */
  minAvgCandidates: 5,
  /** Maximum allowed generator runtime (ms). */
  maxDurationMs: 30_000,
  /** Minimum overlap with Judge V2 winners. */
  minOverlapWithJudgeV2: 1,
};
