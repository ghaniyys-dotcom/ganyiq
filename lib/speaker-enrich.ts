/**
 * lib/speaker-enrich.ts — Speaker metadata enrichment module.
 *
 * Analyzes speaker labels from Deepgram diarization to provide
 * conversational awareness to the analysis pipeline.
 *
 * All functions are NO-OP when speaker data is absent — graceful
 * degradation for YouTube transcripts (no diarization).
 *
 * Architecture:
 *   1. detectSpeakerChanges() — Find speaker transition points
 *   2. measureExchangeRate() — Calculate speaker switch frequency
 *   3. detectDebateSegments() — Find rapid back-and-forth windows
 *   4. detectReactionMoments() — Find brief secondary-speaker utterances
 *   5. getCandidateSpeakerMetadata() — Speaker profile per candidate window
 */

import type { TranscriptSegment } from '@/lib/types';
import type { CandidateWindow } from '@/lib/candidate-extraction';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SpeakerChangePoint {
  segmentIndex: number;
  fromSpeaker: string | undefined;
  toSpeaker: string | undefined;
  timestamp: number;  // seconds
}

export interface DebateSegment {
  startIndex: number;
  endIndex: number;
  startTime: number;
  endTime: number;
  exchangeCount: number;     // Total speaker switches
  exchangeRate: number;      // Switches per minute
  intensity: 'low' | 'medium' | 'high';
}

export interface ReactionMoment {
  segmentIndex: number;
  timestamp: number;
  text: string;
  speaker: string | undefined;
  primarySpeaker: string | undefined;
}

export interface CandidateSpeakerProfile {
  speakers: string[];                // Unique speakers in window
  speakerChangeCount: number;        // Number of speaker transitions
  exchangeRate: number;              // Transitions per minute
  primarySpeaker: string | undefined; // Speaker with most segments
  isDebate: boolean;                 // High exchange rate
  isMonologue: boolean;              // Single speaker throughout
  hasReaction: boolean;              // Contains reaction moment
}

// ---------------------------------------------------------------------------
// Detection Functions
// ---------------------------------------------------------------------------

/**
 * Find all points where the speaker changes between consecutive segments.
 * Returns empty array when no speaker data is present.
 */
export function detectSpeakerChanges(
  segments: TranscriptSegment[],
): SpeakerChangePoint[] {
  if (!segments || segments.length < 2) return [];
  // Check if any segment has speaker data
  if (!segments.some(s => s.speaker !== undefined && s.speaker !== 'mixed')) return [];

  const changes: SpeakerChangePoint[] = [];

  for (let i = 1; i < segments.length; i++) {
    const prev = segments[i - 1];
    const curr = segments[i];

    // Only count clean speaker changes (not mixed segments)
    if (
      prev.speaker &&
      curr.speaker &&
      prev.speaker !== 'mixed' &&
      curr.speaker !== 'mixed' &&
      prev.speaker !== curr.speaker
    ) {
      changes.push({
        segmentIndex: i,
        fromSpeaker: prev.speaker,
        toSpeaker: curr.speaker,
        timestamp: curr.start,
      });
    }
  }

  return changes;
}

/**
 * Calculate speaker exchange rate for a window of segments.
 * Returns switches per minute (0 if no speaker data or no changes).
 */
export function measureExchangeRate(
  startIndex: number,
  endIndex: number,
  changes: SpeakerChangePoint[],
): number {
  const relevantChanges = changes.filter(
    c => c.segmentIndex >= startIndex && c.segmentIndex <= endIndex,
  );

  if (relevantChanges.length === 0) return 0;

  const totalSwitches = relevantChanges.length;
  return totalSwitches; // Return raw count; caller divides by duration if needed
}

/**
 * Detect debate segments — windows of rapid speaker exchange.
 *
 * A "debate" is defined as 3+ speaker changes within a 30-second window.
 * Intensity is based on exchange rate per minute.
 */
export function detectDebateSegments(
  segments: TranscriptSegment[],
  changes: SpeakerChangePoint[],
  windowSeconds: number = 30,
  minChanges: number = 3,
): DebateSegment[] {
  if (changes.length < minChanges) return [];

  const debates: DebateSegment[] = [];

  for (let i = 0; i < changes.length; i++) {
    const windowEnd = changes[i].timestamp + windowSeconds;
    let j = i;
    while (j < changes.length && changes[j].timestamp <= windowEnd) {
      j++;
    }

    const exchangeCount = j - i;
    if (exchangeCount >= minChanges) {
      const firstIdx = changes[i].segmentIndex;
      const lastIdx = changes[j - 1].segmentIndex;
      const startTime = changes[i].timestamp;
      const endTime = changes[j - 1].timestamp;
      const actualDuration = Math.max(1, endTime - startTime);
      const rate = (exchangeCount / actualDuration) * 60; // per minute

      // Determine intensity
      let intensity: 'low' | 'medium' | 'high';
      if (rate >= 12) {
        intensity = 'high';        // ≥12 changes/min = heated debate
      } else if (rate >= 6) {
        intensity = 'medium';      // 6-12 changes/min = active discussion
      } else {
        intensity = 'low';         // 3-6 changes/min = normal conversation
      }

      debates.push({
        startIndex: firstIdx - 1 < 0 ? 0 : firstIdx - 1,
        endIndex: lastIdx + 1 >= segments.length ? segments.length - 1 : lastIdx + 1,
        startTime,
        endTime,
        exchangeCount,
        exchangeRate: Math.round(rate),
        intensity,
      });

      // Skip overlapping windows
      i = j;
    }
  }

  return debates;
}

/**
 * Detect reaction moments — brief utterances from a secondary speaker
 * during another speaker's turn.
 *
 * Examples: laughter, "wow", "really?", "iya", "oh", "gitu"
 */
export function detectReactionMoments(
  segments: TranscriptSegment[],
  changes: SpeakerChangePoint[],
): ReactionMoment[] {
  if (!segments || segments.length < 3) return [];
  if (!segments.some(s => s.speaker !== undefined && s.speaker !== 'mixed')) return [];

  const reactions: ReactionMoment[] = [];

  // Brief utterance keywords (Indonesian + English)
  const reactionWords = new Set([
    'oh', 'ah', 'eh', 'ohh', 'ahh', 'woah', 'wow',
    'iya', 'ya', 'y' ,'yes', 'tuh', 'nah', 'loh', 'lho',
    'sih', 'dong', 'kok', 'gitu', 'begitu', 'masa',
    'serius', 'beneran', 'really', 'seriously',
    'hah', 'ha', 'hmm', 'mmm', 'oh ya', 'oh gitu',
    'gila', 'anjir', 'waduh', 'astaga', 'aduh',
    'what', 'wait', 'whoa', 'no way', 'omg',
  ]);

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (!seg.speaker || seg.speaker === 'mixed') continue;

    // Check if this is a brief segment (<3s effective or few words)
    const wordCount = seg.text.split(/\s+/).length;
    if (wordCount > 5) continue; // Too many words to be a reaction

    // Check if text matches reaction patterns
    const textLower = seg.text.toLowerCase().trim();
    const isReaction = reactionWords.has(textLower) ||
      textLower.endsWith('?') && wordCount <= 3 ||
      [...reactionWords].some(w => textLower === w);

    if (isReaction) {
      // Determine who the primary speaker was before this reaction
      let primarySpeaker: string | undefined;
      for (let j = i - 1; j >= 0; j--) {
        if (segments[j].speaker && segments[j].speaker !== 'mixed') {
          primarySpeaker = segments[j].speaker;
          break;
        }
      }

      reactions.push({
        segmentIndex: i,
        timestamp: seg.start,
        text: seg.text.trim(),
        speaker: seg.speaker,
        primarySpeaker: primarySpeaker !== seg.speaker ? primarySpeaker : undefined,
      });
    }
  }

  return reactions;
}

/**
 * Get the top-level speaker (dominant speaker) from a segment range.
 * Returns the speaker with the most text in the range.
 */
export function getDominantSpeaker(
  segments: TranscriptSegment[],
  startIndex: number,
  endIndex: number,
): string | undefined {
  const speakerText: Record<string, number> = {};

  for (let i = startIndex; i <= endIndex; i++) {
    const seg = segments[i];
    if (seg.speaker && seg.speaker !== 'mixed') {
      speakerText[seg.speaker] = (speakerText[seg.speaker] || 0) + seg.text.length;
    }
  }

  const entries = Object.entries(speakerText);
  if (entries.length === 0) return undefined;

  return entries.sort((a, b) => b[1] - a[1])[0][0];
}

/**
 * Build a speaker profile for a candidate window.
 * Gracefully handles missing speaker data — returns monologue profile.
 */
export function getCandidateSpeakerProfile(
  segments: TranscriptSegment[],
  candidateStartIndex: number,
  candidateEndIndex: number,
  allChanges: SpeakerChangePoint[],
): CandidateSpeakerProfile {
  // Check if speaker data exists
  const hasSpeakerData = segments.some(s => s.speaker !== undefined && s.speaker !== 'mixed');
  if (!hasSpeakerData) {
    return {
      speakers: [],
      speakerChangeCount: 0,
      exchangeRate: 0,
      primarySpeaker: undefined,
      isDebate: false,
      isMonologue: true,
      hasReaction: false,
    };
  }

  // Get unique speakers in this window
  const speakerSet = new Set<string>();
  for (let i = candidateStartIndex; i <= candidateEndIndex; i++) {
    const s = segments[i]?.speaker;
    if (s && s !== 'mixed') speakerSet.add(s);
  }

  const speakers = [...speakerSet];
  const changeCount = allChanges.filter(
    c => c.segmentIndex >= candidateStartIndex && c.segmentIndex <= candidateEndIndex,
  ).length;

  // Duration for exchange rate
  const startTime = segments[candidateStartIndex]?.start ?? 0;
  const endSeg = segments[candidateEndIndex];
  const endTime = endSeg ? endSeg.start + endSeg.duration : 0;
  const durationSec = Math.max(1, endTime - startTime);
  const exchangeRate = (changeCount / durationSec) * 60;

  const primarySpeaker = getDominantSpeaker(segments, candidateStartIndex, candidateEndIndex);

  return {
    speakers,
    speakerChangeCount: changeCount,
    exchangeRate: Math.round(exchangeRate * 10) / 10,
    primarySpeaker,
    isDebate: changeCount >= 3 && exchangeRate >= 6,
    isMonologue: speakers.length <= 1,
    hasReaction: speakers.length > 1 && changeCount > 0,
  };
}

// ---------------------------------------------------------------------------
// Main Export
// ---------------------------------------------------------------------------

export interface SpeakerEnrichmentResult {
  changes: SpeakerChangePoint[];
  exchanges: number;           // Total speaker changes in full transcript
  uniqueSpeakers: number;      // Distinct speaker count
  debateSegments: DebateSegment[];
  reactionMoments: ReactionMoment[];
  hasSpeakerData: boolean;
}

/**
 * Run full speaker enrichment on a transcript.
 *
 * @param segments - Transcript segments from YouTube or Deepgram
 * @returns Enriched speaker metadata (empty/zero when no speaker data)
 */
export function enrichTranscript(
  segments: TranscriptSegment[],
): SpeakerEnrichmentResult {
  const hasSpeakerData = segments.some(
    s => s.speaker !== undefined && s.speaker !== 'mixed'
  );

  if (!hasSpeakerData) {
    return {
      changes: [],
      exchanges: 0,
      uniqueSpeakers: 0,
      debateSegments: [],
      reactionMoments: [],
      hasSpeakerData: false,
    };
  }

  const changes = detectSpeakerChanges(segments);
  const uniqueSpeakers = new Set(
    segments
      .filter(s => s.speaker && s.speaker !== 'mixed')
      .map(s => s.speaker as string)
  ).size;
  const debateSegments = detectDebateSegments(segments, changes);
  const reactionMoments = detectReactionMoments(segments, changes);

  return {
    changes,
    exchanges: changes.length,
    uniqueSpeakers,
    debateSegments,
    reactionMoments,
    hasSpeakerData: true,
  };
}
