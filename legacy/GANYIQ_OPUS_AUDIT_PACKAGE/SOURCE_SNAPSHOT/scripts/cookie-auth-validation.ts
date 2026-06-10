/**
 * ganyIQ — Cookie Auth Validation Script
 *
 * Validates whether cookie-authenticated YouTube requests improve
 * transcript coverage for Indonesian podcast videos.
 *
 * Tests EACH video TWICE:
 *   1. Anonymous (current behavior)
 *   2. Cookie-authenticated (using cookies.txt)
 *
 * Reports detailed comparison metrics.
 *
 * Usage: npx tsx scripts/cookie-auth-validation.ts
 */

import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const COOKIE_PATH = '/root/GANYIQ/cookies.txt';
const INNERTUBE_PLAYER_URL =
  'https://www.youtube.com/youtubei/v1/player?prettyPrint=false';
const INNERTUBE_UA =
  'com.google.android.youtube/20.10.38 (Linux; U; Android 14)';
const MAX_WORD_GAP = 1.0;
const SEGMENT_TARGET = 5.0;
const PREFERRED_LANG = 'id';

const DEEPSEEK_API_URL = 'https://opencode.ai/zen/go/v1/chat/completions';
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
  "reasoning": ["string"],
  "confidence": ["string"]
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

// ---------------------------------------------------------------------------
// Test Video URLs (15 Indonesian podcasts across 6 categories)
// ---------------------------------------------------------------------------

interface TestVideo {
  id: string;
  url: string;
  videoId: string;
  category: string;
  channel: string;
  title: string;
}

const TEST_VIDEOS: TestVideo[] = [
  // BUSINESS (3)
  { id: 'BUS-01', url: 'https://www.youtube.com/watch?v=2QFV58h8BsU', videoId: '2QFV58h8BsU', category: 'business', channel: 'Fellexandro Ruby', title: 'Podcast Bisnis Fellexandro Ruby' },
  { id: 'BUS-02', url: 'https://www.youtube.com/watch?v=FIXQQ7X7tZE', videoId: 'FIXQQ7X7tZE', category: 'business', channel: 'Suara Berkelas', title: 'Cara Menemukan Bahagia & Bersyukur' },
  { id: 'BUS-03', url: 'https://www.youtube.com/watch?v=R8rLV9PhQg0', videoId: 'R8rLV9PhQg0', category: 'business', channel: 'What Is Up Indonesia', title: 'Therapy Session with Tom Lembong' },

  // MOTIVATION (2)
  { id: 'MOT-01', url: 'https://www.youtube.com/watch?v=y10GDKyPmfg', videoId: 'y10GDKyPmfg', category: 'motivation', channel: 'Mario Teguh Official', title: 'Mario Teguh Motivasi' },
  { id: 'MOT-02', url: 'https://www.youtube.com/watch?v=hN-V0YYDSak', videoId: 'hN-V0YYDSak', category: 'motivation', channel: 'Raditya Dika', title: 'Diskusi Tentang Pendidikan Indonesia' },

  // COMEDY (3)
  { id: 'COM-01', url: 'https://www.youtube.com/watch?v=qG2Rf_mtmiQ', videoId: 'qG2Rf_mtmiQ', category: 'comedy', channel: 'Podcast Awal Minggu', title: 'Comedy Podcast Awal Minggu' },
  { id: 'COM-02', url: 'https://www.youtube.com/watch?v=pFJ5L6F55Jw', videoId: 'pFJ5L6F55Jw', category: 'comedy', channel: 'Risyad and Son', title: 'Tempat Terhorror di Indonesia' },
  { id: 'COM-03', url: 'https://www.youtube.com/watch?v=ytalcSHJYik', videoId: 'ytalcSHJYik', category: 'comedy', channel: 'Tuah Kreasi', title: 'Kejar Setoran - Fajar Sadboy' },

  // STORYTELLING (3)
  { id: 'STL-01', url: 'https://www.youtube.com/watch?v=6AaD_80wh4g', videoId: '6AaD_80wh4g', category: 'storytelling', channel: 'Curhat Bang', title: 'Curhat Bang Cerita Inspiratif' },
  { id: 'STL-02', url: 'https://www.youtube.com/watch?v=i2W5y8fqb9I', videoId: 'i2W5y8fqb9I', category: 'storytelling', channel: 'Rotten Mango', title: 'The Indonesian Girl That Killed' },
  { id: 'STL-03', url: 'https://www.youtube.com/watch?v=6BpIg7jtE_4', videoId: '6BpIg7jtE_4', category: 'storytelling', channel: 'UNLOCKED MEDIA', title: 'Wanita Ini Jadikan Office Boy' },

  // FINANCE (2)
  { id: 'FIN-01', url: 'https://www.youtube.com/watch?v=0yu5yFkZmKo', videoId: '0yu5yFkZmKo', category: 'finance', channel: 'Raymond Chin', title: 'Finance Podcast Raymond Chin' },
  { id: 'FIN-02', url: 'https://www.youtube.com/watch?v=E5ctwVEl4KM', videoId: 'E5ctwVEl4KM', category: 'finance', channel: 'Deddy Corbuzier', title: 'Close The Door - Deddy Corbuzier' },

  // CONTROVERSY (2)
  { id: 'CON-01', url: 'https://www.youtube.com/watch?v=i-VLCYAlANI', videoId: 'i-VLCYAlANI', category: 'controversy', channel: 'Risyad and Son', title: 'Kejadian TerGila di Pedalaman Indonesia' },
  { id: 'CON-02', url: 'https://www.youtube.com/watch?v=ydE9TD6vhE8', videoId: 'ydE9TD6vhE8', category: 'controversy', channel: 'Raditya Dika', title: 'Adili Reza Arap' },
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CaptionTrack {
  baseUrl: string;
  languageCode: string;
  name: { simpleText?: string; runs?: { text: string }[] };
  kind?: string;
}

interface TranscriptSegment {
  start: number;
  duration: number;
  text: string;
}

interface VideoMetadata {
  youtubeId: string;
  title: string;
  channelName: string;
  durationSeconds: number;
}

interface TranscriptResult {
  success: boolean;
  segments?: TranscriptSegment[];
  metadata?: VideoMetadata;
  trackCount?: number;
  selectedTrack?: string;
  trackKind?: string;
  error?: string;
  errorType?: string;
  durationMs?: number;
}

interface TestResult {
  video: TestVideo;
  anonymous: TranscriptResult;
  cookieAuth: TranscriptResult;
  analysis?: AnalysisResult;
}

interface AnalysisResult {
  success: boolean;
  eliteCount?: number;
  secondaryCount?: number;
  totalMoments?: number;
  avgScore?: number;
  durationMs?: number;
  transcriptSize?: number;
  error?: string;
}

interface FullResult {
  video: TestVideo;
  anonymous: TranscriptResult;
  cookieAuth: TranscriptResult;
  deepseek?: {
    success: boolean;
    eliteCount: number;
    secondaryCount: number;
    totalMoments: number;
    avgScore: number;
    durationMs: number;
    transcriptSize: number;
    error?: string;
  };
}

// ---------------------------------------------------------------------------
// Cookie Parser
// ---------------------------------------------------------------------------

function parseNetscapeCookies(filePath: string): string {
  const content = fs.readFileSync(filePath, 'utf-8');
  const cookies: string[] = [];

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const parts = trimmed.split('\t');
    if (parts.length < 7) continue;

    const name = parts[5]?.trim();
    const value = parts[6]?.trim();
    if (name && value) {
      cookies.push(`${encodeURIComponent(name)}=${encodeURIComponent(value)}`);
    }
  }

  return cookies.join('; ');
}

// ---------------------------------------------------------------------------
// InnerTube API — Fetch Caption Tracks
// ---------------------------------------------------------------------------

async function fetchCaptionTracks(
  videoId: string,
  cookieHeader?: string,
): Promise<{ tracks: CaptionTrack[]; durationMs: number }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': INNERTUBE_UA,
  };

  if (cookieHeader) {
    headers['Cookie'] = cookieHeader;
  }

  const start = Date.now();
  const resp = await fetch(INNERTUBE_PLAYER_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      context: {
        client: { clientName: 'ANDROID', clientVersion: '20.10.38' },
      },
      videoId,
    }),
  });
  const elapsed = Date.now() - start;

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    let errorType = 'UNKNOWN';
    if (resp.status === 403) errorType = 'FORBIDDEN';
    else if (resp.status === 404) errorType = 'NOT_FOUND';
    else if (resp.status === 429) errorType = 'RATE_LIMITED';
    else if (resp.status === 401) errorType = 'LOGIN_REQUIRED';

    const detail = body.slice(0, 200);
    throw {
      message: `InnerTube API returned HTTP ${resp.status}: ${detail}`,
      statusCode: resp.status,
      errorType,
      durationMs: elapsed,
    } as any;
  }

  const data = await resp.json();
  const tracks: CaptionTrack[] =
    data?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];

  const playbackTracking = data?.playbackTracking;
  const videoDetails = data?.videoDetails;

  return { tracks, durationMs: elapsed };
}

// ---------------------------------------------------------------------------
// Fetch & Parse Transcript XML
// ---------------------------------------------------------------------------

async function fetchTranscriptXml(
  baseUrl: string,
  cookieHeader?: string,
): Promise<TranscriptSegment[]> {
  const headers: Record<string, string> = {
    'User-Agent': INNERTUBE_UA,
  };
  if (cookieHeader) {
    headers['Cookie'] = cookieHeader;
  }

  const resp = await fetch(baseUrl, { headers });
  const xml = await resp.text();

  const rawWords: { timeSec: number; text: string }[] = [];

  // Format 3: <p t="START_MS" d="DUR_MS">...</p>
  const RE_PARAGRAPH = /<p t="(\d+)"[^>]*d="(\d+)"[^>]*>([\s\S]*?)<\/p>/g;
  const RE_WORD = /<s(?: t="(\d+)")?[^>]*>([^<]*)<\/s>/g;

  let paraMatch: RegExpExecArray | null;
  while ((paraMatch = RE_PARAGRAPH.exec(xml)) !== null) {
    const paraStartMs = parseInt(paraMatch[1], 10);
    const paraBody = paraMatch[3];
    let wordMatch: RegExpExecArray | null;

    while ((wordMatch = RE_WORD.exec(paraBody)) !== null) {
      const wordOffsetMs = wordMatch[1] ? parseInt(wordMatch[1], 10) : 0;
      const timeSec = (paraStartMs + wordOffsetMs) / 1000;
      const text = decodeXmlEntities(wordMatch[2]).trim();
      if (text.length > 0) {
        rawWords.push({ timeSec, text });
      }
    }
  }

  // Format 1 (legacy): <text start="..." dur="...">text</text>
  if (rawWords.length === 0) {
    const RE_LEGACY = /<text start="([^"]*)" dur="([^"]*)">([^<]*)<\/text>/g;
    let legacyMatch: RegExpExecArray | null;
    while ((legacyMatch = RE_LEGACY.exec(xml)) !== null) {
      const text = decodeXmlEntities(legacyMatch[3]).trim();
      if (text.length > 0) {
        rawWords.push({
          timeSec: parseFloat(legacyMatch[1]),
          text,
        });
      }
    }
  }

  if (rawWords.length === 0) {
    throw new Error('Transcript XML contained no parseable segments');
  }

  // Group words into segments of ~5 seconds
  const segments: TranscriptSegment[] = [];
  let segStart = rawWords[0].timeSec;
  let segWords: string[] = [];

  for (let i = 0; i < rawWords.length; i++) {
    const w = rawWords[i];
    const prevTime = i > 0 ? rawWords[i - 1].timeSec : segStart;

    if (w.timeSec - segStart > SEGMENT_TARGET || w.timeSec - prevTime > MAX_WORD_GAP * 2) {
      if (segWords.length > 0) {
        segments.push({
          start: segStart,
          duration: prevTime - segStart + 0.5,
          text: segWords.join(' ').trim(),
        });
      }
      segStart = w.timeSec;
      segWords = [w.text];
    } else {
      segWords.push(w.text);
    }
  }

  if (segWords.length > 0) {
    const lastTime = rawWords[rawWords.length - 1].timeSec;
    segments.push({
      start: segStart,
      duration: Math.max(1, lastTime - segStart),
      text: segWords.join(' ').trim(),
    });
  }

  return segments;
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\\n/g, ' ');
}

// ---------------------------------------------------------------------------
// Track Selection
// ---------------------------------------------------------------------------

function getTrackName(track: CaptionTrack): string {
  return track.name?.simpleText ?? track.name?.runs?.[0]?.text ?? track.languageCode;
}

function selectTrack(tracks: CaptionTrack[]): CaptionTrack {
  const asrPreferred = tracks.find(
    (t) => t.kind === 'asr' && t.languageCode === PREFERRED_LANG,
  );
  if (asrPreferred) return asrPreferred;

  const asrAny = tracks.find((t) => t.kind === 'asr');
  if (asrAny) return asrAny;

  const manualPreferred = tracks.find(
    (t) => !t.kind && t.languageCode === PREFERRED_LANG,
  );
  if (manualPreferred) return manualPreferred;

  return tracks[0];
}

// ---------------------------------------------------------------------------
// Full Transcript Extraction (anonymous or cookie-auth)
// ---------------------------------------------------------------------------

async function extractTranscript(
  videoId: string,
  cookieHeader?: string,
): Promise<TranscriptResult> {
  const start = Date.now();

  try {
    // Step 1: Fetch caption tracks via InnerTube API
    const { tracks } = await fetchCaptionTracks(videoId, cookieHeader);
    const elapsed1 = Date.now() - start;

    if (tracks.length === 0) {
      return {
        success: false,
        error: 'No caption tracks available',
        errorType: 'TRANSCRIPT_UNAVAILABLE',
        trackCount: 0,
        durationMs: Date.now() - start,
      };
    }

    // Step 2: Select best track
    const track = selectTrack(tracks);
    const trackName = getTrackName(track);

    // Step 3: Fetch and parse transcript XML
    const segments = await fetchTranscriptXml(track.baseUrl, cookieHeader);
    const elapsed2 = Date.now() - start;

    // Count total chars
    const totalChars = segments.reduce((sum, s) => sum + s.text.length, 0);

    return {
      success: true,
      segments,
      trackCount: tracks.length,
      selectedTrack: `${track.languageCode} "${trackName}"`,
      trackKind: track.kind === 'asr' ? 'auto-generated' : 'manual',
      durationMs: Date.now() - start,
    };
  } catch (err: any) {
    const elapsed = Date.now() - start;
    const errorType = err.errorType || 'UNKNOWN';
    const statusCode = err.statusCode || 0;

    let friendlyType = errorType;
    if (statusCode === 403) friendlyType = 'FORBIDDEN';
    else if (statusCode === 404) friendlyType = 'NOT_FOUND';
    else if (statusCode === 429) friendlyType = 'RATE_LIMITED';
    else if (statusCode === 401) friendlyType = 'LOGIN_REQUIRED';

    return {
      success: false,
      error: err.message || 'Unknown error',
      errorType: friendlyType,
      durationMs: Date.now() - start,
    };
  }
}

// ---------------------------------------------------------------------------
// Metadata Extraction (youtubei.js)
// ---------------------------------------------------------------------------

async function fetchMetadata(videoId: string): Promise<VideoMetadata | null> {
  try {
    const { Innertube, UniversalCache } = await import('youtubei.js');
    const yt = await Innertube.create({ cache: new UniversalCache(true) });
    const info = await yt.getInfo(videoId);

    return {
      youtubeId: videoId,
      title: info.basic_info.title?.toString() ?? 'Unknown',
      channelName: info.basic_info.author?.toString() ?? 'Unknown',
      durationSeconds: info.basic_info.duration ?? 0,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// DeepSeek Analysis
// ---------------------------------------------------------------------------

function formatTranscript(segments: TranscriptSegment[]): string {
  const lines: string[] = [];
  for (const seg of segments) {
    const mins = Math.floor(seg.start / 60);
    const secs = Math.floor(seg.start % 60);
    const ts = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    lines.push(`[${ts}] ${seg.text}`);
  }
  return lines.join('\n');
}

async function runDeepSeekAnalysis(
  transcript: TranscriptSegment[],
  metadata: VideoMetadata,
): Promise<AnalysisResult> {
  const apiKey =
    process.env.OPENCODE_GO_API_KEY ||
    process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return { success: false, error: 'No API key found' };
  }

  const transcriptText = formatTranscript(transcript);
  const start = Date.now();

  try {
    const systemPrompt = 'You are a professional short-form content clipper in Indonesia. Your income depends entirely on views. You have 3+ years of experience clipping Indonesian podcast content for TikTok, Reels, and Shorts.';
    const userPrompt = `${ANALYSIS_PROMPT}\n\nVIDEO:\nTitle: ${metadata.title}\nChannel: ${metadata.channelName}\nDuration: ${Math.round(metadata.durationSeconds / 60)} minutes\n\nTRANSCRIPT:\n${transcriptText}`;

    const response = await fetch(DEEPSEEK_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'deepseek-v4-flash',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.3,
        max_tokens: 8192,
      }),
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => 'unknown');
      return {
        success: false,
        error: `DeepSeek API HTTP ${response.status}: ${errBody.slice(0, 200)}`,
        durationMs: Date.now() - start,
        transcriptSize: transcriptText.length,
      };
    }

    const data = await response.json();
    const rawText = data.choices?.[0]?.message?.content;
    if (!rawText) {
      return {
        success: false,
        error: 'Empty response from DeepSeek',
        durationMs: Date.now() - start,
        transcriptSize: transcriptText.length,
      };
    }

    // Extract JSON
    const jsonMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)\s*```/) ?? [null, rawText];
    const jsonStr = jsonMatch[1] ?? rawText;
    const parsed = JSON.parse(jsonStr.trim());

    const elite = parsed.elite_moments || [];
    const secondary = parsed.secondary_moments || [];
    const allMoments = [...elite, ...secondary];
    const avgScore = allMoments.length > 0
      ? Math.round(allMoments.reduce((s: number, m: any) => s + (m.worthClippingScore || 0), 0) / allMoments.length)
      : 0;

    return {
      success: true,
      eliteCount: elite.length,
      secondaryCount: secondary.length,
      totalMoments: allMoments.length,
      avgScore,
      durationMs: Date.now() - start,
      transcriptSize: transcriptText.length,
    };
  } catch (err: any) {
    return {
      success: false,
      error: err.message || 'Analysis failed',
      durationMs: Date.now() - start,
      transcriptSize: transcriptText.length,
    };
  }
}

// ---------------------------------------------------------------------------
// Main Validation
// ---------------------------------------------------------------------------

async function main() {
  console.log('╔═══════════════════════════════════════════════════════════════╗');
  console.log('║        ganyIQ — Cookie Auth Validation (Batch 002)          ║');
  console.log('╚═══════════════════════════════════════════════════════════════╝');
  console.log();

  // Step 0: Verify cookies.txt exists
  if (!fs.existsSync(COOKIE_PATH)) {
    console.error(`❌ Cookie file not found at: ${COOKIE_PATH}`);
    process.exit(1);
  }
  const cookieStr = parseNetscapeCookies(COOKIE_PATH);
  const cookieCount = cookieStr.split(';').length;
  console.log(`📄 Cookie file: ${COOKIE_PATH}`);
  console.log(`   Cookies parsed: ${cookieCount}`);
  console.log();

  // Step 1: Test each video
  const results: FullResult[] = [];
  let anonymousSuccess = 0;
  let cookieSuccess = 0;
  let loginRequiredCount = 0;
  let transcriptUnavailableCount = 0;

  for (let i = 0; i < TEST_VIDEOS.length; i++) {
    const video = TEST_VIDEOS[i];
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`[${i + 1}/${TEST_VIDEOS.length}] ${video.id} — ${video.category.toUpperCase()}`);
    console.log(`   ${video.url}`);
    console.log(`   ${video.channel}`);

    // — Anonymous —
    console.log(`\n   🔒 ANONYMOUS:`);
    const anonStart = Date.now();
    const anonResult = await extractTranscript(video.videoId);
    const anonTime = Date.now() - anonStart;

    if (anonResult.success) {
      anonymousSuccess++;
      const totalChars = anonResult.segments!.reduce((s, seg) => s + seg.text.length, 0);
      console.log(`   ✅ SUCCESS | ${anonResult.segments!.length} segments, ${totalChars} chars, ${anonResult.trackCount} tracks`);
    } else {
      console.log(`   ❌ FAILED  | ${anonResult.errorType}: ${anonResult.error?.slice(0, 100)}`);
      if (anonResult.errorType === 'LOGIN_REQUIRED') loginRequiredCount++;
      if (anonResult.errorType === 'TRANSCRIPT_UNAVAILABLE' || anonResult.errorType === 'NOT_FOUND') transcriptUnavailableCount++;
    }

    // — Cookie-Auth —
    console.log(`   🍪 COOKIE-AUTH:`);
    const cookieStart = Date.now();
    const cookieResult = await extractTranscript(video.videoId, cookieStr);
    const cookieTime = Date.now() - cookieStart;

    if (cookieResult.success) {
      cookieSuccess++;
      const totalChars = cookieResult.segments!.reduce((s, seg) => s + seg.text.length, 0);
      console.log(`   ✅ SUCCESS | ${cookieResult.segments!.length} segments, ${totalChars} chars, ${cookieResult.trackCount} tracks`);
    } else {
      console.log(`   ❌ FAILED  | ${cookieResult.errorType}: ${cookieResult.error?.slice(0, 100)}`);
      if (cookieResult.errorType === 'LOGIN_REQUIRED') loginRequiredCount++;
    }

    // — Full analysis if cookie-auth succeeded —
    let deepseekResult: FullResult['deepseek'] = undefined;
    if (cookieResult.success) {
      const meta = await fetchMetadata(video.videoId);
      const displayTitle = meta?.title ?? video.title;
      const displayChannel = meta?.channelName ?? video.channel;

      console.log(`   🤖 DEEPSEEK ANALYSIS:`);
      const analysis = await runDeepSeekAnalysis(
        cookieResult.segments!,
        meta || { youtubeId: video.videoId, title: video.title, channelName: video.channel, durationSeconds: 0 },
      );

      if (analysis.success) {
        console.log(`   ✅ DONE | ${analysis.totalMoments} moments (${analysis.eliteCount} elite, ${analysis.secondaryCount} secondary), avg score ${analysis.avgScore}, ${(analysis.durationMs! / 1000).toFixed(1)}s`);
        deepseekResult = {
          success: true,
          eliteCount: analysis.eliteCount!,
          secondaryCount: analysis.secondaryCount!,
          totalMoments: analysis.totalMoments!,
          avgScore: analysis.avgScore!,
          durationMs: analysis.durationMs!,
          transcriptSize: analysis.transcriptSize!,
        };
      } else {
        console.log(`   ❌ FAILED | ${analysis.error?.slice(0, 100)}`);
        deepseekResult = {
          success: false,
          eliteCount: 0,
          secondaryCount: 0,
          totalMoments: 0,
          avgScore: 0,
          durationMs: analysis.durationMs || 0,
          transcriptSize: analysis.transcriptSize || 0,
          error: analysis.error,
        };
      }
    }

    results.push({
      video,
      anonymous: anonResult,
      cookieAuth: cookieResult,
      deepseek: deepseekResult,
    });

    // Rate limit politeness
    if (i < TEST_VIDEOS.length - 1) {
      console.log(`\n   ⏳ Waiting 1.5s before next video...`);
      await new Promise(r => setTimeout(r, 1500));
    }
  }

  // ---------------------------------------------------------------------------
  // Compute Metrics
  // ---------------------------------------------------------------------------

  const total = TEST_VIDEOS.length;
  const anonymousCoverage = Math.round((anonymousSuccess / total) * 100);
  const cookieCoverage = Math.round((cookieSuccess / total) * 100);
  const improvement = cookieCoverage - anonymousCoverage;

  console.log('\n');
  console.log('╔═══════════════════════════════════════════════════════════════╗');
  console.log('║                     VALIDATION RESULTS                       ║');
  console.log('╚═══════════════════════════════════════════════════════════════╝');
  console.log();
  console.log(`📊 TOTAL VIDEOS TESTED:    ${total}`);
  console.log(`📊 ANONYMOUS SUCCESS:      ${anonymousSuccess}/${total} (${anonymousCoverage}%)`);
  console.log(`📊 COOKIE-AUTH SUCCESS:    ${cookieSuccess}/${total} (${cookieCoverage}%)`);
  console.log(`📊 IMPROVEMENT:            ${improvement >= 0 ? '+' : ''}${improvement}%`);
  console.log(`📊 LOGIN_REQUIRED:         ${loginRequiredCount}x`);
  console.log(`📊 TRANSCRIPT_UNAVAILABLE: ${transcriptUnavailableCount}x`);
  console.log();

  // Verdict
  let verdict: string;
  let verdictSymbol: string;
  if (cookieCoverage >= 70) {
    verdict = 'PASS';
    verdictSymbol = '✅';
  } else if (cookieCoverage >= 30) {
    verdict = 'PARTIAL';
    verdictSymbol = '⚠️';
  } else {
    verdict = 'FAIL';
    verdictSymbol = '❌';
  }

  console.log(`${'═'.repeat(60)}`);
  console.log(`🏁 VERDICT: ${verdictSymbol} ${verdict}`);
  console.log(`${'═'.repeat(60)}`);
  console.log();

  // ===========================================================================
  // OUTPUT: docs/COOKIE_AUTH_VALIDATION_RESULTS.md
  // ===========================================================================

  const mdResults = generateValidationResults(results, {
    total, anonymousSuccess, cookieSuccess, anonymousCoverage, cookieCoverage,
    improvement, loginRequiredCount, transcriptUnavailableCount, verdict,
  });

  fs.writeFileSync('/root/GANYIQ/docs/COOKIE_AUTH_VALIDATION_RESULTS.md', mdResults);
  console.log('📄 Written: docs/COOKIE_AUTH_VALIDATION_RESULTS.md');

  // ===========================================================================
  // OUTPUT: docs/VALIDATION_BATCH_002_REPORT.md
  // ===========================================================================

  const mdReport = generateBatchReport(results, {
    total, anonymousSuccess, cookieSuccess, anonymousCoverage, cookieCoverage,
    improvement, loginRequiredCount, transcriptUnavailableCount, verdict,
  });

  fs.writeFileSync('/root/GANYIQ/docs/VALIDATION_BATCH_002_REPORT.md', mdReport);
  console.log('📄 Written: docs/VALIDATION_BATCH_002_REPORT.md');

  console.log('\n✅ Validation complete!');
}

// ---------------------------------------------------------------------------
// Report Generators
// ---------------------------------------------------------------------------

function generateValidationResults(
  results: FullResult[],
  metrics: {
    total: number; anonymousSuccess: number; cookieSuccess: number;
    anonymousCoverage: number; cookieCoverage: number;
    improvement: number; loginRequiredCount: number;
    transcriptUnavailableCount: number; verdict: string;
  },
): string {
  const lines: string[] = [];
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

  lines.push('# Cookie Auth Validation Results');
  lines.push('');
  lines.push(`> **Date:** ${now}`);
  lines.push(`> **Purpose:** Validate whether cookie-authenticated YouTube requests improve transcript coverage for Indonesian podcast videos`);
  lines.push(`> **Method:** Each video tested twice — anonymous vs cookie-auth`);
  lines.push(`> **Cookie file:** \`cookies.txt\` (${fs.statSync(COOKIE_PATH).size} bytes, Netscape format)`);
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('## Summary Metrics');
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('|---|---|');
  lines.push(`| Total Videos Tested | ${metrics.total} |`);
  lines.push(`| Anonymous Success | ${metrics.anonymousSuccess}/${metrics.total} (${metrics.anonymousCoverage}%) |`);
  lines.push(`| Cookie-Auth Success | ${metrics.cookieSuccess}/${metrics.total} (${metrics.cookieCoverage}%) |`);
  lines.push(`| Improvement | ${metrics.improvement >= 0 ? '+' : ''}${metrics.improvement} pp |`);
  lines.push(`| LOGIN_REQUIRED Count | ${metrics.loginRequiredCount} |`);
  lines.push(`| TRANSCRIPT_UNAVAILABLE Count | ${metrics.transcriptUnavailableCount} |`);
  lines.push('');
  lines.push(`**Verdict: ${metrics.verdict}**`);
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('## Per-Video Results');
  lines.push('');

  for (const r of results) {
    const anonStatus = r.anonymous.success ? '✅' : '❌';
    const cookieStatus = r.cookieAuth.success ? '✅' : '❌';

    lines.push(`### ${r.video.id} — ${r.video.category}`);
    lines.push('');
    lines.push(`**URL:** ${r.video.url}`);
    lines.push(`**Channel:** ${r.video.channel}`);
    lines.push('');
    lines.push('| Mode | Result | Tracks | Segments | Chars | Time | Error |');
    lines.push('|---|---|---|---|---|---|---|');

    const anonTrack = r.anonymous.success ? r.anonymous.trackCount?.toString() ?? '-' : '-';
    const anonSeg = r.anonymous.success ? r.anonymous.segments?.length.toString() ?? '-' : '-';
    const anonChars = r.anonymous.success
      ? (r.anonymous.segments!.reduce((s, seg) => s + seg.text.length, 0)).toLocaleString()
      : '-';
    const anonTime = r.anonymous.durationMs ? `${(r.anonymous.durationMs / 1000).toFixed(1)}s` : '-';
    const anonErr = r.anonymous.success ? '-' : (r.anonymous.errorType || r.anonymous.error?.slice(0, 60) || 'FAILED');

    const cookieTrack = r.cookieAuth.success ? r.cookieAuth.trackCount?.toString() ?? '-' : '-';
    const cookieSeg = r.cookieAuth.success ? r.cookieAuth.segments?.length.toString() ?? '-' : '-';
    const cookieChars = r.cookieAuth.success
      ? (r.cookieAuth.segments!.reduce((s, seg) => s + seg.text.length, 0)).toLocaleString()
      : '-';
    const cookieTime = r.cookieAuth.durationMs ? `${(r.cookieAuth.durationMs / 1000).toFixed(1)}s` : '-';
    const cookieErr = r.cookieAuth.success ? '-' : (r.cookieAuth.errorType || r.cookieAuth.error?.slice(0, 60) || 'FAILED');

    lines.push(`| Anonymous | ${anonStatus} | ${anonTrack} | ${anonSeg} | ${anonChars} | ${anonTime} | ${anonErr} |`);
    lines.push(`| Cookie-Auth | ${cookieStatus} | ${cookieTrack} | ${cookieSeg} | ${cookieChars} | ${cookieTime} | ${cookieErr} |`);
    lines.push('');

    if (r.cookieAuth.success) {
      lines.push(`**Selected Track:** ${r.cookieAuth.selectedTrack} (${r.cookieAuth.trackKind})`);
      lines.push('');
    }

    // DeepSeek analysis results
    if (r.deepseek) {
      lines.push('**DeepSeek V4 Flash Analysis:**');
      lines.push('');
      if (r.deepseek.success) {
        lines.push(`- ✅ Success | ${r.deepseek.totalMoments} moments (${r.deepseek.eliteCount} elite, ${r.deepseek.secondaryCount} secondary)`);
        lines.push(`- Average Score: ${r.deepseek.avgScore}/100`);
        lines.push(`- Processing Time: ${(r.deepseek.durationMs / 1000).toFixed(1)}s`);
        lines.push(`- Transcript Size: ${r.deepseek.transcriptSize.toLocaleString()} chars`);
      } else {
        lines.push(`- ❌ Failed: ${r.deepseek.error}`);
      }
      lines.push('');
    }

    lines.push('---');
    lines.push('');
  }

  lines.push('## Detailed Error Breakdown');
  lines.push('');
  lines.push('| Error Type | Anonymous | Cookie-Auth |');
  lines.push('|---|---|---|');

  const anonErrors: Record<string, number> = {};
  const cookieErrors: Record<string, number> = {};
  for (const r of results) {
    if (!r.anonymous.success) {
      const et = r.anonymous.errorType || 'UNKNOWN';
      anonErrors[et] = (anonErrors[et] || 0) + 1;
    }
    if (!r.cookieAuth.success) {
      const et = r.cookieAuth.errorType || 'UNKNOWN';
      cookieErrors[et] = (cookieErrors[et] || 0) + 1;
    }
  }

  const allErrorTypes = new Set([...Object.keys(anonErrors), ...Object.keys(cookieErrors)]);
  for (const et of [...allErrorTypes].sort()) {
    lines.push(`| ${et} | ${anonErrors[et] || 0} | ${cookieErrors[et] || 0} |`);
  }

  lines.push('');
  lines.push('## Raw Data');
  lines.push('');
  lines.push('```json');
  lines.push(JSON.stringify({ results, metrics }, null, 2));
  lines.push('```');
  lines.push('');

  return lines.join('\n');
}

function generateBatchReport(
  results: FullResult[],
  metrics: {
    total: number; anonymousSuccess: number; cookieSuccess: number;
    anonymousCoverage: number; cookieCoverage: number;
    improvement: number; loginRequiredCount: number;
    transcriptUnavailableCount: number; verdict: string;
  },
): string {
  const lines: string[] = [];
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

  lines.push('# VALIDATION BATCH 002 — Cookie Auth Coverage Report');
  lines.push('');
  lines.push(`> **Date:** ${now}`);
  lines.push(`> **Tester:** VPS (DigitalOcean Singapore, 68.183.231.223)`);
  lines.push(`> **Scope:** Transcript coverage validation — Anonymous vs Cookie-Auth`);
  lines.push(`> **Videos Tested:** ${metrics.total}`);
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('## 1. Executive Summary');
  lines.push('');
  lines.push(`This report validates whether cookie-authenticated YouTube API requests improve transcript`);
  lines.push(`acquisition success rates for Indonesian podcast content from a DigitalOcean VPS.`);
  lines.push('');
  lines.push(`**Key Finding:** Cookie authentication ${metrics.improvement >= 0 ? 'im' : 'de'}proves transcript coverage by ${Math.abs(metrics.improvement)} percentage points`);
  lines.push(`(${metrics.anonymousCoverage}% anonymous → ${metrics.cookieCoverage}% cookie-auth).`);
  lines.push('');
  lines.push(`**Verdict: ${metrics.verdict}**`);
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('## 2. Methodology');
  lines.push('');
  lines.push('Each video was tested in two modes:');
  lines.push('');
  lines.push('1. **Anonymous:** Direct InnerTube API call (Android client context, no authentication)');
  lines.push('2. **Cookie-Auth:** Same InnerTube API call with browser-exported cookies attached');
  lines.push('');
  lines.push('Cookie file format: Netscape HTTP Cookie File (from Chrome extension export)');
  lines.push(`Session cookies from: youtube.com (__Secure-YNID, etc.)`);
  lines.push('');
  lines.push('### Test Videos by Category');
  lines.push('');

  const byCategory: Record<string, TestResult[]> = {};
  for (const r of results) {
    if (!byCategory[r.video.category]) byCategory[r.video.category] = [];
    byCategory[r.video.category].push(r as any);
  }

  // Table by category
  lines.push('| Category | Videos | Anonymous OK | Cookie-Auth OK |');
  lines.push('|---|---|---|---|');
  for (const [cat, vids] of Object.entries(byCategory).sort()) {
    const anonOk = vids.filter(v => v.anonymous.success).length;
    const cookieOk = vids.filter(v => v.cookieAuth.success).length;
    const niceCat = cat.charAt(0).toUpperCase() + cat.slice(1);
    lines.push(`| ${niceCat} | ${vids.length} | ${anonOk} | ${cookieOk} |`);
  }

  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('## 3. Results by Category');
  lines.push('');

  for (const [cat, vids] of Object.entries(byCategory).sort()) {
    const niceCat = cat.charAt(0).toUpperCase() + cat.slice(1);
    lines.push(`### ${niceCat}`);
    lines.push('');

    for (const r of vids) {
      const anonStatus = r.anonymous.success ? '✅' : '❌';
      const cookieStatus = r.cookieAuth.success ? '✅' : '❌';
      const anonDetail = r.anonymous.success
        ? `${r.anonymous.segments!.length} seg, ${(r.anonymous.segments!.reduce((s, seg) => s + seg.text.length, 0)).toLocaleString()} chars`
        : r.anonymous.errorType || 'FAILED';
      const cookieDetail = r.cookieAuth.success
        ? `${r.cookieAuth.segments!.length} seg, ${(r.cookieAuth.segments!.reduce((s, seg) => s + seg.text.length, 0)).toLocaleString()} chars`
        : r.cookieAuth.errorType || 'FAILED';

      lines.push(`- **${r.video.channel}** [${r.video.id}]`);
      lines.push(`  - Anonymous: ${anonStatus} ${anonDetail}`);
      lines.push(`  - Cookie-Auth: ${cookieStatus} ${cookieDetail}`);

      if (r.deepseek) {
        if (r.deepseek.success) {
          lines.push(`  - Analysis: ✅ ${r.deepseek.totalMoments} moments (${r.deepseek.eliteCount} elite, ${r.deepseek.secondaryCount} secondary), avg ${r.deepseek.avgScore}/100`);
        } else {
          lines.push(`  - Analysis: ❌ ${r.deepseek.error?.slice(0, 80)}`);
        }
      }
      lines.push('');
    }
  }

  lines.push('---');
  lines.push('');
  lines.push('## 4. DeepSeek V4 Flash Analysis Summary');
  lines.push('');

  const analysisResults = results.filter(r => r.deepseek?.success);
  if (analysisResults.length > 0) {
    const totalElite = analysisResults.reduce((s, r) => s + (r.deepseek?.eliteCount || 0), 0);
    const totalSecondary = analysisResults.reduce((s, r) => s + (r.deepseek?.secondaryCount || 0), 0);
    const totalMoments = analysisResults.reduce((s, r) => s + (r.deepseek?.totalMoments || 0), 0);
    const avgScores = analysisResults.map(r => r.deepseek?.avgScore || 0);
    const overallAvgScore = Math.round(avgScores.reduce((s, v) => s + v, 0) / avgScores.length);
    const avgTime = Math.round(analysisResults.reduce((s, r) => s + (r.deepseek?.durationMs || 0), 0) / analysisResults.length);
    const avgTranscriptSize = Math.round(analysisResults.reduce((s, r) => s + (r.deepseek?.transcriptSize || 0), 0) / analysisResults.length);

    lines.push('| Metric | Value |');
    lines.push('|---|---|');
    lines.push(`| Videos Analyzed | ${analysisResults.length}/${metrics.total} |`);
    lines.push(`| Total Moments Found | ${totalMoments} |`);
    lines.push(`| Elite Moments | ${totalElite} (${Math.round(totalElite / totalMoments * 100)}%) |`);
    lines.push(`| Secondary Moments | ${totalSecondary} (${Math.round(totalSecondary / totalMoments * 100)}%) |`);
    lines.push(`| Overall Avg Score | ${overallAvgScore}/100 |`);
    lines.push(`| Avg Processing Time | ${(avgTime / 1000).toFixed(1)}s |`);
    lines.push(`| Avg Transcript Size | ${avgTranscriptSize.toLocaleString()} chars |`);
    lines.push('');
    lines.push('#### Per-Video Analysis Detail');
    lines.push('');
    lines.push('| Video | Elite | Secondary | Total | Avg Score | Time |');
    lines.push('|---|---|---|---|---|---|');
    for (const r of analysisResults) {
      lines.push(`| ${r.video.id} (${r.video.channel.slice(0, 20)}) | ${r.deepseek?.eliteCount} | ${r.deepseek?.secondaryCount} | ${r.deepseek?.totalMoments} | ${r.deepseek?.avgScore} | ${((r.deepseek?.durationMs || 0) / 1000).toFixed(1)}s |`);
    }
  } else {
    lines.push('No successful DeepSeek analyses to report.');
  }

  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('## 5. Verdict & Recommendations');
  lines.push('');

  lines.push(`### Verdict: **${metrics.verdict}**`);
  lines.push('');

  if (metrics.verdict === 'PASS') {
    lines.push('Cookie authentication provides sufficient transcript coverage for production use.');
    lines.push('The cookies.txt file should be integrated into the application\'s YouTube transcript');
    lines.push('acquisition pipeline as a drop-in credential source.');
    lines.push('');
    lines.push('**Recommendations:**');
    lines.push('');
    lines.push('1. **Integrate cookies.txt** path into the app configuration (COOKIE_PATH env var)');
    lines.push('2. **Auto-refresh** — cookies expire; set up a monthly reminder or auto-refresh');
    lines.push('3. **Fallback chain** — try cookie-auth first, fall back to anonymous');
    lines.push('4. **Monitor** — track coverage changes over time');
  } else if (metrics.verdict === 'PARTIAL') {
    lines.push('Cookie authentication improves coverage but does not fully solve the problem.');
    lines.push('Additional strategies should be explored for the remaining uncovered videos.');
    lines.push('');
    lines.push('**Recommendations:**');
    lines.push('');
    lines.push('1. **Integrate cookies.txt** — improvement is meaningful, use it as primary strategy');
    lines.push('2. **YouTube Data API v3** — add as secondary fallback for remaining failures');
    lines.push('3. **Investigate failures** — check if failed videos lack captions entirely');
    lines.push('4. **Session rotation** — consider multiple cookie sources if rate limiting persists');
  } else {
    lines.push('Cookie authentication does not provide adequate transcript coverage.');
    lines.push('Alternative approaches are needed for transcript acquisition.');
    lines.push('');
    lines.push('**Recommendations:**');
    lines.push('');
    lines.push('1. **YouTube Data API v3** — official API is the most reliable path');
    lines.push('2. **Whisper API** — audio-based transcription as ultimate fallback');
    lines.push('3. **Check cookie freshness** — expired cookies provide no benefit');
    lines.push('4. **Re-export cookies** — ensure the session is logged into a valid YouTube account');
  }

  lines.push('');
  lines.push('### Detailed Recommendations');
  lines.push('');

  if (metrics.loginRequiredCount > 0) {
    lines.push(`- **LOGIN_REQUIRED issues (${metrics.loginRequiredCount}x):** Videos requiring login`);
    lines.push(`  ${metrics.cookieSuccess > metrics.anonymousSuccess ? 'were resolved' : 'were NOT resolved'} by cookie authentication.`);
    const newlyUnlocked = results.filter(r => !r.anonymous.success && r.cookieAuth.success && r.anonymous.errorType === 'LOGIN_REQUIRED');
    if (newlyUnlocked.length > 0) {
      lines.push(`  Videos unlocked by cookies: ${newlyUnlocked.map(r => r.video.id).join(', ')}`);
    }
    lines.push('');
  }

  if (metrics.transcriptUnavailableCount > 0) {
    lines.push(`- **TRANSCRIPT_UNAVAILABLE (${metrics.transcriptUnavailableCount}x):** These videos`);
    lines.push(`  likely have no captions at all. Cookie auth cannot generate captions that don't exist.`);
    const stillNoTranscript = results.filter(r => !r.cookieAuth.success && r.cookieAuth.errorType === 'TRANSCRIPT_UNAVAILABLE');
    if (stillNoTranscript.length > 0) {
      lines.push(`  Videos without captions: ${stillNoTranscript.map(r => r.video.id).join(', ')}`);
    }
    lines.push('');
  }

  const newlyAccessible = results.filter(r => !r.anonymous.success && r.cookieAuth.success);
  if (newlyAccessible.length > 0) {
    lines.push(`- **Newly accessible with cookies (${newlyAccessible.length}):**`);
    for (const r of newlyAccessible) {
      lines.push(`  - ${r.video.id} (${r.video.channel}): ${r.anonymous.errorType} → ✅`);
    }
    lines.push('');
  }

  const stillBlocked = results.filter(r => !r.cookieAuth.success);
  if (stillBlocked.length > 0) {
    lines.push(`- **Still blocked (${stillBlocked.length}):**`);
    for (const r of stillBlocked) {
      lines.push(`  - ${r.video.id} (${r.video.channel}): ${r.cookieAuth.errorType}`);
    }
    lines.push('');
    lines.push('  For these videos, consider: YouTube Data API v3 or Whisper API fallback.');
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push('## 6. Appendix');
  lines.push('');
  lines.push('### Environment');
  lines.push('');
  lines.push('| Parameter | Value |');
  lines.push('|---|---|');
  lines.push(`| Server | DigitalOcean Singapore (${require('os').hostname() || 'unknown'}) |`);
  lines.push(`| IP | 68.183.231.223 |`);
  lines.push(`| Cookie File | ${COOKIE_PATH} (${fs.statSync(COOKIE_PATH).size} bytes) |`);
  lines.push(`| Cookie Count | ${metrics.total} |`);
  lines.push(`| Test Date | ${now} |`);
  lines.push(`| YouTube API | InnerTube (Android client v20.10.38) |`);
  lines.push('');
  lines.push('### Cookie File Validation');
  lines.push('');
  lines.push(`File: \`${COOKIE_PATH}\``);
  lines.push(`Size: ${fs.statSync(COOKIE_PATH).size} bytes`);
  lines.push(`Format: Netscape HTTP Cookie File`);
  lines.push(`Parsed cookies: ${metrics.total}`);
  lines.push(`Domain: .youtube.com`);
  lines.push('');
  lines.push('### Notes');
  lines.push('');
  lines.push('- Cookies expire over time; validation results are timestamp-specific');
  lines.push('- Some videos may not have captions regardless of auth state');
  lines.push('- Rate limiting may cause temporary failures not related to auth');
  lines.push('- InnerTube Android API is used (same as youtube-transcript library)');
  lines.push('');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
