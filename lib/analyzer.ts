/**
 * ganyIQ LLM analysis pipeline — V2 Candidate Extraction + Batch Scoring.
 *
 * V2 ARCHITECTURE:
 *   1. extractCandidates(transcript) → CandidateWindow[] (deterministic, <50ms)
 *   2. buildBatchCandidateScoringPrompt(candidates) → single LLM prompt (~2000-4000 tokens)
 *   3. LLM scores ALL candidates in ONE call → RawMoment[]
 *   4. validateMoments() → filter invalid → sort by score
 *
 * This replaces the old approach of sending the full transcript (~20,000 tokens)
 * to the LLM, which caused token exhaustion on DeepSeek V4 Flash.
 *
 * THREE-LAYER VALIDATION:
 *   1. JSON structure — valid array, valid objects, no missing fields
 *   2. Value boundaries — timestamps in range, scores 0-100, valid enums
 *   3. Semantic constraints — duration 15-90s, start < end, timestamps exist
 */

import { AppError } from '@/lib/errors';
import { buildV2CompactPrompt, MODELS, TARGET_MODEL, PROMPT_VERSION_V2C } from '@/lib/prompt';
import { extractCandidates } from '@/lib/candidate-extraction';
import type { RawMoment, DnaTag, ConfidenceLevel, VideoMetadata, TranscriptSegment } from '@/lib/types';

// ---------------------------------------------------------------------------
// Analysis Result
// ---------------------------------------------------------------------------

export interface AnalysisResult {
  moments: RawMoment[];
  model: string;
}

// ---------------------------------------------------------------------------
// Fallback Metrics (in-memory counters, reset on process restart)
// ---------------------------------------------------------------------------

const metrics = {
  primarySuccess: 0,
  fallback1Success: 0,
  fallback2Success: 0,
  fallbackUsage: 0,
  allModelsFailed: 0,
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_DNA_TAGS: ReadonlySet<string> = new Set([
  'hookPower',
  'curiosity',
  'controversy',
  'emotion',
  'humor',
  'storytelling',
  'authority',
  'money',
  'shock',
  'educational',
  'motivation',
  'relatability',
  'vulnerability',
  'inspiration',
]);

const VALID_CONFIDENCE: ReadonlySet<string> = new Set([
  'high',
  'medium',
  'low',
]);

const MIN_CLIP_DURATION = 15;   // seconds
const MAX_CLIP_DURATION = 90;   // seconds
const MIN_SCORE = 0;
const MAX_SCORE = 100;

/** OpenCode Go API endpoint (OpenAI-compatible chat completions). */
const LLM_API_URL = 'https://opencode.ai/zen/go/v1/chat/completions';

/** Maximum candidates to send to LLM in one batch. */
const MAX_CANDIDATES_PER_BATCH = 15;

/** Deployment version marker — incremented on each fix. */
const DEPLOY_VERSION = 'v2-compact';

// ---------------------------------------------------------------------------
// Main Export
// ---------------------------------------------------------------------------

/**
 * Analyze a podcast transcript and extract worth-clipping moments.
 *
 * V2 Pipeline:
 *   1. Extract candidate windows using deterministic text signal analysis
 *   2. Send all candidates to LLM in a single batch scoring prompt
 *   3. Parse and validate LLM response
 *
 * @param metadata  - Video metadata (title, channel, duration)
 * @param transcript - Parsed transcript segments from the YouTube video
 * @returns Validated RawMoment[], sorted by score descending
 *
 * @throws AppError
 *   - ANALYSIS_FAILED: LLM call failed, empty response, or unparseable output
 */
export async function analyzeTranscript(
  metadata: VideoMetadata,
  transcript: TranscriptSegment[],
): Promise<AnalysisResult> {
  // Step 1: Extract candidate windows (deterministic, no LLM)
  console.log(`[V2] Extracting candidates from ${transcript.length} segments...`);
  const candidates = extractCandidates(transcript, MAX_CANDIDATES_PER_BATCH);
  console.log(`[V2] Found ${candidates.length} candidates`);

  if (candidates.length === 0) {
    console.log(`[V2] No candidates extracted. Returning empty.`);
    return { moments: [], model: TARGET_MODEL };
  }

  // Compute effective duration: use metadata duration, but fall back to transcript
  const lastSeg = transcript[transcript.length - 1];
  const transcriptDuration = lastSeg ? Math.ceil(lastSeg.start + lastSeg.duration) : 0;
  const effectiveDuration = metadata.durationSeconds > 0 ? metadata.durationSeconds : transcriptDuration;
  if (effectiveDuration !== metadata.durationSeconds) {
    console.log(`[V2] Metadata duration was ${metadata.durationSeconds}s, using transcript duration: ${effectiveDuration}s`);
  }

  // Step 2: Build batch scoring prompt (all candidates in one call)
  const { system, user } = buildV2CompactPrompt(metadata, candidates);
  console.log(`[V2] Batch prompt built. Prompt length: ${user.length} chars. Video duration: ${metadata.durationSeconds}s`);

  // Step 3: Model fallback loop — try each model in priority order
  for (let modelIdx = 0; modelIdx < MODELS.length; modelIdx++) {
    const model = MODELS[modelIdx];
    const isPrimary = modelIdx === 0;
    const isFallback = modelIdx > 0;

    if (isFallback) {
      console.log('[LLM] PRIMARY_FAILED');
      console.log(`[LLM] FALLBACK_ACTIVATED model=${model}`);
    }

    // Each model gets 2 attempts (matching existing retry behavior)
    // Primary (DeepSeek) gets only 1 attempt — if it fails, immediately fallback
    let lastError: string | null = null;

    const maxAttempts = isPrimary ? 1 : 2;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      console.log(`[LLM] model=${model} attempt=${attempt + 1}`);

      const userPrompt = attempt === 0
        ? user
        : `${user}\n\nYour previous response could not be parsed as valid JSON. Output valid JSON only. No markdown, no code fences, no extra text.`;

      let rawText: string;
      try {
        rawText = await callLLM(model, system, userPrompt);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        console.log(`[LLM] FAILED model=${model} attempt=${attempt + 1} error=${msg.slice(0, 200)}`);
        lastError = msg;
        continue;
      }

      const cleaned = stripMarkdownFences(rawText);

      // Parse JSON array
      let parsed: unknown;
      try {
        parsed = JSON.parse(cleaned);
      } catch {
        const preview = cleaned.slice(0, 200);
        console.log(`[LLM] FAILED model=${model} attempt=${attempt + 1} error=JSON parse failed`);
        lastError = `JSON parse failed on attempt ${attempt + 1}. Raw preview: ${preview}`;
        continue;
      }

      if (!Array.isArray(parsed)) {
        console.log(`[LLM] FAILED model=${model} attempt=${attempt + 1} error=Expected JSON array, got ${typeof parsed}`);
        lastError = `Expected JSON array, got ${typeof parsed}`;
        continue;
      }

      // Validate each moment
      const moments = validateMoments(parsed, effectiveDuration);

      if (moments.length === 0 && parsed.length > 0) {
        const rawPreview = cleaned.slice(0, 500);
        console.log(`[LLM] FAILED model=${model} attempt=${attempt + 1} error=All moments failed validation`);
        lastError = `All moments failed validation [${DEPLOY_VERSION}]. Raw LLM output preview: ${rawPreview}`;
        continue;
      }

      // ── SUCCESS — moments validated ──
      console.log(`[LLM] success model=${model} latency=N/A`);
      logMetricCounts(isPrimary, isFallback, modelIdx);

      // Sort by score descending
      moments.sort((a, b) => b.worthClippingScore - a.worthClippingScore);

      // Strategy B: Recover max 12s lead-in from candidate window context
      const MAX_LEAD_IN = 12;
      let expandedCount = 0;
      for (const moment of moments) {
        const candidate = candidates.find(c =>
          moment.startTime >= c.startSeconds && moment.startTime <= c.endSeconds
        );
        if (!candidate) continue;

        const originalStart = moment.startTime;
        const targetStart = Math.max(candidate.startSeconds, moment.startTime - MAX_LEAD_IN);
        const newDuration = moment.endTime - targetStart;

        if (newDuration <= MAX_CLIP_DURATION) {
          if (targetStart < moment.startTime) {
            moment.startTime = targetStart;
            expandedCount++;
          }
        } else {
          const cappedStart = moment.endTime - MAX_CLIP_DURATION;
          if (cappedStart < moment.startTime) {
            moment.startTime = cappedStart;
            expandedCount++;
          }
        }

        const addedSec = Math.round((originalStart - moment.startTime) * 10) / 10;
        if (addedSec > 0) {
          const candMin = Math.floor(candidate.startSeconds / 60);
          const candSec = Math.floor(candidate.startSeconds % 60);
          const origMin = Math.floor(originalStart / 60);
          const origSec = Math.floor(originalStart % 60);
          const finalMin = Math.floor(moment.startTime / 60);
          const finalSec = Math.floor(moment.startTime % 60);
          console.log(
            `[LEAD-IN] Clip added ${addedSec}s: ` +
            `cand_start=${candMin}:${String(candSec).padStart(2,'0')} ` +
            `llm_start=${origMin}:${String(origSec).padStart(2,'0')} ` +
            `final_start=${finalMin}:${String(finalSec).padStart(2,'0')}`
          );
        }
      }
      if (expandedCount > 0) {
        console.log(`[V2] Expanded ${expandedCount}/${moments.length} clips (max ${MAX_LEAD_IN}s lead-in)`);
      }

      console.log(`[V2] Analysis complete. ${moments.length} valid moments from ${candidates.length} candidates.`);
      return { moments, model };
    }

    // Both attempts with this model failed
    console.log(`[LLM] model=${model} exhausted retries`);
  }

  // ── ALL MODELS FAILED ──
  console.log('[LLM] ALL_MODELS_FAILED');
  metrics.allModelsFailed++;
  logMetricCounts(false, false, -1);

  throw new AppError(
    'ANALYSIS_FAILED',
    `Analysis failed after exhausting all ${MODELS.length} models [${DEPLOY_VERSION}]. Please try again.`,
    500,
  );
}

// ---------------------------------------------------------------------------
// LLM API Call with Model Parameter
// ---------------------------------------------------------------------------

/**
 * Call a model via OpenCode Go API.
 *
 * @param model   - Model name (e.g. 'deepseek-v4-flash', 'mimo-v2.5', 'qwen3.7-plus')
 * @param system  - System prompt
 * @param user    - User prompt
 * @returns Raw response text
 * @throws AppError ANALYSIS_FAILED if the API call fails or returns empty.
 */
async function callLLM(model: string, system: string, user: string): Promise<string> {
  const apiKey = process.env.OPENCODE_GO_API_KEY;
  if (!apiKey) {
    throw new AppError(
      'ANALYSIS_FAILED',
      'No API key configured. Set OPENCODE_GO_API_KEY in .env.local.',
      500,
    );
  }

  try {
    const response = await fetch(LLM_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: 0.3,
        max_tokens: 16384,
      }),
      signal: AbortSignal.timeout(500_000),
    });
    console.log(`[LLM] response received | model=${model} status=${response.status}`);

    if (!response.ok) {
      const errBody = await response.text().catch(() => 'unknown');
      // HTTP >= 500 is a server error — trigger fallback
      if (response.status >= 500) {
        throw new Error(
          `HTTP ${response.status}: ${errBody.slice(0, 200)}`,
        );
      }
      // 4xx errors (except 429 which is handled upstream) — don't fallback
      throw new AppError(
        'ANALYSIS_FAILED',
        `LLM API returned HTTP ${response.status}: ${errBody.slice(0, 200)}`,
        response.status,
      );
    }

    const data = await response.json();
    console.log(`[LLM] choices length: ${data?.choices?.length ?? 'N/A'} | model=${model}`);
    if (data?.choices?.[0]) {
      console.log(`[LLM] finish_reason: ${data.choices[0].finish_reason ?? 'N/A'} | model=${model}`);
      console.log(`[LLM] content length: ${data.choices[0].message?.content?.length ?? 'N/A'} | model=${model}`);
    }
    console.log(`[LLM] usage: ${JSON.stringify(data?.usage ?? {})} | model=${model}`);

    // Check finish_reason for failure indicators
    const finishReason = data?.choices?.[0]?.finish_reason;
    if (finishReason && finishReason !== 'stop' && finishReason !== 'length') {
      throw new Error(
        `LLM finished with reason: ${finishReason} (expected 'stop')`,
      );
    }
    if (finishReason === 'length') {
      console.log(`[LLM] WARNING: finish_reason='length' — response truncated. model=${model} max_tokens=16384`);
    }

    const text: string | undefined =
      data?.choices?.[0]?.message?.content;

    if (!text || text.trim().length === 0) {
      const diagnosticInfo = JSON.stringify({
        hasChoices: !!data?.choices?.length,
        finishReason: data?.choices?.[0]?.finish_reason ?? null,
        contentLength: data?.choices?.[0]?.message?.content?.length ?? null,
        usage: data?.usage ?? null,
      });
      throw new Error(
        `LLM returned an empty response. Diagnostic: ${diagnosticInfo}`,
      );
    }

    // Check for OpenCode provider error in response body
    const bodyStr = typeof data === 'string' ? data : JSON.stringify(data);
    if (
      bodyStr.includes('provider_error') ||
      bodyStr.includes('upstream_error') ||
      bodyStr.includes('model_not_available')
    ) {
      throw new Error(
        `OpenCode provider error detected in response`,
      );
    }

    return text.trim();
  } catch (err: unknown) {
    if (err instanceof AppError) throw err;

    const message = err instanceof Error ? err.message : 'Unknown error';
    throw new Error(
      `LLM call failed: ${message.slice(0, 200)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Metrics Logger
// ---------------------------------------------------------------------------

function logMetricCounts(isPrimary: boolean, isFallback: boolean, modelIdx: number): void {
  if (isPrimary) {
    metrics.primarySuccess++;
  } else if (isFallback) {
    metrics.fallbackUsage++;
    if (modelIdx === 1) {
      metrics.fallback1Success++;
    } else if (modelIdx === 2) {
      metrics.fallback2Success++;
    }
  }
  // Log metrics every 20 successful calls
  const total = metrics.primarySuccess + metrics.fallback1Success + metrics.fallback2Success;
  if (total % 20 === 0) {
    console.log(`[METRIC] primary_success_count=${metrics.primarySuccess}`);
    console.log(`[METRIC] fallback1_success_count=${metrics.fallback1Success}`);
    console.log(`[METRIC] fallback2_success_count=${metrics.fallback2Success}`);
    console.log(`[METRIC] fallback_usage_count=${metrics.fallbackUsage}`);
    console.log(`[METRIC] all_models_failed_count=${metrics.allModelsFailed}`);
  }
}

// ---------------------------------------------------------------------------
// JSON Cleaning
// ---------------------------------------------------------------------------

/**
 * Strip markdown code fences from LLM output if present.
 */
function stripMarkdownFences(text: string): string {
  const trimmed = text.trim();
  const jsonFenceMatch = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
  if (jsonFenceMatch) {
    return jsonFenceMatch[1].trim();
  }
  return trimmed;
}

// ---------------------------------------------------------------------------
// Moment Validation
// ---------------------------------------------------------------------------

/**
 * Validate an array of raw parsed moments against all constraints.
 * Invalid moments are silently dropped.
 */
function validateMoments(
  items: unknown[],
  durationSeconds: number,
): RawMoment[] {
  const valid: RawMoment[] = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i] as Record<string, unknown> | null;
    if (!item || typeof item !== 'object') continue;

    const startTime = coerceNumber(item.startTime);
    const endTime = coerceNumber(item.endTime);
    const score = coerceNumber(item.worthClippingScore);
    const confidence = String(item.confidence ?? '').toLowerCase();
    const dnaTags = item.dnaTags;
    const reasoning = String(item.reasoning ?? '').trim();

    // 1. Start time is a valid number within video duration
    if (startTime === null || startTime < 0 || startTime >= durationSeconds) continue;

    // 2. End time is a valid number, after start, within video
    if (endTime === null || endTime <= startTime || endTime > durationSeconds) continue;

    // 3. Clip duration is between 15 and 90 seconds
    const clipDuration = endTime - startTime;
    if (clipDuration < MIN_CLIP_DURATION || clipDuration > MAX_CLIP_DURATION) continue;

    // 4. Score is 0-100
    if (score === null || score < MIN_SCORE || score > MAX_SCORE) continue;

    // 5. Confidence is a valid level
    if (!VALID_CONFIDENCE.has(confidence)) continue;

    // 6. DNA tags — valid array of 1-3 valid tags
    const tags = validateDnaTags(dnaTags);
    if (tags.length === 0) continue;

    // 7. Reasoning is non-empty
    if (reasoning.length === 0) continue;

    valid.push({
      startTime,
      endTime,
      worthClippingScore: score,
      confidence: confidence as ConfidenceLevel,
      dnaTags: tags,
      reasoning,
    });
  }

  return valid;
}

// ---------------------------------------------------------------------------
// Field Validators
// ---------------------------------------------------------------------------

function coerceNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    // Try direct number parse first
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
    // Try timestamp format "MM:SS" or "H:MM:SS"
    const tsMatch = value.match(/^(\d+):(\d{2})(?::(\d{2}))?$/);
    if (tsMatch) {
      if (tsMatch[3]) {
        // H:MM:SS
        return parseInt(tsMatch[1]) * 3600 + parseInt(tsMatch[2]) * 60 + parseInt(tsMatch[3]);
      }
      // MM:SS
      return parseInt(tsMatch[1]) * 60 + parseInt(tsMatch[2]);
    }
  }
  return null;
}

function validateDnaTags(value: unknown): DnaTag[] {
  if (!Array.isArray(value)) return [];

  const tags: DnaTag[] = [];
  for (const tag of value) {
    const strTag = String(tag).trim();
    if (VALID_DNA_TAGS.has(strTag)) {
      tags.push(strTag as DnaTag);
    }
    if (tags.length >= 3) break;
  }

  return tags;
}

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export { PROMPT_VERSION_V2C as PROMPT_VERSION, TARGET_MODEL };
