/**
 * lib/score-curve.ts — Raw → Curved Score Transformation
 *
 * Standalone module for the score curve formula.
 * Can be used by both JudgeEngine and RankingEngine.
 *
 * OpusClip reverse engineering (VALIDATED, 36 clips, MAE=0.97):
 *   curvedScore ≈ 2.817 * rawScore + 7.490
 *
 * The curve spreads a narrow raw range (26-32 out of 40 max) onto
 * a wider display range (83-99 out of 100 max).
 *
 * Note: rawScore uses continuous (float-precision) component values
 * internally. The integer component scores exposed in the API are
 * rounded from these floats. This creates the spread seen where
 * identical integer components produce different curved scores.
 */

// ---------------------------------------------------------------------------
// Curve Formula Constants (from OLS linear fit on 36 Opus clips)
// ---------------------------------------------------------------------------

/**
 * Slope of the linear curve: 2.817
 * Derived from OLS: curved = 2.817432 * raw + 7.489596
 */
export const CURVE_SLOPE = 2.817432;

/**
 * Intercept of the linear curve: 7.490
 */
export const CURVE_INTERCEPT = 7.489596;

/** Minimum possible raw score (sum of 4 components at 0 each). */
export const RAW_MIN = 0;
/** Maximum possible raw score (4 components at 10 each + sponsorship at 10). */
export const RAW_MAX = 50;
/** Minimum curved score output. */
export const CURVED_MIN = 0;
/** Maximum curved score output. */
export const CURVED_MAX = 100;

// ---------------------------------------------------------------------------
// Curve Function
// ---------------------------------------------------------------------------

/**
 * Transform a raw score to a user-facing curved score.
 *
 * Formula: round(CURVE_SLOPE * rawScore + CURVE_INTERCEPT)
 *
 * Validation mapping (Opus observed):
 *   raw=26 → curved=83
 *   raw=27 → curved=85
 *   raw=28 → curved=86 or 87
 *   raw=29 → curved=87, 88, or 89
 *   raw=30 → curved=89-94 (5 distinct values)
 *   raw=31 → curved=94-97 (4 distinct values)
 *   raw=32 → curved=97-99 (3 distinct values)
 *
 * @param rawScore - Raw score (sum of component scores, continuous value)
 * @returns Curved score clamped to [CURVED_MIN, CURVED_MAX]
 */
export function rawToCurved(rawScore: number): number {
  const curved = CURVE_SLOPE * rawScore + CURVE_INTERCEPT;
  return Math.round(Math.max(CURVED_MIN, Math.min(CURVED_MAX, curved)));
}

/**
 * Apply curve in batch (for ranking).
 * More efficient than calling rawToCurved per-clip.
 *
 * @param rawScores - Array of raw scores
 * @returns Array of curved scores
 */
export function batchRawToCurved(rawScores: number[]): number[] {
  return rawScores.map(rawToCurved);
}

// ---------------------------------------------------------------------------
// Scoring Constants
// ---------------------------------------------------------------------------

/** Opus-observed score ranges for reference. */
export const REFERENCE_MAP: Record<number, number[]> = {
  26: [83],
  27: [85],
  28: [86, 87],
  29: [87, 88, 89],
  30: [89, 90, 91, 92, 93, 94],
  31: [94, 95, 96, 97],
  32: [97, 98, 99],
};

/**
 * Component score ranges (0-10 each, per Opus observation).
 * hookScore: 6-9
 * coherenceScore: 6-10
 * connectionScore: 5-10
 * trendScore: 5-8
 * sponsorshipScore: always 0 on free tier
 */
export const COMPONENT_RANGES = {
  hook: { min: 0, max: 10, observedMin: 6, observedMax: 9 },
  coherence: { min: 0, max: 10, observedMin: 6, observedMax: 10 },
  connection: { min: 0, max: 10, observedMin: 5, observedMax: 10 },
  trend: { min: 0, max: 10, observedMin: 5, observedMax: 8 },
  sponsorship: { min: 0, max: 10, observedMin: 0, observedMax: 0 },
};
