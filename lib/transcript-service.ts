/**
 * lib/transcript-service.ts — Orchestration layer for transcript acquisition.
 *
 * Tries YouTube transcript first, falls back to Deepgram STT on failure.
 *
 * Separation of concerns:
 *   - lib/youtube.ts       → YouTube transcript acquisition (unchanged)
 *   - lib/deepgram.ts      → Deepgram STT transcription
 *   - lib/transcript-service.ts → Fallback orchestration (this file)
 *
 * Flow:
 *   fetchVideoDataWithFallback()
 *     ├─ try:    fetchVideoData()          → transcript_source: 'youtube'
 *     ├─ catch:  TRANSCRIPT_UNAVAILABLE
 *     │           ├─ VERCEL=1? → throw original (no yt-dlp)
 *     │           └─ fetchDeepgramTranscript() → transcript_source: 'deepgram'
 *     └─ return: VideoDataWithSource
 */

import { fetchVideoData, fetchMetadata, cacheVideo } from '@/lib/youtube';
import { fetchDeepgramTranscript } from '@/lib/deepgram';
import { AppError } from '@/lib/errors';
import type { VideoData } from '@/lib/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VideoDataWithSource extends VideoData {
  /** Database UUID of the videos row (set by fetchVideoData or cacheVideo). */
  videoDbId: string;
  /** Identifies which transcription source produced the transcript. */
  transcriptSource: 'youtube' | 'deepgram';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch video data (metadata + transcript) with automatic Deepgram fallback.
 *
 * Steps:
 *   1. Try YouTube transcript acquisition (with DB caching)
 *   2. If TRANSCRIPT_UNAVAILABLE and not on Vercel → fallback to Deepgram
 *   3. Deepgram path: download audio → Deepgram STT → metadata fetch → cache
 *
 * @param youtubeId - 11-character YouTube video ID
 * @param youtubeUrl - Full YouTube URL (needed for yt-dlp in fallback)
 * @returns Video data with transcript, DB ID, and source indicator
 * @throws AppError TRANSCRIPT_UNAVAILABLE if both sources fail
 */
export async function fetchVideoDataWithFallback(
  youtubeId: string,
  youtubeUrl: string,
): Promise<VideoDataWithSource> {
  // ---- Step 1: Try YouTube transcript acquisition ----
  try {
    const data = await fetchVideoData(youtubeId);
    return { ...data, transcriptSource: 'youtube' };
  } catch (err) {
    // Only fallback for transcript-specific errors
    if (!(err instanceof AppError) || err.code !== 'TRANSCRIPT_UNAVAILABLE') {
      throw err;
    }

    // ---- Step 2: Check if fallback is possible ----
    // Vercel has no yt-dlp — skip fallback, throw original error
    if (process.env.VERCEL === '1') throw err;

    // Check Deepgram API key is configured
    if (!isDeepgramConfigured()) {
      // Key not present — skip fallback
      throw err;
    }

    // ---- Step 3: Fallback to Deepgram ----
    return await fallbackToDeepgram(youtubeId, youtubeUrl, err);
  }
}

// ---------------------------------------------------------------------------
// Internal: Deepgram Fallback
// ---------------------------------------------------------------------------

/**
 * Execute the Deepgram fallback path.
 *
 * Separated into its own async function to keep the dynamic import isolated
 * from the main module scope. This ensures that on Vercel:
 *   - The `lib/deepgram.ts` module (which imports `child_process`) is NEVER
 *     loaded at module evaluation time
 *   - It's only loaded when the fallback path actually executes
 *   - The VERCEL guard above prevents this code from running on Vercel
 */
async function fallbackToDeepgram(
  youtubeId: string,
  youtubeUrl: string,
  originalError: Error,
): Promise<VideoDataWithSource> {
  try {
    // Dynamic import to avoid bundling child_process on Vercel
    const dgModule = await import('@/lib/deepgram');
    const dgResult = await dgModule.fetchDeepgramTranscript(youtubeUrl);

    // Get metadata (lightweight — uses youtubei.js, no caption fetch)
    const metadata = await fetchMetadata(youtubeId);

    // Cache in database so future requests are instant
    const videoDbId = await cacheVideo({
      metadata,
      transcript: dgResult.segments,
    });

    return {
      metadata,
      transcript: dgResult.segments,
      videoDbId,
      transcriptSource: 'deepgram',
    };
  } catch (fallbackErr) {
    // If Deepgram fallback fails, throw the original YouTube error
    // so the API returns the expected TRANSCRIPT_UNAVAILABLE code
    throw originalError;
  }
}

// ---------------------------------------------------------------------------
// Internal: Deepgram Availability Check
// ---------------------------------------------------------------------------

/**
 * Quick check whether Deepgram API key is available.
 * Avoids the expensive module import just to check config.
 */
function isDeepgramConfigured(): boolean {
  // Check environment variable
  const envKey = process.env.DEEPGRAM_API_KEY;
  if (envKey && envKey.length > 10 && envKey !== '***') return true;

  // Check .env.local without importing deepgram module
  try {
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const { join } = require('node:path') as typeof import('node:path');
    const envContent = readFileSync(join(process.cwd(), '.env.local'), 'utf-8');
    const match = envContent.match(/^DEEPGRAM_API_KEY=(.+)$/m);
    if (match) {
      const key = match[1].trim();
      if (key.length > 10 && key !== '***') return true;
    }
  } catch {
    // .env.local may not exist — that's fine
  }

  return false;
}
