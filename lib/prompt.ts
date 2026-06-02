/**
 * ganyIQ analysis prompt template.
 *
 * Reuses the proven worth-clipping logic from proof/src/index.ts.
 * Preserves the Viral DNA framework and Indonesian creator context.
 *
 * OUTPUT CONTRACT: RawMoment[] (flat array, NOT grouped by elite/secondary).
 * Tier assignment is done deterministically in lib/ranking.ts.
 */

import { formatTranscriptForPrompt } from '@/lib/youtube';
import type { VideoMetadata, TranscriptSegment } from '@/lib/types';

// ---------------------------------------------------------------------------
// System Prompt
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
// Analysis Task Prompt
// ---------------------------------------------------------------------------

/**
 * The core analysis task injected as the user message.
 *
 * Key design decisions (compared to proof):
 *   1. Output is a flat JSON array `Moment[]` — NO elite_moments / secondary_moments
 *      grouping. The LLM's ONLY job is to find and score moments. Tier
 *      assignment (elite / secondary) is handled deterministically by the
 *      ranking module (lib/ranking.ts).
 *   2. The LLM returns ALL moments it identifies as worthy (up to 20). No
 *      hard cap at 5 elite + 10 secondary — the LLM focuses purely on quality
 *      detection. Deterministic ranking handles ordering and deduplication.
 *   3. No overall "reasoning" or "confidence" arrays — those were metadata
 *      that belong in the analysis record, not in the prompt output.
 *   4. Duration range tightened to 15-90 seconds (per MVP LOCK), aligning
 *      with professional short-form content standards.
 */
const ANALYSIS_TASK = `

TASK:
Analyze the podcast transcript below and identify the moments worth clipping into short-form content.

For each moment you identify, provide:
  1. startTime (seconds) — when the moment begins
  2. endTime (seconds) — when the moment ends
  3. worthClippingScore (0-100) — be harsh. Only the very best moments should score above 85.
  4. confidence ("high", "medium", or "low") — how confident you are that this moment will perform well
  5. dnaTags (array of exactly 3 strings) — pick the top 3 that best describe this moment's viral DNA, from: hookPower, curiosity, controversy, emotion, humor, storytelling, authority, money, shock, educational, motivation, relatability
  6. reasoning (1-2 sentences) — explain in English why this moment is worth clipping. Speak like a clipper, not a professor. Be specific about what makes this moment work.

RULES:
  1. Standalone value — each moment must make sense to someone who hasn't watched the full video. No inside jokes, no multi-episode context.
  2. Hook-first — the first 3 seconds of the clip must grab attention. If the moment has a slow start, score it lower.
  3. Duration — each moment must be between 15 and 90 seconds long.
  4. Be honest — if the transcript only has 3 good moments, return 3 moments. Do NOT pad to meet a count.
  5. Text-only — score only what is visible in the transcript. Do not imagine tone, delivery, facial expressions, or audience reaction.
  6. Indonesian audience — consider what resonates with Indonesian viewers: controversy, money topics, relatable humor, emotional stories, and authority figures perform well on Indonesian TikTok/Reels/Shorts.
  7. Timestamps must exist within the video duration. Do not invent timestamps beyond the transcript range.
  8. Sort your output by worthClippingScore descending (highest score first).

OUTPUT FORMAT:
Return ONLY a valid JSON array. No markdown, no code fences, no extra text.

[
  {
    "startTime": number,
    "endTime": number,
    "worthClippingScore": number,
    "confidence": "high" | "medium" | "low",
    "dnaTags": ["tag1", "tag2", "tag3"],
    "reasoning": "1-2 sentence explanation"
  }
]

The array should contain between 3 and 20 moments.
If you identify fewer than 3 moments worth clipping, still return them.
Do NOT include any text outside the JSON array — no summary, no explanations, no notes.`;

// ---------------------------------------------------------------------------
// Prompt Builder
// ---------------------------------------------------------------------------

/**
 * Build the complete prompt payload for a Gemini LLM call.
 *
 * @param metadata - Video metadata (title, channel, duration)
 * @param transcript - Parsed transcript segments
 * @returns An object with `system` and `user` strings for the LLM API.
 */
export function buildAnalysisPrompt(
  metadata: VideoMetadata,
  transcript: TranscriptSegment[],
): { system: string; user: string } {
  const transcriptText = formatTranscriptForPrompt(transcript);

  const userMessage =
    `${ANALYSIS_TASK}\n` +
    `\n` +
    `VIDEO:\n` +
    `Title: ${metadata.title}\n` +
    `Channel: ${metadata.channelName}\n` +
    `Duration: ${Math.round(metadata.durationSeconds / 60)} minutes\n` +
    `\n` +
    `TRANSCRIPT:\n` +
    `${transcriptText}`;

  return {
    system: SYSTEM_PROMPT,
    user: userMessage,
  };
}

// ---------------------------------------------------------------------------
// Prompt Version Tracking
// ---------------------------------------------------------------------------

/**
 * Current prompt version identifier.
 * Stored alongside each analysis in the database for traceability.
 * Increment this when making prompt changes that affect output quality,
 * so we can A/B test and debug by comparing prompt versions.
 */
export const PROMPT_VERSION = 'mvp-v1';

/**
 * The LLM model this prompt is designed for.
 * DeepSeek V4 Flash via OpenCode Go API — fast inference, proven in proof.
 * 1M+ token context window, low cost, Indonesian content optimized.
 */
export const TARGET_MODEL = 'deepseek-v4-flash';
