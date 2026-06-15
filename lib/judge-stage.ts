/**
 * lib/judge-stage.ts — V2 Judge Engine Pipeline Stage
 *
 * Takes RawMoment[] from candidate extraction, runs Judge Engine V2,
 * and enriches each moment with 4-dimension scores.
 *
 * This is the bridge between:
 *   Candidate Extraction → RawMoment[] (old)
 *   Judge Engine V2 → JudgeResult (new)
 *
 * The judgeResult is attached to each RawMoment for use by ranking-v2.ts.
 */

import type { RawMoment, TranscriptSegment } from './types';
import type { JudgeResult } from './judge-types';
import { JudgeEngine, buildJudgeContext } from './judge-engine';

// ---------------------------------------------------------------------------
// Stage Function
// ---------------------------------------------------------------------------

export interface JudgeStageConfig {
  /** Judge engine LLM function. */
  llm: (prompt: string, options?: {
    responseFormat?: { type: string };
    schema?: Record<string, unknown>;
    temperature?: number;
  }) => Promise<{ text: string }>;
  /** Maximum candidates to judge in a single batch. */
  batchSize?: number;
  /** Whether to include reasoning comments (uses more tokens). */
  includeComments?: boolean;
  /** Judge engine model name. */
  model?: string;
}

const DEFAULT_STAGE_CONFIG: Partial<JudgeStageConfig> = {
  batchSize: 10,
  includeComments: false,
  model: 'deepseek-v4-flash',
};

/**
 * Run Judge Engine V2 on a set of moments.
 *
 * @param moments    - RawMoments from candidate extraction / LLM analysis
 * @param transcript - Full video transcript for context
 * @param config     - Judge stage configuration
 * @returns          - Same moments with judgeResult attached
 */
export async function judgeStage(
  moments: RawMoment[],
  transcript: TranscriptSegment[],
  config: JudgeStageConfig,
): Promise<RawMoment[]> {
  const cfg = { ...DEFAULT_STAGE_CONFIG, ...config };
  const judge = new JudgeEngine(cfg.llm, {
    model: cfg.model ?? 'deepseek-v4-flash',
    includeComments: cfg.includeComments ?? false,
    batchSize: cfg.batchSize ?? 10,
    temperature: 0.1,
  });

  // Build transcript text for context
  const transcriptText = transcript
    .map(s => s.text)
    .join(' ')
    .slice(0, 20000); // Safety cap

  // Build JudgeContext for each moment
  const contexts = moments.map(m => {
    // Extract relevant transcript excerpt for this moment
    const excerpt = transcript
      .filter(s => s.start >= m.startTime && s.start <= m.endTime)
      .map(s => s.text)
      .join(' ');

    return buildJudgeContext(
      excerpt || transcriptText.slice(0, 500),
      m.endTime - m.startTime,
      1, // speaker count — from diarization
      1, // segment count — always 1 for initial candidates
      '', // topic — from genre detection
    );
  });

  // Run judge engine
  const results = await judge.evaluateBatch(contexts);

  // Attach results to moments
  return moments.map((m, i) => ({
    ...m,
    judgeResult: results[i] ?? fallbackResult(),
  }));
}

/**
 * Run Judge Engine on a SINGLE moment.
 * Useful for re-judging or when batch is not needed.
 */
export async function judgeSingleMoment(
  moment: RawMoment,
  transcript: TranscriptSegment[],
  config: JudgeStageConfig,
): Promise<RawMoment> {
  const [enriched] = await judgeStage([moment], transcript, config);
  return enriched;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fallbackResult(): JudgeResult {
  const { calculateRawScore, applyCurve } = require('./judge-types');
  const raw = calculateRawScore(5, 5, 5, 5);
  return {
    hookScore: 5,
    coherenceScore: 5,
    connectionScore: 5,
    trendScore: 5,
    sponsorshipScore: 0,
    rawScore: raw,
    curvedScore: applyCurve(raw),
    judgeModel: 'fallback',
    judgeVersion: 'ganyiq-judge-v1',
    judgeTimestamp: new Date().toISOString(),
  };
}

/**
 * Format judge results for logging.
 */
export function formatJudgeResult(r: JudgeResult): string {
  return [
    `hook=${r.hookScore.toFixed(1)}`,
    `coh=${r.coherenceScore.toFixed(1)}`,
    `conn=${r.connectionScore.toFixed(1)}`,
    `trend=${r.trendScore.toFixed(1)}`,
    `raw=${r.rawScore.toFixed(1)}`,
    `curved=${r.curvedScore}`,
  ].join(' ');
}
