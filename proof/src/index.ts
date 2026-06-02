/**
 * ganyIQ — Phase 0.5 Proof of Intelligence
 * 
 * End-to-end pipeline validation:
 *   1. Fetch transcript from YouTube video via InnerTube API
 *   2. Send transcript to Gemini 2.0 Flash for worth-clipping analysis
 *   3. Parse, validate, and display structured results
 * 
 * Usage: npx tsx src/index.ts <youtube-video-id-or-url>
 * 
 * Requires: GEMINI_API_KEY in .env at proof/ level
 */

import "dotenv/config";
import { Innertube, UniversalCache } from "youtubei.js";
import {
  AnalysisResultSchema,
  type AnalysisResult,
  type TranscriptSegment,
  type VideoMetadata,
} from "./types.js";

// ---------------------------------------------------------------------------
// 1. TRANSCRIPT EXTRACTION
// ---------------------------------------------------------------------------

/**
 * Extract video ID from a YouTube URL or plain ID.
 */
function extractVideoId(input: string): string {
  // Already a plain ID (11 chars alphanumeric + dash/underscore)
  if (/^[A-Za-z0-9_-]{11}$/.test(input.trim())) {
    return input.trim();
  }
  // Full URL patterns
  const patterns = [
    /(?:youtube\.com\/watch\?v=)([^"&?/\s]{11})/i,
    /(?:youtu\.be\/)([^"&?/\s]{11})/i,
    /(?:youtube\.com\/embed\/)([^"&?/\s]{11})/i,
  ];
  for (const p of patterns) {
    const match = input.match(p);
    if (match) return match[1];
  }
  throw new Error(`Cannot extract video ID from: "${input}"`);
}

/**
 * InnerTube API endpoint for fetching video metadata + caption tracks.
 * Uses Android client context (same approach as youtube-transcript library).
 */
const INNERTUBE_PLAYER_URL =
  "https://www.youtube.com/youtubei/v1/player?prettyPrint=false";
const INNERTUBE_UA =
  "com.google.android.youtube/20.10.38 (Linux; U; Android 14)";

interface CaptionTrack {
  baseUrl: string;
  languageCode: string;
  name: { simpleText?: string; runs?: { text: string }[] };
  kind?: string; // "asr" = auto-generated
}

async function fetchCaptionTracks(
  videoId: string
): Promise<CaptionTrack[]> {
  const resp = await fetch(INNERTUBE_PLAYER_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": INNERTUBE_UA,
    },
    body: JSON.stringify({
      context: {
        client: { clientName: "ANDROID", clientVersion: "20.10.38" },
      },
      videoId,
    }),
  });

  if (!resp.ok) {
    throw new Error(`InnerTube API returned HTTP ${resp.status}`);
  }

  const data = await resp.json();
  const tracks: CaptionTrack[] =
    data?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];

  if (tracks.length === 0) {
    throw new Error(
      `No caption tracks available for video ${videoId}. ` +
        `Transcript may be disabled for this content.`
    );
  }

  return tracks;
}

/**
 * Fetch and parse a timedtext XML transcript from a caption track base URL.
 * Handles YouTube timedtext format 3 (current) and format 1 (legacy).
 * Returns TranscriptSegment array compatible with our type system.
 */
async function fetchTranscriptXml(
  baseUrl: string
): Promise<TranscriptSegment[]> {
  const resp = await fetch(baseUrl, {
    headers: { "User-Agent": INNERTUBE_UA },
  });
  const xml = await resp.text();

  // YouTube timedtext format 3: <p t="START_MS" ...><s t="OFFSET_MS">word</s>...</p>
  // Aggregate words into segments of ~5 seconds each
  const RE_PARAGRAPH = /<p t="(\d+)"[^>]*d="(\d+)"[^>]*>([\s\S]*?)<\/p>/g;
  const RE_WORD = /<s(?: t="(\d+)")?[^>]*>([^<]*)<\/s>/g;

  const rawWords: { timeSec: number; text: string }[] = [];
  let paraMatch: RegExpExecArray | null;

  while ((paraMatch = RE_PARAGRAPH.exec(xml)) !== null) {
    const paraStartMs = parseInt(paraMatch[1], 10);
    const paraBody = paraMatch[3];
    let wordMatch: RegExpExecArray | null;

    while ((wordMatch = RE_WORD.exec(paraBody)) !== null) {
      const wordOffsetMs = wordMatch[1] ? parseInt(wordMatch[1], 10) : 0;
      const timeSec = (paraStartMs + wordOffsetMs) / 1000;
      const text = wordMatch[2]
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\\n/g, " ")
        .trim();
      if (text.length > 0) {
        rawWords.push({ timeSec, text });
      }
    }
  }

  // If format 3 didn't match, try legacy format 1: <text start="..." dur="...">text</text>
  if (rawWords.length === 0) {
    const RE_LEGACY = /<text start="([^"]*)" dur="([^"]*)">([^<]*)<\/text>/g;
    let legacyMatch: RegExpExecArray | null;
    while ((legacyMatch = RE_LEGACY.exec(xml)) !== null) {
      rawWords.push({
        timeSec: parseFloat(legacyMatch[1]),
        text: legacyMatch[3]
          .replace(/&amp;/g, "&")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
          .trim(),
      });
    }
  }

  if (rawWords.length === 0) {
    throw new Error("Transcript XML contained no parseable segments");
  }

  // Group words into segments of ~5 seconds
  const segments: TranscriptSegment[] = [];
  let segStart = rawWords[0].timeSec;
  let segWords: string[] = [];
  const MAX_GAP = 1.0; // seconds — gap between words that we can bridge

  for (let i = 0; i < rawWords.length; i++) {
    const w = rawWords[i];
    const prevTime = i > 0 ? rawWords[i - 1].timeSec : segStart;

    // Start new segment if we've accumulated >5s or there's a large gap
    if (w.timeSec - segStart > 5.0 || w.timeSec - prevTime > MAX_GAP * 2) {
      if (segWords.length > 0) {
        segments.push({
          start: segStart,
          duration: prevTime - segStart + 0.5, // approximate
          text: segWords.join(" ").trim(),
        });
      }
      segStart = w.timeSec;
      segWords = [w.text];
    } else {
      segWords.push(w.text);
    }
  }

  // Final segment
  if (segWords.length > 0) {
    const lastTime = rawWords[rawWords.length - 1].timeSec;
    segments.push({
      start: segStart,
      duration: Math.max(1, lastTime - segStart),
      text: segWords.join(" ").trim(),
    });
  }

  return segments;
}

/**
 * Pick the best caption track: prefer auto-generated (asr) in Indonesian,
 * fall back to any auto-generated, then any manual track.
 */
function selectTrack(tracks: CaptionTrack[], preferredLang = "id"): CaptionTrack {
  // Auto-generated, preferred language
  const asrPreferred = tracks.find(
    (t) => t.kind === "asr" && t.languageCode === preferredLang
  );
  if (asrPreferred) return asrPreferred;

  // Auto-generated, any language
  const asrAny = tracks.find((t) => t.kind === "asr");
  if (asrAny) return asrAny;

  // Manual, preferred language
  const manualPreferred = tracks.find(
    (t) => !t.kind && t.languageCode === preferredLang
  );
  if (manualPreferred) return manualPreferred;

  // Any track
  return tracks[0];
}

async function extractTranscript(
  videoId: string
): Promise<{ metadata: VideoMetadata; transcript: TranscriptSegment[] }> {
  // 1. Get metadata via youtubei.js (more reliable for title/channel/duration)
  const yt = await Innertube.create({ cache: new UniversalCache(true) });
  const info = await yt.getInfo(videoId);

  const metadata: VideoMetadata = {
    youtubeId: videoId,
    title: info.basic_info.title?.toString() ?? "Unknown",
    channelName: info.basic_info.author?.toString() ?? "Unknown",
    durationSeconds: info.basic_info.duration ?? 0,
  };

  // 2. Get caption tracks via InnerTube API (youtubei.js getTranscript is broken)
  const tracks = await fetchCaptionTracks(videoId);
  const track = selectTrack(tracks);
  console.log(
    `  Using track: ${track.languageCode} "${getTrackName(track)}" (${track.kind === "asr" ? "auto-generated" : "manual"})`
  );

  // 3. Fetch and parse transcript XML
  const transcript = await fetchTranscriptXml(track.baseUrl);

  return { metadata, transcript };
}

function getTrackName(track: CaptionTrack): string {
  return track.name?.simpleText ?? track.name?.runs?.[0]?.text ?? track.languageCode;
}

// ---------------------------------------------------------------------------
// 2. AI ANALYSIS (DeepSeek V4 Flash via OpenAI-compatible API)
// ---------------------------------------------------------------------------

/**
 * Format transcript as timestamped text for the LLM prompt.
 */
function formatTranscript(segments: TranscriptSegment[]): string {
  const lines: string[] = [];
  for (const seg of segments) {
    const mins = Math.floor(seg.start / 60);
    const secs = Math.floor(seg.start % 60);
    const ts = `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
    lines.push(`[${ts}] ${seg.text}`);
  }
  return lines.join("\n");
}

const ANALYSIS_PROMPT = `You are a professional short-form content clipper in Indonesia.
Your income depends entirely on views.
You have 3+ years of experience clipping Indonesian podcast content for TikTok, Reels, and Shorts.

TASK:
Analyze this transcript and identify the top moments worth clipping into short-form content.

For each moment, provide:
1. startTime (seconds) and endTime (seconds) — must be 10-120 seconds
2. worthClippingScore (0-100) — be harsh, only the top 2-4 should score above 85
3. confidence ("high", "medium", or "low")
4. dnaTags — top 3 from this list: hookPower, curiosity, controversy, emotion, humor, storytelling, authority, money, shock, educational, motivation, relatability
5. reasoning — 1-2 sentences in English explaining why this is worth clipping

RULES:
- Moments must stand alone — a viewer should understand them without watching the full video
- Strong hooks matter most. If the first 3 seconds don't grab attention, score lower
- Be honest. If the video has only 3 good moments, return 3. Don't pad to 15
- Only score based on what's in the transcript. Don't imagine tone or delivery
- Return moments sorted by worthClippingScore descending
- Return ONLY valid JSON in the exact format specified

OUTPUT FORMAT:
Return a JSON object with this exact structure:
{
  "elite_moments": [Moment],   // score >= 85
  "secondary_moments": [Moment], // score 70-84
  "reasoning": ["string"],     // 1-2 sentences of overall analysis
  "confidence": ["string"]     // notes about transcript quality and confidence
}

Each Moment object:
{
  "startTime": number,
  "endTime": number,
  "worthClippingScore": number,
  "confidence": "high" | "medium" | "low",
  "dnaTags": ["tag1", "tag2", "tag3"],
  "reasoning": "1-2 sentence explanation"
}`;

const DEEPSEEK_API_URL = "https://opencode.ai/zen/go/v1/chat/completions";

async function analyzeTranscript(
  transcript: TranscriptSegment[],
  metadata: VideoMetadata
): Promise<AnalysisResult> {
  const apiKey = process.env.OPENCODE_GO_API_KEY || process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "API key not set. Set OPENCODE_GO_API_KEY or GEMINI_API_KEY in .env"
    );
  }

  const transcriptText = formatTranscript(transcript);

  const systemPrompt = `You are a professional short-form content clipper in Indonesia. Your income depends entirely on views. You have 3+ years of experience clipping Indonesian podcast content for TikTok, Reels, and Shorts.`;
  const userPrompt = `${ANALYSIS_PROMPT}

VIDEO:
Title: ${metadata.title}
Channel: ${metadata.channelName}
Duration: ${Math.round(metadata.durationSeconds / 60)} minutes

TRANSCRIPT:
${transcriptText}`;

  console.log(`  Transcript: ${transcript.length} segments, ~${transcriptText.length} chars`);
  console.log(`  Sending to DeepSeek V4 Flash...`);

  const startTime = Date.now();

  const response = await fetch(DEEPSEEK_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "deepseek-v4-flash",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.3,
      max_tokens: 8192,
    }),
  });

  const elapsed = (Date.now() - startTime) / 1000;
  console.log(`  Response received in ${elapsed.toFixed(1)}s`);

  if (!response.ok) {
    const errBody = await response.text().catch(() => "unknown");
    throw new Error(`DeepSeek API returned HTTP ${response.status}: ${errBody.slice(0, 200)}`);
  }

  const data = await response.json();
  const rawText = data.choices?.[0]?.message?.content;
  if (!rawText) {
    throw new Error("DeepSeek returned empty response");
  }

  // Extract JSON from response (may be wrapped in markdown code fence)
  const jsonMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)\s*```/) ?? [null, rawText];
  const jsonStr = jsonMatch[1] ?? rawText;

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr.trim());
  } catch {
    console.error("Raw DeepSeek response (first 1000 chars):");
    console.error(rawText.slice(0, 1000));
    throw new Error("Failed to parse DeepSeek response as JSON");
  }

  // Validate against Zod schema
  const result = AnalysisResultSchema.parse(parsed);

  return result as AnalysisResult;
}

// ---------------------------------------------------------------------------
// 3. DISPLAY
// ---------------------------------------------------------------------------

function displayResults(result: AnalysisResult, metadata: VideoMetadata): void {
  console.log("\n" + "═".repeat(60));
  console.log(`🎬 ${metadata.title}`);
  console.log(`📺 ${metadata.channelName}  |  ⏱ ${Math.round(metadata.durationSeconds / 60)} min`);
  console.log("═".repeat(60));

  if (result.reasoning.length > 0) {
    console.log(`\n💡 ${result.reasoning[0]}`);
  }

  if (result.elite_moments.length > 0) {
    console.log(`\n🔥 ELITE MOMENTS (${result.elite_moments.length})`);
    console.log("─".repeat(40));
    for (const m of result.elite_moments) {
      console.log(`  ⏱ ${fmtTime(m.startTime)} → ${fmtTime(m.endTime)}  |  Score: ${m.worthClippingScore}  |  ${m.confidence}`);
      console.log(`  🧬 ${m.dnaTags.join(" · ")}`);
      console.log(`  💬 ${m.reasoning}`);
      console.log();
    }
  }

  if (result.secondary_moments.length > 0) {
    console.log(`\n✅ SECONDARY MOMENTS (${result.secondary_moments.length})`);
    console.log("─".repeat(40));
    for (const m of result.secondary_moments) {
      console.log(`  ⏱ ${fmtTime(m.startTime)} → ${fmtTime(m.endTime)}  |  Score: ${m.worthClippingScore}  |  ${m.confidence}`);
      console.log(`  🧬 ${m.dnaTags.join(" · ")}`);
      console.log(`  💬 ${m.reasoning}`);
      console.log();
    }
  }

  const total = result.elite_moments.length + result.secondary_moments.length;
  console.log("═".repeat(60));
  console.log(`📊 Total moments found: ${total}`);
  console.log("═".repeat(60));
}

function fmtTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const input = process.argv[2];
  if (!input) {
    console.log("Usage: npx tsx src/index.ts <youtube-url-or-video-id>");
    console.log("Example: npx tsx src/index.ts dQw4w9WgXcQ");
    process.exit(1);
  }

  const videoId = extractVideoId(input);
  console.log(`ganyIQ — Proof of Intelligence v0.5`);
  console.log(`Video ID: ${videoId}\n`);

  // Step 1: Extract transcript
  console.log("1/3  Extracting transcript...");
  let metadata: VideoMetadata;
  let transcript: TranscriptSegment[];
  try {
    const extracted = await extractTranscript(videoId);
    metadata = extracted.metadata;
    transcript = extracted.transcript;
    console.log(`  ✅ ${transcript.length} segments extracted\n`);
  } catch (err: any) {
    console.error(`  ❌ Transcript extraction failed: ${err.message}`);
    console.error(
      "\n💡 This video may not have captions enabled. " +
        "Try a video with closed captions (look for the CC badge on YouTube)."
    );
    process.exit(1);
  }

  // Step 2: Analyze with Gemini
  console.log("2/3  Analyzing with Gemini 2.0 Flash...");
  let result: AnalysisResult;
  try {
    result = await analyzeTranscript(transcript, metadata);
    console.log(`  ✅ Analysis complete\n`);
  } catch (err: any) {
    console.error(`  ❌ Analysis failed: ${err.message}`);
    process.exit(1);
  }

  // Step 3: Display results
  console.log("3/3  Results:");
  displayResults(result, metadata);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
