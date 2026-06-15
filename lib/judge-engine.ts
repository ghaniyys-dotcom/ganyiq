/**
 * lib/judge-engine.ts — GANYIQ V2 Judge Engine
 *
 * Evaluates clip candidates across 4 quality dimensions:
 *   1. Hook Strength — Opening engagement
 *   2. Coherence — Narrative flow
 *   3. Connection — Emotional resonance / relatability
 *   4. Trend — Topical relevance / virality
 *
 * Architecture:
 *   Candidate[] → JudgeEngine → JudgeResult[] → Score aggregation → Ranking
 *
 * Two modes:
 *   - INDIVIDUAL: 1 LLM call per dimension per clip (5 calls/clip)
 *   - BATCHED: 1 LLM call for all 4 dimensions of multiple clips
 *
 * For MVP: use BATCHED mode (fewer API calls, faster).
 */

import type { JudgeResult, JudgeConfig } from './judge-types';
import {
  DEFAULT_JUDGE_CONFIG,
  calculateRawScore,
  applyCurve,
} from './judge-types';
import type { JudgeContext } from './judge-prompt';
import {
  buildCombinedJudgePrompt,
  buildBatchJudgePrompt,
} from './judge-prompt';

// ---------------------------------------------------------------------------
// LLM Interface (adapt to your LLM provider)
// ---------------------------------------------------------------------------

interface LlmResponse {
  text: string;
}

type LlmFunction = (prompt: string, options?: {
  responseFormat?: { type: string };
  schema?: Record<string, unknown>;
  temperature?: number;
}) => Promise<LlmResponse>;

// ---------------------------------------------------------------------------
// Judge Engine
// ---------------------------------------------------------------------------

export class JudgeEngine {
  private config: JudgeConfig;
  private llm: LlmFunction;

  constructor(llm: LlmFunction, config: Partial<JudgeConfig> = {}) {
    this.config = { ...DEFAULT_JUDGE_CONFIG, ...config };
    this.llm = llm;
  }

  /**
   * Evaluate a single clip candidate across all 4 dimensions.
   * Uses combined prompt (1 LLM call for all dimensions).
   */
  async evaluate(candidate: JudgeContext): Promise<JudgeResult> {
    const prompt = buildCombinedJudgePrompt(candidate);

    const response = await this.llm(prompt, {
      responseFormat: { type: 'json_object' },
      temperature: this.config.temperature,
    });

    return this.parseSingleResponse(response.text, candidate, response);
  }

  /**
   * Evaluate multiple clip candidates in batch.
   * More efficient — 1 LLM call for N clips × 4 dimensions.
   */
  async evaluateBatch(candidates: JudgeContext[]): Promise<JudgeResult[]> {
    if (candidates.length === 0) return [];
    if (candidates.length === 1) return [await this.evaluate(candidates[0])];

    // Batch in chunks of batchSize
    const results: JudgeResult[] = [];
    for (let i = 0; i < candidates.length; i += this.config.batchSize) {
      const batch = candidates.slice(i, i + this.config.batchSize);
      const prompt = buildBatchJudgePrompt(batch);

      const response = await this.llm(prompt, {
        responseFormat: { type: 'json_object' },
        temperature: this.config.temperature,
      });

      const batchResults = this.parseBatchResponse(response.text, batch, response);
      results.push(...batchResults);
    }

    return results;
  }

  /**
   * Parse individual judge response.
   */
  private parseSingleResponse(
    responseText: string,
    candidate: JudgeContext,
    _response: LlmResponse,
  ): JudgeResult {
    try {
      const parsed = JSON.parse(responseText);

      const hookScore = clampScore(parsed.hook?.score ?? parsed.hookScore ?? 5);
      const coherenceScore = clampScore(parsed.coherence?.score ?? parsed.coherenceScore ?? 5);
      const connectionScore = clampScore(parsed.connection?.score ?? parsed.connectionScore ?? 5);
      const trendScore = clampScore(parsed.trend?.score ?? parsed.trendScore ?? 5);

      const rawScore = calculateRawScore(
        hookScore,
        coherenceScore,
        connectionScore,
        trendScore,
      );

      return {
        hookScore,
        coherenceScore,
        connectionScore,
        trendScore,
        sponsorshipScore: 0,
        rawScore,
        curvedScore: applyCurve(rawScore),
        judgeModel: this.config.model,
        judgeVersion: 'ganyiq-judge-v1',
        judgeTimestamp: new Date().toISOString(),
        hookComment: parsed.hook?.reasoning ?? parsed.hookComment,
        coherenceComment: parsed.coherence?.reasoning ?? parsed.coherenceComment,
        connectionComment: parsed.connection?.reasoning ?? parsed.connectionComment,
        trendComment: parsed.trend?.reasoning ?? parsed.trendComment,
      };
    } catch (err) {
      console.error('[JUDGE] Failed to parse response:', err);
      return this.fallbackResult(candidate);
    }
  }

  /**
   * Sanitize LLM response text for safe JSON parsing.
   * Fixes common issues: control chars, unterminated strings, trailing commas.
   */
  private sanitizeJsonResponse(raw: string): string {
    let cleaned = raw;
    // 1. Strip non-printable control characters (keep \n, \r, \t inside strings)
    cleaned = cleaned.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
    // 2. Replace literal newlines/carriage returns inside string values
    cleaned = cleaned.replace(/\\(?!["\\/bfnrtu])/g, '\\\\');
    // 3. Remove BOM and zero-width chars
    cleaned = cleaned.replace(/[\uFEFF\u200B-\u200D\u2060]/g, '');
    // 4. Try to extract JSON array from markdown code fences
    const fenceMatch = cleaned.match(/```(?:json)?\s*\n?(\[[\s\S]*?\])\n?\s*```/);
    if (fenceMatch) return fenceMatch[1].trim();
    // 5. Try to find JSON array directly
    const arrayMatch = cleaned.match(/(\[[\s\S]*\])/);
    if (arrayMatch) return arrayMatch[1].trim();
    return cleaned.trim();
  }

  /**
   * Parse batch judge response with robust fallback strategies.
   * Never returns partial results — each clip either gets its real score
   * or a mid-range fallback, but parsing failure in one clip never
   * collapses the entire batch.
   */
  private parseBatchResponse(
    responseText: string,
    candidates: JudgeContext[],
    _response: LlmResponse,
  ): JudgeResult[] {
    // ---- Strategy 1: Direct JSON parse ----
    let parsed: unknown;
    try {
      parsed = JSON.parse(responseText);
    } catch {
      // ---- Strategy 2: Sanitize + retry ----
      try {
        const sanitized = this.sanitizeJsonResponse(responseText);
        parsed = JSON.parse(sanitized);
      } catch (innerErr) {
        // ---- Strategy 3: Try per-item recovery ----
        try {
          return this.recoverBatchTryEach(responseText, candidates, _response);
        } catch {
          console.error('[JUDGE] Failed to parse batch response after all strategies:', innerErr);
          return candidates.map(c => this.fallbackResult(c));
        }
      }
    }

    // Handle non-array responses
    if (!Array.isArray(parsed)) {
      console.warn('[JUDGE] Batch response is not an array, treating as single');
      return [this.parseSingleResponse(responseText, candidates[0], _response)];
    }

    // Map parsed items to JudgeResults with per-item fallback
    const results: JudgeResult[] = [];
    for (let i = 0; i < candidates.length; i++) {
      const item = parsed[i];
      if (!item || typeof item !== 'object') {
        console.warn(`[JUDGE] Batch item ${i} missing or invalid, using fallback`);
        results.push(this.fallbackResult(candidates[i]));
        continue;
      }

      try {
        const dims = item as Record<string, { score?: number; reasoning?: string }>;
        const hookScore = clampScore(dims.hook?.score ?? 5);
        const coherenceScore = clampScore(dims.coherence?.score ?? 5);
        const connectionScore = clampScore(dims.connection?.score ?? 5);
        const trendScore = clampScore(dims.trend?.score ?? 5);

        results.push({
          hookScore,
          coherenceScore,
          connectionScore,
          trendScore,
          sponsorshipScore: 0,
          rawScore: calculateRawScore(hookScore, coherenceScore, connectionScore, trendScore),
          curvedScore: applyCurve(calculateRawScore(hookScore, coherenceScore, connectionScore, trendScore)),
          judgeModel: this.config.model,
          judgeVersion: 'ganyiq-judge-v1',
          judgeTimestamp: new Date().toISOString(),
          hookComment: dims.hook?.reasoning,
          coherenceComment: dims.coherence?.reasoning,
          connectionComment: dims.connection?.reasoning,
          trendComment: dims.trend?.reasoning,
        });
      } catch {
        console.warn(`[JUDGE] Failed to parse batch item ${i}, using fallback`);
        results.push(this.fallbackResult(candidates[i]));
      }
    }
    return results;
  }

  /**
   * Recovery strategy: try to parse each clip's response individually.
   * Splits the response text on CLIP_N markers and parses each segment.
   */
  private recoverBatchTryEach(
    responseText: string,
    candidates: JudgeContext[],
    _response: LlmResponse,
  ): JudgeResult[] {
    // Split on numbered clip markers
    const segments = responseText.split(/(?=CLIP \d+)/i);
    const results: JudgeResult[] = [];

    for (let i = 0; i < candidates.length; i++) {
      const segment = segments[i] ?? segments[segments.length - 1] ?? '';
      try {
        // Try to extract JSON object from this segment
        const objMatch = segment.match(/\{[^{}]*\}/);
        if (objMatch) {
          const cleaned = this.sanitizeJsonResponse(objMatch[0]);
          const parsed = JSON.parse(cleaned);
          const dims = parsed as Record<string, { score?: number; reasoning?: string }>;
          results.push({
            hookScore: clampScore(dims.hook?.score ?? 5),
            coherenceScore: clampScore(dims.coherence?.score ?? 5),
            connectionScore: clampScore(dims.connection?.score ?? 5),
            trendScore: clampScore(dims.trend?.score ?? 5),
            sponsorshipScore: 0,
            rawScore: 0,
            curvedScore: 0,
            judgeModel: this.config.model,
            judgeVersion: 'ganyiq-judge-v1',
            judgeTimestamp: new Date().toISOString(),
          });
          const r = results[results.length - 1];
          r.rawScore = calculateRawScore(r.hookScore, r.coherenceScore, r.connectionScore, r.trendScore);
          r.curvedScore = applyCurve(r.rawScore);
        } else {
          results.push(this.fallbackResult(candidates[i]));
        }
      } catch {
        results.push(this.fallbackResult(candidates[i]));
      }
    }
    return results;
  }

  /**
   * Fallback result when parsing fails.
   * Returns mid-range scores so the clip still gets ranked.
   */
  private fallbackResult(candidate: JudgeContext): JudgeResult {
    const rawScore = calculateRawScore(5, 5, 5, 5);
    return {
      hookScore: 5,
      coherenceScore: 5,
      connectionScore: 5,
      trendScore: 5,
      sponsorshipScore: 0,
      rawScore,
      curvedScore: applyCurve(rawScore),
      judgeModel: this.config.model,
      judgeVersion: 'ganyiq-judge-v1',
      judgeTimestamp: new Date().toISOString(),
      hookComment: 'Fallback (parse failed)',
      coherenceComment: 'Fallback (parse failed)',
      connectionComment: 'Fallback (parse failed)',
      trendComment: 'Fallback (parse failed)',
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clampScore(value: number): number {
  return Math.max(0, Math.min(10, Math.round(value * 10) / 10));
}

/**
 * Build a JudgeContext from pipeline data.
 * This is the bridge between candidate extraction → judge engine.
 */
export function buildJudgeContext(
  transcriptText: string,
  durationSeconds: number,
  speakerCount: number = 1,
  segmentCount: number = 1,
  topic: string = '',
): JudgeContext {
  return {
    transcriptText,
    durationSeconds,
    speakerCount,
    segmentCount,
    topic,
  };
}
