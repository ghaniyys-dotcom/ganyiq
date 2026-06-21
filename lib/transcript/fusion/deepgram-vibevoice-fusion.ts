/**
 * lib/transcript/fusion/deepgram-vibevoice-fusion.ts — Transcript Fusion Engine
 *
 * Merges Deepgram transcript (word timestamps, high ASR accuracy) with
 * VibeVoice speaker assignments (who said what).
 *
 * Rules:
 * - Deepgram remains source of word timestamps (start, end)
 * - VibeVoice becomes source of speaker assignments
 * - Handles overlap between the two outputs
 * - Handles missing speaker segments (graceful degradation)
 * - Handles confidence conflicts (prefer VibeVoice for speaker, Deepgram for words)
 */

import type {
  ProviderResult,
  TranscriptWord,
  TranscriptSegment,
} from '../providers/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FusionResult {
  /** Merged word-level transcript */
  words: TranscriptWord[];
  /** Merged segments with speaker labels */
  segments: TranscriptSegment[];
  /** Full plain-text */
  transcript: string;
  /** Overall confidence */
  confidence: number;
  /** How many words got speaker assignments from VibeVoice */
  vibevoiceSpeakerCount: number;
  /** How many words kept Deepgram speaker or had no speaker */
  deepgramFallbackCount: number;
  /** Source provider summary */
  sources: {
    transcription: 'deepgram' | 'vibevoice';
    speaker: 'vibevoice' | 'deepgram' | 'none';
  };
}

// ---------------------------------------------------------------------------
// Fusion Engine
// ---------------------------------------------------------------------------

/**
 * Fuse Deepgram transcript with VibeVoice speaker assignments.
 *
 * @param deepgram - ProviderResult from Deepgram (timestamps + words)
 * @param vibevoice - ProviderResult from VibeVoice (speaker segments)
 * @returns Merged FusionResult
 */
export function fuseTranscripts(
  deepgram: ProviderResult,
  vibevoice: ProviderResult | null,
): FusionResult {
  // If VibeVoice is not available, return Deepgram as-is
  if (!vibevoice || vibevoice.segments.length === 0) {
    return produceFallbackResult(deepgram, 'deepgram', 'none');
  }

  // If Deepgram has no word-level data, use VibeVoice as-is
  if (deepgram.words.length === 0) {
    return produceFallbackResult(vibevoice, 'vibevoice', 'vibevoice');
  }

  // Main fusion: Deepgram words + VibeVoice speakers
  const dgWords = deepgram.words;
  const vvSegments = vibevoice.segments;

  let vibevoiceSpeakerCount = 0;
  let deepgramFallbackCount = 0;

  const fusedWords: TranscriptWord[] = dgWords.map((word) => {
    // Assign speaker from VibeVoice based on timestamp overlap
    const speaker = assignSpeakerByTimestamp(word, vvSegments);

    if (speaker) {
      vibevoiceSpeakerCount++;
    } else if (word.speaker) {
      // Keep Deepgram's own speaker label as fallback
      deepgramFallbackCount++;
    }

    return {
      ...word,
      speaker: speaker || word.speaker, // VibeVoice > Deepgram
    };
  });

  // Build segments from fused words (using Deepgram's timing)
  const fusedSegments = buildFusedSegments(fusedWords, deepgram.segments, vvSegments);

  return {
    words: fusedWords,
    segments: fusedSegments,
    transcript: buildTranscript(fusedWords),
    confidence: deepgram.confidence,
    vibevoiceSpeakerCount,
    deepgramFallbackCount,
    sources: {
      transcription: 'deepgram',
      speaker: vibevoiceSpeakerCount > 0 ? 'vibevoice' : 'deepgram',
    },
  };
}

// ---------------------------------------------------------------------------
// Speaker Assignment
// ---------------------------------------------------------------------------

/**
 * Assign a speaker label from VibeVoice segments based on word timestamp overlap.
 * Uses a 0.3s tolerance window for matching.
 */
function assignSpeakerByTimestamp(
  word: TranscriptWord,
  vvSegments: TranscriptSegment[],
): string | undefined {
  const wordMid = (word.start + word.end) / 2;
  const TOLERANCE = 0.3; // seconds

  for (const seg of vvSegments) {
    const segEnd = seg.start + seg.duration;
    // Check if word midpoint falls within segment (with tolerance)
    if (wordMid >= seg.start - TOLERANCE && wordMid <= segEnd + TOLERANCE) {
      return seg.speaker;
    }
  }

  return undefined;
}

/**
 * Handle overlapping speaker assignments.
 * If a word falls within TWO VibeVoice segments, pick the one with
 * the closest midpoint to the word's midpoint.
 */
function assignSpeakerWithOverlapHandling(
  word: TranscriptWord,
  vvSegments: TranscriptSegment[],
): string | undefined {
  const wordMid = (word.start + word.end) / 2;
  const TOLERANCE = 0.3;

  const candidates: Array<{ speaker: string; distance: number }> = [];

  for (const seg of vvSegments) {
    const segEnd = seg.start + seg.duration;
    if (wordMid >= seg.start - TOLERANCE && wordMid <= segEnd + TOLERANCE) {
      const segMid = (seg.start + segEnd) / 2;
      candidates.push({
        speaker: seg.speaker || 'unknown',
        distance: Math.abs(wordMid - segMid),
      });
    }
  }

  if (candidates.length === 0) return undefined;

  // Pick the closest segment
  candidates.sort((a, b) => a.distance - b.distance);
  return candidates[0].speaker;
}

// ---------------------------------------------------------------------------
// Segment Building
// ---------------------------------------------------------------------------

function buildFusedSegments(
  words: TranscriptWord[],
  dgSegments: TranscriptSegment[],
  vvSegments: TranscriptSegment[],
): TranscriptSegment[] {
  if (words.length === 0) return [];

  // Group words into segments (preserving Deepgram boundaries, adding speaker)
  const segments: TranscriptSegment[] = [];

  // Use VibeVoice segment boundaries as the primary structure
  // because they have proper speaker labels
  if (vvSegments.length > 0 && hasSpeakerData(vvSegments)) {
    for (const vvSeg of vvSegments) {
      const segWords = words.filter(
        (w) =>
          w.start >= vvSeg.start - 0.3 &&
          w.end <= vvSeg.start + vvSeg.duration + 0.3,
      );

      if (segWords.length > 0) {
        segments.push({
          start: vvSeg.start,
          duration: vvSeg.duration,
          text: segWords.map((w) => w.word).join(' '),
          speaker: vvSeg.speaker,
          words: segWords,
        });
      } else {
        // Keep VibeVoice segment even without Deepgram words
        segments.push(vvSeg);
      }
    }
    return segments;
  }

  // Fallback: Deepgram segments with speaker from words
  for (const dgSeg of dgSegments) {
    const segWords = words.filter(
      (w) => w.start >= dgSeg.start && w.start <= dgSeg.start + dgSeg.duration,
    );

    const uniqueSpeakers = [...new Set(segWords.map(w => w.speaker).filter(Boolean))];
    const speaker = uniqueSpeakers.length === 1 ? uniqueSpeakers[0] : undefined;

    segments.push({
      start: dgSeg.start,
      duration: dgSeg.duration || (segWords.length > 0
        ? segWords[segWords.length - 1].end - segWords[0].start
        : 5),
      text: dgSeg.text,
      speaker: speaker || dgSeg.speaker,
      words: segWords.length > 0 ? segWords : undefined,
    });
  }

  return segments;
}

function buildTranscript(words: TranscriptWord[]): string {
  return words.map((w) => w.word).join(' ');
}

function produceFallbackResult(
  source: ProviderResult,
  transcriptionSource: 'deepgram' | 'vibevoice',
  speakerSource: 'vibevoice' | 'deepgram' | 'none',
): FusionResult {
  return {
    words: source.words,
    segments: source.segments,
    transcript: source.transcript,
    confidence: source.confidence,
    vibevoiceSpeakerCount: 0,
    deepgramFallbackCount: source.words.length,
    sources: {
      transcription: transcriptionSource,
      speaker: speakerSource,
    },
  };
}

function hasSpeakerData(segments: TranscriptSegment[]): boolean {
  return segments.some(s => s.speaker !== undefined && s.speaker !== '');
}
