import { enforceEvaluatorRules } from "./evaluator-validator";
import { removeDuplicateMoments } from "./remove-duplicates";
/**
 * ganyIQ LLM analysis pipeline — V2 Candidate Extraction + Batch Scoring.
 *
 * Phase 5A:
 *   - Adaptive candidate cap (scales with duration)
 *   - Genre-aware intelligence (calibrates prompts, passes, scoring)
 *   - Multi-factor dedup (time + DNA + score + transcript similarity)
 *
 * V2 ARCHITECTURE:
 *   1. extractCandidates(transcript) → CandidateWindow[] (deterministic, <50ms)
 *   2. buildBatchCandidateScoringPrompt(candidates) → single LLM prompt (~2000-4000 tokens)
 *   3. LLM scores ALL candidates in ONE call → RawMoment[]
 *   4. validateMoments() → filter invalid → sort by score
 *
 * THREE-LAYER VALIDATION:
 *   1. JSON structure — valid array, valid objects, no missing fields
 *   2. Value boundaries — timestamps in range, scores 0-100, valid enums
 *   3. Semantic constraints — duration 8-120s, start < end, valid DNA tags
 */

import { AppError } from '@/lib/errors';
import { query } from '@/db/client';
import { buildActivePrompt, MODELS, TARGET_MODEL, PROMPT_VERSION_V2C } from '@/lib/prompt';
import { extractCandidates, type CandidateWindow } from '@/lib/candidate-extraction';
import { cleanTranscript } from '@/lib/transcript-cleaner';
import { enrichTranscript } from '@/lib/speaker-enrich';
import { enrichCandidatesWithSpeakerData } from '@/lib/candidate-extraction';
import { runSpecializedPasses } from '@/lib/multi-pass';
import { detectGenre, type GenreProfile } from '@/lib/genre-detector';
import type { RawMoment, DnaTag, ConfidenceLevel, VideoMetadata, TranscriptSegment } from '@/lib/types';
import { EvaluatorRunner } from './evaluator-runner';
import { calculateHybridScore } from './hybrid-ranking';
import { callOwlAlpha } from './openrouter-client';

// ---------------------------------------------------------------------------
// Analysis Result
// ---------------------------------------------------------------------------

export interface AnalysisResult {
  moments: RawMoment[];
  model: string;
  rawResponse: string | null;  // Raw LLM response text for DB storage
}

/** Phase 5A: Extended analysis metadata for benchmarking. */
export interface AnalysisDebugInfo {
  candidateCount: number;
  numBatches: number;
  genre: GenreProfile;
  maxCandidates: number;
  dedupConfig: { primaryWindow: number };
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

const MIN_CLIP_DURATION = 8;   // seconds
const MAX_CLIP_DURATION = 120; // seconds
const MIN_SCORE = 0;
const MAX_SCORE = 100;

/** OpenCode Go API endpoint (OpenAI-compatible chat completions). */
const LLM_API_URL = 'https://opencode.ai/zen/go/v1/chat/completions';

/**
 * Phase 5A: Dynamic candidate cap scaling.
 *
 * Candidate limits scale with content length:
 *   0-30 min:  30 candidates  (1.0/min)
 *   30-60 min: 60 candidates  (1.0-2.0/min tapering)
 *   60-120 min: 120 candidates (~1.5/min tapering)
 *   120+ min:  180 candidates (~1.0/min floor)
 *
 * This replaces the old 60-candidate hard cap.
 */
/**
 * Phase 5A: Adaptive candidate scaling with signal density multiplier.
 *
 * Base allocation from video duration, then scaled by signal density
 * so content-rich long videos get proportionally more coverage.
 *
 *   0-30 min:  1.0/min (min 15, max 30) × density
 *   30-60 min: 30 + (min-30)×1.0 × density
 *   60-120 min: 60 + (min-60)×1.0 × density
 *   120+ min:  120 + (min-120)×0.5 × density, cap 180
 */
export function calculateMaxCandidates(durationSeconds: number, signalDensity?: number): number {
  const durationMinutes = Math.max(1, Math.round(durationSeconds / 60));

  let base: number;
  if (durationMinutes <= 30) {
    base = Math.max(15, Math.min(30, durationMinutes));
  } else if (durationMinutes <= 60) {
    base = Math.min(60, 30 + (durationMinutes - 30));
  } else if (durationMinutes <= 120) {
    base = 60 + (durationMinutes - 60);
  } else {
    base = Math.min(180, 120 + (durationMinutes - 120) * 0.5);
  }

  // Signal density multiplier: high-density content gets +20% candidates
  if (signalDensity !== undefined && signalDensity > 0.5) {
    const multiplier = 1 + Math.min(0.2, signalDensity * 0.3);
    base = Math.round(base * multiplier);
  }

  return Math.min(250, Math.max(15, base));
}

/** Maximum candidates per single LLM batch call (to stay within token budget). */
const CANDIDATES_PER_LLM_BATCH = 20;

/** Deployment version marker — incremented on each fix. */
const DEPLOY_VERSION = 'v2-compact';

/**
 * Phase 5B: Candidate count budget by tier.
 * Higher-tier candidates get priority in candidate selection.
 * Podcast/interview: more lower-density coverage.
 * Educational/technical: fewer, higher-quality targets.
 */
export function getCandidateBudget(genre: ContentGenre, maxCandidates: number): number {
  // Always return the max — let signal scoring determine which candidates survive
  return maxCandidates;
}

import type { ContentGenre } from '@/lib/genre-detector';

// ---------------------------------------------------------------------------
// Genre-Aware Prompt Builder Wrapper
// ---------------------------------------------------------------------------

/**
 * Phase 5A: Extend the active prompt with genre-specific system prompt modifier.
 */
function buildGenreAwarePrompt(
  metadata: VideoMetadata,
  candidates: CandidateWindow[],
  genre: GenreProfile,
): { system: string; user: string; version: string } {
  const base = buildActivePrompt(metadata, candidates);

  // Append genre modifier to system prompt if genre is known
  if (genre.genre !== 'unknown' && genre.systemPromptModifier) {
    const modifiedSystem = base.system + '\n\n' + genre.systemPromptModifier;
    return { ...base, system: modifiedSystem };
  }

  return base;
}

// ---------------------------------------------------------------------------
// Main Export
// ---------------------------------------------------------------------------

/**
 * Analyze a podcast transcript and extract worth-clipping moments.
 *
 * Phase 5A:
 *   - Dynamic candidate scaling (no more 60-candidate hard cap)
 *   - Genre-aware prompt selection
 *   - Genre-aware pass weights in multi-pass
 *
 * @param metadata  - Video metadata (title, channel, duration)
 * @param transcript - Parsed transcript segments from the YouTube video
 * @returns Validated RawMoment[] with raw LLM response concatenated
 *
 * @throws AppError ANALYSIS_FAILED if all batches fail for all models
 */
export async function analyzeTranscript(
  metadata: VideoMetadata,
  transcript: TranscriptSegment[],
  analysisId?: string,
): Promise<AnalysisResult> {
  const youtubeId = metadata.youtubeId;
  // Compute effective duration first (needed for dynamic candidate cap)
  const lastSeg = transcript[transcript.length - 1];
  const transcriptDuration = lastSeg ? Math.ceil(lastSeg.start + lastSeg.duration) : 0;
  const effectiveDuration = metadata.durationSeconds > 0 ? metadata.durationSeconds : transcriptDuration;
  if (effectiveDuration !== metadata.durationSeconds) {
    console.log(`[V2] Metadata duration was ${metadata.durationSeconds}s, using transcript duration: ${effectiveDuration}s`);
  }

  // Step 0: Clean transcript (remove filler words, stutters, duplicates)
  console.log(`[V3] Cleaning ${transcript.length} transcript segments...`);
  cleanTranscript(transcript);

  // Step 0b: Speaker enrichment (Phase 3B)
  const speakerData = enrichTranscript(transcript);
  if (speakerData.hasSpeakerData) {
    console.log(`[SPEAKER] Detected ${speakerData.uniqueSpeakers} speaker(s), ${speakerData.exchanges} exchanges, ${speakerData.debateSegments.length} debate segments, ${speakerData.reactionMoments.length} reaction moments`);
  } else {
    console.log(`[SPEAKER] No speaker data available (YouTube transcript or Deepgram without diarization)`);
  }

  // Phase 5A: Genre detection — now actually USED
  const genreProfile = detectGenre(metadata.title, metadata.channelName, transcript);
  console.log(`[GENRE] Detected: ${genreProfile.genre} (confidence: ${genreProfile.confidence.toFixed(2)}, dedupWindow: ${genreProfile.dedupWindow}s)`);
  console.log(`[GENRE] Pass boosts: ${JSON.stringify(genreProfile.passBoosts)}`);
  console.log(`[GENRE] DNA priorities: ${genreProfile.dnaPriorities.join(', ')}`);

  // Step 1: Extract candidate windows with Phase 5A dynamic cap
  const maxCandidates = calculateMaxCandidates(effectiveDuration);
  console.log(`[V2] Max candidates: ${maxCandidates} (video duration: ${Math.round(effectiveDuration / 60)} min, genre: ${genreProfile.genre})`);
  console.log(`[V2] Extracting candidates from ${transcript.length} segments...`);
  console.time(`[PROFILE] ${youtubeId} 2a_candidate_extraction`);
  const candidates = extractCandidates(transcript, maxCandidates);
  console.timeEnd(`[PROFILE] ${youtubeId} 2a_candidate_extraction`);
  console.log(`[FORENSIC] extractCandidates output: ${candidates.length} candidate windows (maxCandidates=${maxCandidates})`);
  console.log(`[FORENSIC] Candidate signal distribution: ${JSON.stringify(countBySignal(candidates))}`);
  console.log(`[FORENSIC] Candidate time coverage: first=${candidates[0]?.startSeconds?.toFixed(1) ?? 'N/A'}s last=${candidates[candidates.length-1]?.startSeconds?.toFixed(1) ?? 'N/A'}s`);
  console.log(`[V2] Found ${candidates.length} candidates`);

  // Step 1b: Enrich candidates with speaker metadata (Phase 3B)
  if (speakerData.hasSpeakerData) {
    enrichCandidatesWithSpeakerData(candidates, transcript);
    const multiSpeakerCount = candidates.filter(c => c.speakers && c.speakers.length >= 2).length;
    console.log(`[SPEAKER] Enriched candidates: ${multiSpeakerCount}/${candidates.length} have multiple speakers`);
  }

  if (candidates.length === 0) {
    console.log(`[V2] No candidates extracted. Returning empty.`);
    return { moments: [], model: TARGET_MODEL, rawResponse: null };
  }

  // Progress: candidate extraction done → batch analysis starts
  if (analysisId) {
    await query(
      'UPDATE analyses SET progress_stage = $1 WHERE id = $2',
      ['batch_analysis', analysisId],
    ).catch(() => {});
  }

  // Step 2: Split candidates into batches for multi-batch evaluation
  const batches: CandidateWindow[][] = [];
  for (let i = 0; i < candidates.length; i += CANDIDATES_PER_LLM_BATCH) {
    batches.push(candidates.slice(i, i + CANDIDATES_PER_LLM_BATCH));
  }
  const numBatches = batches.length;
  console.log(`[V3] Split ${candidates.length} candidates into ${numBatches} batch(es) of max ${CANDIDATES_PER_LLM_BATCH} each`);

  // Step 3: Multi-batch LLM evaluation — PARALLEL with concurrency control
  let allValidMoments: RawMoment[] = [];
  let allRawResponses: string[] = [];
  console.time(`[PROFILE] ${youtubeId} 2b_llm_scoring`);

  const BATCH_CONCURRENCY = 4; // Safe parallel batches — 4 concurrent to hit 5-min target

  async function processSingleBatch(batchIdx: number): Promise<void> {
    const batchCandidates = batches[batchIdx];
    console.log(`[V3] Batch ${batchIdx + 1}/${numBatches}: ${batchCandidates.length} candidates`);

    // Build prompt for this batch — Phase 5A: genre-aware
    const { system, user, version: promptVersion } = buildGenreAwarePrompt(metadata, batchCandidates, genreProfile);
    console.log(`[V3] Prompt: ${promptVersion} | Prompt length: ${user.length} chars | Genre: ${genreProfile.genre}`);

    // Model fallback loop for this batch
    let batchSucceeded = false;
    for (let modelIdx = 0; modelIdx < MODELS.length && !batchSucceeded; modelIdx++) {
      const model = MODELS[modelIdx];
      const isPrimary = modelIdx === 0;
      const isFallback = modelIdx > 0;

      if (isFallback) {
        console.log(`[LLM] Batch ${batchIdx + 1}: PRIMARY_FAILED`);
        console.log(`[LLM] Batch ${batchIdx + 1}: FALLBACK_ACTIVATED model=${model}`);
      }

      const maxAttempts = 2;
      for (let attempt = 0; attempt < maxAttempts && !batchSucceeded; attempt++) {
        console.log(`[LLM] Batch ${batchIdx + 1}: model=${model} attempt=${attempt + 1}`);

        const userPrompt = attempt === 0
          ? user
          : `${user}\n\nYour previous response could not be parsed as valid JSON. Output valid JSON only. No markdown, no code fences, no extra text.`;

        let rawText: string;
        try {
          rawText = await callLLM(model, system, userPrompt);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : 'Unknown error';
          console.log(`[LLM] Batch ${batchIdx + 1}: FAILED model=${model} attempt=${attempt + 1} error=${msg.slice(0, 200)}`);
          continue;
        }

        const cleaned = stripMarkdownFences(rawText);
        allRawResponses.push(rawText);

        let parsed: unknown;
        try {
          parsed = JSON.parse(cleaned);
        } catch {
          const preview = cleaned.slice(0, 200);
          console.log(`[LLM] Batch ${batchIdx + 1}: FAILED model=${model} attempt=${attempt + 1} error=JSON parse failed`);
          continue;
        }

        if (!Array.isArray(parsed)) {
          console.log(`[LLM] Batch ${batchIdx + 1}: FAILED model=${model} attempt=${attempt + 1} error=Expected JSON array, got ${typeof parsed}`);
          continue;
        }

        // Validate moments
        const batchMoments = validateMoments(parsed, effectiveDuration);

        if (batchMoments.length === 0 && parsed.length > 0) {
          console.log(`[LLM] Batch ${batchIdx + 1}: FAILED model=${model} attempt=${attempt + 1} error=All moments failed validation`);
          continue;
        }

        // Apply lead-in expansion using this batch's candidates
        const MAX_LEAD_IN = 12;
        let expandedCount = 0;
        for (const moment of batchMoments) {
          const candidate = batchCandidates.find(c =>
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
        }

        // ── Batch succeeded ──
        console.log(`[LLM] Batch ${batchIdx + 1}: success model=${model} | ${batchMoments.length} valid moments from ${batchCandidates.length} candidates`);
        if (expandedCount > 0) {
          console.log(`[V3] Batch ${batchIdx + 1}: Expanded ${expandedCount}/${batchMoments.length} clips`);
        }

        // Push is safe in concurrent JS — single-threaded event loop
        allValidMoments.push(...batchMoments);
        logMetricCounts(isPrimary, isFallback, modelIdx);
        batchSucceeded = true;
      }
    }

    if (!batchSucceeded) {
      console.log(`[V3] Batch ${batchIdx + 1}: ALL MODELS FAILED — batch skipped`);
    }
  }

  // Run batches in waves of BATCH_CONCURRENCY
  for (let i = 0; i < numBatches; i += BATCH_CONCURRENCY) {
    const waveEnd = Math.min(i + BATCH_CONCURRENCY, numBatches);
    const wave: Promise<void>[] = [];
    for (let j = i; j < waveEnd; j++) {
      wave.push(processSingleBatch(j));
    }
    const results = await Promise.allSettled(wave);
    // Log any batch failures
    for (let j = 0; j < results.length; j++) {
      const result = results[j];
      if (result.status === 'rejected') {
        const batchNum = i + j + 1;
        const reason = result.reason;
        const msg = reason instanceof Error ? reason.message : String(reason);
        console.log(`[V3] Batch ${batchNum}: UNHANDLED ERROR — ${msg.slice(0, 200)}`);
      }
    }
  }

  // Step 4: Combine all raw responses
  const combinedRawResponse = allRawResponses.length > 0
    ? allRawResponses.join('\n---BATCH---\n')
    : null;

  console.log(`[FORENSIC] Multi-batch scoring: ${allValidMoments.length} valid moments from ${candidates.length} candidates across ${numBatches} batches`);
  console.log(`[FORENSIC] Batch score range: min=${Math.min(...allValidMoments.map(m=>m.worthClippingScore))} max=${Math.max(...allValidMoments.map(m=>m.worthClippingScore))} avg=${(allValidMoments.reduce((s,m)=>s+m.worthClippingScore,0)/Math.max(1,allValidMoments.length)).toFixed(1)}`);
  console.log(`[V3] Multi-batch complete. ${allValidMoments.length} valid moments across ${numBatches} batches from ${candidates.length} total candidates.`);
  console.timeEnd(`[PROFILE] ${youtubeId} 2b_llm_scoring`);

  // Progress: batch scoring done → multi-pass verification starts
  if (analysisId) {
    await query(
      'UPDATE analyses SET progress_stage = $1 WHERE id = $2',
      ['multi_pass', analysisId],
    ).catch(() => {});
  }

  // Step 5: Phase 4B baseline pass bonuses + Phase 5A genre-calibrated pass bonuses
  const BASE_PASS_BONUSES: Record<string, number> = {
    hook: 4,
    storytelling: 5,
    educational: 6,
    controversy: 6,
    emotion: 8,
  };

  const CROSS_PASS_BONUS = 5;
  const TIME_PROXIMITY = 3; // seconds — max gap to consider same clip

  // Phase 5A: Apply genre-specific pass boosts on top of base bonuses
  const genreBoosts = genreProfile.passBoosts;
  const effectivePassBonuses: Record<string, number> = {};
  for (const passName of Object.keys(BASE_PASS_BONUSES)) {
    effectivePassBonuses[passName] = (BASE_PASS_BONUSES[passName] ?? 5) + (genreBoosts[passName] ?? 0);
  }
  console.log(`[P5A] Genre-adjusted pass bonuses: ${JSON.stringify(effectivePassBonuses)}`);

  let multiPassMoments: RawMoment[] = [];
  try {
    console.time(`[PROFILE] ${youtubeId} 2c_multipass`);
    const passResults = await runSpecializedPasses(candidates, metadata, genreProfile);
    console.timeEnd(`[PROFILE] ${youtubeId} 2c_multipass`);
    const succeededPasses = passResults.filter(r => r.succeeded);
    const totalPassMoments = passResults.reduce((s, r) => s + r.moments.length, 0);

    if (totalPassMoments > 0) {
      // Phase 4B: Base pass bonuses + Phase 5A: Genre boosts
      for (const result of passResults) {
        const bonus = effectivePassBonuses[result.passName] ?? 5;
        for (const moment of result.moments) {
          moment.worthClippingScore = Math.min(100, moment.worthClippingScore + bonus);
        }
      }

      // Cross-pass reinforcement
      const allPassMoments = passResults.flatMap(r =>
        r.moments.map(m => ({ ...m, passName: r.passName }))
      );
      let reinforcedCount = 0;
      for (let i = 0; i < allPassMoments.length; i++) {
        let agreementCount = 0;
        const matchPasses = new Set<string>([allPassMoments[i].passName]);
        for (let j = i + 1; j < allPassMoments.length; j++) {
          const diff = Math.abs(allPassMoments[i].startTime - allPassMoments[j].startTime);
          if (diff <= TIME_PROXIMITY) {
            matchPasses.add(allPassMoments[j].passName);
          }
        }
        agreementCount = matchPasses.size;
        if (agreementCount >= 2) {
          allPassMoments[i].worthClippingScore = Math.min(100, allPassMoments[i].worthClippingScore + CROSS_PASS_BONUS);
          reinforcedCount++;
        }
      }

      multiPassMoments = allPassMoments;
      console.log(`[P5A] Multi-pass added ${multiPassMoments.length} moments from ${succeededPasses.length}/${passResults.length} passes`);
      console.log(`[P5A] Cross-pass reinforcement: ${reinforcedCount} clips boosted (${CROSS_PASS_BONUS} pts each)`);
      if (succeededPasses.length > 0) {
        const bonusSummary = succeededPasses.map(r =>
          `${r.passName}=${r.moments.length}×+${effectivePassBonuses[r.passName] ?? 5}`
        ).join(' ');
        console.log(`[P5A] Pass bonuses: ${bonusSummary}`);
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.log(`[P5A] Multi-pass failed: ${msg.slice(0, 200)}. Falling back to general pass only.`);
  }

  // Combine general pass + multi-pass moments
  const combinedMoments = [...allValidMoments, ...multiPassMoments];
  console.log(`[P5A] Total moments: ${combinedMoments.length} (${allValidMoments.length} general + ${multiPassMoments.length} multi-pass; genre: ${genreProfile.genre})`);
  console.log(`[FORENSIC] Combined moments score range: min=${Math.min(...combinedMoments.map(m=>m.worthClippingScore))} max=${Math.max(...combinedMoments.map(m=>m.worthClippingScore))} avg=${(combinedMoments.reduce((s,m)=>s+m.worthClippingScore,0)/Math.max(1,combinedMoments.length)).toFixed(1)}`);


  // Sprint 2: Integrate 3-factor evaluator (FROZEN) + viral score
  const evaluator = new (await import("./evaluator-runner")).EvaluatorRunner();
  for (const m of combinedMoments) {
    try {
      const transcript_short = (m as any).transcriptExcerpt || "";
      if (transcript_short.length > 10) {
        let res = await evaluator.evaluateClip({ clipId: (m as any).clipId || "c", transcript: transcript_short });
        res = enforceEvaluatorRules(res);
        (m as any).information_gain = res.information_gain;
        (m as any).attention_capture = res.attention_capture;
        (m as any).harm = res.harm;
        (m as any).final_score = Number(((res.information_gain * 5.0) + (res.attention_capture * 2.0) - (res.harm * 4.0)).toFixed(2));
      }
    } catch (e) {
      // ignore
    }
    // Phase 1: Viral score (independent signal, not modifying frozen evaluator)
    try {
      const t = (m as any).transcriptExcerpt || "";
      if (t.length > 10) {
        const { computeViralScore } = require("./viral-moment-detector");
        const viral = computeViralScore(t);
        (m as any).viral_score = viral.viral_score;
        (m as any).hook_strength = viral.components.hookStrength;
        (m as any).surprise_level = viral.components.surpriseLevel;
        (m as any).novelty_score = viral.components.noveltyScore;
        (m as any).emotional_intensity = viral.components.emotionalIntensity;
        (m as any).audience_relevance = viral.components.audienceRelevance;
      }
    } catch (_) {}
  }

  const deduped = removeDuplicateMoments(combinedMoments);
  return {
    moments: deduped,
    model: TARGET_MODEL,
    rawResponse: combinedRawResponse,
  };
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
  // OpenRouter owl-alpha fallback (last resort)
  if (model === 'openrouter/owl-alpha') {
    try {
      const result = await callOwlAlpha(system, user, {
        temperature: 0.2,
        maxTokens: 4000,
        responseFormat: 'json_object',
      });
      console.log(`[LLM] OpenRouter owl-alpha success`);
      return result.text;
    } catch (err: any) {
      console.error(`[LLM] OpenRouter owl-alpha failed: ${err.message}`);
      throw new Error(`OpenRouter fallback failed: ${err.message}`);
    }
  }

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
        max_tokens: 32768,
      }),
      signal: AbortSignal.timeout(500_000),
    });
    console.log(`[LLM] response received | model=${model} status=${response.status}`);

    if (!response.ok) {
      const errBody = await response.text().catch(() => 'unknown');
      if (response.status >= 500) {
        throw new Error(
          `HTTP ${response.status}: ${errBody.slice(0, 200)}`,
        );
      }
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

    const finishReason = data?.choices?.[0]?.finish_reason;
    if (finishReason && finishReason !== 'stop' && finishReason !== 'length') {
      throw new Error(
        `LLM finished with reason: ${finishReason} (expected 'stop')`,
      );
    }
    if (finishReason === 'length') {
      console.log(`[LLM] WARNING: finish_reason='length' — response truncated. model=${model} max_tokens=32768`);
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

function validateMoments(
  items: unknown[],
  durationSeconds: number,
): RawMoment[] {
  const valid: RawMoment[] = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i] as Record<string, unknown> | null;
    if (!item || typeof item !== 'object') continue;

    const startTime = coerceNumber(item.startTime);
    let endTime = coerceNumber(item.endTime);
    const score = coerceNumber(item.worthClippingScore);
    let confidence = String(item.confidence ?? '').toLowerCase();
    const dnaTags = item.dnaTags;
    let reasoning = String(item.reasoning ?? '').trim();

    // 1. Start time is a valid number within video duration
    if (startTime === null || startTime < 0 || startTime >= durationSeconds) continue;

    // 2. End time is a valid number, after start, within video
    if (endTime === null || endTime <= startTime || endTime > durationSeconds) continue;

    // 3. Clip duration is between 8 and 120 seconds
    const clipDuration = endTime - startTime;
    if (clipDuration < 8) continue;
    if (clipDuration > 120) {
      endTime = startTime + 120;
      console.log(`[VALIDATION] Clipped duration from ${clipDuration.toFixed(1)}s to 120s`);
    }

    // 4. Score is 0-100
    if (score === null || score < MIN_SCORE || score > MAX_SCORE) continue;

    // 5. Confidence is a valid level (with soft mapping)
    {
      const CONFIDENCE_SYNONYMS: Record<string, string> = {
        'very high': 'high', 'very_high': 'high', 'strong': 'high', 'very high confidence': 'high',
        'moderate': 'medium', 'mid': 'medium', 'average': 'medium', 'medium confidence': 'medium',
        'very low': 'low', 'very_low': 'low', 'weak': 'low', 'poor': 'low', 'none': 'low',
        'extremely high': 'high', 'extremely low': 'low',
      };
      const mapped = CONFIDENCE_SYNONYMS[confidence];
      if (mapped) confidence = mapped;
    }
    if (!VALID_CONFIDENCE.has(confidence)) {
      confidence = 'medium';
      console.log(`[VALIDATION] Defaulted unrecognized confidence to 'medium'`);
    }

    // 6. DNA tags — valid array of 1-3 valid tags
    const tags = validateDnaTags(dnaTags);
    if (tags.length === 0) continue;

    // 7. Reasoning is non-empty (provide fallback if missing)
    if (reasoning.length === 0) {
      const tagsStr = tags.map(t => t.toString()).join(', ');
      reasoning = `Clip scored ${typeof score === 'number' ? score : 'N/A'} with DNA tags: ${tagsStr}`;
      console.log(`[VALIDATION] Generated fallback reasoning`);
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

// ---------------------------------------------------------------------------
// Field Validators
// ---------------------------------------------------------------------------

function coerceNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
    const tsMatch = value.match(/^(\d+):(\d{2})(?::(\d{2}))?$/);
    if (tsMatch) {
      if (tsMatch[3]) {
        return parseInt(tsMatch[1]) * 3600 + parseInt(tsMatch[2]) * 60 + parseInt(tsMatch[3]);
      }
      return parseInt(tsMatch[1]) * 60 + parseInt(tsMatch[2]);
    }
  }
  return null;
}

const TAG_SYNONYMS: Record<string, string> = {
  'funny': 'humor', 'comedy': 'humor', 'comedic': 'humor', 'hilarious': 'humor', 'lol': 'humor', 'lmao': 'humor',
  'real_talk': 'relatability', 'relatable': 'relatability', 'authentic': 'relatability', 'real': 'relatability', 'down_to_earth': 'relatability',
  'dramatic': 'emotion', 'emotional': 'emotion', 'feelings': 'emotion', 'passionate': 'emotion', 'heartfelt': 'emotion',
  'shocking': 'shock', 'surprised': 'shock', 'surprising': 'shock', 'unexpected': 'shock', 'jaw_dropping': 'shock',
  'story': 'storytelling', 'narrative': 'storytelling', 'tale': 'storytelling', 'anecdote': 'storytelling', 'personal_story': 'storytelling',
  'debate': 'controversy', 'argument': 'controversy', 'controversial': 'controversy', 'disagreement': 'controversy', 'conflict': 'controversy',
  'expert': 'authority', 'credibility': 'authority', 'expertise': 'authority', 'professional': 'authority', 'specialist': 'authority',
  'financial': 'money', 'wealth': 'money', 'income': 'money', 'business': 'money', 'entrepreneur': 'money', 'salary': 'money', 'investing': 'money',
  'motivational': 'motivation', 'inspiring': 'inspiration', 'inspirational': 'inspiration', 'uplifting': 'inspiration', 'encouraging': 'motivation',
  'curious': 'curiosity', 'intriguing': 'curiosity', 'interesting': 'curiosity', 'fascinating': 'curiosity', 'makes_you_think': 'curiosity',
  'learning': 'educational', 'informative': 'educational', 'knowledge': 'educational', 'insightful': 'educational',
  'hook': 'hookPower', 'attention': 'hookPower', 'grabbing': 'hookPower', 'opening': 'hookPower', 'attention_grabbing': 'hookPower',
  'raw': 'vulnerability', 'honest': 'vulnerability', 'confession': 'vulnerability', 'deep': 'vulnerability', 'candid': 'vulnerability',
  'vulnerable': 'vulnerability',
  'hookPower': 'hookPower', 'hookpower': 'hookPower',
  'curiosity': 'curiosity',
  'controversy': 'controversy',
  'emotion': 'emotion',
  'humor': 'humor',
  'storytelling': 'storytelling',
  'authority': 'authority',
  'money': 'money',
  'shock': 'shock',
  'educational': 'educational',
  'motivation': 'motivation',
  'relatability': 'relatability',
  'vulnerability': 'vulnerability',
  'inspiration': 'inspiration',
};

function validateDnaTags(value: unknown): DnaTag[] {
  if (!Array.isArray(value)) return [];

  const tags: DnaTag[] = [];
  for (const tag of value) {
    let strTag = String(tag).trim();

    // 1. Try direct exact match first
    if (VALID_DNA_TAGS.has(strTag)) {
      if (!tags.includes(strTag as DnaTag)) {
        tags.push(strTag as DnaTag);
      }
    }
    // 2. Try lowercase match (LLM uses camelCase inconsistently)
    else if (VALID_DNA_TAGS.has(strTag.charAt(0).toLowerCase() + strTag.slice(1))) {
      const corrected = strTag.charAt(0).toLowerCase() + strTag.slice(1) as DnaTag;
      if (!tags.includes(corrected)) tags.push(corrected);
    }
    // 3. Try synonym map
    else {
      const lower = strTag.toLowerCase();
      const mapped = TAG_SYNONYMS[lower];
      if (mapped) {
        const mappedTag = mapped as DnaTag;
        if (!tags.includes(mappedTag)) tags.push(mappedTag);
      }
    }

    if (tags.length >= 3) break;
  }

  return tags;
}

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export { PROMPT_VERSION_V2C as PROMPT_VERSION, TARGET_MODEL };

// ---------------------------------------------------------------------------
// Forensic helpers
// ---------------------------------------------------------------------------

/** Count total signal instances across all candidates (for forensic analysis). */
function countBySignal(candidates: Array<{ signals: string[] }>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const c of candidates) {
    for (const s of c.signals) {
      counts[s] = (counts[s] ?? 0) + 1;
    }
  }
  return counts;
}
