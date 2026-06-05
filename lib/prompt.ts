/**
 * ganyIQ analysis prompt template.
 *
 * TWO MODES:
 *   1. buildAnalysisPrompt() — LEGACY: full transcript → LLM (pre-V2, broken on long videos)
 *   2. buildCandidateScoringPrompt() — V2: per-candidate scoring (current)
 *
 * V2 Pipeline:
 *   Candidate Extraction (deterministic) → CandidateWindow[]
 *   → LLM scores EACH candidate (small prompt, ~300 tokens)
 *   → RawMoment[] → ranking → output
 *
 * OUTPUT CONTRACT: RawMoment[] (flat array, NOT grouped by elite/secondary).
 * Tier assignment is done deterministically in lib/ranking.ts.
 */

import type { VideoMetadata, TranscriptSegment } from '@/lib/types';
import type { CandidateWindow } from '@/lib/candidate-extraction';

// ---------------------------------------------------------------------------
// System Prompt (shared)
// ---------------------------------------------------------------------------

/**
 * System-level instruction that defines the LLM's role and context.
 */
const SYSTEM_PROMPT =
  'You are a professional short-form content clipper in Indonesia. ' +
  'Your income depends entirely on views. ' +
  'You have 3+ years of experience clipping Indonesian podcast content ' +
  'for TikTok, Instagram Reels, and YouTube Shorts. ' +
  'You spot viral moments faster than any algorithm.';

// ---------------------------------------------------------------------------
// V2: Per-Candidate Scoring Prompt
// ---------------------------------------------------------------------------

/**
 * Build a prompt to score a SINGLE candidate window.
 *
 * This is the V2 approach: instead of sending the full transcript to the LLM,
 * we send one pre-extracted candidate at a time. Each prompt is ~300 tokens
 * instead of ~20,000 tokens.
 *
 * @param metadata - Video metadata
 * @param candidate - A single candidate window from the extraction stage
 * @returns An object with `system` and `user` strings for the LLM API.
 */
export function buildCandidateScoringPrompt(
  metadata: VideoMetadata,
  candidate: CandidateWindow,
): { system: string; user: string } {
  const startMin = Math.floor(candidate.startSeconds / 60);
  const startSec = Math.floor(candidate.startSeconds % 60);
  const endMin = Math.floor(candidate.endSeconds / 60);
  const endSec = Math.floor(candidate.endSeconds % 60);
  const ts = `${startMin}:${String(startSec).padStart(2, '0')} - ${endMin}:${String(endSec).padStart(2, '0')}`;

  const userMessage =
    `TASK:\n` +
    `Score the following candidate clip from a podcast for viral potential.\n` +
    `\n` +
    `VIDEO:\n` +
    `Title: ${metadata.title}\n` +
    `Channel: ${metadata.channelName}\n` +
    `Duration: ${Math.round(metadata.durationSeconds / 60)} minutes\n` +
    `\n` +
    `CANDIDATE CLIP (${ts}, ${Math.round(candidate.durationSeconds)}s):\n` +
    `"${candidate.text}"\n` +
    `\n` +
    `SIGNALS DETECTED IN THIS CLIP: ${candidate.signals.join(', ')}\n` +
    `\n` +
    `Rate this candidate on viral potential for Indonesian short-form content (TikTok, Reels, Shorts).\n` +
    `\n` +
    `Provide:\n` +
    `  1. worthClippingScore (0-100) — be harsh. Only truly viral moments should score above 85.\n` +
    `  2. confidence ("high", "medium", or "low")\n` +
    `  3. dnaTags (array of 1-3 strings) — from: hookPower, curiosity, controversy, emotion, humor, storytelling, authority, money, shock, educational, motivation, relatability, vulnerability, inspiration\n` +
    `  4. reasoning (1-2 sentences) — explain why this clip would or wouldn't perform well\n` +
    `\n` +
    `RULES:\n` +
    `  - The clip must stand alone — a viewer should understand it without watching the full video\n` +
    `  - Hook-first: the first 3 seconds must grab attention\n` +
    `  - Score based ONLY on the transcript text provided\n` +
    `  - Consider Indonesian audience preferences: controversy, money, emotion, humor, authority\n` +
    `\n` +
    `OUTPUT FORMAT:\n` +
    `Return ONLY a valid JSON object. No markdown, no code fences, no extra text.\n` +
    `\n` +
    `{\n` +
    `  "startTime": ${candidate.startSeconds},\n` +
    `  "endTime": ${candidate.endSeconds},\n` +
    `  "worthClippingScore": number,\n` +
    `  "confidence": "high" | "medium" | "low",\n` +
    `  "dnaTags": ["tag1", "tag2", "tag3"],\n` +
    `  "reasoning": "1-2 sentence explanation"\n` +
    `}`;

  return {
    system: SYSTEM_PROMPT,
    user: userMessage,
  };
}

// ---------------------------------------------------------------------------
// V2: Batch Candidate Scoring Prompt (all candidates in one call)
// ---------------------------------------------------------------------------

/**
 * Build a prompt to score ALL candidates in a SINGLE LLM call.
 *
 * This is the optimal V2 approach: one LLM call with all candidates,
 * each scored independently. Total prompt ~2000-4000 tokens (vs 20,000+ for full transcript).
 *
 * @param metadata - Video metadata
 * @param candidates - All candidate windows from the extraction stage
 * @returns An object with `system` and `user` strings for the LLM API.
 */
export function buildBatchCandidateScoringPrompt(
  metadata: VideoMetadata,
  candidates: CandidateWindow[],
): { system: string; user: string } {
  const candidateTexts = candidates.map((c, i) => {
    const startMin = Math.floor(c.startSeconds / 60);
    const startSec = Math.floor(c.startSeconds % 60);
    const endMin = Math.floor(c.endSeconds / 60);
    const endSec = Math.floor(c.endSeconds % 60);
    const ts = `${startMin}:${String(startSec).padStart(2, '0')} - ${endMin}:${String(endSec).padStart(2, '0')}`;
    return `CANDIDATE ${i + 1} (${ts}, ${Math.round(c.durationSeconds)}s):\n"${c.text}"\nSignals: ${c.signals.join(', ')}\nstartTime: ${c.startSeconds}\nendTime: ${c.endSeconds}`;
  }).join('\n---\n\n');

  const userMessage =
    `TASK:\n` +
    `Score each of the following ${candidates.length} candidate clips from a podcast for viral potential.\n` +
    `These candidates were pre-extracted using text signal analysis.\n` +
    `\n` +
    `VIDEO:\n` +
    `Title: ${metadata.title}\n` +
    `Channel: ${metadata.channelName}\n` +
    `Duration: ${Math.round(metadata.durationSeconds / 60)} minutes\n` +
    `\n` +
    `CANDIDATES:\n` +
    `${candidateTexts}\n` +
    `\n` +
    `For EACH candidate, provide:\n` +
    `  1. candidateIndex (1-based, matching the input)\n` +
    `  2. startTime (number) — MUST be the start time in SECONDS as a plain number (e.g., 1690), NOT a timestamp string\n` +
    `  3. endTime (number) — MUST be the end time in SECONDS as a plain number (e.g., 1752), NOT a timestamp string\n` +
    `  4. worthClippingScore (0-100) — be harsh. Only truly viral moments should score above 85.\n` +
    `  5. confidence ("high", "medium", or "low")\n` +
    `  6. dnaTags (array of 1-3 strings) — from: hookPower, curiosity, controversy, emotion, humor, storytelling, authority, money, shock, educational, motivation, relatability, vulnerability, inspiration\n` +
    `  7. reasoning (1-2 sentences) — explain why this clip would or wouldn't perform well\n` +
    `\n` +
    `RULES:\n` +
    `  - Each clip must stand alone — a viewer should understand it without watching the full video\n` +
    `  - Hook-first: the first 3 seconds must grab attention\n` +
    `  - Score based ONLY on the transcript text provided\n` +
    `  - Consider Indonesian audience preferences: controversy, money, emotion, humor, authority\n` +
    `  - Be honest: if a candidate is not clip-worthy, give it a low score (below 40)\n` +
    `  - startTime and endTime MUST be numbers (seconds), not strings. Example: 1690, not "28:10"\n` +
    `\n` +
    `OUTPUT FORMAT:\n` +
    `Return ONLY a valid JSON array. No markdown, no code fences, no extra text.\n` +
    `\n` +
    `[\n` +
    `  {\n` +
    `    "candidateIndex": number,\n` +
    `    "startTime": number,\n` +
    `    "endTime": number,\n` +
    `    "worthClippingScore": number,\n` +
    `    "confidence": "high" | "medium" | "low",\n` +
    `    "dnaTags": ["tag1", "tag2", "tag3"],\n` +
    `    "reasoning": "1-2 sentence explanation"\n` +
    `  }\n` +
    `]`;

  return {
    system: SYSTEM_PROMPT,
    user: userMessage,
  };
}

// ---------------------------------------------------------------------------
// V2-Compact: Production-Ready Prompt (evidence-based, Q4 2026)
// ---------------------------------------------------------------------------

/**
 * V2-Compact system prompt — professional clipper persona, no drama.
 * Reverted from "brutally honest" to "viral-focused" to fix dnaTag compliance.
 */
const SYSTEM_PROMPT_V2C =
  'You are a professional short-form content clipper in Indonesia. ' +
  'Your income depends entirely on views. ' +
  'You have 3+ years of experience. ' +
  'Your job: score podcast clips for viral potential.';

/**
 * Build a V2-Compact batch scoring prompt.
 *
 * Design principles:
 *   - Shorter than V1 to avoid DeepSeek reasoning token explosion
 *   - Strict dnaTag enum to eliminate soft failures
 *   - Compressed tier + confidence instructions
 *   - Anti-hallucination guardrail
 *   - No few-shot examples (proven unnecessary in forensic audit)
 *
 * @param metadata   - Video metadata
 * @param candidates - Candidate windows from extraction stage
 * @returns System and user prompt strings
 */
export function buildV2CompactPrompt(
  metadata: VideoMetadata,
  candidates: CandidateWindow[],
): { system: string; user: string } {
  const candidateTexts = candidates.map((c, i) => {
    const ts = `${Math.floor(c.startSeconds / 60)}:${String(Math.floor(c.startSeconds % 60)).padStart(2, '0')} - ${Math.floor(c.endSeconds / 60)}:${String(Math.floor(c.endSeconds % 60)).padStart(2, '0')}`;
    return `CANDIDATE ${i + 1} (${ts}, ${Math.round(c.durationSeconds)}s):"${c.text}" startTime:${c.startSeconds} endTime:${c.endSeconds}`;
  }).join('\n---\n');

  const userMessage =
    `TASK: Score each of the following ${candidates.length} candidate clips. Score each independently — this is NOT a ranking task.\n` +
    `\n` +
    `VIDEO: ${metadata.title} by ${metadata.channelName}, ${Math.round(metadata.durationSeconds / 60)} min\n` +
    `\n` +
    `CANDIDATES:\n${candidateTexts}\n` +
    `\n` +
    `SCORING:\n` +
    `  85-100 ELITE (rare — max 1-2 per batch) | 70-84 STRONG | 50-69 MODERATE | 0-49 REJECT (expect 3-5 per batch)\n` +
    `\n` +
    `CONFIDENCE: high=clear hook, standalone | medium=ambiguous | low=fragmented or very weak\n` +
    `\n` +
    `DNA TAGS — ONLY use values from this exact list:\n` +
    `  hookPower, curiosity, controversy, emotion, humor, storytelling,\n` +
    `  authority, money, shock, educational, motivation, relatability,\n` +
    `  vulnerability, inspiration\n` +
    `  DO NOT invent your own tags. Choose 1-3 from the list above.\n` +
    `\n` +
    `RULES:\n` +
    `  - Base score ONLY on transcript text. Do not imagine tone, delivery, or expressions.\n` +
    `  - Hook-first: first 3 seconds must grab attention.\n` +
    `  - If content is generic or fragmented, score REJECT (< 50).\n` +
    `\n` +
    `OUTPUT: Valid JSON array only. No markdown.\n` +
    `[\n` +
    `  {\n` +
    `    "candidateIndex": number,\n` +
    `    "startTime": number,\n` +
    `    "endTime": number,\n` +
    `    "worthClippingScore": number,\n` +
    `    "confidence": "high" | "medium" | "low",\n` +
    `    "dnaTags": ["tag1", "tag2"],\n` +
    `    "reasoning": "1 sentence"\n` +
    `  }\n` +
    `]`;

  return { system: SYSTEM_PROMPT_V2C, user: userMessage };
}

/** Prompt version identifier for V2-Compact. */
export const PROMPT_VERSION_V2C = 'v2-compact';

// ---------------------------------------------------------------------------
// Prompt Version Tracking (legacy)
// ---------------------------------------------------------------------------

/**
 * Current prompt version identifier.
 * Stored alongside each analysis in the database for traceability.
 */
export const PROMPT_VERSION = 'v2-candidate-scoring';

/**
 * The LLM model this prompt is designed for.
 * DeepSeek V4 Flash via OpenCode Go API.
 */
export const TARGET_MODEL = 'deepseek-v4-flash';

/**
 * Fallback model priority order — only OpenCode Go models.
 * No new providers, API keys, or SDKs needed.
 */
export const MODELS: readonly string[] = [
  'deepseek-v4-flash',  // PRIMARY
  'mimo-v2.5',          // FALLBACK #1
  'qwen3.7-plus',       // FALLBACK #2
];
