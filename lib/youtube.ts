/**
 * YouTube transcript and metadata extraction pipeline.
 *
 * RELIES ON: InnerTube API + XML transcript parsing (proven working).
 * DOES NOT USE: youtubei.js.getTranscript() (confirmed broken in proof).
 *
 * Flow:
 *   1. Check database cache (avoid re-fetching same video)
 *   2. If not cached: fetch metadata via Innertube + captions via InnerTube API
 *   3. Parse transcript XML (format 3, fallback to legacy format 1)
 *   4. Cache result in database
 *   5. Return VideoData
 */

import { Innertube, UniversalCache } from 'youtubei.js';
import { AppError } from '@/lib/errors';
import { query } from '@/db/client';
import type {
  VideoData,
  VideoMetadata,
  TranscriptSegment,
} from '@/lib/types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const INNERTUBE_PLAYER_URL =
  'https://www.youtube.com/youtubei/v1/player?prettyPrint=false';

const INNERTUBE_UA =
  'com.google.android.youtube/20.10.38 (Linux; U; Android 14)';

/** Max gap between words in seconds — larger gaps start a new segment. */
const MAX_WORD_GAP = 1.0;

/** Target segment duration in seconds. */
const SEGMENT_TARGET = 5.0;

/** Preferred language for caption tracks. */
const PREFERRED_LANG = 'id';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CaptionTrack {
  baseUrl: string;
  languageCode: string;
  name: { simpleText?: string; runs?: { text: string }[] };
  kind?: string; // 'asr' = auto-generated
}

// ---------------------------------------------------------------------------
// 1. CAPTION TRACK DISCOVERY (InnerTube API)
// ---------------------------------------------------------------------------

/**
 * Fetch caption tracks from a YouTube video via InnerTube API.
 * Uses Android client context (same approach as youtube-transcript library).
 *
 * @throws AppError TRANSCRIPT_UNAVAILABLE if no tracks found.
 */
async function fetchCaptionTracks(videoId: string): Promise<CaptionTrack[]> {
  const resp = await fetch(INNERTUBE_PLAYER_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': INNERTUBE_UA,
    },
    body: JSON.stringify({
      context: {
        client: { clientName: 'ANDROID', clientVersion: '20.10.38' },
      },
      videoId,
    }),
  });

  if (!resp.ok) {
    throw new AppError(
      'TRANSCRIPT_UNAVAILABLE',
      `YouTube API returned HTTP ${resp.status} for video ${videoId}.`,
      404,
    );
  }

  const data = await resp.json();
  const tracks: CaptionTrack[] =
    data?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];

  if (tracks.length === 0) {
    throw new AppError(
      'TRANSCRIPT_UNAVAILABLE',
      `No caption tracks available for video ${videoId}. ` +
        'The video may not have captions enabled.',
      404,
    );
  }

  return tracks;
}

// ---------------------------------------------------------------------------
// 2. XML TRANSCRIPT PARSING
// ---------------------------------------------------------------------------

/**
 * Fetch and parse a timedtext XML transcript from a caption track base URL.
 *
 * Handles two YouTube timedtext formats:
 *   - Format 3 (current): <p t="START_MS" d="DUR_MS">...</p>
 *   - Format 1 (legacy):  <text start="..." dur="...">text</text>
 *
 * Words are grouped into segments of ~5 seconds each for efficient LLM input.
 *
 * @throws AppError TRANSCRIPT_UNAVAILABLE if XML is empty or unparseable.
 */
async function fetchTranscriptXml(baseUrl: string): Promise<TranscriptSegment[]> {
  const resp = await fetch(baseUrl, {
    headers: { 'User-Agent': INNERTUBE_UA },
  });
  const xml = await resp.text();

  // -------------------------------------------------------
  // Format 3: <p t="START_MS" d="DUR_MS"><s t="OFFSET_MS">word</s>...</p>
  // -------------------------------------------------------
  const rawWords: { timeSec: number; text: string }[] = [];
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

  // -------------------------------------------------------
  // Format 1 (legacy): <text start="..." dur="...">text</text>
  // -------------------------------------------------------
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
    throw new AppError(
      'TRANSCRIPT_UNAVAILABLE',
      'Transcript XML contained no parseable segments.',
      404,
    );
  }

  // -------------------------------------------------------
  // Group words into segments of ~5 seconds
  // -------------------------------------------------------
  const segments: TranscriptSegment[] = [];
  let segStart = rawWords[0].timeSec;
  let segWords: string[] = [];

  for (let i = 0; i < rawWords.length; i++) {
    const w = rawWords[i];
    const prevTime = i > 0 ? rawWords[i - 1].timeSec : segStart;

    // Start new segment if accumulated >5s or large gap
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

  // Final segment
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

// ---------------------------------------------------------------------------
// 3. TRACK SELECTION
// ---------------------------------------------------------------------------

/** Extract a human-readable track name from a CaptionTrack object. */
function getTrackName(track: CaptionTrack): string {
  return track.name?.simpleText ?? track.name?.runs?.[0]?.text ?? track.languageCode;
}

/**
 * Pick the best caption track for Indonesian podcast analysis.
 *
 * Priority:
 *   1. Auto-generated (ASR) Indonesian
 *   2. Auto-generated any language
 *   3. Manual Indonesian
 *   4. Any available track
 */
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
// 4. METADATA EXTRACTION (youtubei.js — works for metadata, NOT transcripts)
// ---------------------------------------------------------------------------

/**
 * Fetch video metadata via youtubei.js Innertube client.
 * @returns VideoMetadata with title, channelName, durationSeconds, youtubeId
 * @throws AppError if metadata cannot be fetched
 */
async function fetchMetadata(videoId: string): Promise<VideoMetadata> {
  try {
    const yt = await Innertube.create({ cache: new UniversalCache(true) });
    const info = await yt.getInfo(videoId);

    return {
      youtubeId: videoId,
      title: info.basic_info.title?.toString() ?? 'Unknown',
      channelName: info.basic_info.author?.toString() ?? 'Unknown',
      durationSeconds: info.basic_info.duration ?? 0,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    throw new AppError(
      'ANALYSIS_FAILED',
      `Failed to fetch video metadata: ${msg}`,
      500,
    );
  }
}

// ---------------------------------------------------------------------------
// 5. MAIN EXTRACTION ORCHESTRATION
// ---------------------------------------------------------------------------

/**
 * Extract transcript + metadata from a YouTube video.
 *
 * Uses youtubei.js for reliable metadata, then InnerTube API for caption
 * track discovery and XML parsing (the proven-working approach).
 *
 * @throws AppError for missing captions, API failures, or parse errors.
 */
async function extractVideo(videoId: string): Promise<VideoData> {
  // Step 1: Get metadata via youtubei.js (reliable)
  const metadata = await fetchMetadata(videoId);

  // Step 2: Get caption tracks via InnerTube API
  const tracks = await fetchCaptionTracks(videoId);
  const track = selectTrack(tracks);

  // Step 3: Fetch and parse transcript XML
  const transcript = await fetchTranscriptXml(track.baseUrl);

  return { metadata, transcript };
}

// ---------------------------------------------------------------------------
// 6. DATABASE CACHING
// ---------------------------------------------------------------------------

/**
 * Check the database for a cached video by youtube_id.
 * Returns VideoData if a cached entry with transcript exists, or null.
 */
async function getCachedVideo(youtubeId: string): Promise<VideoData | null> {
  const result = await query<{
    title: string;
    channel_name: string;
    duration_seconds: number;
    transcript: unknown;
  }>(
    `SELECT title, channel_name, duration_seconds, transcript
     FROM videos
     WHERE youtube_id = $1 AND transcript IS NOT NULL`,
    [youtubeId],
  );

  if (result.rows.length === 0) return null;

  const row = result.rows[0];

  // Safely parse the JSONB transcript back to TranscriptSegment[]
  let transcript: TranscriptSegment[];
  try {
    transcript = JSON.parse(JSON.stringify(row.transcript)) as TranscriptSegment[];
  } catch {
    // Corrupted cache — treat as not cached
    return null;
  }

  if (!Array.isArray(transcript) || transcript.length === 0) {
    return null;
  }

  return {
    metadata: {
      youtubeId,
      title: row.title ?? 'Unknown',
      channelName: row.channel_name ?? 'Unknown',
      durationSeconds: row.duration_seconds ?? 0,
    },
    transcript,
  };
}

/**
 * Insert a fetched video into the database cache.
 * Returns the UUID of the inserted row.
 */
async function cacheVideo(data: VideoData): Promise<string> {
  const result = await query<{ id: string }>(
    `INSERT INTO videos (youtube_id, title, channel_name, duration_seconds, transcript)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     ON CONFLICT (youtube_id)
     DO UPDATE SET
       title       = EXCLUDED.title,
       channel_name = EXCLUDED.channel_name,
       duration_seconds = EXCLUDED.duration_seconds,
       transcript  = EXCLUDED.transcript,
       fetched_at  = NOW()
     RETURNING id`,
    [
      data.metadata.youtubeId,
      data.metadata.title,
      data.metadata.channelName,
      data.metadata.durationSeconds,
      JSON.stringify(data.transcript),
    ],
  );

  return result.rows[0].id;
}

// ---------------------------------------------------------------------------
// 7. EXPORTED API
// ---------------------------------------------------------------------------

/**
 * Fetch video data (metadata + transcript) for a given YouTube video ID.
 *
 * Uses smart caching: checks the database first; only fetches from YouTube
 * if no cached version exists. New fetches are automatically cached.
 *
 * @param youtubeId - 11-character YouTube video ID
 * @returns VideoData with metadata and parsed transcript segments
 *
 * @throws AppError
 *   - TRANSCRIPT_UNAVAILABLE: no captions or parse failed
 *   - ANALYSIS_FAILED: metadata fetch failed
 */
export async function fetchVideoData(youtubeId: string): Promise<VideoData & { videoDbId: string }> {
  // 1. Try cache
  const cached = await getCachedVideo(youtubeId);
  if (cached) {
    // Need the video DB ID for downstream use — fetch it
    const idResult = await query<{ id: string }>(
      'SELECT id FROM videos WHERE youtube_id = $1',
      [youtubeId],
    );
    return {
      ...cached,
      videoDbId: idResult.rows[0]?.id ?? '',
    };
  }

  // 2. Fetch from YouTube
  const data = await extractVideo(youtubeId);

  // 3. Cache in database
  const videoDbId = await cacheVideo(data);

  return { ...data, videoDbId };
}

/**
 * Format transcript segments into timestamped text for LLM prompt injection.
 *
 * Output format:
 *   [MM:SS] text content
 *   [MM:SS] text content
 *   ...
 *
 * @param segments - Array of transcript segments
 * @returns Formatted string ready for prompt template.
 */
export function formatTranscriptForPrompt(segments: TranscriptSegment[]): string {
  const lines: string[] = [];
  for (const seg of segments) {
    const mins = Math.floor(seg.start / 60);
    const secs = Math.floor(seg.start % 60);
    const ts = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    lines.push(`[${ts}] ${seg.text}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Internal Helpers
// ---------------------------------------------------------------------------

/**
 * Decode XML/HTML entities in transcript text.
 */
function decodeXmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\\n/g, ' ');
}
