/**
 * lib/transcript-cleaner.ts — Conservative transcript cleaning for GANYIQ.
 *
 * Removes noise from raw YouTube / Deepgram transcripts without altering meaning,
 * emotion, humor, or storytelling content.
 *
 * Cleaning operations:
 *   1. Remove filler words (anu, eh, oh, ah, etc.)
 *   2. Remove stutter patterns (repeated word at start)
 *   3. Remove duplicate fragments
 *   4. Normalize whitespace
 *
 * Design principles:
 *   - CONSERVATIVE: Better to leave noise than destroy meaning
 *   - PRESERVE: Emotion, humor, storytelling, emphasis
 *   - IDEMPOTENT: Running twice produces same result
 *   - LANGUAGE-AWARE: Handles Indonesian and English patterns
 */

import type { TranscriptSegment } from '@/lib/types';

// ---------------------------------------------------------------------------
// Filler words — safe to remove (adds no meaning)
// ---------------------------------------------------------------------------

/** Indonesian filler words — single words that carry no semantic content. */
const ID_FILLERS = new Set([
  'anu', 'eh', 'oh', 'ah', 'ih', 'uh', 'hmm', 'mmm',
  'nah', 'yuk', 'dek', 'sih', 'dong', 'kok', 'loh', 'lho',
  'dah', 'deh', 'yah', 'ya', 'si', 'lah',
  'gitu', 'gitulah', 'gituloh',
  'begitu', 'begitulah',
  'oke', 'ok', 'okay',
  'well',
  'jadi', // Only as filler at sentence start — but risky to remove, keep for now
]);

/** English filler words */
const EN_FILLERS = new Set([
  'um', 'uh', 'ah', 'er', 'hmm', 'like',
  'you know', 'i mean', 'sort of', 'kind of',
]);

// ---------------------------------------------------------------------------
// Stutter patterns — repeated words at the start of a segment
// ---------------------------------------------------------------------------

/** Regex for common Indonesian stutter patterns. */
const ID_STUTTER = /^(\w+)[- ]\1\b/i;

/** Regex for common English stutter patterns. */
const EN_STUTTER = /^(\w+)[- ]\1\b/i;

// ---------------------------------------------------------------------------
// Duplicate fragment detection
// ---------------------------------------------------------------------------

/** Minimum length for a fragment to be considered a duplicate. */
const MIN_DUPE_LENGTH = 10;

/** Maximum gap between duplicates to consider them adjacent. */
const MAX_DUPE_GAP_CHARS = 15;

// ---------------------------------------------------------------------------
// Cleaning pipeline
// ---------------------------------------------------------------------------

/**
 * Clean a single transcript segment text.
 * Applied per-segment so timestamps remain accurate.
 */
function cleanSegmentText(text: string): string {
  if (!text || text.trim().length === 0) return text;

  let cleaned = text;

  // Step 1: Remove leading stutters (e.g., "gua-gua" → "gua")
  const stutterMatch = cleaned.match(/(\w+)[- ]\1\b/i);
  if (stutterMatch && stutterMatch.index === 0) {
    // Only remove stutter at the start of the segment
    // Keep the first occurrence, remove the duplication
    const word = stutterMatch[1];
    cleaned = cleaned.slice(stutterMatch[0].length).trim();
    cleaned = word + ' ' + cleaned;
  }

  // Step 2: Remove isolated filler words
  // Only remove fillers that are surrounded by spaces or punctuation
  // to avoid breaking compound words
  for (const filler of ID_FILLERS) {
    // Match filler when it's a standalone word (not part of another word)
    const regex = new RegExp(`\\b${filler}\\b`, 'gi');
    cleaned = cleaned.replace(regex, '');
  }
  for (const filler of EN_FILLERS) {
    const regex = new RegExp(`\\b${filler}\\b`, 'gi');
    cleaned = cleaned.replace(regex, '');
  }

  // Step 3: Remove consecutive duplicate fragments
  // e.g., "back back back back back" → "back"
  // This catches the repetitive word patterns common in Deepgram output
  cleaned = cleaned.replace(/(\b\w+\b)(?:\s+\1\b)+/gi, '$1');

  // Step 4: Remove repeated single characters (e.g., "teng teng teng")
  // Only when the same word repeats more than 3 times
  cleaned = cleaned.replace(/(\b\w{1,4}\b)(?:\s+\1\b){3,}/gi, '$1 (repeated)');

  // Step 5: Clean up whitespace
  cleaned = cleaned.replace(/\s{2,}/g, ' ').trim();

  return cleaned;
}

// ---------------------------------------------------------------------------
// Main Export
// ---------------------------------------------------------------------------

/**
 * Apply conservative transcript cleaning to an array of transcript segments.
 *
 * Each segment is cleaned independently to preserve timing information.
 * Only removes noise — never alters meaning, emotion, or storytelling.
 *
 * @param segments - Raw transcript segments from YouTube/Deepgram
 * @returns Cleaned transcript segments (same array, modified in-place)
 */
export function cleanTranscript(segments: TranscriptSegment[]): TranscriptSegment[] {
  if (!segments || segments.length === 0) return segments;

  let totalCharsBefore = 0;
  let totalCharsAfter = 0;
  let cleanedCount = 0;

  for (const segment of segments) {
    const original = segment.text;
    totalCharsBefore += original.length;

    const cleaned = cleanSegmentText(original);

    if (cleaned !== original) {
      segment.text = cleaned;
      cleanedCount++;
    }

    totalCharsAfter += cleaned.length;
  }

  const reduction = totalCharsBefore > 0
    ? Math.round((1 - totalCharsAfter / totalCharsBefore) * 100)
    : 0;

  console.log(
    `[CLEAN] Cleaned ${cleanedCount}/${segments.length} segments | ` +
    `chars: ${totalCharsBefore} → ${totalCharsAfter} (-${reduction}%)`
  );

  return segments;
}
