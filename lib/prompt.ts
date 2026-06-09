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
    // Add speaker context if available (Phase 3B)
    const speakerInfo = c.speakers && c.speakers.length > 0
      ? ` Speakers: ${c.speakers.join(', ')} | Changes: ${c.speakerChangeCount ?? 0}`
      : '';
    return `CANDIDATE ${i + 1} (${ts}, ${Math.round(c.durationSeconds)}s):"${c.text}"${speakerInfo} startTime:${c.startSeconds} endTime:${c.endSeconds}`;
  }).join('\n---\n');

  const userMessage =
    `TASK: Score each of the following ${candidates.length} candidate clips. Score each independently — this is NOT a ranking task.\n` +
    `\n` +
    `VIDEO: ${metadata.title} by ${metadata.channelName}, ${Math.round(metadata.durationSeconds / 60)} min\n` +
    `\n` +
    `CANDIDATES:\n${candidateTexts}\n` +
    `\n` +
    `SCORING:\n` +
    `  85-100 ELITE | 70-84 STRONG | 50-69 MODERATE | 0-49 LOW\n` +
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
    `  - If content is generic or fragmented, score LOW (< 50).\n` +
    `  - Timestamps: Echo back the EXACT startTime and endTime values provided for each candidate.\n` +
    `    Do NOT modify, recalculate, or convert these values.\n` +
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

/** Prompt version identifier for V2-Enhanced. */
export const PROMPT_VERSION_V2E = 'v2-enhanced';

/**
 * Prompt mode selector — switch between v2-compact and v2-enhanced.
 * Set PROMPT_MODE=enhanced in .env.local to use the new prompt.
 * Defaults to compact for backward compatibility.
 */
const USE_ENHANCED_PROMPT = process.env.PROMPT_MODE === 'enhanced';

/**
 * Select the active prompt builder based on configuration.
 * This enables A/B testing without code changes.
 */
export function buildActivePrompt(
  metadata: VideoMetadata,
  candidates: CandidateWindow[],
): { system: string; user: string; version: string } {
  if (USE_ENHANCED_PROMPT) {
    const p = buildV2EnhancedPrompt(metadata, candidates);
    return { ...p, version: PROMPT_VERSION_V2E };
  }
  const p = buildV2CompactPrompt(metadata, candidates);
  return { ...p, version: PROMPT_VERSION_V2C };
}

// ---------------------------------------------------------------------------
// V2-Enhanced: Production-Ready Prompt (Q2 2026)
// ---------------------------------------------------------------------------

/**
 * V2-Enhanced system prompt — comprehensive clipper persona with genre awareness.
 * Longer than V2-Compact to provide more context for better scoring calibration.
 */
const SYSTEM_PROMPT_V2E =
  'You are an elite short-form content editor with 5 years of experience creating viral clips from podcasts, interviews, and educational content for TikTok, Instagram Reels, and YouTube Shorts. You specialize in Indonesian content but understand global viral mechanics.\n\n' +
  'Your expertise:\n' +
  '- Controversy, raw emotion, money stories, and unexpected revelations drive the most views\n' +
  '- Educational "aha moments" and clear how-to segments have massive replay value\n' +
  '- Humor, even subtle humor, is the #1 driver of shares\n' +
  '- Storytelling arcs (setup → tension → payoff) keep viewers watching\n' +
  '- Hot takes and contrarian opinions drive comments and engagement\n' +
  '- Personal vulnerability creates deep connection with viewers\n' +
  '- Speaker dynamics (disagreement, debate, interruptions) create engagement\n' +
  '- Rapid back-and-forth between speakers signals high-energy conversation\n\n' +
  'Your job: evaluate pre-extracted candidate clips and score EACH for viral potential. Score GENEROUSLY — your goal is to find every possible clip that could work, not to eliminate candidates.';

/**
 * Build a V2-Enhanced batch scoring prompt with few-shot examples.
 *
 * Key improvements over V2-Compact:
 *   - Longer, more detailed system prompt with genre context
 *   - Few-shot examples for format compliance
 *   - Content-type aware scoring guidance
 *   - "Score generously" philosophy (not elimination-focused)
 *   - Timestamp echo enforcement
 *   - Better anti-hallucination with candidate-index-based fallback
 *
 * @param metadata   - Video metadata
 * @param candidates - Candidate windows from extraction stage
 * @returns System and user prompt strings
 */
export function buildV2EnhancedPrompt(
  metadata: VideoMetadata,
  candidates: CandidateWindow[],
): { system: string; user: string } {
  const candidateTexts = candidates.map((c, i) => {
    const ts = `${Math.floor(c.startSeconds / 60)}:${String(Math.floor(c.startSeconds % 60)).padStart(2, '0')} - ${Math.floor(c.endSeconds / 60)}:${String(Math.floor(c.endSeconds % 60)).padStart(2, '0')}`;
    // Add speaker context if available (Phase 3B)
    const speakerInfo = c.speakers && c.speakers.length > 0
      ? ` speakers:${c.speakers.join(',')} exchanges:${c.speakerChangeCount ?? 0}`
      : '';
    return `CANDIDATE ${i + 1} (${ts}, ${Math.round(c.durationSeconds)}s):"${c.text}"${speakerInfo} startTime:${c.startSeconds} endTime:${c.endSeconds} signals:${c.signals.join(',')}`;
  }).join('\n---\n');

  const userMessage =
    `TASK: Score each of the ${candidates.length} candidate clips below. Score each independently — this is NOT a ranking task.\n` +
    `\n` +
    `VIDEO: "${metadata.title}" by ${metadata.channelName}, ${Math.round(metadata.durationSeconds / 60)} min\n` +
    `\n` +
    `CANDIDATES:\n${candidateTexts}\n` +
    `\n` +
    `SCORING GUIDE:\n` +
    `  90-100: VIRAL LOCK — would bet money this goes viral (rare, 0-2 per video)\n` +
    `  75-89:  STRONG — high confidence this performs well (expect 3-6 per batch)\n` +
    `  60-74:  SOLID — worth clipping, good content (expect 3-5 per batch)\n` +
    `  40-59:  BORDERLINE — might work with good editing (expect 2-4 per batch)\n` +
    `  0-39:   SKIP — not clip-worthy\n` +
    `\n` +
    `CONFIDENCE:\n` +
    `  high:   Clear hook, standalone, strong viral signals\n` +
    `  medium: Ambiguous hook, needs context to understand\n` +
    `  low:    Fragmented, very weak signals, or incomplete thought\n` +
    `\n` +
    `DNA TAGS — Choose 1-3 from this EXACT list only (do NOT invent your own):\n` +
    `  hookPower, curiosity, controversy, emotion, humor, storytelling,\n` +
    `  authority, money, shock, educational, motivation, relatability,\n` +
    `  vulnerability, inspiration\n` +
    `\n` +
    `WHAT MAKES A GREAT CLIP:\n` +
    `  - Strong hook in first 3 seconds (question, bold claim, emotional statement)\n` +
    `  - Self-contained — viewer understands without full video context\n` +
    `  - Emotional resonance (surprise, laughter, relatability, inspiration)\n` +
    `  - Knowledge value (teaches something, reveals something)\n` +
    `  - Conversation starter (viewers will comment and debate)\n` +
    `\n` +
    `RULES:\n` +
    `  1. Base score on transcript text AND likely delivery/energy. If the text has strong emotional words, it will likely be delivered with energy.\n` +
    `  2. Hook-first: first 3 seconds must grab attention.\n` +
    `  3. Echo back the EXACT startTime and endTime values provided for each candidate. Do NOT modify these numbers.\n` +
    `  4. confidence must be exactly one of: "high", "medium", "low"\n` +
    `  5. reasoning must be 1-2 sentences explaining why this clip would/wouldn't perform\n` +
    `  6. Score GENEROUSLY — find reasons clips COULD work, not reasons they can't\n` +
    `  7. If content is truly generic or fragmented, score SKIP (< 40)\n` +
    `\n` +
    `OUTPUT: Valid JSON array only. No markdown, no code fences, no extra text.\n` +
    `[\n` +
    `  {\n` +
    `    "candidateIndex": number,\n` +
    `    "startTime": number,\n` +
    `    "endTime": number,\n` +
    `    "worthClippingScore": number,\n` +
    `    "confidence": "high" | "medium" | "low",\n` +
    `    "dnaTags": ["tag1", "tag2"],\n` +
    `    "reasoning": "1-2 sentence explanation"\n` +
    `  }\n` +
    `]\n` +
    `\n` +
    `--- EXAMPLE (for format reference only) ---\n` +
    `Input candidate: CANDIDATE 1 (12:00 - 12:50, 50s):"gini dong gua baru tahu bahwa kalau main di sana makanan dan minuman rokok semua gratis" startTime:720 endTime:770 signals:surprise,money\n` +
    `Output:\n` +
    `[\n` +
    `  {\n` +
    `    "candidateIndex": 1,\n` +
    `    "startTime": 720,\n` +
    `    "endTime": 770,\n` +
    `    "worthClippingScore": 82,\n` +
    `    "confidence": "high",\n` +
    `    "dnaTags": ["surprise", "money", "curiosity"],\n` +
    `    "reasoning": "Reveals a surprising fact about free food and drinks in a casino-like setting, instantly sparks curiosity and has strong shock value."\n` +
    `  }\n` +
    `]`;

  return { system: SYSTEM_PROMPT_V2E, user: userMessage };
}

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

// ---------------------------------------------------------------------------
// Phase 4A: Specialized Discovery Pass Prompts
// ---------------------------------------------------------------------------

/**
 * Phase 4B: Build a specialized prompt for hook/attention-grabbing discovery.
 * Compact format with explicit JSON output instruction.
 */
export function buildHookPrompt(
  candidates: CandidateWindow[],
  title: string,
): { system: string; user: string } {
  const system = 'You rate hook strength. A great hook grabs attention in the first 3 seconds. Output valid JSON only.';
  const candTexts = candidates.map((c, i) =>
    `CANDIDATE ${i + 1}: "${c.text.slice(0, 300)}" startTime:${c.startSeconds} endTime:${c.endSeconds}`
  ).join('\n---\n');
  const user = `TASK: Rate hook strength for each candidate.\nVIDEO: ${title}\n\nCANDIDATES:\n${candTexts}\n\nHOOK SCORING:\n  85+: Hook (grabs attention in first 3 seconds)\n  70-84: Strong hook\n  50-69: OK hook\n  0-49: Weak/no hook\n\nDNA TAGS for hooks ONLY: hookPower, curiosity, shock\nOUTPUT: Valid JSON array. [{"startTime":n,"endTime":n,"worthClippingScore":n,"confidence":"high"|"medium"|"low","dnaTags":["tag"],"reasoning":"1 sentence"}]`;
  return { system, user };
}

/**
 * Build a specialized prompt for storytelling/narrative discovery.
 */
export function buildStorytellingPrompt(
  candidates: CandidateWindow[],
  title: string,
): { system: string; user: string } {
  const system = 'You are a storytelling analyst. Your only job: rate how compelling a clip\u2019s narrative arc is. Great storytelling has setup, tension/conflict, and payoff/revelation.';
  const candTexts = candidates.map((c, i) =>
    `CANDIDATE ${i + 1}: "${c.text.slice(0, 300)}" startTime:${c.startSeconds} endTime:${c.endSeconds}`
  ).join('\n---\n');
  const user = `TASK: Rate storytelling quality for each candidate.\nVIDEO: ${title}\n\nCANDIDATES:\n${candTexts}\n\nSTORYTELLING SCORING:\n  85+: Complete narrative arc (setup\u2192tension\u2192payoff)\n  70-84: Clear story, strong emotional or comedic beat\n  50-69: Interesting anecdote, somewhat fragmented\n  0-49: No narrative structure\n\nDNA TAGS for stories ONLY: storytelling, relatability, vulnerability\nOUTPUT: Valid JSON array. [{"startTime":n,"endTime":n,"worthClippingScore":n,"confidence":"high"|"medium"|"low","dnaTags":["tag"],"reasoning":"1 sentence"}]`;
  return { system, user };
}

/**
 * Build a specialized prompt for educational/informative discovery.
 */
export function buildEducationalPrompt(
  candidates: CandidateWindow[],
  title: string,
): { system: string; user: string } {
  const system = 'You are a content educator. Your only job: rate how much educational or informative value a clip has. Great educational clips teach something useful, reveal surprising facts, or provide actionable advice.';
  const candTexts = candidates.map((c, i) =>
    `CANDIDATE ${i + 1}: "${c.text.slice(0, 300)}" startTime:${c.startSeconds} endTime:${c.endSeconds}`
  ).join('\n---\n');
  const user = `TASK: Rate educational value for each candidate.\nVIDEO: ${title}\n\nCANDIDATES:\n${candTexts}\n\nEDUCATIONAL SCORING:\n  85+: Teaches something significant, clear how-to or insight\n  70-84: Informative, interesting fact or perspective\n  50-69: Somewhat educational, mild takeaway\n  0-49: No educational value\n\nDNA TAGS for education ONLY: educational, authority, money, motivation\nOUTPUT: Valid JSON array. [{"startTime":n,"endTime":n,"worthClippingScore":n,"confidence":"high"|"medium"|"low","dnaTags":["tag"],"reasoning":"1 sentence"}]`;
  return { system, user };
}

/**
 * Build a specialized prompt for controversy/debate discovery.
 */
export function buildControversyPrompt(
  candidates: CandidateWindow[],
  title: string,
): { system: string; user: string } {
  const system = 'You are a debate analyst. Your only job: rate a clip\u2019s controversy and engagement potential. Controversial clips spark comments, debates, and disagreements. Hot takes, bold claims, and opposing viewpoints drive engagement.';
  const candTexts = candidates.map((c, i) =>
    `CANDIDATE ${i + 1}: "${c.text.slice(0, 300)}" startTime:${c.startSeconds} endTime:${c.endSeconds}`
  ).join('\n---\n');
  const user = `TASK: Rate controversy/debate potential for each candidate.\nVIDEO: ${title}\n\nCANDIDATES:\n${candTexts}\n\nCONTROVERSY SCORING:\n  85+: Heated debate, strong disagreement, polarizing take\n  70-84: Clear hot take or contrarian opinion\n  50-69: Mild disagreement or debate\n  0-49: No controversy\n\nDNA TAGS for controversy ONLY: controversy, emotion, shock\nOUTPUT: Valid JSON array. [{"startTime":n,"endTime":n,"worthClippingScore":n,"confidence":"high"|"medium"|"low","dnaTags":["tag"],"reasoning":"1 sentence"}]`;
  return { system, user };
}

/**
 * Build a specialized prompt for emotion/vulnerability discovery.
 */
export function buildEmotionPrompt(
  candidates: CandidateWindow[],
  title: string,
): { system: string; user: string } {
  const system = 'You are an emotional resonance analyst. Your only job: rate a clip\u2019s emotional impact. Great emotional clips create connection through vulnerability, raw honesty, inspiration, or relatable struggles.';
  const candTexts = candidates.map((c, i) =>
    `CANDIDATE ${i + 1}: "${c.text.slice(0, 300)}" startTime:${c.startSeconds} endTime:${c.endSeconds}`
  ).join('\n---\n');
  const user = `TASK: Rate emotional impact for each candidate.\nVIDEO: ${title}\n\nCANDIDATES:\n${candTexts}\n\nEMOTION SCORING:\n  85+: Deeply moving, vulnerable, or inspiring\n  70-84: Genuine emotional moment, relatable struggle\n  50-69: Mild emotional content\n  0-49: No emotional resonance\n\nDNA TAGS for emotion ONLY: emotion, vulnerability, inspiration, motivation, relatability\nOUTPUT: Valid JSON array. [{"startTime":n,"endTime":n,"worthClippingScore":n,"confidence":"high"|"medium"|"low","dnaTags":["tag"],"reasoning":"1 sentence"}]`;
  return { system, user };
}

/**
 * Combined multi-pass prompt — evaluates ALL 5 dimensions in a single call.
 * Replaces 5 separate pass prompts with one comprehensive evaluation.
 */
export function buildCombinedPassPrompt(
  candidates: CandidateWindow[],
  title: string,
): { system: string; user: string } {
  const system = `You are a multi-dimensional content analyst. Score each candidate across ALL 5 dimensions: HOOK (attention-grabbing), STORYTELLING (narrative arc), EDUCATIONAL (informative value), CONTROVERSY (debate potential), EMOTION (emotional impact). Return one array entry per candidate per dimension that scores ≥50.`;

  const candTexts = candidates.map((c, i) =>
    `CANDIDATE ${i + 1}: "${c.text.slice(0, 250)}" startTime:${c.startSeconds} endTime:${c.endSeconds}`
  ).join('\n---\n');
  const user = `TASK: Score each candidate on ALL 5 dimensions. Output one entry per dimension per candidate (score ≥50 only).
VIDEO: ${title}

CANDIDATES:
${candTexts}

DIMENSIONS:
1. HOOK: grabs attention → dnaTags: hookPower, curiosity, shock
2. STORYTELLING: has narrative arc → dnaTags: storytelling, relatability, vulnerability
3. EDUCATIONAL: teaches something → dnaTags: educational, authority, money, motivation
4. CONTROVERSY: sparks debate → dnaTags: controversy, emotion, shock
5. EMOTION: emotional impact → dnaTags: emotion, vulnerability, inspiration, motivation, relatability

CRITICAL: Output a SEPARATE entry for each dimension. A candidate scoring well on 3 dimensions = 3 separate entries.
Each entry's dnaTags must match the dimension being scored.

OUTPUT: Valid JSON array only.
[{"startTime":n,"endTime":n,"worthClippingScore":n,"confidence":"high"|"medium"|"low","dnaTags":["tag"],"reasoning":"1 sentence"}]`;

  return { system, user };
}
