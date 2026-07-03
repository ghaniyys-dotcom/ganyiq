/**
 * worker/emphasis-engine.ts — NLP word emphasis detection for GANYIQ V3 (P0.4).
 *
 * Analyzes word-level timestamps and classifies each word for visual emphasis:
 *
 *   highlight — numbers, money, names, emotional phrases, hooks
 *   dim       — filler words (uh, um, jadi, anu)
 *   none      — normal words (remain in base color)
 *
 * Design principles:
 *   - Only 10-15% of words should be emphasized (over-emphasis = no emphasis)
 *   - Emphasis works with existing karaoke system (\\K timing is unchanged)
 *   - Pure TypeScript, no external NLP dependencies
 *   - Two analysis passes: first pass classifies, second pass enforces density limit
 *
 * Usage:
 *   const emphasisMap = analyzeWordEmphasis(words, speakerSegments);
 *   // emphasisMap.get(wordIndex) => { type: 'highlight', color: '&H00E2C266' }
 */

import type { WordTimestamp, SpeakerLabel } from './speaker-detector';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EmphasisType = 'none' | 'highlight' | 'dim';

export interface EmphasisInfo {
  type: EmphasisType;
  color: string;       // ASS color format: &H00RRGGBB
  reason?: string;     // for debugging
}

// ---------------------------------------------------------------------------
// Emphasis Colors (ASS BGR format)
// ---------------------------------------------------------------------------

// ASS uses BGR format: &H00BBGGRR
// So &H0066C2E2 in ASS = R=0xE2, G=0xC2, B=0x66 → gold
const ASS_GOLD = '&H0066C2E2';     // gold highlight (#E2C266 → BGR: 66C2E2)
const ASS_WHITE = '&H00FFFFFF';    // normal
const ASS_GRAY = '&H00888888';     // dim/filler

// ---------------------------------------------------------------------------
// Detection Patterns
// ---------------------------------------------------------------------------

// ── Number patterns ──
const NUMBER_RE = /\b\d+(?:[.,]\d+)?(?:x|×|k|K|m|M|b|B|rb|jt|triliun)?\b/;
const PERCENTAGE_RE = /\b\d+(?:[.,]\d+)?%/;
const ORDINAL_RE = /\b(?:pertama|kedua|ketiga|ke-\d+|1st|2nd|3rd|\d+th)\b/i;
const INDONESIAN_NUMBER_RE = /\b(?:ratus|ribu|juta|miliar|triliun|setengah|seperempat)\b/i;

// ── Money patterns ──
const MONEY_RE = /\b(?:Rp|USD|EUR|GBP|Rp\.?)\s*\d+(?:[.,]\d+)?(?:\s*(?:ribu|juta|miliar))?\b/i;
const MONEY_WORD_RE = /\b\d+\s*(?:ratus\s*)?(?:ribu|juta|miliar|triliun)\s*(?:rupiah|dolar|euro)?\b/i;

// ── Emotional/Hook phrases ──
const EMOTIONAL_WORDS = new Set([
  // English
  'incredible', 'amazing', 'unbelievable', 'wow', 'crazy', 'insane',
  'brilliant', 'terrible', 'horrible', 'fantastic', 'beautiful',
  'disgusting', 'shocking', 'stunning', 'hilarious', 'genius',
  'disaster', 'miracle', 'nightmare', 'legendary', 'epic',
  'absolutely', 'completely', 'totally', 'literally', 'seriously',
  // Indonesian
  'luar', 'biasa', 'gila', 'mantap', 'keren', 'sakit', 'parah',
  'ngeri', 'sumpah', 'serius', 'jahat', 'brutal', 'fantastis',
  'mengerikan', 'indah', 'sempurna', 'hebat', 'dahsyat',
  // Emotional core
  'love', 'hate', 'cry', 'laugh', 'died', 'death', 'win', 'lost',
  'menang', 'kalah', 'mati', 'hidup', 'selamat',
]);

const HOOK_PATTERNS = [
  /\byou won't believe\b/i,
  /\bwait (?:for|until|till)\b/i,
  /\bcheck this\b/i,
  /\bwatch this\b/i,
  /\byou need to see\b/i,
  /\bthis is (?:what happens|why|how)\b/i,
  /\bthe (?:moment|second|minute)\b/i,
  /\bthis changes everything\b/i,
  /\bwhat happened next\b/i,
  /\byou'll never guess\b/i,
  /\bi can't believe\b/i,
  /\bdont (?:miss|skip)\b/i,
  /\btunggu\b/i,
  /\blihat (?:ini|nih)\b/i,
  /\bcoba lihat\b/i,
  /\bgak bakal (?:percaya|nyangka)\b/i,
  /\bini (?:gila|parah|ngeri)\b/i,
];

// ── Question patterns ──
const QUESTION_WORDS = new Set([
  'kenapa', 'mengapa', 'bagaimana', 'apa', 'siapa', 'kapan', 'dimana',
  'why', 'how', 'what', 'who', 'when', 'where', 'which',
]);

// ── Filler words ──
const FILLER_WORDS = new Set([
  // English
  'uh', 'um', 'ah', 'eh', 'er', 'hmm', 'mm', 'uhh', 'umm',
  'like', 'you know', 'i mean', 'actually', 'basically', 'literally',
  'so', 'well', 'anyway',
  // Indonesian
  'anu', 'eee', 'hmm', 'mmm', 'aah', 'ooh',
  'jadi',  // "jadi" can be filler when used as discourse marker
  'gitu', 'gitulah', 'gimana', 'yah',
  // Discourse markers
  'ok', 'oke', 'okay', 'right', 'kay', 'yah', 'ya',
]);

// ── Proper name indicators ──
// These are heuristic — capitalized words that aren't at sentence start.
// We detect them by looking at word patterns across the entire transcript.
const NAME_TITLE_PREFIXES = [
  'mr', 'mrs', 'ms', 'dr', 'prof', 'capt', 'coach', 'bang', 'kak', 'pak', 'bu',
];

// ---------------------------------------------------------------------------
// Emphasis Analyzer
// ---------------------------------------------------------------------------

/**
 * Result of the emphasis analysis for the entire word sequence.
 */
export interface EmphasisAnalysis {
  /** Per-word emphasis by index into the original words array. */
  wordMap: Map<number, EmphasisInfo>;
  /** Summary statistics. */
  stats: {
    totalWords: number;
    highlighted: number;
    dimmed: number;
    percentageHighlighted: number;
  };
}

/**
 * Analyze word-level timestamps and produce emphasis classifications.
 *
 * Two-pass algorithm:
 *   Pass 1: Classify each word using pattern matching
 *   Pass 2: Enforce < 15% emphasis density — demote lowest-confidence
 *           highlights if over threshold
 *
 * @param words - Word-level timestamps
 * @param speakerSegments - Speaker labels (used for name detection)
 * @returns EmphasisAnalysis with per-word emphasis info
 */
export function analyzeWordEmphasis(
  words: WordTimestamp[],
  speakerSegments?: SpeakerLabel[],
): EmphasisAnalysis {
  const wordMap = new Map<number, EmphasisInfo>();

  if (words.length === 0) {
    return { wordMap, stats: { totalWords: 0, highlighted: 0, dimmed: 0, percentageHighlighted: 0 } };
  }

  // ── Pass 1: Classify each word ──
  const classifications: Array<{ type: EmphasisType; confidence: number; reason?: string }> = [];

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const text = word.word.trim();

    // Skip empty/punctuation-only words
    if (!text || /^[.,!?'"\-:;()]+$/.test(text)) {
      classifications.push({ type: 'none', confidence: 0 });
      continue;
    }

    const classification = classifyWord(text, i, words, speakerSegments);
    classifications.push(classification);
  }

  // ── Pass 2: Enforce emphasis density limit (< 15%) ──
  const highlightedIndices: number[] = [];
  for (let i = 0; i < classifications.length; i++) {
    if (classifications[i].type === 'highlight') {
      highlightedIndices.push(i);
    }
  }

  const totalWords = classifications.length;
  const maxHighlights = Math.max(1, Math.ceil(totalWords * 0.15)); // max 15%
  const dimmedCount = classifications.filter(c => c.type === 'dim').length;

  // Demote lowest-confidence highlights if over limit
  if (highlightedIndices.length > maxHighlights) {
    // Sort by confidence (ascending) so lowest get demoted first
    highlightedIndices.sort((a, b) => classifications[a].confidence - classifications[b].confidence);
    const toDemote = highlightedIndices.length - maxHighlights;
    for (let i = 0; i < toDemote; i++) {
      const idx = highlightedIndices[i];
      classifications[idx] = { type: 'none', confidence: 0, reason: 'demoted (density limit)' };
    }
  }

  // Ensure minimum highlights for short clips (if there's at least one highlight-worthy word)
  const finalHighlightedCount = classifications.filter(c => c.type === 'highlight').length;
  if (finalHighlightedCount === 0 && totalWords >= 3) {
    // Find the word with the highest non-zero confidence and promote it
    let bestIdx = -1;
    let bestConf = 0;
    for (let i = 0; i < classifications.length; i++) {
      if (classifications[i].type === 'none' && classifications[i].confidence > bestConf) {
        bestConf = classifications[i].confidence;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0 && bestConf > 0) {
      classifications[bestIdx] = { type: 'highlight', confidence: bestConf, reason: 'promoted (min guarantee)' };
    }
  }

  // ── Build output map ──
  for (let i = 0; i < classifications.length; i++) {
    const c = classifications[i];
    wordMap.set(i, {
      type: c.type,
      color: c.type === 'highlight' ? ASS_GOLD : c.type === 'dim' ? ASS_GRAY : ASS_WHITE,
      reason: c.reason,
    });
  }

  const finalHighlighted = classifications.filter(c => c.type === 'highlight').length;
  const finalDimmed = classifications.filter(c => c.type === 'dim').length;

  return {
    wordMap,
    stats: {
      totalWords,
      highlighted: finalHighlighted,
      dimmed: finalDimmed,
      percentageHighlighted: totalWords > 0
        ? Math.round((finalHighlighted / totalWords) * 100)
        : 0,
    },
  };
}

/**
 * Classify a single word into emphasis type with confidence score.
 *
 * Detection priority (highest wins):
 *   1. Question (if word ends with ?) → keep as 'none' (don't emphasize questions)
 *   2. Hook phrase match → highlight (high confidence)
 *   3. Money value → highlight (high confidence)
 *   4. Number → highlight (medium-high confidence)
 *   5. Emotional word → highlight (medium confidence)
 *   6. Proper name (capitalized mid-sentence) → highlight (medium confidence)
 *   7. Filler word → dim (low confidence for mild fillers, higher for strong fillers)
 *   8. Everything else → none
 */
function classifyWord(
  text: string,
  index: number,
  allWords: WordTimestamp[],
  speakerSegments?: SpeakerLabel[],
): { type: EmphasisType; confidence: number; reason?: string } {
  const cleanText = text.replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, '');
  if (!cleanText) return { type: 'none', confidence: 0 };

  const lowerText = cleanText.toLowerCase();

  // ── 1. Question: words ending with ? ──
  if (text.endsWith('?') || text.startsWith('?')) {
    return { type: 'none', confidence: 0, reason: 'question' };
  }

  // ── 2. Hook phrases ──
  for (const pattern of HOOK_PATTERNS) {
    if (pattern.test(text)) {
      return { type: 'highlight', confidence: 0.95, reason: 'hook' };
    }
  }

  // Check multi-word hook patterns across neighboring words
  if (checkMultiWordHook(index, allWords)) {
    return { type: 'highlight', confidence: 0.9, reason: 'hook_phrase' };
  }

  // ── 3. Money ──
  if (MONEY_RE.test(cleanText) || MONEY_WORD_RE.test(cleanText)) {
    return { type: 'highlight', confidence: 0.9, reason: 'money' };
  }

  // ── 4. Numbers ──
  if (NUMBER_RE.test(cleanText) || PERCENTAGE_RE.test(cleanText) ||
      ORDINAL_RE.test(cleanText) || INDONESIAN_NUMBER_RE.test(cleanText)) {
    return { type: 'highlight', confidence: 0.8, reason: 'number' };
  }

  // Check if word is part of a number phrase (e.g., "50 juta", "3 miliar")
  if (index > 0 && index < allWords.length) {
    const prevWord = allWords[index - 1].word.replace(/[^a-zA-Z0-9]/g, '');
    const nextWord = index < allWords.length - 1 ? allWords[index + 1].word.replace(/[^a-zA-Z0-9]/g, '') : '';
    if (/^\d+$/.test(prevWord) && INDONESIAN_NUMBER_RE.test(cleanText)) {
      return { type: 'highlight', confidence: 0.85, reason: 'number_phrase' };
    }
  }

  // ── 5. Emotional words ──
  if (EMOTIONAL_WORDS.has(lowerText)) {
    return { type: 'highlight', confidence: 0.7, reason: 'emotional' };
  }

  // ── 6. Proper names (heuristic: capitalized mid-sentence, not first word) ──
  if (isLikelyProperName(cleanText, index, allWords)) {
    return { type: 'highlight', confidence: 0.6, reason: 'proper_name' };
  }

  // ── 7. Filler words ──
  if (FILLER_WORDS.has(lowerText)) {
    // Strong fillers (uh, um, anu, eee) → higher confidence dim
    const strongFillers = new Set(['uh', 'um', 'uhh', 'umm', 'anu', 'eee', 'hmm', 'mmm']);
    const confidence = strongFillers.has(lowerText) ? 0.9 : 0.6;
    return { type: 'dim', confidence, reason: 'filler' };
  }

  // ── 8. Nothing special ──
  return { type: 'none', confidence: 0 };
}

/**
 * Check if this word is part of a multi-word hook phrase.
 */
function checkMultiWordHook(index: number, allWords: WordTimestamp[]): boolean {
  if (index < 0 || index >= allWords.length) return false;

  // Build a small window of text around this word
  const start = Math.max(0, index - 1);
  const end = Math.min(allWords.length, index + 3);
  const windowText = allWords.slice(start, end).map(w => w.word).join(' ');

  for (const pattern of HOOK_PATTERNS) {
    if (pattern.test(windowText)) return true;
  }

  return false;
}

/**
 * Heuristic proper name detection.
 * A word is likely a proper name if:
 *   - It starts with a capital letter
 *   - It's NOT the first word in the clip
 *   - It's NOT the first word of the segment (no preceding word in quote)
 *   - It's not followed by a period/end of sentence
 *   - It's preceded by a title prefix (Mr., Dr., etc.)
 *   - OR it's a capitalized word mid-transcript
 */
function isLikelyProperName(
  text: string,
  index: number,
  allWords: WordTimestamp[],
): boolean {
  // Must be capitalized test (first letter uppercase, rest lowercase or mixed)
  const firstChar = text.charAt(0);
  if (firstChar !== firstChar.toUpperCase() || firstChar === firstChar.toLowerCase()) {
    return false;
  }

  // Exclude words that are ALL CAPS (acronyms) — they're common but not proper names
  if (text === text.toUpperCase() && text.length > 2) {
    return true; // acronyms can be highlighted too
  }

  // Exclude first word of transcript
  if (index === 0) return false;

  // Check if preceded by a title prefix
  if (index > 0) {
    const prevWord = allWords[index - 1].word.toLowerCase().replace(/[^a-zA-Z]/g, '');
    if (NAME_TITLE_PREFIXES.includes(prevWord)) {
      return true;
    }
  }

  // Check if preceded by period, exclamation, or question mark (new sentence)
  if (index > 0) {
    const prevWordEnd = allWords[index - 1].word;
    const lastChar = prevWordEnd.charAt(prevWordEnd.length - 1);
    if (lastChar === '.' || lastChar === '!' || lastChar === '?') {
      // First word after punctuation is likely a sentence start, not a proper name
      // unless it follows a title prefix (already checked above)
      return false;
    }
  }

  // Capitalized word mid-sentence is likely a proper name
  // Check that surrounding words provide context
  if (index > 0 && index < allWords.length - 1) {
    return true; // Reasonable heuristic
  }

  return false;
}

// ---------------------------------------------------------------------------
// Convenience: get emphasis color for ASS output
// ---------------------------------------------------------------------------

/**
 * Get the ASS color for a word based on emphasis analysis.
 * Direct lookup from the emphasis map.
 */
export function getEmphasisColor(
  wordIndex: number,
  emphasisMap: Map<number, EmphasisInfo> | undefined,
): string {
  if (!emphasisMap) return ASS_WHITE;
  const info = emphasisMap.get(wordIndex);
  return info?.color || ASS_WHITE;
}

/**
 * Get the emphasis type for logging/debugging.
 */
export function getEmphasisType(
  wordIndex: number,
  emphasisMap: Map<number, EmphasisInfo> | undefined,
): EmphasisType {
  if (!emphasisMap) return 'none';
  const info = emphasisMap.get(wordIndex);
  return info?.type || 'none';
}
