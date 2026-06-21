// ============================================================================
// lib/multi-generator/diversity-types.ts — Diversity Safeguard Types
// ============================================================================
// Three-layer overlap detection + clustering + dedup + diversity scoring.
// Used by the pipeline's diversity stage (between aggregation and Judge V2).
// ============================================================================

import type { GeneratorCandidate, GeneratorStrategy } from './types';

// ─── Overlap Detection ──────────────────────────────────────────────────────

/**
 * Overlap between two clips across three independent dimensions.
 * Each value is 0.0 (completely disjoint) to 1.0 (identical).
 */
export interface OverlapScore {
  /** Temporal overlap: intersection(start..end) / union(start..end) */
  timeOverlap: number;
  /** Transcript overlap: token-based similarity (Jaccard index on words) */
  transcriptOverlap: number;
  /** Semantic overlap: keyword-set similarity on content descriptors */
  semanticOverlap: number;
}

export interface ClipPairOverlap {
  a: GeneratorCandidate;
  b: GeneratorCandidate;
  scores: OverlapScore;
  /**
   * Weighted composite: (time × 0.40 + transcript × 0.35 + semantic × 0.25)
   * Normalised to 0–1.
   */
  composite: number;
  /** Flagged if composite >= pair overlap threshold (default 0.65). */
  flagged: boolean;
}

// ─── Overlap Weights ────────────────────────────────────────────────────────

export interface OverlapWeights {
  time: number;        // default 0.40
  transcript: number;  // default 0.35
  semantic: number;    // default 0.25
}

export const DEFAULT_OVERLAP_WEIGHTS: OverlapWeights = {
  time: 0.40,
  transcript: 0.35,
  semantic: 0.25,
};

// ─── Candidate Clustering ───────────────────────────────────────────────────

/**
 * A cluster of clips that overlap significantly.
 * Three types of clusters are identified:
 * 1. Near-identical clips (composite >= 0.80)
 * 2. Same moment, different boundaries (0.65 <= composite < 0.80)
 * 3. Different moments, low overlap — unclustered (singletons)
 */
export interface MomentCluster {
  /** Synthetic id: cluster-0, cluster-1, ... */
  id: string;
  /** All clips belonging to this cluster. */
  clips: GeneratorCandidate[];
  /** Earliest start offset (seconds). */
  startSec: number;
  /** Latest end offset (seconds). */
  endSec: number;
  /** How tightly packed (0–1): 1.0 = all start at same offset. */
  density: number;
  /** Which generator strategies are represented in this cluster. */
  strategies: GeneratorStrategy[];
  /** Representative clip (highest internalScore in cluster). */
  centroid: GeneratorCandidate;
  /** Human-readable label describing what moment this cluster covers. */
  label: string;
}

export interface ClusterMap {
  clusters: MomentCluster[];
  totalClips: number;
  /** Fraction of clips that are singletons (0–1). High = good diversity. */
  uniquenessRatio: number;
}

// ─── Diversity Score (per candidate) ────────────────────────────────────────

export interface DiversityScore {
  /** Overall 0–1 score for this candidate within the pool. */
  composite: number;
  /**
   * Novelty: how different this clip is from the mean vector of
   * all other clips in the pool (0 = identical, 1 = completely novel).
   */
  novelty: number;
  /**
   * Moment spread: Euclidean distance of this clip's start time from
   * the median start time of the pool (0–1, normalised by video duration).
   */
  momentSpread: number;
  /**
   * Intent diversity: penalty if >3 candidates share the same
   * generator strategy within the pool (0–1).
   */
  intentDiversity: number;
}

// ─── Dedup Result ───────────────────────────────────────────────────────────

export interface DedupResult {
  /** Surviving candidates after dedup. */
  survivors: GeneratorCandidate[];
  /** Clusters that were identified. */
  clusters: MomentCluster[];
  /** Clips that were removed, with the exact reason. */
  removed: Array<{
    candidate: GeneratorCandidate;
    reason: string;
    clusterId?: string;
  }>;
  /** Summary statistics. */
  stats: {
    before: number;
    after: number;
    removedCount: number;
    clusterCount: number;
    singletonCount: number;
    avgDiversityScore: number;
  };
}

// ─── Diversity Stage Output ─────────────────────────────────────────────────

export interface DiversityStageResult {
  deduped: DedupResult;
  diversityScores: Map<string, DiversityScore>;
  weightConfig: OverlapWeights;
}
