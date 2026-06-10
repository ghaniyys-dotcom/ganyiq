/**
 * Deterministic moment ranking and tier assignment.
 *
 * NO AI calls. PURE LOGIC.
 *
 * Pipeline:
 *   1. Sort by worthClippingScore descending
 *   2. Proximity dedup (30s window → keep highest score)
 *   3. Score-based classification (elite >= 85, secondary >= 70, drop < 70)
 *   4. Presentation caps (max 5 elite, max 10 secondary)
 *   5. Assign rank positions
 *   6. Extract transcript excerpts
 *   7. Format timestamps
 */

import { secondsToTimestamp } from '@/lib/format';
import type {
  RawMoment,
  RankedMoment,
  TranscriptSegment,
  MomentTier,
} from '@/lib/types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Score threshold for elite tier (MASTER_PLAN Section 10). */
export const ELITE_THRESHOLD = 85;

/** Score threshold for secondary tier (MASTER_PLAN Section 10). */
export const SECONDARY_THRESHOLD = 70;

/** Maximum number of elite moments displayed in UI. */
const MAX_ELITE = 5;

/** Maximum number of secondary moments displayed in UI. */
const MAX_SECONDARY = 10;

/**
 * Proximity threshold in seconds.
 * Two moments whose start times are within this distance are considered
 * overlapping and the lower-scored one is removed.
 */
const PROXIMITY_SECONDS = 30;

// ---------------------------------------------------------------------------
// Main Export
// ---------------------------------------------------------------------------

/**
 * Rank, deduplicate, and tier a set of raw moments from the LLM.
 *
 * Tiers are SCORE-BASED (elite >= 85, secondary >= 70). Presentation caps
 * (max 5 elite, max 10 secondary) are applied after tier classification.
 * Moments with score < 70 are silently dropped.
 *
 * @param moments    - Raw moments from the LLM (unranked, may overlap)
 * @param transcript - Full transcript segments for excerpt extraction
 * @returns RankedMoment[] — sorted, deduped, tiered, presentation-capped
 */
export function rankMoments(
  moments: RawMoment[],
  transcript: TranscriptSegment[],
): RankedMoment[] {
  if (moments.length === 0) return [];

  // Step 1: Sort by score descending
  const sorted = [...moments].sort(
    (a, b) => b.worthClippingScore - a.worthClippingScore,
  );

  // Step 2: Proximity dedup (unchanged)
  const deduped = deduplicateMoments(sorted);

  // Step 3: Score-based classification
  //   score >= 85  → elite
  //   score >= 70  → secondary
  //   score <  70  → silently dropped
  const elite: RawMoment[] = [];
  const secondary: RawMoment[] = [];

  for (const m of deduped) {
    if (m.worthClippingScore >= ELITE_THRESHOLD) {
      elite.push(m);
    } else if (m.worthClippingScore >= SECONDARY_THRESHOLD) {
      secondary.push(m);
    }
  }

  // Step 4: Apply presentation caps (max 5 elite, max 10 secondary)
  const topElite = elite.slice(0, MAX_ELITE);
  const topSecondary = secondary.slice(0, MAX_SECONDARY);

  // Step 5: Combine — elite first (by score), then secondary (by score)
  const top = [...topElite, ...topSecondary];

  // Step 6: Build RankedMoments with score-based tiers
  const ranked: RankedMoment[] = top.map((m, index) => {
    const rank = index + 1;
    const tier = assignTier(m.worthClippingScore);

    return {
      ...m,
      rank,
      tier,
      startTimestamp: secondsToTimestamp(m.startTime),
      endTimestamp: secondsToTimestamp(m.endTime),
      transcriptExcerpt: extractExcerpt(m.startTime, m.endTime, transcript),
    };
  });

  return ranked;
}

// ---------------------------------------------------------------------------
// Proximity Deduplication
// ---------------------------------------------------------------------------

/**
 * Remove overlapping moments using a greedy keep-highest-score strategy.
 *
 * Algorithm:
 *   1. Iterate moments in score-descending order (caller must pre-sort).
 *   2. For each moment, check whether its start time is within
 *      PROXIMITY_SECONDS of any already-kept moment's start time.
 *   3. If no overlap → keep. If overlap → skip (kept moment already scored higher).
 *
 * Why compare by start time only:
 *   Podcast clips naturally vary in length. Comparing by start time is simpler
 *   and more predictable than full interval overlap detection. Two moments
 *   that start within 30 seconds of each other almost certainly cover the same
 *   conversational segment, regardless of where they end.
 *
 * Complexity: O(n²) where n ≤ 20 (typical LLM output). For this small n,
 *   quadratic is fine — a more complex sweep-line algorithm adds no benefit.
 *
 * @param moments - Pre-sorted by score descending
 * @returns Deduplicated array (still sorted)
 */
function deduplicateMoments(moments: RawMoment[]): RawMoment[] {
  const kept: RawMoment[] = [];

  for (const moment of moments) {
    const isOverlapping = kept.some(
      (keptMoment) =>
        Math.abs(moment.startTime - keptMoment.startTime) < PROXIMITY_SECONDS,
    );

    if (!isOverlapping) {
      kept.push(moment);
    }
  }

  return kept;
}

// ---------------------------------------------------------------------------
// Tier Assignment
// ---------------------------------------------------------------------------

/**
 * Assign a deterministic tier based on worth-clipping score.
 *
 * MASTER_PLAN Section 10 thresholds:
 *   score >= 85  → elite     (🔥 Clip this immediately. High confidence.)
 *   score >= 70  → secondary (✅ Worth clipping. Solid performer.)
 *   score <  70  → dropped   (not worth showing)
 *
 * Score-based assignment ensures:
 *   - User trust: the tier label matches the AI's quality assessment
 *   - AI integrity: LLM scores directly determine outcomes
 *   - Dataset quality: only genuinely high-scoring moments are labelled elite
 *
 * Presentation caps (5 elite, 10 secondary) are applied SEPARATELY in
 * rankMoments(). This function only answers: "what quality IS this moment?"
 */
function assignTier(score: number): MomentTier {
  if (score >= ELITE_THRESHOLD) return 'elite';
  return 'secondary';
}

// ---------------------------------------------------------------------------
// Transcript Excerpt Extraction
// ---------------------------------------------------------------------------

/**
 * Extract a readable transcript excerpt for a given time window.
 *
 * Finds all transcript segments whose `start` time falls within
 * [startTime, endTime] and concatenates their text.
 *
 * @param startTime  - Moment start time in seconds
 * @param endTime    - Moment end time in seconds
 * @param transcript - Full transcript segments
 * @returns Concatenated text from overlapping segments (max 500 chars)
 */
function extractExcerpt(
  startTime: number,
  endTime: number,
  transcript: TranscriptSegment[],
): string {
  const words: string[] = [];

  for (const seg of transcript) {
    // Segment overlaps with moment range if segment start is within range
    if (seg.start >= startTime && seg.start < endTime) {
      words.push(seg.text);
    }
  }

  // Return concatenated text, trimmed and truncated to 500 chars
  const excerpt = words.join(' ').trim();
  if (excerpt.length > 500) {
    return excerpt.slice(0, 497) + '...';
  }

  return excerpt;
}

// ---------------------------------------------------------------------------
// Index rebuilding (Optional — for when transcript changes)
// ---------------------------------------------------------------------------

/**
 * Merge a new analysis result into an existing list, re-ranking and
 * re-deduplicating. Useful when combining chunked analysis results.
 *
 * @param existing   - Previously ranked moments
 * @param newMoments - Raw moments from a new chunk
 * @param transcript - Full transcript for excerpt extraction
 * @returns Freshly ranked, deduped list
 */
export function mergeAndRerank(
  existing: RankedMoment[],
  newMoments: RawMoment[],
  transcript: TranscriptSegment[],
): RankedMoment[] {
  const combined: RawMoment[] = [
    ...existing.map(stripRank),
    ...newMoments,
  ];
  return rankMoments(combined, transcript);
}

/**
 * Strip ranking metadata from a RankedMoment back to RawMoment.
 */
function stripRank(m: RankedMoment): RawMoment {
  return {
    startTime: m.startTime,
    endTime: m.endTime,
    worthClippingScore: m.worthClippingScore,
    confidence: m.confidence,
    dnaTags: m.dnaTags,
    reasoning: m.reasoning,
  };
}
