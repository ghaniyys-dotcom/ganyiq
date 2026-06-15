/**
 * lib/multi-generator/types.ts — Phase 2.1 Shared Types & Interfaces
 *
 * Two-stage ranking architecture:
 *   Generator → local ranking (top K) → global Judge V2 → final selection
 *
 * Each generator produces candidates, ranks them by internalScore,
 * and only the top K per generator proceed to the global pool.
 */

import type { TimelineJSON } from '../timeline-types';
import type { TranscriptSegment } from '../types';

// ---------------------------------------------------------------------------
// Strategy & Identity
// ---------------------------------------------------------------------------

/** Which candidate-generation strategy produced this clip. */
export type GeneratorStrategy = 'hook' | 'story' | 'insight' | 'emotion';

/** Human-readable label for each strategy. */
export const GENERATOR_LABELS: Record<GeneratorStrategy, string> = {
  hook: 'Hook First',
  story: 'Story First',
  insight: 'Insight First',
  emotion: 'Emotion First',
};

// ---------------------------------------------------------------------------
// Generator Candidate
// ---------------------------------------------------------------------------

/**
 * A single clip candidate produced by a generator.
 * Every generator outputs the same type — they are interchangeable.
 */
export interface GeneratorCandidate {
  /** Unique within this analysis run (usually `${strategy}_${index}`). */
  candidateId: string;
  /** Which generator produced this candidate. */
  generator: GeneratorStrategy;
  /** Source video reference. */
  videoId: string;
  /** Clip boundaries in seconds. */
  startTime: number;
  endTime: number;
  /** Duration in seconds. */
  durationSeconds: number;
  /** Transcript text for this clip window. */
  transcriptExcerpt: string;
  /** Timeline JSON — the permanent renderer-agnostic contract. */
  timeline: TimelineJSON;
  /** Generator-specific analysis metadata. */
  metadata: GeneratorMetadata;
  /**
   * Judge V2 result (set during global ranking stage).
   * Undefined until Judge V2 processes this candidate.
   */
  judgeResult?: import('../judge-types').JudgeResult;
}

/** Generator-specific metadata for analysis, debugging, and tuning. */
export interface GeneratorMetadata {
  /** Human-readable explanation of why this clip was selected. */
  selectionRationale: string;
  /** Which signals from the transcript triggered this selection. */
  triggerSignals: string[];
  /**
   * Internal quality score (0-100) assigned by the generator.
   * Used for LOCAL ranking within a generator's output.
   * This is NOT the Judge V2 score — it's the generator's own estimate.
   */
  internalScore: number;
  /**
   * Confidence level based on source data quality.
   * - high:   clean boundaries, strong signal match
   * - medium: reasonable boundaries, moderate signal match
   * - low:    fallback boundaries, sparse source, weak signals
   */
  confidence: 'high' | 'medium' | 'low';
}

// ---------------------------------------------------------------------------
// Generator Result (after local ranking)
// ---------------------------------------------------------------------------

/**
 * Output of a single generator run.
 * Contains the ranked candidates AFTER local sorting.
 * Only the top `k` candidates (default 5) proceed to global pool.
 */
export interface GeneratorResult {
  /** Which strategy ran. */
  strategy: GeneratorStrategy;
  /** All candidates produced (before local ranking cut). */
  allCandidates: GeneratorCandidate[];
  /** Top K candidates after local ranking (sorted by internalScore DESC). */
  topCandidates: GeneratorCandidate[];
  /** K value used (how many survived local rank cut). */
  k: number;
  /** Total raw candidates generated before any filtering. */
  rawCount: number;
  /** Duration of this generator run in ms. */
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for a single generator.
 * Each generator has its own parameters.
 */
export interface GeneratorConfig {
  /** Strategy identifier. */
  strategy: GeneratorStrategy;
  /**
   * Maximum raw candidates to generate before local ranking.
   * Generator explores transcript, generates up to this many candidates,
   * then ranks and keeps only top `localTopK`.
   */
  maxRawCandidates: number;
  /**
   * How many of the best candidates survive the local ranking cut.
   * These proceed to the global Judge V2 pool.
   * Default: 5 (so 4 generators × 5 = 20 candidates in pool).
   */
  localTopK: number;
  /** Minimum clip duration in seconds. */
  minDuration: number;
  /** Maximum clip duration in seconds. */
  maxDuration: number;
  /**
   * If false, generator avoids creating candidates that overlap
   * with other generators' time ranges. (Coordination TBD in Phase 2.6.)
   */
  allowOverlap: boolean;
}

/** Default configuration for each generator strategy. */
export const DEFAULT_GENERATOR_CONFIGS: Record<GeneratorStrategy, GeneratorConfig> = {
  hook: {
    strategy: 'hook',
    maxRawCandidates: 15,
    localTopK: 5,
    minDuration: 15,
    maxDuration: 45,
    allowOverlap: false,
  },
  story: {
    strategy: 'story',
    maxRawCandidates: 10,
    localTopK: 5,
    minDuration: 30,
    maxDuration: 90,
    allowOverlap: false,
  },
  insight: {
    strategy: 'insight',
    maxRawCandidates: 12,
    localTopK: 5,
    minDuration: 15,
    maxDuration: 60,
    allowOverlap: false,
  },
  emotion: {
    strategy: 'emotion',
    maxRawCandidates: 12,
    localTopK: 5,
    minDuration: 15,
    maxDuration: 60,
    allowOverlap: false,
  },
};

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

/** Configuration for the aggregation stage. */
export interface AggregationConfig {
  /**
   * Maximum total candidates in the global pool (before Judge V2).
   * Total = sum of localTopK from each generator.
   * Default: 20 (4 generators × 5 each).
   */
  maxPoolSize: number;
  /**
   * Minimum number of strategies that must be represented in final top N.
   * Default: 2 (at least 2 different generator types).
   */
  minStrategiesInOutput: number;
  /**
   * Maximum overlap fraction (0.0-1.0) allowed between final clips.
   * If two clips have > this fraction word overlap, one is dropped.
   * Default: 0.7 (70%).
   */
  maxOverlapFraction: number;
  /**
   * After Judge V2 ranking, how many candidates to keep as output.
   * Default: 15 (same as current pipeline top N).
   */
  finalTopN: number;
}

export const DEFAULT_AGGREGATION_CONFIG: AggregationConfig = {
  maxPoolSize: 20,
  minStrategiesInOutput: 2,
  maxOverlapFraction: 0.7,
  finalTopN: 15,
};

/** Output of the candidate aggregation stage. */
export interface CandidatePool {
  /** All candidates that passed dedup and diversity filters. */
  candidates: GeneratorCandidate[];
  /** How many came from each strategy. */
  strategyCounts: Record<GeneratorStrategy, number>;
  /** Total before dedup. */
  rawTotal: number;
  /** Total after dedup. */
  dedupedTotal: number;
  /** Candidates dropped by dedup. */
  dropped: Array<{ candidateId: string; reason: string }>;
}

// ---------------------------------------------------------------------------
// Pipeline Configuration (top-level)
// ---------------------------------------------------------------------------

/** Top-level configuration for the multi-generator pipeline. */
export interface MultiGeneratorPipelineConfig {
  /** Per-generator configuration. */
  generators: Record<GeneratorStrategy, GeneratorConfig>;
  /** Aggregation stage configuration. */
  aggregation: AggregationConfig;
  /** Whether to enable multi-generator (default: false during migration). */
  enabled: boolean;
}

export const DEFAULT_PIPELINE_CONFIG: MultiGeneratorPipelineConfig = {
  generators: { ...DEFAULT_GENERATOR_CONFIGS },
  aggregation: DEFAULT_AGGREGATION_CONFIG,
  enabled: false,
};

// ---------------------------------------------------------------------------
// Generator Interface (contract for all generators)
// ---------------------------------------------------------------------------

/**
 * Contract that every generator must implement.
 * This is the ONLY interface a generator needs to satisfy.
 */
export interface IGenerator {
  /** Which strategy this generator implements. */
  readonly strategy: GeneratorStrategy;

  /**
   * Run the generator on a transcript.
   *
   * @param transcript - Full video transcript
   * @param videoId - YouTube video ID
   * @param config - Generator configuration
   * @returns GeneratorResult with locally-ranked candidates
   */
  generate(
    transcript: TranscriptSegment[],
    videoId: string,
    config: GeneratorConfig,
  ): Promise<GeneratorResult>;

  /**
   * Get a human-readable description of what this generator does.
   * Used for logging, debugging, and evaluation.
   */
  describe(): string;
}

// ---------------------------------------------------------------------------
// Evaluation Types
// ---------------------------------------------------------------------------

/** Per-generator evaluation metrics tracked during benchmarking. */
export interface GeneratorEvalMetrics {
  /** Generator strategy. */
  strategy: GeneratorStrategy;
  /** Average number of raw candidates produced per run. */
  avgCandidateCount: number;
  /** Average number of candidates that pass local top K. */
  avgTopKCount: number;
  /**
   * Precision: fraction of this generator's top K that appear
   * in the final Judge V2 top N output.
   */
  precision: number;
  /**
   * Recall: fraction of this generator's top K that appear
   * in the final top N, divided by total top N.
   */
  recall: number;
  /**
   * Overlap with Judge V2 winners: how many of this generator's
   * candidates also appear in Judge V2's top N (ignoring local rank).
   */
  overlapWithJudgeV2: number;
  /** Average internalScore of candidates. */
  avgInternalScore: number;
  /** Average Judge V2 curvedScore of candidates that made it. */
  avgJudgeScore: number;
  /** Average generator runtime in ms. */
  avgDurationMs: number;
  /** Number of evaluation runs. */
  nRuns: number;
}
