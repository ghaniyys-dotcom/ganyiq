/**
 * lib/transcript/fusion/deepgram-to-provider.ts — Deepgram → ProviderResult adapter
 *
 * Converts the legacy Deepgram output format to the new normalized ProviderResult.
 * Also extracts speaker information from Deepgram utterances.
 */

import type { DeepgramResult } from '../../deepgram';
import type { ProviderResult, TranscriptWord, TranscriptSegment } from '../providers/types';
import type { TranscriptSegment as LegacySegment } from '../../types';

/**
 * Convert legacy DeepgramResult to normalized ProviderResult.
 *
 * Deepgram nova-2 with utterances=true returns speaker labels
 * in the utterance objects. This extracts them and maps to our format.
 */
export function deepgramToProviderResult(
  dgResult: DeepgramResult,
): ProviderResult {
  const words = extractWordsFromDeepgram();
  const segments = convertSegments(dgResult.segments);
  const speakers = extractSpeakersFromSegments(segments);

  return {
    transcript: dgResult.fullTranscript,
    segments,
    words,
    confidence: dgResult.confidence,
    durationSeconds: computeDuration(segments),
    speakers,
    providerName: 'deepgram',
    latencyMs: 0, // Not tracked by legacy code
  };
}

/**
 * Convert legacy TranscriptSegment[] to new format with speaker extraction.
 * Note: Legacy segments may not have word-level data.
 */
function convertSegments(
  legacySegments: LegacySegment[],
): TranscriptSegment[] {
  return legacySegments.map((seg) => ({
    start: seg.start,
    duration: seg.duration,
    text: seg.text,
    speaker: (seg as any).speaker || undefined,
  }));
}

/**
 * Extract word-level data from Deepgram.
 * Legacy path: segments don't carry word arrays,
 * so we reconstruct from segment boundaries.
 */
function extractWordsFromDeepgram(): TranscriptWord[] {
  // Legacy Deepgram path doesn't provide word arrays in segments.
  // Words are reconstructed in the fusion step.
  return [];
}

function computeDuration(segments: TranscriptSegment[]): number {
  if (segments.length === 0) return 0;
  const last = segments[segments.length - 1];
  return last.start + last.duration;
}

function extractSpeakersFromSegments(segments: TranscriptSegment[]): string[] {
  const speakerSet = new Set<string>();
  for (const s of segments) {
    if (s.speaker) speakerSet.add(s.speaker);
  }
  return [...speakerSet].sort();
}
