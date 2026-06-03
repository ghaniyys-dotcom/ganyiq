/**
 * ganyIQ LLM analysis pipeline.
 *
 * Takes video metadata + transcript → builds prompt → calls DeepSeek V4 Flash
 * via OpenCode Go API (OpenAI-compatible) → parses JSON output → validates
 * every field → returns RawMoment[].
 *
 * The LLM's ONLY job is to detect and score moments. Tier assignment (elite
 * vs. secondary) is deferred to lib/ranking.ts.
 *
 * THREE-LAYER VALIDATION:
 *   1. JSON structure — valid array, valid objects, no missing fields
 *   2. Value boundaries — timestamps in range, scores 0-100, valid enums
 *   3. Semantic constraints — duration 15-90s, start < end, timestamps exist
 */

import { AppError } from '@/lib/errors';
import { buildAnalysisPrompt, TARGET_MODEL, PROMPT_VERSION } from '@/lib/prompt';
import type { RawMoment, DnaTag, ConfidenceLevel, VideoMetadata, TranscriptSegment } from '@/lib/types';

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

// ---------------------------------------------------------------------------
// Main Export
// ---------------------------------------------------------------------------

/**
 * Analyze a podcast transcript and extract worth-clipping moments.
 *
 * @param metadata  - Video metadata (title, channel, duration)
 * @param transcript - Parsed transcript segments from the YouTube video
 * @returns Validated RawMoment[], sorted by score descending
 *
 * @throws AppError
 *   - ANALYSIS_FAILED: LLM call failed, empty response, or unparseable output
 *   - (retries once on JSON parse failure)
 */
export async function analyzeTranscript(
  metadata: VideoMetadata,
  transcript: TranscriptSegment[],
): Promise<RawMoment[]> {
  // 1. Build prompt
  const { system, user } = buildAnalysisPrompt(metadata, transcript);

  // 2. Call LLM with one retry on parse failure
  let lastError: string | null = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    // Append retry instruction on second attempt
    const userPrompt = attempt === 0
      ? user
      : `${user}\n\nYour previous response could not be parsed as valid JSON. Output valid JSON only. No markdown, no code fences, no extra text.`;

    const rawText = await callLLM(system, userPrompt);

    // Clean the response
    const cleaned = stripMarkdownFences(rawText);

    // Parse JSON
    let parsed: unknown;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      lastError = `JSON parse failed on attempt ${attempt + 1}`;
      continue;
    }

    // Must be an array
    if (!Array.isArray(parsed)) {
      lastError = `Expected JSON array, got ${typeof parsed}`;
      continue;
    }

    // Validate each moment
    const moments = validateMoments(parsed, metadata.durationSeconds);

    if (moments.length === 0 && parsed.length > 0) {
      // DIAGNOSTIC: include raw text preview for debugging
      const rawPreview = cleaned.slice(0, 500);
      lastError = `All moments failed validation. Raw LLM output preview: ${rawPreview}`;
      continue;
    }

    // Sort by score descending (defensive — prompt asks for this)
    moments.sort((a, b) => b.worthClippingScore - a.worthClippingScore);

    return moments;
  }

  // Both attempts failed
  throw new AppError(
    'ANALYSIS_FAILED',
    `Analysis failed: ${lastError ?? 'Unknown error'}. Please try again.`,
    500,
  );
}

// ---------------------------------------------------------------------------
// DeepSeek V4 Flash via OpenCode Go API (OpenAI-compatible)
// ---------------------------------------------------------------------------

/**
 * Call DeepSeek V4 Flash via OpenCode Go API.
 *
 * OpenAI-compatible chat completions format. Proven working in Phase 0.5.
 *
 * @throws AppError ANALYSIS_FAILED if the API call fails or returns empty.
 */
async function callLLM(system: string, user: string): Promise<string> {
  const apiKey = process.env.OPENCODE_GO_API_KEY;
  if (!apiKey) {
    throw new AppError(
      'ANALYSIS_FAILED',
      'No API key configured. Set OPENCODE_GO_API_KEY in .env.local.',
      500,
    );
  }

  try {
    console.log(`[LLM] request start | model=${TARGET_MODEL}`);
    const response = await fetch(LLM_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: TARGET_MODEL,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: 0.3,
        max_tokens: 4096,
      }),
      signal: AbortSignal.timeout(300_000),
    });
    console.log(`[LLM] response received | status=${response.status}`);

    if (!response.ok) {
      const errBody = await response.text().catch(() => 'unknown');
      throw new Error(
        `LLM API returned HTTP ${response.status}: ${errBody.slice(0, 200)}`,
      );
    }

    const data = await response.json();
    // DIAGNOSTIC: log raw response structure for debugging empty content
    console.log(`[LLM] raw response keys: ${JSON.stringify(Object.keys(data))}`);
    console.log(`[LLM] choices length: ${data?.choices?.length ?? 'N/A'}`);
    if (data?.choices?.[0]) {
      console.log(`[LLM] choice[0] keys: ${JSON.stringify(Object.keys(data.choices[0]))}`);
      console.log(`[LLM] finish_reason: ${data.choices[0].finish_reason ?? 'N/A'}`);
      console.log(`[LLM] content length: ${data.choices[0].message?.content?.length ?? 'N/A'}`);
      console.log(`[LLM] content preview: ${(data.choices[0].message?.content ?? '').slice(0, 100)}`);
    }
    console.log(`[LLM] usage: ${JSON.stringify(data?.usage ?? {})}`);
    const text: string | undefined =
      data?.choices?.[0]?.message?.content;

    if (!text || text.trim().length === 0) {
      // DIAGNOSTIC: include raw response details in error
      const diagnosticInfo = JSON.stringify({
        hasChoices: !!data?.choices?.length,
        choice0Keys: data?.choices?.[0] ? Object.keys(data.choices[0]) : null,
        finishReason: data?.choices?.[0]?.finish_reason ?? null,
        contentLength: data?.choices?.[0]?.message?.content?.length ?? null,
        contentPreview: (data?.choices?.[0]?.message?.content ?? '').slice(0, 200),
        usage: data?.usage ?? null,
        responseKeys: Object.keys(data),
      });
      throw new AppError(
        'ANALYSIS_FAILED',
        `LLM returned an empty response. Diagnostic: ${diagnosticInfo}`,
        500,
      );
    }

    return text.trim();
  } catch (err: unknown) {
    if (err instanceof AppError) throw err;

    const message = err instanceof Error ? err.message : 'Unknown error';
    throw new AppError(
      'ANALYSIS_FAILED',
      `LLM call failed: ${message.slice(0, 200)}`,
      500,
    );
  }
}

// ---------------------------------------------------------------------------
// JSON Cleaning
// ---------------------------------------------------------------------------

/**
 * Strip markdown code fences from LLM output if present.
 *
 * Handles:
 *   ```json\n...\n```  (json-fenced)
 *   ```\n...\n```      (bare-fenced)
 *   plain text          (no fence — returned as-is)
 */
function stripMarkdownFences(text: string): string {
  const trimmed = text.trim();

  // Try json-fenced first
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
 *
 * Invalid moments are silently dropped. This is intentional — the LLM may
 * produce candidates with bad timestamps (hallucination) or malformed fields.
 * Silent dropping protects the pipeline without crashing the entire analysis.
 *
 * Returns only moments that pass ALL validation checks.
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

/**
 * Safely coerce a value to a number, returning null if not possible.
 */
function coerceNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/**
 * Validate DNA tags array. Returns only valid tags (drop invalid entries).
 * Requires at least 1 valid tag, max 3.
 */
function validateDnaTags(value: unknown): DnaTag[] {
  if (!Array.isArray(value)) return [];

  const tags: DnaTag[] = [];
  for (const tag of value) {
    const strTag = String(tag).trim();
    if (VALID_DNA_TAGS.has(strTag)) {
      tags.push(strTag as DnaTag);
    }
    if (tags.length >= 3) break; // max 3 tags
  }

  return tags;
}

// ---------------------------------------------------------------------------
// Prompt Version (re-exported for convenience)
// ---------------------------------------------------------------------------

export { PROMPT_VERSION, TARGET_MODEL };
