/**
 * lib/judge-integration.ts — Feature-flagged Judge V2 Integration
 *
 * Wires Judge Engine V2 into the existing pipeline without breaking V1.
 *
 * Feature flag: ENABLE_JUDGE_V2 (env var)
 *   true  → Run Judge V2 on all moments, use curvedScore for ranking
 *   false → Use existing worthClippingScore (V1 behavior)
 *
 * Integration points:
 *   1. After analyzeTranscript() returns, call enrichWithJudgeV2()
 *   2. Before rankMoments(), judgeResult will be attached to RawMoment[]
 *   3. rankMoments() uses curvedScore when judgeResult exists
 */

import type { RawMoment, TranscriptSegment } from './types';
import { JudgeEngine } from './judge-engine';
import { buildJudgeContext } from './judge-engine';
import { formatJudgeResult } from './judge-stage';

// ---------------------------------------------------------------------------
// LLM API Config (mirrors existing callLLM in analyzer.ts)
// ---------------------------------------------------------------------------

const LLM_API_URL = 'https://opencode.ai/zen/go/v1/chat/completions';
const JUDGE_MODEL = 'deepseek-v4-flash';

/**
 * Build LLM function for judge engine.
 * Uses same API as the existing pipeline.
 */
export function createJudgeLlm(): (prompt: string, options?: {
  responseFormat?: { type: string };
  schema?: Record<string, unknown>;
  temperature?: number;
}) => Promise<{ text: string }> {

  return async (prompt: string, options?: {
    responseFormat?: { type: string };
    schema?: Record<string, unknown>;
    temperature?: number;
  }): Promise<{ text: string }> => {
    const apiKey = process.env.OPENCODE_GO_API_KEY;
    if (!apiKey) {
      throw new Error('No OPENCODE_GO_API_KEY configured');
    }

    const body: Record<string, unknown> = {
      model: JUDGE_MODEL,
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
      temperature: options?.temperature ?? 0.1,
      max_tokens: 4096,
    };

    // Add response_format for structured output
    if (options?.responseFormat?.type === 'json_object') {
      body.response_format = { type: 'json_object' };
    }

    const response = await fetch(LLM_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => 'unknown');
      throw new Error(`Judge LLM HTTP ${response.status}: ${errBody.slice(0, 200)}`);
    }

    const data = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = data?.choices?.[0]?.message?.content ?? '';
    if (!text) {
      throw new Error('Judge LLM returned empty response');
    }

    return { text };
  };
}

// ---------------------------------------------------------------------------
// Feature Flag
// ---------------------------------------------------------------------------

/**
 * Check if Judge V2 is enabled.
 * Controlled by ENABLE_JUDGE_V2 env var (default: false for safety).
 */
export function isJudgeV2Enabled(): boolean {
  return process.env.ENABLE_JUDGE_V2 === 'true';
}

// ---------------------------------------------------------------------------
// Integration: Enrich moments with Judge V2 scores
// ---------------------------------------------------------------------------

/**
 * Enrich RawMoment[] with Judge V2 4-dimension scores.
 *
 * This is designed to be called AFTER analyzeTranscript() but BEFORE rankMoments().
 *
 * If Judge V2 is disabled, returns moments unchanged (V1 fallback).
 * If Judge fails for any moment, that moment keeps V1 scores (graceful degradation).
 *
 * @param moments    - Raw moments from analyzeTranscript()
 * @param transcript - Full transcript for context
 * @param llm        - LLM function (from existing pipeline)
 * @returns          - Enriched moments (V1 + V2 scores side by side)
 */
export async function enrichWithJudgeV2(
  moments: RawMoment[],
  transcript: TranscriptSegment[],
  llm: (prompt: string, options?: {
    responseFormat?: { type: string };
    schema?: Record<string, unknown>;
    temperature?: number;
  }) => Promise<{ text: string }>,
): Promise<RawMoment[]> {
  if (!isJudgeV2Enabled()) {
    console.log('[JUDGE-V2] Feature disabled, using V1 scores');
    return moments;
  }

  if (moments.length === 0) return moments;

  console.log(`[JUDGE-V2] Enriching ${moments.length} moments...`);

  try {
    const judge = new JudgeEngine(llm, {
      model: 'deepseek-v4-flash',
      includeComments: false,
      batchSize: 5,
      temperature: 0.1,
    });

    // Build judge contexts
    const contexts = moments.map(m => {
      const excerpt = transcript
        .filter(s => s.start >= m.startTime && (s.start + s.duration) <= m.endTime + 2)
        .map(s => s.text)
        .join(' ');

      return buildJudgeContext(
        excerpt || '(empty)',
        m.endTime - m.startTime,
        1, // speaker count (from diarization)
        1, // segment count (always 1 for initial candidates)
        '',
      );
    });

    // Run judge engine
    const results = await judge.evaluateBatch(contexts);

    // Attach results, preserving V1 scores for comparison
    let enriched = 0;
    const enrichedMoments = moments.map((m, i) => {
      const jr = results[i];
      if (jr) {
        enriched++;
        return {
          ...m,
          judgeResult: jr,
        };
      }
      return m; // Keep V1 only if judge failed
    });

    // Log summary
    const withJudge = enrichedMoments.filter(m => m.judgeResult);
    if (withJudge.length > 0) {
      const avgCurved = withJudge.reduce((s, m) => s + (m.judgeResult?.curvedScore ?? 0), 0) / withJudge.length;
      console.log(`[JUDGE-V2] Enriched ${enriched}/${moments.length} moments`);
      console.log(`[JUDGE-V2] Avg curvedScore: ${avgCurved.toFixed(1)}`);

      // Log top 3 for debugging
      const sorted = [...enrichedMoments].sort((a, b) => {
        const curvedA = a.judgeResult?.curvedScore ?? a.worthClippingScore;
        const curvedB = b.judgeResult?.curvedScore ?? b.worthClippingScore;
        return curvedB - curvedA;
      });
      for (let i = 0; i < Math.min(3, sorted.length); i++) {
        const m = sorted[i];
        const v1 = m.worthClippingScore;
        const v2 = m.judgeResult ? formatJudgeResult(m.judgeResult) : '(no V2)';
        console.log(`[JUDGE-V2] Top ${i + 1}: V1=${v1} V2={${v2}} "${(m.reasoning || '').slice(0, 50)}"`);
      }
    }

    return enrichedMoments;
  } catch (err) {
    console.error('[JUDGE-V2] Error:', err);
    console.log('[JUDGE-V2] Falling back to V1 scores');
    return moments; // Safe fallback: return original moments
  }
}
