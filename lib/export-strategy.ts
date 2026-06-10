/**
 * lib/export-strategy.ts — Clip Export Strategy Heuristics
 *
 * Deterministic clip trimming suggestions based on transcript timing.
 * No LLM calls. No extra API calls. Pure math on existing data.
 *
 * Given a clip window and transcript segments within it, detects:
 *   - Dead air (gaps > 1.5s between segments)
 *   - Weak intro (low speech density at start)
 *   - Late payoff (trailing silence after last meaningful segment)
 */

export interface CutSuggestion {
  start: number;   // seconds
  end: number;     // seconds
  duration: number; // seconds (end - start)
}

export interface ExportStrategy {
  currentDuration: number;
  conservative: CutSuggestion;
  balanced: CutSuggestion;
  aggressive: CutSuggestion;
  recommended: 'conservative' | 'balanced' | 'aggressive';
  reasons: string[];
  retentionImpact: {
    label: string;       // "Estimated retention improvement" or "Potential retention improvement"
    pct: number;         // percentage points
    confidence: 'high' | 'medium' | 'low';
  } | null;
}

interface Segment {
  start: number;
  duration: number;
  text: string;
}

// Filler word patterns for Indonesian (common at segment starts)
const FILLER_PATTERNS = /^(jadi|eee?|anu|gini|gitu|nah|wah|oh|yah|yahh|hmm|eh|ah|si|nih|tuh|gua|gue|aku|iya|ya|oo?hi?)($|\s|,)/i;

// Natural pause markers (end of meaningful segment)
const END_MARKERS = /[.!?]$/;

// ---------------------------------------------------------------------------
// Core heuristics
// ---------------------------------------------------------------------------

/**
 * Find transcript segments that overlap with the clip window.
 */
function segmentsInWindow(segments: Segment[], clipStart: number, clipEnd: number): Segment[] {
  return segments.filter(s => s.start < clipEnd && (s.start + s.duration) > clipStart);
}

/**
 * Compute gaps between consecutive segments within the window.
 * Positive gap = silence/dead air. Negative gap = overlapping speech.
 */
function computeGaps(segments: Segment[]): number[] {
  const gaps: number[] = [];
  for (let i = 1; i < segments.length; i++) {
    const prevEnd = segments[i - 1].start + segments[i - 1].duration;
    gaps.push(segments[i].start - prevEnd);
  }
  return gaps;
}

/**
 * Total dead air time (gaps > 1.5s)
 */
function totalDeadAir(gaps: number[]): number {
  return gaps.filter(g => g > 1.5).reduce((sum, g) => sum + g, 0);
}

/**
 * Speech density: ratio of speech time to total window duration
 */
function speechDensity(segments: Segment[], windowDuration: number): number {
  if (windowDuration <= 0) return 0;
  const totalSpeech = segments.reduce((sum, s) => sum + s.duration, 0);
  return Math.min(1, totalSpeech / windowDuration);
}

/**
 * Detect if first segment is likely filler/warm-up
 */
function isWeakIntro(segments: Segment[], clipStart: number): boolean {
  if (segments.length === 0) return false;

  const first = segments[0];
  // First segment starts > 1s after clipStart → silence before speaking
  const gapBeforeFirst = first.start - clipStart;
  if (gapBeforeFirst > 2) return true;

  // First segment text matches filler patterns
  if (FILLER_PATTERNS.test(first.text)) return true;

  // First segment is very short (< 1.5s) suggesting a fragment
  if (first.duration < 1.5) return true;

  // Gap between first and second segment is large (warm-up pause)
  if (segments.length >= 2) {
    const gap = segments[1].start - (first.start + first.duration);
    if (gap > 2) return true;
  }

  return false;
}

/**
 * Find the best trim point at the start (skip weak intro)
 */
function findOptimalStart(
  segments: Segment[],
  clipStart: number,
  aggressiveness: 'conservative' | 'balanced' | 'aggressive',
): number {
  if (segments.length === 0) return clipStart;
  if (segments.length === 1) {
    // Single segment — trim silence before it
    const segStart = Math.max(clipStart, segments[0].start);
    if (aggressiveness === 'aggressive' && segStart - clipStart > 0.5) return segStart;
    return clipStart;
  }

  const first = segments[0];
  const second = segments[1];

  // Base: skip silence before first segment
  let suggestedStart = clipStart;
  const leadSilence = first.start - clipStart;

  if (aggressiveness === 'conservative') {
    // Minimal trim: just cut leading silence if > 1s
    if (leadSilence > 1) suggestedStart = first.start;
  }

  if (aggressiveness === 'balanced' || aggressiveness === 'aggressive') {
    // Skip leading silence
    if (leadSilence > 0.5) suggestedStart = first.start;

    // If first segment is weak, skip to second
    if (isWeakIntro(segments, clipStart)) {
      if (aggressiveness === 'aggressive') {
        // Skip to start of second segment
        suggestedStart = second.start;
      } else {
        // Split the difference between first segment start and second segment start
        suggestedStart = first.start + (second.start - first.start) * 0.4;
      }
    }
  }

  return suggestedStart;
}

/**
 * Find the best trim point at the end (cut trailing silence / post-payoff)
 */
function findOptimalEnd(
  segments: Segment[],
  clipEnd: number,
  aggressiveness: 'conservative' | 'balanced' | 'aggressive',
): number {
  if (segments.length === 0) return clipEnd;

  const last = segments[segments.length - 1];
  const lastEnd = last.start + last.duration;
  const trailSilence = clipEnd - lastEnd;

  if (aggressiveness === 'conservative') {
    // Only trim if > 2s of silence at end
    if (trailSilence > 2) return Math.max(clipEnd - 2, lastEnd + 0.5);
    return clipEnd;
  }

  if (aggressiveness === 'balanced') {
    // Trim all trailing silence, keep 0.5s buffer
    if (trailSilence > 1) return Math.min(clipEnd, lastEnd + 0.5);
    return clipEnd;
  }

  // Aggressive: Trim trailing silence + check if last segment adds value
  let suggested = clipEnd;

  // Trim trailing silence
  if (trailSilence > 0.3) {
    suggested = lastEnd + 0.3;
  }

  // Check gap between penultimate and last segment
  if (segments.length >= 2) {
    const prev = segments[segments.length - 2];
    const prevEnd = prev.start + prev.duration;
    const gapToLast = last.start - prevEnd;

    // If there's a big gap before the last segment, the payoff happened before it
    if (gapToLast > 3) {
      suggested = prevEnd + 0.3;
    }
  }

  return Math.min(suggested, clipEnd);
}

/**
 * Generate reasons based on what was detected
 */
function generateReasons(
  segments: Segment[],
  clipStart: number,
  clipEnd: number,
  optStart: number,
  optEnd: number,
  gaps: number[],
): string[] {
  const reasons: string[] = [];
  const leadSilence = segments.length > 0 ? segments[0].start - clipStart : 0;
  const lastEnd = segments.length > 0 ? segments[segments.length - 1].start + segments[segments.length - 1].duration : clipEnd;
  const trailSilence = clipEnd - lastEnd;
  const deadAir = totalDeadAir(gaps);

  // Detect what was trimmed
  const startTrimmed = optStart - clipStart > 0.5;
  const endTrimmed = clipEnd - optEnd > 0.5;

  if (!startTrimmed && !endTrimmed) {
    reasons.push('Story remains complete');
    reasons.push('No dead air detected');
  } else {
    if (startTrimmed) {
      if (leadSilence > 1.5) reasons.push('Dead air removed at start');
      else if (segments.length >= 2 && isWeakIntro(segments, clipStart)) reasons.push('Weak intro removed');
      else reasons.push('Tighter opening');
    }

    if (endTrimmed) {
      if (trailSilence > 2) reasons.push('Dead air removed at end');
      else reasons.push('Faster payoff');
    }

    if (deadAir > 2) reasons.push('Long pauses removed');
  }

  if (segments.length >= 2) {
    const density = speechDensity(segments, clipEnd - clipStart);
    if (density > 0.8) reasons.push('High speech density — minimal trimming needed');
  }

  // Fallback if empty
  if (reasons.length === 0) {
    reasons.push('Story remains complete');
  }

  return reasons.slice(0, 4);
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Compute export strategy for a clip window.
 *
 * @param segments - Full transcript segments array from DB
 * @param clipStart - Current clip start time (seconds)
 * @param clipEnd   - Current clip end time (seconds)
 */
export function computeExportStrategy(
  segments: Segment[],
  clipStart: number,
  clipEnd: number,
): ExportStrategy {
  const currentDuration = clipEnd - clipStart;
  const windowSegments = segmentsInWindow(segments, clipStart, clipEnd);
  const gaps = computeGaps(windowSegments);

  // Compute for each aggressiveness level
  const levels: ['conservative', 'balanced', 'aggressive'] = ['conservative', 'balanced', 'aggressive'];

  const suggestions = {} as Record<string, CutSuggestion>;
  let recommended: ExportStrategy['recommended'] = 'balanced';

  for (const level of levels) {
    const start = findOptimalStart(windowSegments, clipStart, level);
    const end = findOptimalEnd(windowSegments, clipEnd, level);
    const duration = Math.max(5, end - start); // Minimum 5s clip

    suggestions[level] = { start, end: start + duration, duration };

    // Clamp to clip window
    if (suggestions[level].start < clipStart) suggestions[level].start = clipStart;
    if (suggestions[level].end > clipEnd) suggestions[level].end = clipEnd;
    suggestions[level].duration = suggestions[level].end - suggestions[level].start;
  }

  // Determine recommended level
  const balDuration = suggestions.balanced.duration;
  const origDuration = currentDuration;

  if (origDuration - balDuration <= 2) {
    // Balanced barely changes anything → conservative
    recommended = 'conservative';
  } else if (suggestions.aggressive.duration < suggestions.balanced.duration * 0.6) {
    // Aggressive is too aggressive → balanced
    recommended = 'balanced';
  }

  // Generate reasons
  const reasons = generateReasons(
    windowSegments, clipStart, clipEnd,
    suggestions[recommended].start, suggestions[recommended].end,
    gaps,
  );

  // Retention impact estimate
  let retentionImpact: ExportStrategy['retentionImpact'] = null;
  const density = speechDensity(windowSegments, currentDuration);
  const trimmedDuration = currentDuration - suggestions[recommended].duration;
  const trimPct = currentDuration > 0 ? (trimmedDuration / currentDuration) * 100 : 0;

  if (trimPct > 3 && density > 0.4) {
    // Higher confidence when we detected real issues
    const confidence = (deadAirFromGaps(gaps) > 1.5 || isWeakIntro(windowSegments, clipStart))
      ? ('high' as const)
      : ('medium' as const);

    const label = confidence === 'high'
      ? 'Estimated retention improvement'
      : 'Potential retention improvement';

    // Rough heuristic: 1s trimmed ≈ 0.3-0.5% retention gain for short clips
    const retentionGain = Math.round(trimPct * 0.35);
    retentionImpact = {
      label,
      pct: Math.min(25, Math.max(3, retentionGain)),
      confidence,
    };
  }

  return {
    currentDuration,
    conservative: suggestions.conservative,
    balanced: suggestions.balanced,
    aggressive: suggestions.aggressive,
    recommended,
    reasons,
    retentionImpact,
  };
}

function deadAirFromGaps(gaps: number[]): number {
  return gaps.filter(g => g > 1.5).reduce((s, g) => s + g, 0);
}
