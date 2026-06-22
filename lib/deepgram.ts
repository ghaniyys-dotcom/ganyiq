/**
 * lib/deepgram.ts — Deepgram STT transcription module.
 *
 * Pure transcription: no knowledge of YouTube transcripts or analysis pipeline.
 * Called by lib/transcript-service.ts as fallback when YouTube fails.
 *
 * Flow:
 *   yt-dlp audio download → Deepgram binary upload → word-level timestamps
 *   → TranscriptSegment[] (same format as youtube.ts)
 *
 * Requires:
 *   - DEEPGRAM_API_KEY in environment or .env.local
 *   - yt-dlp installed on the system
 */

import { exec } from 'node:child_process';
import { readFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { AppError } from '@/lib/errors';
import type { TranscriptSegment } from '@/lib/types';

const execAsync = promisify(exec);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Target segment duration in seconds (matches youtube.ts). */
const SEGMENT_TARGET = 5.0;

/** Max gap between words in seconds before forcing a new segment. */
const MAX_WORD_GAP = 1.0;

/** Deepgram API base URL. */
const DEEPGRAM_BASE = 'https://api.deepgram.com/v1/listen';

/** Audio download timeout (5 min). */
const DL_TIMEOUT = 300_000;

/** Deepgram API timeout (10 min — transcription of long podcasts). */
const DG_TIMEOUT = 600_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DeepgramResult {
  /** Transcript segments compatible with the analysis pipeline. */
  segments: TranscriptSegment[];
  /** Overall confidence score (0-1). */
  confidence: number;
  /** Full plain-text transcript for debug/logging. */
  fullTranscript: string;
}

/** Raw word from Deepgram response JSON. */
interface DgWord {
  word: string;
  start: number;
  end: number;
}

/** Parsed Deepgram API response shape. */
interface DgResponse {
  results?: {
    channels?: Array<{
      alternatives?: Array<{
        transcript?: string;
        confidence?: number;
        words?: Array<{
          word?: string;
          punctuated_word?: string;
          start?: number;
          end?: number;
          confidence?: number;
        }>;
      }>;
    }>;
  };
  metadata?: {
    request_id?: string;
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Transcribe a YouTube video via Deepgram STT.
 *
 * Downloads audio with yt-dlp, uploads to Deepgram, returns word-level
 * transcript segments in the same format as youtube.ts.
 *
 * @param youtubeUrl - Full YouTube URL (e.g. https://youtu.be/VIDEO_ID)
 * @returns Segments, confidence, and full transcript text
 * @throws AppError on any failure (key missing, download error, API error)
 */
export async function fetchDeepgramTranscript(
  youtubeUrl: string,
): Promise<DeepgramResult> {
  const apiKey = resolveApiKey();
  const tmpFile = `/tmp/ganyiq-dg-${Date.now()}.mp4`;

  try {
    // Step 1: Download audio with yt-dlp
    const audioBuf = await downloadAudio(youtubeUrl, tmpFile);

    // Step 2: Send to Deepgram
    const dgResult = await transcribeAudio(audioBuf, apiKey);

    // Step 3: Convert word-level data to TranscriptSegment[]
    const segments = wordsToSegments(dgResult.words);

    return {
      segments,
      confidence: dgResult.confidence,
      fullTranscript: dgResult.fullTranscript,
    };
  } finally {
    // Cleanup temp file even on error
    try { unlinkSync(tmpFile); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Internal: API Key Resolution
// ---------------------------------------------------------------------------

function resolveApiKey(): string {
  // Try environment variable first
  let key = process.env.DEEPGRAM_API_KEY;
  if (key && key.length > 10) return key;

  // Fallback: parse .env.local
  try {
    const envContent = readFileSync(join(process.cwd(), '.env.local'), 'utf-8');
    const match = envContent.match(/^DEEPGRAM_API_KEY=(.+)$/m);
    if (match) {
      key = match[1].trim();
      if (key.length > 10) return key;
    }
  } catch { /* .env.local may not exist */ }

  throw new AppError(
    'ANALYSIS_FAILED',
    'Deepgram API key not configured. Set DEEPGRAM_API_KEY in .env.local or environment.',
    500,
  );
}

// ---------------------------------------------------------------------------
// Internal: Audio Download with yt-dlp
// ---------------------------------------------------------------------------

async function downloadAudio(youtubeUrl: string, outputPath: string): Promise<Buffer> {
  // Check yt-dlp is available
  try {
    await execAsync('which yt-dlp', { timeout: 5_000 });
  } catch {
    throw new AppError(
      'TRANSCRIPT_UNAVAILABLE',
      'yt-dlp not available — cannot use Deepgram fallback.',
      500,
    );
  }

  // Determine cookie file for yt-dlp (VPS needs cookies for YouTube access)
  const cookieFile = '/root/GANYIQ/cookies.txt';
  const cookieExists = existsSync(cookieFile);
  // NOTE: Do NOT use --extractor-args "youtube:player_client=android" when cookies are present.
  // The ANDROID client does NOT support cookies and yt-dlp will skip it entirely,
  // causing "No video formats found!". Let yt-dlp choose the best client automatically.
  const cookieArg = cookieExists ? `--cookies "${cookieFile}"` : '';

  try {
    console.log(`[DEEPDOWNLOAD] Starting audio download (async, ${Math.round(DL_TIMEOUT/1000)}s timeout)...`);
    await execAsync(
      `yt-dlp ${cookieArg} -f "bestaudio/best" -o "${outputPath}" "${youtubeUrl}" 2>&1`,
      { timeout: DL_TIMEOUT, maxBuffer: 50 * 1024 * 1024 },
    );
    console.log(`[DEEPDOWNLOAD] Audio download complete: ${outputPath}`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    throw new AppError(
      'ANALYSIS_FAILED',
      `Audio download failed: ${msg.substring(0, 200)}`,
      500,
    );
  }

  // Verify the file was created
  if (!existsSync(outputPath)) {
    throw new AppError(
      'ANALYSIS_FAILED',
      'Audio download completed but output file not found.',
      500,
    );
  }

  return readFileSync(outputPath);
}

// ---------------------------------------------------------------------------
// Internal: Deepgram API Call
// ---------------------------------------------------------------------------

async function transcribeAudio(
  audioBuffer: Buffer,
  apiKey: string,
): Promise<{ words: DgWord[]; fullTranscript: string; confidence: number }> {
  const params = new URLSearchParams({
    model: 'nova-2',
    language: 'id',
    smart_format: 'true',
    punctuate: 'true',
    utterances: 'true',
    utt_split: '1.2',
  });

  let resp: Response;
  try {
    resp = await fetch(`${DEEPGRAM_BASE}?${params.toString()}`, {
      method: 'POST',
      headers: {
        Authorization: `Token ${apiKey}`,
        'Content-Type': 'audio/mp4',
      },
      body: new Uint8Array(audioBuffer),
      signal: AbortSignal.timeout(DG_TIMEOUT),
    });
  } catch (fetchErr: unknown) {
    if (fetchErr instanceof DOMException && fetchErr.name === 'TimeoutError') {
      throw new AppError(
        'ANALYSIS_FAILED',
        'Deepgram request timed out after 10 minutes.',
        504,
      );
    }
    throw new AppError(
      'ANALYSIS_FAILED',
      `Deepgram request failed: ${fetchErr instanceof Error ? fetchErr.message : 'Unknown error'}`,
      500,
    );
  }

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new AppError(
      'ANALYSIS_FAILED',
      `Deepgram HTTP ${resp.status}: ${body.substring(0, 200)}`,
      502,
    );
  }

  let data: DgResponse;
  try {
    data = await resp.json() as DgResponse;
  } catch {
    throw new AppError(
      'ANALYSIS_FAILED',
      'Failed to parse Deepgram response JSON.',
      502,
    );
  }

  const alt = data?.results?.channels?.[0]?.alternatives?.[0];
  if (!alt) {
    throw new AppError(
      'ANALYSIS_FAILED',
      'No transcription alternatives in Deepgram response.',
      502,
    );
  }

  const rawWords: DgWord[] = (alt.words ?? []).map((w) => ({
    word: w.punctuated_word ?? w.word ?? '',
    start: w.start ?? 0,
    end: w.end ?? 0,
  }));

  if (rawWords.length === 0) {
    throw new AppError(
      'ANALYSIS_FAILED',
      'Deepgram returned zero words — audio may be silent or empty.',
      502,
    );
  }

  return {
    words: rawWords,
    fullTranscript: alt.transcript ?? '',
    confidence: alt.confidence ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Internal: Word-to-Segment Conversion
// ---------------------------------------------------------------------------

/**
 * Convert Deepgram word-level timestamps into TranscriptSegment[].
 *
 * Uses the same segmentation algorithm as youtube.ts:
 * - Group words into ~5s segments
 * - Split on gaps >2x the max word gap
 * - Each segment has start time + duration
 */
function wordsToSegments(words: DgWord[]): TranscriptSegment[] {
  if (words.length === 0) return [];

  const segments: TranscriptSegment[] = [];
  let segStart = words[0].start;
  let segWords: string[] = [];

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const prevTime = i > 0 ? words[i - 1].start : segStart;

    // Start new segment if accumulated >5s or large gap
    if (
      w.start - segStart > SEGMENT_TARGET ||
      w.start - prevTime > MAX_WORD_GAP * 2
    ) {
      if (segWords.length > 0) {
        segments.push({
          start: segStart,
          duration: prevTime - segStart + 0.5,
          text: segWords.join(' ').trim(),
        });
      }
      segStart = w.start;
      segWords = [w.word];
    } else {
      segWords.push(w.word);
    }
  }

  // Final segment
  if (segWords.length > 0) {
    const lastTime = words[words.length - 1].end;
    segments.push({
      start: segStart,
      duration: Math.max(1, lastTime - segStart),
      text: segWords.join(' ').trim(),
    });
  }

  return segments;
}
