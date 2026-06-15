/**
 * Deterministic moment ranking and tier assignment.
 *
 * NO AI calls. PURE LOGIC.
 *
 * Phase 5A: Dedup rewrite with multi-factor similarity.
 * Instead of simple 30s proximity dedup, we now use:
 *   1. Time proximity (30s primary, 20-30s based on genre)
 *   2. DNA tag overlap (≥2 same tags + 60s window = dedup)
 *   3. Score similarity (within 10pts + same tags + 45s window = dedup)
 *   4. Transcript excerpt overlap (Jaccard similarity on word sets)
 *
 * Pipeline:
 *   1. Sort by worthClippingScore descending
 *   2. Multi-factor dedup with configurable window
 *   3. Adaptive threshold calculation
 *   4. Score-based classification
 *   5. Diversity enforcement (when scores are close)
 *   6. Presentation caps (max 5 elite, max 10 secondary)
 *   7. Assign rank positions
 *   8. Extract transcript excerpts
 *   9. Format timestamps
 */

import { secondsToTimestamp } from '@/lib/format';
import type {
  RawMoment,
  RankedMoment,
  TranscriptSegment,
  MomentTier,
} from '@/lib/types';
import type { JudgeResult } from '@/lib/judge-types';
import type { GenreProfile } from '@/lib/genre-detector';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Base score threshold for elite tier (adjusted by adaptive thresholds). */
export const ELITE_THRESHOLD = 80;

/** Base score threshold for secondary tier (adjusted by adaptive thresholds). */
export const SECONDARY_THRESHOLD = 50;

/** Maximum number of elite moments displayed in UI. */
const MAX_ELITE = 10;

/** Maximum number of secondary moments displayed in UI. */
const MAX_SECONDARY = 5;

/**
 * Multi-speaker score boost (Phase 3B).
 */
const MULTI_SPEAKER_BONUS = 5;   // 2+ speakers present
const DEBATE_BONUS = 8;          // 3+ speaker changes in window
const REACTION_BONUS = 3;        // Brief reaction utterance present

// ---------------------------------------------------------------------------
// Phase 5A: Multi-Factor Dedup Configuration
// ---------------------------------------------------------------------------

interface DedupConfig {
  /** Primary time window in seconds — two moments starting within this are candidates for dedup */
  primaryWindow: number;
  /** Secondary time window for DNA-based dedup (wider) */
  dnaWindow: number;
  /** Tertiary time window for score+tag based dedup */
  scoreWindow: number;
  /** Minimum number of shared DNA tags to consider same-topic */
  minSharedDnaTags: number;
  /** Score difference threshold for score+tag dedup */
  scoreProximityThreshold: number;
  /** Jaccard similarity threshold for transcript overlap (0-1) */
  transcriptOverlapThreshold: number;
}

/**
 * Generate dedup config based on genre dedup window preference.
 * Phase 5B: Reduced window sizes to preserve more clips.
 * @param genreDedupWindow - Genre-specific dedup window (from GenreProfile)
 */
export function getDedupConfig(genreDedupWindow: number = 25): DedupConfig {
  return {
    primaryWindow: 15,                         // WAS 30s — halved to reduce aggressive dedup
    dnaWindow: Math.max(genreDedupWindow + 25, 50),  // 45-55s (was 50-60s)
    scoreWindow: Math.max(genreDedupWindow + 10, 35), // 30-40s (was 35-45s)
    minSharedDnaTags: 3,                    // WAS 2 — require more tag overlap
    scoreProximityThreshold: 8,             // WAS 10 — tighter score diff
    transcriptOverlapThreshold: 0.65,       // WAS 0.5 — higher bar for transcript dedup
  };
}

// ---------------------------------------------------------------------------
// Adaptive Threshold System
// ---------------------------------------------------------------------------

interface AdaptiveThresholds {
  elite: number;
  secondary: number;
  minimum: number;
}

function calculateThresholds(validatedCount: number): AdaptiveThresholds {
  const baseElite = ELITE_THRESHOLD;
  const baseSecondary = SECONDARY_THRESHOLD;

  if (validatedCount <= 2) {
    return {
      elite: Math.max(60, baseElite - 20),
      secondary: Math.max(35, baseSecondary - 15),
      minimum: 35,
    };
  }

  if (validatedCount <= 4) {
    return {
      elite: Math.max(70, baseElite - 10),
      secondary: Math.max(40, baseSecondary - 10),
      minimum: 40,
    };
  }

  if (validatedCount <= 6) {
    return {
      elite: baseElite,
      secondary: Math.max(45, baseSecondary - 5),
      minimum: 45,
    };
  }

  return {
    elite: baseElite,
    secondary: baseSecondary,
    minimum: baseSecondary,
  };
}

// ---------------------------------------------------------------------------
// Diversity Enforcement
// ---------------------------------------------------------------------------

const TAG_FAMILIES: Record<string, string[]> = {
  'emotion-driven': ['emotion', 'shock', 'vulnerability', 'inspiration'],
  'engagement-driven': ['hookPower', 'curiosity', 'humor', 'relatability'],
  'value-driven': ['educational', 'money', 'authority', 'motivation'],
  'conflict-driven': ['controversy', 'storytelling'],
};

function getDominantFamily(tags: string[]): string | null {
  for (const [family, members] of Object.entries(TAG_FAMILIES)) {
    for (const tag of tags) {
      if (members.includes(tag)) return family;
    }
  }
  return null;
}

function enforceDiversity(ranked: RankedMoment[]): RankedMoment[] {
  if (ranked.length <= 3) return ranked;

  const top3 = ranked.slice(0, 3);
  const topFamilies = top3.map(m => getDominantFamily(m.dnaTags)).filter(Boolean);

  if (topFamilies.length < 3) return ranked;

  const allSameFamily = topFamilies.every(f => f === topFamilies[0]);
  if (!allSameFamily) return ranked;

  const dominantFamily = topFamilies[0];
  const lowestKeptScore = ranked[Math.min(2, ranked.length - 1)].worthClippingScore;

  for (let i = 3; i < ranked.length; i++) {
    const candidateFamily = getDominantFamily(ranked[i].dnaTags);
    if (candidateFamily && candidateFamily !== dominantFamily) {
      if (ranked[i].worthClippingScore >= lowestKeptScore - 10) {
        const diverseClip = ranked.splice(i, 1)[0];
        ranked.splice(2, 0, diverseClip);
        console.log(`[DIVERSITY] Promoted clip from rank ${i + 1} to rank 3 (family: ${candidateFamily})`);
        break;
      }
    }
  }

  return ranked;
}

// ---------------------------------------------------------------------------
// Phase 5A: Multi-Factor Dedup
// ---------------------------------------------------------------------------

/**
 * Compute Jaccard similarity between two text strings based on word sets.
 * Returns 0-1 where 1 means identical word composition.
 */
function computeJaccardSimilarity(textA: string, textB: string): number {
  const wordsA = new Set(textA.toLowerCase().split(/\s+/));
  const wordsB = new Set(textB.toLowerCase().split(/\s+/));

  if (wordsA.size === 0 && wordsB.size === 0) return 0;

  let intersection = 0;
  for (const word of wordsA) {
    if (wordsB.has(word)) intersection++;
  }

  const union = wordsA.size + wordsB.size - intersection;
  return union > 0 ? intersection / union : 0;
}

/**
 * Compute the number of shared DNA tags between two moments.
 */
function countSharedDnaTags(a: string[], b: string[]): number {
  const setB = new Set(b);
  return a.filter(tag => setB.has(tag)).length;
}

/**
 * Check if moment `candidate` should be removed because it's too similar
 * to an already-kept moment `kept`.
 *
 * Phase 5A: Multi-factor similarity check.
 * Returns true if candidate should be removed (duplicate of kept).
 */
function isDuplicateOf(
  candidate: RawMoment,
  kept: RawMoment,
  dedupConfig: DedupConfig,
  candidateIdx: number,
  keptIdx: number,
): { isDuplicate: boolean; reason: string } {
  const timeGap = Math.abs(candidate.startTime - kept.startTime);
  const timeGapEnd = Math.abs(candidate.endTime - kept.endTime);

  // ----- Factor 1: Time Proximity (primary) -----
  // If two moments start within primaryWindow seconds, keep higher score
  if (timeGap < dedupConfig.primaryWindow) {
    return { isDuplicate: true, reason: `time_proximity_${dedupConfig.primaryWindow}s` };
  }

  // ----- Factor 2: DNA Tag Overlap + Wider Time Window -----
  // If two moments share ≥2 DNA tags AND start within dnaWindow, they're same-topic
  const sharedTags = countSharedDnaTags(candidate.dnaTags, kept.dnaTags);
  if (sharedTags >= dedupConfig.minSharedDnaTags && timeGap < dedupConfig.dnaWindow) {
    return { isDuplicate: true, reason: `dna_overlap_${sharedTags}tags_${Math.round(timeGap)}s` };
  }

  // ----- Factor 3: Score Proximity + Same Tags + Moderate Time -----
  // If scores are within threshold AND share tags AND start within scoreWindow
  const scoreA = candidate.judgeResult?.curvedScore ?? candidate.worthClippingScore;
  const scoreB = kept.judgeResult?.curvedScore ?? kept.worthClippingScore;
  const scoreDiff = Math.abs(scoreA - scoreB);
  if (sharedTags >= 1 && scoreDiff <= dedupConfig.scoreProximityThreshold && timeGap < dedupConfig.scoreWindow) {
    return { isDuplicate: true, reason: `score_proximity_${Math.round(scoreDiff)}pts_${Math.round(timeGap)}s` };
  }

  // ----- Factor 4: Transcript Overlap (Jaccard Similarity) -----
  // Only available if we have transcriptExcerpt (RankedMoment) or can compute from somewhere
  // For RawMoment dedup we skip this; applied again post-tier in rankMoments

  return { isDuplicate: false, reason: '' };
}

/**
 * Multi-factor dedup for raw moments (pre-tier).
 *
 * Input must be pre-sorted by score descending.
 * Uses greedy keep-highest-score strategy with multi-factor similarity checks.
 */
function deduplicateMoments(
  moments: RawMoment[],
  dedupConfig: DedupConfig,
): RawMoment[] {
  const kept: RawMoment[] = [];

  for (const moment of moments) {
    let shouldKeep = true;
    let removalReason = '';

    for (let i = 0; i < kept.length; i++) {
      const result = isDuplicateOf(moment, kept[i], dedupConfig, moments.indexOf(moment), i);
      if (result.isDuplicate) {
        shouldKeep = false;
        removalReason = result.reason;
        break;
      }
    }

    if (shouldKeep) {
      kept.push(moment);
    } else {
      const score = moment.judgeResult?.curvedScore ?? moment.worthClippingScore;
      console.log(`[DEDUP] Removed: score=${score} time=${moment.startTime.toFixed(1)}s reason=${removalReason}`);
    }
  }

  return kept;
}

/**
 * Post-ranking transcript-based dedup.
 * After RankedMoments are built with excerpts, check for transcript overlap
 * and remove the lower-ranked one if Jaccard similarity is too high.
 */
function deduplicateByTranscript(
  ranked: RankedMoment[],
  dedupConfig: DedupConfig,
): RankedMoment[] {
  const result: RankedMoment[] = [];

  for (const moment of ranked) {
    let shouldKeep = true;

    for (const kept of result) {
      if (!moment.transcriptExcerpt || !kept.transcriptExcerpt) continue;

      const jaccard = computeJaccardSimilarity(
        moment.transcriptExcerpt,
        kept.transcriptExcerpt,
      );

      if (jaccard >= dedupConfig.transcriptOverlapThreshold) {
        shouldKeep = false;
        console.log(`[DEDUP-TRANSCRIPT] Removed rank ${moment.rank}: Jaccard=${jaccard.toFixed(2)} with rank ${kept.rank}`);
        break;
      }
    }

    if (shouldKeep) {
      result.push(moment);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Phase 5C: Genre-Aware Score Boosts
// ---------------------------------------------------------------------------

/**
 * Apply genre-aware score boosts to moments before ranking.
 * Moments with DNA tags matching genre priorities get a score bump,
 * with genre-specific amplifying boosts.
 */
function applyGenreBoosts(
  moments: RawMoment[],
  genreProfile: GenreProfile,
): void {
  const { dnaPriorities, passBoosts } = genreProfile;
  if (!dnaPriorities || dnaPriorities.length === 0) return;

  let boosted = 0;
  for (const m of moments) {
    const matchCount = m.dnaTags.filter(t => dnaPriorities.includes(t)).length;
    if (matchCount === 0) continue;

    // Base boost: +3 per matching priority tag
    let boost = matchCount * 3;

    // Genre-specific amplifying boosts from passBoosts
    for (const tag of m.dnaTags) {
      if (passBoosts[tag]) {
        boost += passBoosts[tag] * 2; // Amplify pass boost in ranking
      }
    }

    if (boost > 0) {
      m.worthClippingScore = Math.min(100, m.worthClippingScore + boost);
      boosted++;
    }
  }
  if (boosted > 0) {
    console.log(`[GENRE] Applied genre boost to ${boosted}/${moments.length} moments (${genreProfile.genre})`);
  }
}

// ---------------------------------------------------------------------------
// Main Export
// ---------------------------------------------------------------------------

/**
 * Rank, deduplicate, and tier a set of raw moments from the LLM.
 *
 * Phase 5A: Multi-factor dedup replaces simple 30s proximity dedup.
 * Accepts optional dedupConfig for genre-aware dedup windows.
 *
 * @param moments    - Raw moments from the LLM (unranked, may overlap)
 * @param transcript - Full transcript segments for excerpt extraction
 * @param dedupConfig - Optional dedup configuration (genre-aware)
 * @returns RankedMoment[] — sorted, deduped, tiered, presentation-capped
 */
export function rankMoments(
  moments: RawMoment[],
  transcript: TranscriptSegment[],
  dedupConfig?: DedupConfig,
  genreProfile?: GenreProfile,
): RankedMoment[] {
  if (moments.length === 0) return [];

  const config = dedupConfig ?? getDedupConfig(30);

  // Step 1: Sort by score descending
  // V2: Use curvedScore if JudgeResult is available, else worthClippingScore
  const sorted = [...moments].sort((a, b) => {
    const scoreA = a.judgeResult?.curvedScore ?? a.worthClippingScore;
    const scoreB = b.judgeResult?.curvedScore ?? b.worthClippingScore;
    return scoreB - scoreA;
  });

  // Step 2: Apply multi-speaker additive bonus
  const hasSpeakerData = transcript.some(s => s.speaker !== undefined && s.speaker !== 'mixed');
  if (hasSpeakerData) {
    let boostedCount = 0;
    for (const m of sorted) {
      const speakersInWindow = new Set<string>();
      let changes = 0;
      let lastSpeaker: string | undefined;

      for (const seg of transcript) {
        if (seg.start >= m.startTime && seg.start < m.endTime) {
          const s = seg.speaker;
          if (s && s !== 'mixed') {
            speakersInWindow.add(s);
            if (lastSpeaker && s !== lastSpeaker) {
              changes++;
            }
            lastSpeaker = s;
          }
        }
      }

      let bonus = 0;
      if (speakersInWindow.size >= 2) {
        bonus += MULTI_SPEAKER_BONUS;
      }
      if (changes >= 3) {
        bonus += DEBATE_BONUS;
      } else if (changes >= 1) {
        bonus += REACTION_BONUS;
      }

      if (bonus > 0) {
        m.worthClippingScore = Math.min(100, m.worthClippingScore + bonus);
        boostedCount++;
      }
    }
    if (boostedCount > 0) {
      console.log(`[RANK] Applied speaker boost to ${boostedCount}/${sorted.length} moments`);
    }
  }

  // Step 2: Phase 5C — Apply genre-aware score boosts before dedup
  if (genreProfile) {
    applyGenreBoosts(sorted, genreProfile);
  }

  // Step 3: Phase 5A — Multi-factor dedup
  const deduped = deduplicateMoments(sorted, config);
  console.log(`[DEDUP] Multi-factor dedup: ${sorted.length} → ${deduped.length} (config: primaryWindow=${config.primaryWindow}s)`);
  console.log(`[FORENSIC] Score distribution of ${sorted.length} moments: ${scoreDistributionSummary(sorted)}`);
  console.log(`[FORENSIC] Dedup removed ${sorted.length - deduped.length} moments (see individual [DEDUP] Removed lines for per-factor breakdown)`);

  // Step 4: Calculate adaptive thresholds
  const thresholds = calculateThresholds(deduped.length);
  console.log(`[RANK] Adaptive thresholds: elite≥${thresholds.elite} secondary≥${thresholds.secondary} (${deduped.length} moments)`);

  // Step 5: Score-based classification
  const elite: RawMoment[] = [];
  const secondary: RawMoment[] = [];
  const solid: RawMoment[] = [];

  for (const m of deduped) {
    if (m.worthClippingScore >= thresholds.elite) {
      elite.push(m);
    } else if (m.worthClippingScore >= thresholds.secondary) {
      secondary.push(m);
    } else if (m.worthClippingScore >= thresholds.minimum) {
      solid.push(m);
    }
  }

  console.log(`[FORENSIC] Score tiers: ${elite.length} elite (≥${thresholds.elite}), ${secondary.length} secondary (≥${thresholds.secondary}), ${solid.length} solid (≥${thresholds.minimum})`);

  // Step 6: Apply presentation caps
  const topElite = elite.slice(0, MAX_ELITE);
  const topSecondary = secondary.slice(0, MAX_SECONDARY);
  const topSolid = solid.slice(0, Math.min(3, solid.length));

  // Step 7: Combine
  const top = [...topElite, ...topSecondary, ...topSolid];

  // Step 8: Build RankedMoments
  let ranked: RankedMoment[] = top.map((m, index) => {
    const rank = index + 1;
    const tier = assignTier(m.worthClippingScore, thresholds);

    return {
      ...m,
      rank,
      tier,
      startTimestamp: secondsToTimestamp(m.startTime),
      endTimestamp: secondsToTimestamp(m.endTime),
      transcriptExcerpt: extractExcerpt(m.startTime, m.endTime, transcript),
    };
  });

  // Step 9: Phase 5A — Transcript-based dedup (Jaccard similarity on excerpts)
  if (ranked.length >= 2) {
    const beforeCount = ranked.length;
    ranked = deduplicateByTranscript(ranked, config);
    if (ranked.length < beforeCount) {
      console.log(`[DEDUP-TRANSCRIPT] Transcript dedup: ${beforeCount} → ${ranked.length}`);
    }
  }

  // Step 10: Diversity enforcement
  if (ranked.length >= 4) {
    ranked = enforceDiversity(ranked);
    ranked = ranked.map((m, index) => ({ ...m, rank: index + 1 }));
  }

  return ranked;
}

// ---------------------------------------------------------------------------
// Tier Assignment
// ---------------------------------------------------------------------------

function assignTier(score: number, thresholds?: AdaptiveThresholds): MomentTier {
  const elite = thresholds?.elite ?? ELITE_THRESHOLD;
  if (score >= elite) return 'elite';
  return 'secondary';
}

// ---------------------------------------------------------------------------
// Transcript Excerpt Extraction
// ---------------------------------------------------------------------------

function extractExcerpt(
  startTime: number,
  endTime: number,
  transcript: TranscriptSegment[],
): string {
  const words: string[] = [];

  for (const seg of transcript) {
    if (seg.start >= startTime && seg.start < endTime) {
      words.push(seg.text);
    }
  }

  const excerpt = words.join(' ').trim();
  if (excerpt.length > 500) {
    return excerpt.slice(0, 497) + '...';
  }

  return excerpt;
}

// ---------------------------------------------------------------------------
// Merge & Re-rank
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Forensic helpers
// ---------------------------------------------------------------------------

/** Summarize score distribution into buckets for forensic logging. */
function scoreDistributionSummary(moments: RawMoment[]): string {
  const buckets = { '90-100': 0, '80-89': 0, '70-79': 0, '60-69': 0, '50-59': 0, '40-49': 0, '30-39': 0, '<30': 0 };
  for (const m of moments) {
    const s = m.worthClippingScore;
    if (s >= 90) buckets['90-100']++;
    else if (s >= 80) buckets['80-89']++;
    else if (s >= 70) buckets['70-79']++;
    else if (s >= 60) buckets['60-69']++;
    else if (s >= 50) buckets['50-59']++;
    else if (s >= 40) buckets['40-49']++;
    else if (s >= 30) buckets['30-39']++;
    else buckets['<30']++;
  }
  return Object.entries(buckets).filter(([,v]) => v > 0).map(([k,v]) => `${k}:${v}`).join(' ');
}
