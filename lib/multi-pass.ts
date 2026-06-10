/**
 * lib/multi-pass.ts — Phase 4A Multi-Pass Discovery Engine.
 *
 * Runs 5 specialized LLM passes on a shared candidate pool.
 * Each pass focuses on ONE content dimension:
 *   1. Hook Discovery
 *   2. Storytelling Discovery
 *   3. Educational Discovery
 *   4. Controversy/Debate Discovery
 *   5. Emotion/Vulnerability Discovery
 *
 * Architecture:
 *   Shared Candidate Pool (from extractCandidates)
 *       ↓
 *   Each pass: filter → batch → LLM (specialized prompt) → validate
 *       ↓
 *   All moments merged with general pass output
 *       ↓
 *   rankMoments (existing, handles dedup + ranking)
 *
 * Design principles:
 *   - Additive: never replaces existing analysis
 *   - Pre-filtered: each pass only evaluates signal-matched candidates
 *   - Compact prompts: ~500 chars vs ~2000 for general pass
 *   - Parallel execution: passes independent of each other
 *   - Graceful degradation: pass failure does not block others
 */

import { AppError } from '@/lib/errors';
import {
  buildHookPrompt, buildStorytellingPrompt, buildEducationalPrompt,
  buildControversyPrompt, buildEmotionPrompt, buildCombinedPassPrompt,
  MODELS, TARGET_MODEL,
} from '@/lib/prompt';
import type { CandidateWindow } from '@/lib/candidate-extraction';
import type { RawMoment, DnaTag, ConfidenceLevel, VideoMetadata } from '@/lib/types';
import type { GenreProfile } from '@/lib/genre-detector';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LLM_API_URL = 'https://opencode.ai/zen/go/v1/chat/completions';
const CANDIDATES_PER_BATCH = 20;
const MAX_CLIP_DURATION = 120;

/** Per-pass model priority. Hook pass uses deepseek-v4-flash primary for JSON compliance. */
const PASS_MODELS: Record<string, readonly string[]> = {
  hook: ['deepseek-v4-flash', 'mimo-v2.5', 'qwen3.7-plus'],
  storytelling: ['deepseek-v4-flash', 'mimo-v2.5', 'qwen3.7-plus'],
  educational: ['deepseek-v4-flash', 'mimo-v2.5', 'qwen3.7-plus'],
  controversy: ['deepseek-v4-flash', 'mimo-v2.5', 'qwen3.7-plus'],
  emotion: ['deepseek-v4-flash', 'mimo-v2.5', 'qwen3.7-plus'],
};

const VALID_DNA_TAGS = new Set([
  'hookPower', 'curiosity', 'controversy', 'emotion', 'humor',
  'storytelling', 'authority', 'money', 'shock', 'educational',
  'motivation', 'relatability', 'vulnerability', 'inspiration',
]);

const VALID_CONFIDENCE = new Set(['high', 'medium', 'low']);

// ---------------------------------------------------------------------------
// Signal filters per pass type
// ---------------------------------------------------------------------------

const PASS_FILTERS: Record<string, string[]> = {
  hook: ['hookPower', 'curiosity', 'surprise', 'cliffhanger', 'questions'],
  storytelling: ['story_transitions', 'personal', 'storytelling'],
  educational: ['educational_structure', 'numbers', 'actionable_advice', 'authority'],
  controversy: ['controversy', 'debate_arc', 'hot_take', 'speaker_disagreement'],
  emotion: ['emotion', 'vulnerability', 'inspiration', 'reaction_moment'],
};

const PASS_BUILDERS: Record<string, (candidates: CandidateWindow[], title: string) => { system: string; user: string }> = {
  hook: buildHookPrompt,
  storytelling: buildStorytellingPrompt,
  educational: buildEducationalPrompt,
  controversy: buildControversyPrompt,
  emotion: buildEmotionPrompt,
};

// ---------------------------------------------------------------------------
// Pass Result
// ---------------------------------------------------------------------------

export interface PassResult {
  passName: string;
  moments: RawMoment[];
  candidatesEvaluated: number;
  succeeded: boolean;
}

// ---------------------------------------------------------------------------
// Main Export
// ---------------------------------------------------------------------------

/**
 * Run all 5 specialized discovery passes on a shared candidate pool.
 *
 * Each pass:
 *   1. Filters candidates by relevant signals (pre-filter)
 *   2. Batches filtered candidates (max 20)
 *   3. Calls LLM with a compact specialized prompt
 *   4. Validates moments
 *
 * Passes run in parallel (Promise.all) since they are independent.
 * A failing pass does not block other passes.
 *
 * @param candidates - Shared candidate pool from extractCandidates
 * @param metadata   - Video metadata for prompt context
 * @param genreProfile - Phase 5A: Genre calibration profile for signal emphasis
 * @returns Array of PassResult objects (one per pass)
 */
export async function runSpecializedPasses(
  candidates: CandidateWindow[],
  metadata: VideoMetadata,
  genreProfile?: GenreProfile,
): Promise<PassResult[]> {
  const passNames = Object.keys(PASS_FILTERS);

  // Phase 5A: If genre has signal emphasis, apply as additional signal matches
  const effectiveCandidates = genreProfile?.signalEmphasis && genreProfile.signalEmphasis.length > 0
    ? candidates.filter(c =>
        c.signals.some(s => genreProfile.signalEmphasis.includes(s)) || c.signals.length > 0
      )
    : candidates;
  if (genreProfile && effectiveCandidates.length > candidates.length * 0.5) {
    console.log(`[P5A] Genre "${genreProfile.genre}" emphasis: ${effectiveCandidates.length}/${candidates.length} candidates available`);
  }

  // Try combined pass first (1 LLM call instead of 5)
  try {
    const combinedResults = await runCombinedPass(effectiveCandidates, metadata);
    if (combinedResults && combinedResults.length > 0) {
      console.log(`[P5A] Combined multi-pass succeeded: ${combinedResults.reduce((s, r) => s + r.moments.length, 0)} moments across ${combinedResults.length} passes`);
      return combinedResults;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.log(`[P5A] Combined multi-pass failed: ${msg.slice(0, 120)}. Falling back to individual passes.`);
  }

  // Fallback: Run all passes in parallel (original behavior)
  const results = await Promise.all(
    passNames.map(passName => runSinglePass(passName, effectiveCandidates, metadata))
  );

  const totalNew = results.reduce((s, r) => s + r.moments.length, 0);
  const totalEval = results.reduce((s, r) => s + r.candidatesEvaluated, 0);
  const failed = results.filter(r => !r.succeeded).length;

  console.log(`[P4B] Multi-pass complete: ${totalNew} moments from ${totalEval} evaluations across ${passNames.length} passes (${failed} failed)`);
  // Forensic: per-pass moment count
  for (const r of results) {
    if (r.moments.length > 0) {
      const scores = r.moments.map(m => m.worthClippingScore);
      console.log(`[FORENSIC] Pass "${r.passName}": ${r.moments.length} moments, scores ${Math.min(...scores)}-${Math.max(...scores)}, candidates=${r.candidatesEvaluated}`);
    } else {
      console.log(`[FORENSIC] Pass "${r.passName}": 0 moments (evaluated ${r.candidatesEvaluated} candidates)`);
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Single Pass Runner
// ---------------------------------------------------------------------------

async function runSinglePass(
  passName: string,
  candidates: CandidateWindow[],
  metadata: VideoMetadata,
): Promise<PassResult> {
  // Step 1: Filter candidates by matching signals
  const relevantSignals = PASS_FILTERS[passName];
  const filtered = candidates.filter(c =>
    c.signals.some(s => relevantSignals.includes(s))
  );

  if (filtered.length === 0) {
    console.log(`[P4B] Pass "${passName}": 0 candidates matched signals, skipping`);
    console.timeEnd(`[PROFILE] ${metadata.youtubeId} pass_${passName}`);
    return { passName, moments: [], candidatesEvaluated: 0, succeeded: true };
  }

  console.log(`[P4B] Pass "${passName}": ${filtered.length}/${candidates.length} candidates matched`);

  // Step 2: Build prompt
  console.time(`[PROFILE] ${metadata.youtubeId} pass_${passName}`);
  const promptBuilder = PASS_BUILDERS[passName];
  const { system, user } = promptBuilder(filtered, metadata.title);

  // Step 3: Batch candidates (max 20 per LLM call)
  // For most passes, filtered count is <20 so this is 1 batch
  const allMoments: RawMoment[] = [];
  let overallSucceeded = false;

  for (let start = 0; start < filtered.length; start += CANDIDATES_PER_BATCH) {
    const batch = filtered.slice(start, start + CANDIDATES_PER_BATCH);
    const batchUser = user.replace(
      /CANDIDATES:[\s\S]*?(?=\n\n[A-Z]+ SCORING|$)/,
      `CANDIDATES:\n${batch.map((c, i) => `CANDIDATE ${i + 1}: "${c.text.slice(0, 300)}" startTime:${c.startSeconds} endTime:${c.endSeconds}`).join('\n---\n')}\n`
    );

    // Step 4: Try each model (with fallback loop) — per-batch flag so
    // each batch independently stops at the first successful model.
    // Each pass uses its own model priority list (PASS_MODELS).
    let batchSucceeded = false;
    const passModels = PASS_MODELS[passName] ?? MODELS;
    for (let modelIdx = 0; modelIdx < passModels.length && !batchSucceeded; modelIdx++) {
      const model = passModels[modelIdx];
      let attemptSuccess = false;

      for (let attempt = 0; attempt < 2 && !attemptSuccess; attempt++) {
        const promptText = attempt === 0
          ? batchUser
          : `${batchUser}\n\nIMPORTANT: Your previous response was not accepted. Common issues:\n- Not a valid JSON array (wrap in [ ])\n- Missing or invalid dnaTags (must include at least 1 from the allowed list)\n- Confidence abbreviation (use full words: "high", "medium", or "low")\n- Incorrect startTime/endTime (must be numbers, matching the candidate's timestamps)\n\nFix ALL of these issues. Output valid JSON array only.`;

        try {
          const rawText = await callLLMMultiPass(model, system, promptText);
          const cleaned = stripMarkdownFencesMultiPass(rawText);
          let parsed = JSON.parse(cleaned);

          if (!Array.isArray(parsed)) {
            // If the model returned a single object with startTime, wrap it
            if (typeof parsed === 'object' && parsed !== null && 'startTime' in parsed) {
              parsed = [parsed] as unknown[];
              console.log(`[P4B] Pass "${passName}": Model returned single object — wrapped in array`);
            } else if (typeof parsed === 'object' && parsed !== null) {
              // Try to find an array within the object (candidates/data/results keys)
              const obj = parsed as Record<string, unknown>;
              let found = false;
              for (const key of ['candidates', 'results', 'data', 'moments', 'items', 'clips', 'ratings', 'scores']) {
                if (Array.isArray(obj[key]) && (obj[key] as unknown[]).length > 0) {
                  parsed = obj[key] as unknown[];
                  console.log(`[P4B] Pass "${passName}": Extracted ${(parsed as unknown[]).length} items from object key "${key}"`);
                  found = true;
                  break;
                }
              }
              if (!found) {
                console.log(`[P4B] Pass "${passName}": Expected array, got object keys=[${Object.keys(obj).join(',')}]`);
                continue;
              }
            } else if (parsed === null) {
              console.log(`[P4B] Pass "${passName}": Model returned null — skipping batch`);
              continue;
            } else {
              const typeName = Array.isArray(parsed) ? 'array' : typeof parsed;
              console.log(`[P4B] Pass "${passName}": Expected array, got ${typeName} (value=${JSON.stringify(parsed).slice(0, 100)})`);
              continue;
            }
          }

          const validMoments = validateMultiPassMoments(parsed);
          if (validMoments.length > 0 || batch.length === 0) {
            // Apply lead-in expansion using candidate references
            for (const moment of validMoments) {
              const candidate = batch.find(c =>
                moment.startTime >= c.startSeconds && moment.startTime <= c.endSeconds
              );
              if (candidate) {
                const targetStart = Math.max(candidate.startSeconds, moment.startTime - 12);
                const newDuration = moment.endTime - targetStart;
                if (newDuration <= MAX_CLIP_DURATION && targetStart < moment.startTime) {
                  moment.startTime = targetStart;
                }
              }
            }
            allMoments.push(...validMoments);
            attemptSuccess = true;
            batchSucceeded = true;
            overallSucceeded = true;
            console.log(`[P4B] Pass "${passName}": ${validMoments.length} valid from ${batch.length} candidates (model=${model})`);
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : 'Unknown error';
          console.log(`[P4B] Pass "${passName}": FAILED model=${model} attempt=${attempt + 1}: ${msg.slice(0, 120)}`);
        }
      }
    }
  }

  console.timeEnd(`[PROFILE] ${metadata.youtubeId} pass_${passName}`);
  return {
    passName,
    moments: allMoments,
    candidatesEvaluated: filtered.length,
    succeeded: overallSucceeded,
  };
}

// ---------------------------------------------------------------------------
// LLM Call
// ---------------------------------------------------------------------------

async function callLLMMultiPass(model: string, system: string, user: string, timeoutMs?: number): Promise<string> {
  const apiKey = process.env.OPENCODE_GO_API_KEY;
  if (!apiKey) throw new AppError('ANALYSIS_FAILED', 'No API key configured.', 500);

  const response = await fetch(LLM_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.3,
      max_tokens: 32768,
    }),
    signal: AbortSignal.timeout(timeoutMs ?? 500_000),
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => 'unknown');
    if (response.status >= 500) throw new Error(`HTTP ${response.status}: ${errBody.slice(0, 200)}`);
    throw new AppError('ANALYSIS_FAILED', `HTTP ${response.status}: ${errBody.slice(0, 200)}`, response.status);
  }

  const data = await response.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text || text.trim().length === 0) {
    console.log(`[LLM] Empty response: choices=${data?.choices?.length} finish_reason=${data?.choices?.[0]?.finish_reason} usage=${JSON.stringify(data?.usage)}`);
    throw new Error('Empty response');
  }
  return text.trim();
}

// ---------------------------------------------------------------------------
// Combined Pass — evaluates ALL 5 dimensions in a single LLM call
// ---------------------------------------------------------------------------

/**
 * Run a single combined pass that evaluates candidates across all 5 dimensions.
 * Reduces 5 separate LLM calls to 1.
 */
async function runCombinedPass(
  candidates: CandidateWindow[],
  metadata: VideoMetadata,
): Promise<PassResult[] | null> {
  const passNames = Object.keys(PASS_FILTERS);
  const { system, user } = buildCombinedPassPrompt(candidates, metadata.title);
  const model = 'deepseek-v4-flash';

  // Map DNA tags to pass origin
  const TAG_TO_PASS: Record<string, string> = {
    hookPower: 'hook', curiosity: 'hook', shock: 'hook',
    storytelling: 'storytelling', relatability: 'storytelling', vulnerability: 'storytelling',
    educational: 'educational', authority: 'educational', money: 'educational', motivation: 'educational',
    controversy: 'controversy', emotion: 'controversy',
    inspiration: 'emotion',
  };

  // Limit candidates to prevent overly long prompts
  // Reduced from 30 → 15 to avoid HTTP 500 on combined multi-dimension prompt.
  // Each candidate × 5 dimensions produces large JSON; 30 candidates × 5 = 150 entries
  // was overwhelming the API. 15 candidates × 5 = 75 entries is manageable.
  const maxCombined = Math.min(candidates.length, 15);
  const sampled = candidates.slice(0, maxCombined);
  if (maxCombined < candidates.length) {
    console.log(`[P5A] Combined pass: sampling ${maxCombined}/${candidates.length} candidates`);
  }

  const { system: combinedSystem, user: combinedUser } = buildCombinedPassPrompt(sampled, metadata.title);

  // Combined pass: 1 attempt + 1 retry on server error (500+)
  // Timeout lowered to 180s to avoid wasting 3+ minutes if API rejects large payload
  const COMBINED_TIMEOUT_MS = 180_000;
  for (let attempt = 0; attempt < 2; attempt++) {
    console.time(`[PROFILE] ${metadata.youtubeId} combined_multi_pass_${attempt}`);
    try {
      const rawText = await callLLMMultiPass(model, combinedSystem, combinedUser, COMBINED_TIMEOUT_MS);
      const cleaned = stripMarkdownFencesMultiPass(rawText);
      const parsed = JSON.parse(cleaned);

      if (!Array.isArray(parsed) || parsed.length === 0) {
        console.log(`[P5A] Combined pass: empty or invalid response`);
        return null;
      }

      // Validate and group by inferred pass origin
      const byPass: Record<string, RawMoment[]> = {};
      let validCount = 0;
      let skippedCount = 0;

      for (const item of parsed) {
        const obj = item as Record<string, unknown> | null;
        if (!obj || typeof obj !== 'object') { skippedCount++; continue; }

        const moment = validateSinglePassMoment(obj);
        if (!moment) { skippedCount++; continue; }

        // Infer pass origin from DNA tags
        const inferredPasses = new Set<string>();
        for (const tag of moment.dnaTags) {
          const pass = TAG_TO_PASS[tag];
          if (pass) inferredPasses.add(pass);
        }

        if (inferredPasses.size === 0) {
          // Default to hook if no pass can be inferred
          inferredPasses.add('hook');
        }

        const inferredArray = Array.from(inferredPasses);
        for (const pass of inferredArray) {
          if (!byPass[pass]) byPass[pass] = [];
          byPass[pass].push(moment);
        }
        validCount++;
      }

      console.log(`[P5A] Combined pass: ${validCount} valid + ${skippedCount} skipped across ${Object.keys(byPass).length} pass types`);

      if (validCount === 0) return null;

      // Build PassResult for each pass type
      const results: PassResult[] = passNames.map(passName => ({
        passName,
        moments: byPass[passName] || [],
        candidatesEvaluated: candidates.length,
        succeeded: (byPass[passName]?.length || 0) > 0,
      }));

      return results;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      if (attempt === 0 && msg.includes('HTTP 500')) {
        // Retry once on server error (transient HTTP 500)
        console.log(`[P5A] Combined pass attempt ${attempt + 1} failed with server error. Retrying...`);
        continue;
      }
      console.log(`[P5A] Combined pass failed after ${attempt + 1} attempt(s): ${msg.slice(0, 150)}`);
      return null;
    } finally {
      console.timeEnd(`[PROFILE] ${metadata.youtubeId} combined_multi_pass_${attempt}`);
    }
  }
  console.log(`[P5A] Combined pass: exhausted retries`);
  return null;
}

/** Validate a single moment from the combined pass output, including passType. */
function validateSinglePassMoment(obj: Record<string, unknown>): RawMoment | null {
  const startTime = coerceNumber(obj.startTime);
  let endTime = coerceNumber(obj.endTime);
  const score = coerceNumber(obj.worthClippingScore);
  let confidence = String(obj.confidence ?? '').toLowerCase();
  let dnaTags = obj.dnaTags;
  let reasoning = String(obj.reasoning ?? '').trim();

  if (startTime === null || startTime < 0) return null;
  if (endTime === null || endTime <= startTime) return null;

  const clipDuration = endTime - startTime;
  if (clipDuration < 8) return null;
  if (clipDuration > 120) endTime = startTime + 120;

  if (score === null || score < 0 || score > 100) return null;

  // Confidence mapping
  const syn: Record<string, string> = {
    'very high': 'high', 'strong': 'high', 'very high confidence': 'high',
    'moderate': 'medium', 'mid': 'medium', 'average': 'medium',
    'very low': 'low', 'weak': 'low', 'none': 'low',
    'h': 'high', 'm': 'medium', 'l': 'low',
  };
  confidence = syn[confidence] || confidence;
  if (!VALID_CONFIDENCE.has(confidence)) confidence = 'medium';

  // DNA tags
  const tags = validateTags(dnaTags);
  if (tags.length === 0) return null;

  if (!reasoning) {
    reasoning = `Pass scored ${score} with tags: ${tags.join(', ')}`;
  }

  return {
    startTime,
    endTime,
    worthClippingScore: score,
    confidence: confidence as ConfidenceLevel,
    dnaTags: tags,
    reasoning,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stripMarkdownFencesMultiPass(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
  return match ? match[1].trim() : trimmed;
}

function validateMultiPassMoments(items: unknown[]): RawMoment[] {
  const valid: RawMoment[] = [];
  for (const item of items) {
    const obj = item as Record<string, unknown> | null;
    if (!obj || typeof obj !== 'object') continue;

    const startTime = coerceNumber(obj.startTime);
    let endTime = coerceNumber(obj.endTime);
    const score = coerceNumber(obj.worthClippingScore);
    let confidence = String(obj.confidence ?? '').toLowerCase();
    let dnaTags = obj.dnaTags;
    let reasoning = String(obj.reasoning ?? '').trim();

    if (startTime === null || startTime < 0) continue;
    if (endTime === null || endTime <= startTime) continue;
    if (score === null || score < 0 || score > 100) continue;

    const clipDuration = endTime - startTime;
    if (clipDuration < 8) continue;
    if (clipDuration > 120) endTime = startTime + 120;

    // Confidence mapping
    const syn: Record<string, string> = {
      'very high': 'high', 'strong': 'high', 'very high confidence': 'high',
      'moderate': 'medium', 'mid': 'medium', 'average': 'medium',
      'very low': 'low', 'weak': 'low', 'none': 'low',
      // Abbreviations from hook prompt
      'h': 'high', 'm': 'medium', 'l': 'low',
    };
    confidence = syn[confidence] || confidence;
    if (!VALID_CONFIDENCE.has(confidence)) confidence = 'medium';

    // DNA tags
    const tags = validateTags(dnaTags);
    if (tags.length === 0) continue;

    if (!reasoning) {
      reasoning = `Pass scored ${score} with tags: ${tags.join(', ')}`;
    }

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

const TAG_SYNONYMS: Record<string, string> = {
  'funny': 'humor', 'comedy': 'humor', 'hilarious': 'humor',
  'shocking': 'shock', 'surprising': 'shock', 'unexpected': 'shock',
  'educational': 'educational', 'informative': 'educational', 'insightful': 'educational',
  'inspiring': 'inspiration', 'motivational': 'motivation',
  'controversial': 'controversy', 'debate': 'controversy', 'argument': 'controversy',
  'relatable': 'relatability', 'authentic': 'relatability',
  'vulnerable': 'vulnerability', 'raw': 'vulnerability', 'honest': 'vulnerability',
  'story': 'storytelling', 'narrative': 'storytelling', 'anecdote': 'storytelling',
  'hookpower': 'hookPower', 'hook': 'hookPower',
  'emotion': 'emotion', 'emotional': 'emotion',
  'authority': 'authority', 'expert': 'authority',
  'money': 'money', 'financial': 'money', 'wealth': 'money',
  'curiosity': 'curiosity', 'curious': 'curiosity',
};

function validateTags(value: unknown): DnaTag[] {
  if (!Array.isArray(value)) return [];
  const tags: DnaTag[] = [];
  for (const tag of value) {
    let str = String(tag).trim();
    if (VALID_DNA_TAGS.has(str)) {
      if (!tags.includes(str as DnaTag)) tags.push(str as DnaTag);
    } else {
      const lower = str.toLowerCase();
      const mapped = TAG_SYNONYMS[lower];
      if (mapped && !tags.includes(mapped as DnaTag)) {
        tags.push(mapped as DnaTag);
      } else if (VALID_DNA_TAGS.has(lower)) {
        if (!tags.includes(lower as DnaTag)) tags.push(lower as DnaTag);
      }
    }
    if (tags.length >= 3) break;
  }
  return tags;
}

function coerceNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
    const ts = value.match(/^(\d+):(\d{2})(?::(\d{2}))?$/);
    if (ts) {
      if (ts[3]) return parseInt(ts[1]) * 3600 + parseInt(ts[2]) * 60 + parseInt(ts[3]);
      return parseInt(ts[1]) * 60 + parseInt(ts[2]);
    }
  }
  return null;
}
