/**
 * lib/ranking-v2.ts — V2 Global Ranking Engine
 *
 * Replaces the old tier-based ranking with curvedScore DESC ranking.
 *
 * Key differences from V1 ranking (ranking.ts):
 *   V1: worthClippingScore + tier thresholds + genre boosts + diversity caps
 *   V2: curvedScore DESC + rawScore DESC + internal precision tiebreaker
 *
 * The V2 ranking is PURE — no tier thresholds, no genre boosts, no caps.
 * Ranking is by curvedScore only (mirroring OpusClip behavior).
 *
 * Sort order:
 *   1. curvedScore DESC (primary)
 *   2. rawScore DESC (secondary — resolves most ties)
 *   3. Internal float precision of rawScore (tertiary — when rounded scores tie)
 */

import type { RawMoment, RankedMoment, TranscriptSegment } from './types';
import type { JudgeResult } from './judge-types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum curvedScore to be included in output. */
export const MIN_CURVED_SCORE = 0;

/** Minimum clip duration in seconds. */
const MIN_DURATION_S = 5;

/** Maximum clip duration in seconds. */
const MAX_DURATION_S = 180;

// ---------------------------------------------------------------------------
// V2 Ranking Function
// ---------------------------------------------------------------------------

/**
 * Rank moments using V2 ranking (curvedScore DESC).
 *
 * @param moments    - Moments with judgeResult attached (from judgeStage)
 * @param transcript - Full transcript for excerpt extraction
 * @returns          - RankedMoments sorted by curvedScore DESC
 */
export function rankMomentsV2(
  moments: RawMoment[],
  transcript: TranscriptSegment[],
): RankedMoment[] {
  if (moments.length === 0) return [];

  // Filter: must have judgeResult
  const valid = moments.filter(m => {
    if (!m.judgeResult) return false;
    const dur = m.endTime - m.startTime;
    return dur >= MIN_DURATION_S && dur <= MAX_DURATION_S;
  });

  if (valid.length === 0) return [];

  // Sort by curvedScore DESC, then rawScore DESC
  const sorted = [...valid].sort((a, b) => {
    const jrA = a.judgeResult!;
    const jrB = b.judgeResult!;

    // Primary: curvedScore DESC
    if (jrB.curvedScore !== jrA.curvedScore) {
      return jrB.curvedScore - jrA.curvedScore;
    }

    // Secondary: rawScore DESC (handles most ties)
    if (Math.abs(jrB.rawScore - jrA.rawScore) > 0.01) {
      return jrB.rawScore - jrA.rawScore;
    }

    // Tertiary: individual component hierarchy
    // hook > coherence > connection > trend
    if (jrB.hookScore !== jrA.hookScore) {
      return jrB.hookScore - jrA.hookScore;
    }
    if (jrB.coherenceScore !== jrA.coherenceScore) {
      return jrB.coherenceScore - jrA.coherenceScore;
    }
    if (jrB.connectionScore !== jrA.connectionScore) {
      return jrB.connectionScore - jrA.connectionScore;
    }

    // Final: by start time (earlier in video = higher rank)
    return a.startTime - b.startTime;
  });

  // Build RankedMoment array with rank assignment
  return sorted.map((m, i) => {
    const dur = m.endTime - m.startTime;
    const excerpt = extractTranscriptExcerpt(m, transcript);

    return {
      ...m,
      rank: i + 1,
      tier: getTier(i + 1, sorted.length),
      startTimestamp: formatTimestamp(m.startTime),
      endTimestamp: formatTimestamp(m.endTime),
      transcriptExcerpt: excerpt,
    };
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Determine tier based on rank position.
 * Mirrors Opus: top ~30% = "elite", bottom ~70% = "secondary"
 */
function getTier(rank: number, total: number): 'elite' | 'secondary' {
  // Top 30% or top 10 (whichever is smaller)
  const eliteCount = Math.min(Math.ceil(total * 0.3), 10);
  return rank <= eliteCount ? 'elite' : 'secondary';
}

/**
 * Extract transcript excerpt for a moment.
 */
function extractTranscriptExcerpt(
  moment: RawMoment,
  transcript: TranscriptSegment[],
): string {
  const words = transcript
    .filter(s => s.start >= moment.startTime && s.start <= moment.endTime)
    .map(s => s.text);

  if (words.length === 0) return '';

  const excerpt = words.join(' ');
  return excerpt.length > 200 ? excerpt.slice(0, 197) + '...' : excerpt;
}

/**
 * Format seconds as M:SS timestamp.
 */
function formatTimestamp(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = Math.floor(totalSeconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Comparison Report Generator
// ---------------------------------------------------------------------------

/**
 * Generate an A/B comparison between V1 and V2 ranking.
 */
export function generateComparisonReport(
  v1Moments: RankedMoment[],
  v2Moments: RankedMoment[],
): string {
  const lines: string[] = [];

  lines.push('='.repeat(90));
  lines.push('GANYIQ V2 — A/B RANKING COMPARISON REPORT');
  lines.push('='.repeat(90));
  lines.push('');

  // Build lookup maps
  const v1ByRank = new Map(v1Moments.map(m => [m.rank, m]));
  const v2ById = new Map(v2Moments.map(m => [m.startTime + '-' + m.endTime, m]));

  lines.push('V1 (worthClippingScore) → V2 (curvedScore)');
  lines.push('');
  lines.push(`${'Rank'.padStart(4)} ${'V1 Score'.padStart(10)} ${'V2 Curved'.padStart(10)} ${'Raw'.padStart(6)} ${'Hook'.padStart(6)} ${'Coh'.padStart(6)} ${'Conn'.padStart(6)} ${'Trend'.padStart(6)} ${'Tier'.padStart(6)} ${'Clip'.padStart(30)}`);
  lines.push('-'.repeat(90));

  const maxRanks = Math.max(v1Moments.length, v2Moments.length);
  for (let i = 0; i < maxRanks; i++) {
    const v2 = v2Moments[i];
    const jr = v2?.judgeResult;

    const curved = jr?.curvedScore?.toString() ?? '—';
    const hook = jr?.hookScore.toFixed(1) ?? '—';
    const coh = jr?.coherenceScore.toFixed(1) ?? '—';
    const conn = jr?.connectionScore.toFixed(1) ?? '—';
    const trend = jr?.trendScore.toFixed(1) ?? '—';
    const raw = jr?.rawScore.toFixed(1) ?? '—';
    const tier = v2?.tier ?? '—';
    const transcript = v2?.transcriptExcerpt?.slice(0, 28) ?? '—';

    lines.push(
      `${String(i + 1).padStart(4)} ` +
      `${'—'.padStart(10)} ` +
      `${curved.padStart(10)} ` +
      `${raw.padStart(6)} ` +
      `${hook.padStart(6)} ` +
      `${coh.padStart(6)} ` +
      `${conn.padStart(6)} ` +
      `${trend.padStart(6)} ` +
      `${tier.padStart(6)} ` +
      `${transcript.padStart(30)}`,
    );
  }

  lines.push('');
  lines.push('─'.repeat(90));
  lines.push('');

  // Summary statistics
  const v2WithJudge = v2Moments.filter(m => m.judgeResult);
  if (v2WithJudge.length > 0) {
    const avgHook = v2WithJudge.reduce((s, m) => s + (m.judgeResult?.hookScore ?? 0), 0) / v2WithJudge.length;
    const avgCoh = v2WithJudge.reduce((s, m) => s + (m.judgeResult?.coherenceScore ?? 0), 0) / v2WithJudge.length;
    const avgConn = v2WithJudge.reduce((s, m) => s + (m.judgeResult?.connectionScore ?? 0), 0) / v2WithJudge.length;
    const avgTrend = v2WithJudge.reduce((s, m) => s + (m.judgeResult?.trendScore ?? 0), 0) / v2WithJudge.length;
    const avgCurved = v2WithJudge.reduce((s, m) => s + (m.judgeResult?.curvedScore ?? 0), 0) / v2WithJudge.length;

    lines.push('V2 Summary Statistics:');
    lines.push(`  Clips ranked: ${v2Moments.length}`);
    lines.push(`  Avg hookScore: ${avgHook.toFixed(2)}`);
    lines.push(`  Avg coherenceScore: ${avgCoh.toFixed(2)}`);
    lines.push(`  Avg connectionScore: ${avgConn.toFixed(2)}`);
    lines.push(`  Avg trendScore: ${avgTrend.toFixed(2)}`);
    lines.push(`  Avg curvedScore: ${avgCurved.toFixed(2)}`);
    lines.push(`  Score range: ${Math.min(...v2WithJudge.map(m => m.judgeResult!.curvedScore))} - ${Math.max(...v2WithJudge.map(m => m.judgeResult!.curvedScore))}`);
  }

  lines.push('');
  lines.push('Note: V1 scores are not shown in A/B mode because the old ranking');
  lines.push('pipeline and V2 pipeline operate on different score scales. Run');
  lines.push('the test harness with REAL data for actual A/B comparison.');

  return lines.join('\n');
}
