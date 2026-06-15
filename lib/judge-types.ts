/**
 * lib/judge-types.ts — GANYIQ V2 Judge Engine Types
 *
 * Defines the JudgeResult interface and scoring configuration.
 *
 * Architecture:
 *   Candidate + Context → JudgeEngine → JudgeResult
 *
 * JudgeResult contains:
 *   - 4 dimension scores (hook, coherence, connection, trend) — 0-10 each
 *   - rawScore = sum of 4 components
 *   - curvedScore = f(rawScore) → 0-100 (for display)
 *
 * This mirrors OpusClip's judgeResult structure:
 *   judgeResult: { score, curvedScore, hookScore, coherenceScore,
 *                   connectionScore, trendScore, sponsorshipScore,
 *                   hookComment, coherenceComment, connectionComment,
 *                   trendComment }
 */

import type { DnaTag } from './types';

// ---------------------------------------------------------------------------
// Judge Result
// ---------------------------------------------------------------------------

/**
 * Output of the Judge Engine V2.
 * Contains all 4 dimension scores and the aggregated raw + curved scores.
 */
export interface JudgeResult {
  /** Hook strength score (0-10). Internal float precision. */
  hookScore: number;
  /** Coherence score (0-10). */
  coherenceScore: number;
  /** Connection/relatability score (0-10). */
  connectionScore: number;
  /** Trend/timeliness score (0-10). */
  trendScore: number;
  /** Sponsorship detection score (0-10). Always 0 for non-sponsored content. */
  sponsorshipScore: number;

  /** Raw sum of all component scores (hook + coherence + connection + trend + sponsorship). */
  rawScore: number;
  /** User-facing curved score (0-100). Normalized from rawScore. */
  curvedScore: number;

  /** LLM model used for judging. */
  judgeModel: string;
  /** Judge engine version identifier. */
  judgeVersion: string;
  /** ISO timestamp when judging occurred. */
  judgeTimestamp: string;

  /** Per-dimension reasoning from the judge. */
  hookComment?: string;
  coherenceComment?: string;
  connectionComment?: string;
  trendComment?: string;
}

// ---------------------------------------------------------------------------
// Judge Configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for the Judge Engine.
 * Controls scoring parameters and model selection.
 */
export interface JudgeConfig {
  /** LLM model to use for judging. */
  model: string;
  /** Whether to collect reasoning comments (increases token usage). */
  includeComments: boolean;
  /** Batch size for parallel judging. */
  batchSize: number;
  /** Temperature for LLM scoring (0.0 = deterministic). */
  temperature: number;
}

export const DEFAULT_JUDGE_CONFIG: JudgeConfig = {
  model: 'deepseek-v4-flash',
  includeComments: true,
  batchSize: 5,
  temperature: 0.1,
};

// ---------------------------------------------------------------------------
// Dimension Definition
// ---------------------------------------------------------------------------

/**
 * A single scoring dimension evaluated by the Judge Engine.
 */
export interface ScoreDimension {
  /** Dimension key. */
  key: 'hook' | 'coherence' | 'connection' | 'trend';
  /** Human-readable name. */
  label: string;
  /** Weight in the raw score aggregation (default: 1.0). */
  weight: number;
}

export const SCORE_DIMENSIONS: ScoreDimension[] = [
  { key: 'hook', label: 'Hook Strength', weight: 1.25 },
  { key: 'coherence', label: 'Coherence', weight: 0.5 },
  { key: 'connection', label: 'Connection', weight: 1.0 },
  { key: 'trend', label: 'Trend Alignment', weight: 0.5 },
];

// ---------------------------------------------------------------------------
// Raw → Curved Score Formula
// ---------------------------------------------------------------------------

/**
 * Scoring constants derived from OpusClip reverse engineering.
 *
 * Observed range:
 *   rawScore: 26-32 (from sum of 4 components, each 0-10)
 *   curvedScore: 83-99
 *
 * Formula (OLS linear fit):
 *   curvedScore = 2.817 * rawScore + 7.490
 *
 * Note: rawScore uses CONTINUOUS internal values (not the rounded integers
 * exposed in the API). The integer component scores are rounded from
 * float values with sub-integer precision.
 */
export const CURVE_SLOPE = 2.817432;
export const CURVE_INTERCEPT = 7.489596;
export const RAW_MIN = 0;
export const RAW_MAX = 40;
export const CURVED_MIN = 0;
export const CURVED_MAX = 100;

// ---------------------------------------------------------------------------
// Score Calculation Functions
// ---------------------------------------------------------------------------

/**
 * Calculate rawScore from component scores.
 * rawScore = sum of all 5 component scores (continuous values).
 *
 * @param hook - Hook score (0-10, may be fractional internally)
 * @param coherence - Coherence score (0-10)
 * @param connection - Connection score (0-10)
 * @param trend - Trend score (0-10)
 * @param sponsorship - Sponsorship score (0-10, typically 0)
 * @returns Raw score (0-50 range)
 */
export function calculateRawScore(
  hook: number,
  coherence: number,
  connection: number,
  trend: number,
  sponsorship: number = 0,
): number {
  // Weighted sum using human-evaluation-derived weights (Cycle 2)
  // Hook: 1.25x (strong predictor, improved ρ=0.598 in Cycle 1)
  // Connection: 1.0x (strongest at baseline ρ=0.586, 1.5x overshot)
  // Trend: 0.5x (weakest, ρ=0.429)
  // Coherence: 0.5x (weakest at baseline ρ=0.417, improved to 0.519 at 0.5x)
  const hookW = hook * 1.25;
  const coherenceW = coherence * 0.5;
  const connectionW = connection * 1.0;
  const trendW = trend * 0.5;
  return hookW + coherenceW + connectionW + trendW + sponsorship;
}

/**
 * Apply curve to rawScore → user-facing curvedScore.
 *
 * Formula: curvedScore = CURVE_SLOPE * rawScore + CURVE_INTERCEPT
 * Clamped to [CURVED_MIN, CURVED_MAX].
 *
 * @param rawScore - Raw score from calculateRawScore()
 * @returns Curved score (0-100)
 */
export function applyCurve(rawScore: number): number {
  const curved = CURVE_SLOPE * rawScore + CURVE_INTERCEPT;
  return Math.round(Math.max(CURVED_MIN, Math.min(CURVED_MAX, curved)));
}

/**
 * Create a complete JudgeResult from dimension scores.
 *
 * @param scores - Object with dimension scores
 * @param comments - Optional per-dimension reasoning
 * @param judgeVersion - Judge engine version
 * @returns Complete JudgeResult
 */
export function buildJudgeResult(
  scores: {
    hook: number;
    coherence: number;
    connection: number;
    trend: number;
    sponsorship?: number;
  },
  comments?: {
    hook?: string;
    coherence?: string;
    connection?: string;
    trend?: string;
  },
  judgeVersion: string = 'ganyiq-judge-v1',
): JudgeResult {
  const sponsorship = scores.sponsorship ?? 0;
  const rawScore = calculateRawScore(
    scores.hook,
    scores.coherence,
    scores.connection,
    scores.trend,
    sponsorship,
  );

  return {
    hookScore: scores.hook,
    coherenceScore: scores.coherence,
    connectionScore: scores.connection,
    trendScore: scores.trend,
    sponsorshipScore: sponsorship,
    rawScore,
    curvedScore: applyCurve(rawScore),
    judgeModel: DEFAULT_JUDGE_CONFIG.model,
    judgeVersion,
    judgeTimestamp: new Date().toISOString(),
    hookComment: comments?.hook,
    coherenceComment: comments?.coherence,
    connectionComment: comments?.connection,
    trendComment: comments?.trend,
  };
}
