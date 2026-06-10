/**
 * lib/score-spread.ts — Post-ranking score spread utility.
 *
 * Addresses score compression where multiple clips cluster within a narrow range.
 * Detects the "elite cluster" (consecutive clips within 5pts of max) and spreads
 * them using a rank-based curve. Non-cluster clips are capped to maintain
 * monotonic display scores, accurately reflecting quality tiers.
 *
 * Usage: Call AFTER ranking, before returning moments to frontend.
 * Only affects display scores — internal ranking/dedup/tiering unchanged.
 */

export function computeDisplayScores(
  rawScores: number[],
  _ranks: number[],
): number[] {
  const n = rawScores.length;
  if (n <= 1) return [...rawScores];

  const maxScore = Math.max(...rawScores);
  const minScore = Math.min(...rawScores);
  const rawRange = maxScore - minScore;

  // Range > 30: natural spread, keep as-is
  if (rawRange > 30) return [...rawScores];

  // Find consecutive top cluster where scores are within 5pts of max
  let clusterSize = 1;
  for (let i = 1; i < n; i++) {
    if (rawScores[i] >= maxScore - 5) {
      clusterSize++;
    } else {
      break;
    }
  }

  // Small clusters (<3) don't need spreading
  if (clusterSize < 3) return [...rawScores];

  // Inside cluster: spread using fixed gaps
  // Larger clusters need smaller gaps to prevent the last
  // cluster element from falling below the next raw score
  const gap = clusterSize <= 5 ? 4 : 3;

  const result: number[] = [];
  for (let i = 0; i < clusterSize; i++) {
    result.push(100 - i * gap);
  }

  // Non-cluster: keep raw but cap below cluster min to maintain monotonicity
  const clusterMin = result[result.length - 1];
  for (let i = clusterSize; i < n; i++) {
    const raw = rawScores[i];
    // Never exceed previous display, never drop below 55
    const maxAllowed = Math.min(raw, result[i - 1] - 1);
    result.push(Math.max(maxAllowed, 55));
  }

  return result.map(s => Math.round(s));
}

/**
 * Batch compute display scores for all moments in an analysis.
 */
export function computeAllDisplayScores(
  moments: Array<{ worthClippingScore: number; rank: number }>,
): Map<number, number> {
  const result = new Map<number, number>();
  if (moments.length === 0) return result;

  const sorted = [...moments].sort((a, b) => a.rank - b.rank);
  const rawScores = sorted.map(m => m.worthClippingScore);
  const ranks = sorted.map(m => m.rank);

  const displayScores = computeDisplayScores(rawScores, ranks);

  for (let i = 0; i < sorted.length; i++) {
    result.set(sorted[i].rank, displayScores[i]);
  }

  return result;
}
