/**
 * lib/title-generator.ts — AI Title Suggestions for each recommended clip.
 *
 * Generates 3-5 title variations per moment in 5 style categories:
 *   Curiosity, Emotional, Viral, Story-based, Safe / Professional
 *
 * Uses the existing OpenCode Go API (same model as scoring).
 * Caches results in moments.suggested_titles (JSONB).
 */

import { AppError } from '@/lib/errors';
import { TARGET_MODEL } from '@/lib/prompt';
import type { RawMoment, RankedMoment, TranscriptSegment } from '@/lib/types';
import { query } from '@/db/client';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LLM_API_URL = 'https://opencode.ai/zen/go/v1/chat/completions';

export interface TitleSuggestion {
  style: 'curiosity' | 'emotional' | 'viral' | 'story' | 'professional';
  title: string;
}

// ---------------------------------------------------------------------------
// Prompt Builders
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a professional clip-title strategist for a content discovery platform called GANYIQ.

Your task: Given a clip's transcript excerpt, DNA tags, score, and reasoning, generate 3-5 TITLE VARIATIONS.

Each title must:
- Be in Indonesian (mix casual/formal as appropriate for the clip tone)
- Be under 80 characters
- Be engaging and clickable (like YouTube Shorts titles)
- Accurately reflect what's actually said in the clip (NO CLICKBAIT — the user can verify against the transcript)
- Capture the essence of the moment

Generate ONE title per style category. Return exactly 5 titles, one for each style:

1. "curiosity" — Makes the viewer wonder: "Kenapa?" / "Gimana?" (e.g., "Andre Taulany Salah Paham Hadiah Ultahnya")
2. "emotional" — Tugs at feelings: haru, lucu, relatable (e.g., "Momen Haru Andre Curhat Soal Keluarga")
3. "viral" — Short, punchy, shareable, controversy/shock value (e.g., "JAWABAN ANDRE BIKIN SEMUA HENING!")
4. "story" — Story-based narrative hook (e.g., "Kisah Andre Dapet Hadiah Gitar Tapi Minta Sepeda")
5. "professional" — Safe, descriptive, appropriate for professional contexts (e.g., "Andre Taulany Berbagi Pengalaman tentang Hadiah")

Output ONLY valid JSON. No markdown, no code fences, no extra text.`;

const BATCH_SYSTEM_PROMPT = `You are a professional clip-title strategist for a content discovery platform called GANYIQ.

Your task: Generate 5 title variations for EACH of the given video clips in a single response.

Rules for each title:
- Be in Indonesian (mix casual/formal as appropriate for the clip tone)
- Be under 80 characters
- Be engaging and clickable (like YouTube Shorts titles)
- Accurately reflect what's actually said in the clip (NO CLICKBAIT)
- Capture the essence of the moment

For EACH clip, generate exactly 5 titles, one per style:

1. "curiosity" — Makes the viewer wonder: "Kenapa?" / "Gimana?"
2. "emotional" — Tugs at feelings: haru, lucu, relatable
3. "viral" — Short, punchy, shareable, controversy/shock value
4. "story" — Story-based narrative hook
5. "professional" — Safe, descriptive, appropriate for professional contexts

Output ONLY valid JSON. No markdown, no code fences, no extra text.

Output format:
{
  "titles_by_rank": {
    "1": [
      { "style": "curiosity", "title": "..." },
      { "style": "emotional", "title": "..." },
      { "style": "viral", "title": "..." },
      { "style": "story", "title": "..." },
      { "style": "professional", "title": "..." }
    ],
    "2": [ ... same 5 styles ... ],
    ...
  }
}

You MUST output titles for EVERY rank listed in the input. No skipping.`;

/**
 * Build user prompt for a single moment (used in individual fallback calls).
 */
function buildMomentPrompt(
  moment: { startTime: number; endTime: number; worthClippingScore: number; dnaTags: string[]; reasoning: string; transcriptExcerpt: string },
  videoTitle: string,
  channelName: string,
): string {
  return JSON.stringify({
    task: 'Generate 5 title variations for this clip',
    video: { title: videoTitle, channel: channelName },
    clip: {
      timestamp: `${secondsToTimestamp(moment.startTime)} — ${secondsToTimestamp(moment.endTime)}`,
      score: moment.worthClippingScore,
      dnaTags: moment.dnaTags,
      reasoning: moment.reasoning,
      transcript: moment.transcriptExcerpt.slice(0, 800),
    },
    instructions: 'Return exactly 5 titles, one per style. Use format: { "titles": [{ "style": "curiosity", "title": "..." }, ...] }',
  });
}

/**
 * Build combined prompt for all moments in an analysis.
 * Generates titles for ALL moments in ONE LLM call.
 */
function buildCombinedPrompt(
  moments: Array<{
    rank: number;
    startTime: number;
    endTime: number;
    worthClippingScore: number;
    dnaTags: string[];
    reasoning: string;
    transcriptExcerpt: string;
  }>,
  videoTitle: string,
  channelName: string,
): string {
  const clipsSection = moments.map((m) => {
    const excerpt = m.transcriptExcerpt.slice(0, 400); // shorter excerpt in batch to save tokens
    return `## RANK #${m.rank} (Score: ${m.worthClippingScore})
Timestamp: ${secondsToTimestamp(m.startTime)} — ${secondsToTimestamp(m.endTime)}
DNA Tags: ${m.dnaTags.join(', ')}
Reasoning: ${m.reasoning}
Transcript: ${excerpt}`;
  }).join('\n\n');

  return JSON.stringify({
    task: `Generate 5 title variations for each of ${moments.length} clips from the video`,
    video: { title: videoTitle, channel: channelName },
    clips_count: moments.length,
    instructions: 'Output titles_by_rank mapping every rank from the input. Each rank must have exactly 5 title objects (one per style). No skipping.',
    clips: clipsSection,
  });
}

function secondsToTimestamp(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// LLM Call
// ---------------------------------------------------------------------------

async function callTitleLLM(system: string, user: string, maxTokens: number = 2048): Promise<string> {
  const apiKey = process.env.OPENCODE_GO_API_KEY;
  if (!apiKey) {
    throw new AppError('ANALYSIS_FAILED', 'No API key configured.', 500);
  }

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
      temperature: 0.7, // Higher temp for creative variety
      max_tokens: maxTokens,
    }),
    signal: AbortSignal.timeout(Math.max(120_000, maxTokens * 8)), // scale timeout with output size
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => 'unknown');
    throw new Error(`Title LLM HTTP ${response.status}: ${errBody.slice(0, 200)}`);
  }

  const data = await response.json();
  const text: string | undefined = data?.choices?.[0]?.message?.content;
  if (!text || text.trim().length === 0) {
    throw new Error('Title LLM returned empty response');
  }
  return text.trim();
}

// ---------------------------------------------------------------------------
// Parse & Validate
// ---------------------------------------------------------------------------

function parseTitles(raw: string): TitleSuggestion[] {
  // Remove markdown fences if present
  let cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

  let parsed: any;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    // Try to extract JSON object from the text
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        parsed = JSON.parse(match[0]);
      } catch {
        throw new Error('Failed to parse title generator output as JSON');
      }
    } else {
      throw new Error('Failed to parse title generator output as JSON');
    }
  }

  const titles = parsed.titles || parsed;
  if (!Array.isArray(titles)) {
    throw new Error('Title output is not an array');
  }

  const VALID_STYLES = new Set(['curiosity', 'emotional', 'viral', 'story', 'professional']);

  return titles
    .filter((t: any) => t && typeof t === 'object' && typeof t.title === 'string' && VALID_STYLES.has(t.style))
    .map((t: any) => ({
      style: t.style as TitleSuggestion['style'],
      title: t.title.trim().slice(0, 100),
    }));
}

// ---------------------------------------------------------------------------
// Combined batch generation — 1 LLM call for ALL moments
// ---------------------------------------------------------------------------

/**
 * Parse batch response with titles_by_rank mapping.
 * Returns Map<rank, TitleSuggestion[]> or null on failure.
 */
function parseCombinedResponse(raw: string, expectedRanks: Set<number>): Map<number, TitleSuggestion[]> | null {
  let cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

  let parsed: any;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      return null;
    }
  }

  const titlesByRank = parsed.titles_by_rank || parsed;
  if (typeof titlesByRank !== 'object') return null;

  const VALID_STYLES = new Set(['curiosity', 'emotional', 'viral', 'story', 'professional']);
  const result = new Map<number, TitleSuggestion[]>();

  for (const rankStr of Object.keys(titlesByRank)) {
    const rank = parseInt(rankStr, 10);
    if (!expectedRanks.has(rank)) continue;

    const entries = titlesByRank[rankStr];
    if (!Array.isArray(entries)) continue;

    const titles = entries
      .filter((t: any) => t && typeof t === 'object' && typeof t.title === 'string' && VALID_STYLES.has(t.style))
      .map((t: any) => ({
        style: t.style as TitleSuggestion['style'],
        title: t.title.trim().slice(0, 100),
      }));

    if (titles.length >= 3) {
      result.set(rank, titles);
    }
  }

  return result.size > 0 ? result : null;
}

/**
 * Generate titles for ALL moments in ONE combined LLM call.
 * Returns Map<rank, titles> on success, null if the batch call failed entirely.
 */
async function generateAllTitlesCombined(
  moments: Array<{
    id: string;
    rank: number;
    startTime: number;
    endTime: number;
    worthClippingScore: number;
    dnaTags: string[];
    reasoning: string;
    transcriptExcerpt: string;
  }>,
  videoTitle: string,
  channelName: string,
): Promise<Map<string, TitleSuggestion[]> | null> {
  const userPrompt = buildCombinedPrompt(moments, videoTitle, channelName);

  let raw: string;
  try {
    raw = await callTitleLLM(BATCH_SYSTEM_PROMPT, userPrompt, 16_384); // higher max_tokens for 75 titles
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'error';
    console.log(`[TITLES] Combined batch call failed: ${msg.slice(0, 200)}`);
    return null;
  }

  const expectedRanks = new Set(moments.map(m => m.rank));
  const parsed = parseCombinedResponse(raw, expectedRanks);
  if (!parsed) {
    console.log('[TITLES] Combined batch response could not be parsed');
    return null;
  }

  // Map result back to moment IDs
  const result = new Map<string, TitleSuggestion[]>();
  for (const moment of moments) {
    const titles = parsed.get(moment.rank);
    if (titles) {
      result.set(moment.id, titles);
    }
  }

  console.log(`[TITLES] Combined batch generated titles for ${result.size}/${moments.length} moments`);
  return result.size > 0 ? result : null;
}

// ---------------------------------------------------------------------------
// Main Export — Generate titles for a single moment
// ---------------------------------------------------------------------------

/**

/**
 * Generate AI titles for a single moment.
 * Checks DB cache first — if suggested_titles exists, returns cached.
 * Otherwise calls LLM, stores result, returns.
 */
export async function generateTitlesForMoment(
  momentId: string,
  moment: {
    startTime: number;
    endTime: number;
    worthClippingScore: number;
    dnaTags: string[];
    reasoning: string;
    transcriptExcerpt: string;
  },
  videoTitle: string,
  channelName: string,
): Promise<TitleSuggestion[]> {
  // Step 1: Check cache
  const cached = await query<{ suggested_titles: any }>(
    'SELECT suggested_titles FROM moments WHERE id = $1',
    [momentId],
  );

  if (cached.rows.length > 0 && cached.rows[0].suggested_titles) {
    const titles = cached.rows[0].suggested_titles as TitleSuggestion[];
    if (Array.isArray(titles) && titles.length >= 3) {
      console.log(`[TITLES] Cache hit for moment ${momentId}`);
      return titles;
    }
  }

  // Step 2: Generate via LLM
  console.log(`[TITLES] Generating for moment ${momentId} (score=${moment.worthClippingScore})`);
  console.time(`[PROFILE] titles_${momentId}`);

  let titles: TitleSuggestion[] = [];
  try {
    const userPrompt = buildMomentPrompt(moment, videoTitle, channelName);
    const raw = await callTitleLLM(SYSTEM_PROMPT, userPrompt);
    titles = parseTitles(raw);
    console.log(`[TITLES] Generated ${titles.length} titles for moment ${momentId}`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.log(`[TITLES] Failed for moment ${momentId}: ${msg.slice(0, 200)}`);
    // Return empty — don't crash the pipeline
    return [];
  }

  console.timeEnd(`[PROFILE] titles_${momentId}`);

  // Step 3: Cache in DB
  if (titles.length > 0) {
    try {
      await query(
        'UPDATE moments SET suggested_titles = $1::jsonb WHERE id = $2',
        [JSON.stringify(titles), momentId],
      );
      console.log(`[TITLES] Cached ${titles.length} titles for moment ${momentId}`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'error';
      console.error(`[TITLES] Failed to cache for ${momentId}: ${msg}`);
    }
  }

  return titles;
}

// ---------------------------------------------------------------------------
// Batch — Generate titles for ALL moments in an analysis
// ---------------------------------------------------------------------------

/**
 * Generate titles for all moments in an analysis.
 * Runs in background during storing_results stage.
 * Each moment gets titles generated independently (parallel).
 */
export async function generateAllTitlesForAnalysis(
  analysisId: string,
  moments: Array<{
    id: string;
    startTime: number;
    endTime: number;
    worthClippingScore: number;
    dnaTags: string[];
    reasoning: string;
    transcriptExcerpt: string;
  }>,
  videoTitle: string,
  channelName: string,
): Promise<void> {
  if (moments.length === 0) {
    console.log('[TITLES] No moments to generate titles for');
    return;
  }

  console.log(`[TITLES] Generating titles for ${moments.length} moments in analysis ${analysisId}`);
  console.time(`[PROFILE] titles_batch_${analysisId}`);

  // Pre-populate rank for each moment (needed for combined prompt)
  // Assign ranks based on insertion order (matches scoring rank)
  const withRank = moments.map((m, i) => ({ ...m, rank: i + 1 }));

  // Strategy: Try 1 combined LLM call for all moments.
  // If combined call fails → fallback to per-moment calls (current behavior).
  let remaining = new Map<string, typeof moments[0]>();
  for (const m of withRank) remaining.set(m.id, m);

  const combinedResult = await generateAllTitlesCombined(withRank, videoTitle, channelName);

  if (combinedResult && combinedResult.size > 0) {
    // Batch succeeded for some or all moments — immediately cache
    let cached = 0;
    const combinedEntries = Array.from(combinedResult.entries());
    for (let ci = 0; ci < combinedEntries.length; ci++) {
      const [momentId, titles] = combinedEntries[ci];
      if (titles.length > 0) {
        try {
          await query(
            'UPDATE moments SET suggested_titles = $1::jsonb WHERE id = $2',
            [JSON.stringify(titles), momentId],
          );
          cached++;
          remaining.delete(momentId);
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : 'error';
          console.error(`[TITLES] Failed to cache batch title for ${momentId}: ${msg}`);
        }
      }
    }
    console.log(`[TITLES] Combined batch: cached ${cached}/${moments.length} moments`);
  }

  // Fallback: generate per-moment for remaining (failed or missing)
  if (remaining.size > 0) {
    console.log(`[TITLES] Generating per-moment fallback for ${remaining.size} moments`);
    const CONCURRENCY = 3;
    const fallbackMoments = Array.from(remaining.values());
    for (let i = 0; i < fallbackMoments.length; i += CONCURRENCY) {
      const batch = fallbackMoments.slice(i, i + CONCURRENCY);
      await Promise.allSettled(
        batch.map(m => generateTitlesForMoment(m.id, m, videoTitle, channelName)),
      );
    }
  }

  console.timeEnd(`[PROFILE] titles_batch_${analysisId}`);
  console.log(`[TITLES] Done generating for ${moments.length} moments`);
}
