/**
 * lib/transcript-service.ts — Orchestration layer for transcript acquisition.
 *
 * Three acquisition paths, tried in order:
 *   1. YouTube InnerTube API (works for English / captioned videos)
 *   2. Residential worker queue (yt-dlp on PC/Laptop with real IP)
 *   3. Direct Deepgram fallback (VPS-only, may be blocked by YouTube)
 *
 * Flow:
 *   fetchVideoDataWithFallback()
 *     ├─ try:    fetchVideoData()          → transcript_source: 'youtube'
 *     ├─ catch:  TRANSCRIPT_UNAVAILABLE
 *     │           ├─ VERCEL=1?
 *     │           │     └─ throw (no yt-dlp on Vercel)
 *     │           ├─ Workers online?
 *     │           │     ├─ Enqueue job → poll for result → return
 *     │           │     └─ No workers → fall through
 *     │           └─ isDeepgramConfigured()?
 *     │                 └─ fallbackToDeepgram() (VPS-only)
 */

import { query } from '@/db/client';
import { fetchVideoData, fetchMetadata, cacheVideo } from '@/lib/youtube';
import { fetchDeepgramTranscript } from '@/lib/deepgram';
import { AppError } from '@/lib/errors';
import type { VideoData } from '@/lib/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VideoDataWithSource extends VideoData {
  videoDbId: string;
  transcriptSource: 'youtube' | 'deepgram';
}

interface JobResult {
  segments: Array<{ start: number; duration: number; text: string }>;
  transcript_source: string;
  confidence: number;
  full_transcript: string;
  duration_ms: number;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function fetchVideoDataWithFallback(
  youtubeId: string,
  youtubeUrl: string,
): Promise<VideoDataWithSource> {
  // ---- Step 1: Try YouTube transcript acquisition ----
  try {
    console.log(`[TIMING] [${youtubeId}] fetchVideoData() start`);
    console.time(`[TIMING] [${youtubeId}] fetchVideoData()`);
    const data = await fetchVideoData(youtubeId);
    console.timeEnd(`[TIMING] [${youtubeId}] fetchVideoData()`);
    console.log(`[TIMING] [${youtubeId}] YouTube transcript succeeded (${data.transcript.length} segments)`);
    return { ...data, transcriptSource: 'youtube' };
  } catch (err) {
    console.timeEnd(`[TIMING] [${youtubeId}] fetchVideoData()`);
    const originalError = err instanceof AppError ? err : undefined;
    if (originalError && originalError.code !== 'TRANSCRIPT_UNAVAILABLE') {
      console.log(`[TIMING] [${youtubeId}] fetchVideoData() error (${originalError.code}): ${originalError.message.slice(0, 100)}`);
    }
    if (originalError && originalError.code === 'TRANSCRIPT_UNAVAILABLE') {
      console.log(`[TIMING] [${youtubeId}] YouTube transcript unavailable — trying worker queue`);
    } else {
      console.log(`[TIMING] [${youtubeId}] fetchVideoData() failed but attempting worker queue fallback`);
    }
  }

  // ---- Step 2: Try residential worker queue ----
  // Removed VERCEL guard: Vercel API must be able to enqueue jobs to Neon
  // for residential workers (PC-GANY, LAPTOP-GANY) to claim and process.
  console.log(`[TIMING] [${youtubeId}] tryWorkerQueue() start`);
  console.time(`[TIMING] [${youtubeId}] tryWorkerQueue()`);
  const result = await tryWorkerQueue(youtubeId, youtubeUrl);
  console.timeEnd(`[TIMING] [${youtubeId}] tryWorkerQueue()`);
  if (result) {
    console.log(`[TIMING] [${youtubeId}] Worker queue returned result (transcript_source=${result.transcriptSource}, ${result.transcript.length} segments)`);
    return result;
  }
  console.log(`[TIMING] [${youtubeId}] Worker queue returned null — falling through`);

  // ---- Step 3: Direct Deepgram fallback (VPS-only) ----
  // Note: on Vercel, this path is skipped (VERCEL=1), so Vercel users
  // always get TRANSCRIPT_UNAVAILABLE if Step 1 and 2 fail.
  if (process.env.VERCEL !== '1' && isDeepgramConfigured()) {
    return await fallbackToDeepgram(youtubeId, youtubeUrl);
  }

  throw new AppError('TRANSCRIPT_UNAVAILABLE', 'No caption tracks available.', 404);
}

// ---------------------------------------------------------------------------
// Worker Queue Path
// ---------------------------------------------------------------------------

async function tryWorkerQueue(
  youtubeId: string,
  youtubeUrl: string,
): Promise<VideoDataWithSource | null> {
  // Check if any workers are online
  const workers = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM workers
     WHERE status = 'online' AND last_heartbeat > NOW() - INTERVAL '5 minutes'`,
  );

  const onlineCount = parseInt(workers.rows[0]?.count || '0');
  if (onlineCount === 0) return null;  // No workers — skip queue path

  // Check for existing job for this video
  const existing = await query<{ id: string; status: string }>(
    `SELECT id, status FROM jobs_queue
     WHERE youtube_id = $1
       AND status IN ('pending', 'claimed', 'completed')
     ORDER BY created_at DESC
     LIMIT 1`,
    [youtubeId],
  );

  let jobId: string;

  if (existing.rows.length > 0) {
    const job = existing.rows[0];
    jobId = job.id;

    // If already completed, return the cached result
    if (job.status === 'completed') {
      return await resolveCompletedJob(jobId, youtubeId);
    }
    // If pending or claimed, poll it
  } else {
    // Enqueue new job
    const inserted = await query<{ id: string }>(
      `INSERT INTO jobs_queue (youtube_id, youtube_url)
       VALUES ($1, $2)
       RETURNING id`,
      [youtubeId, youtubeUrl],
    );
    jobId = inserted.rows[0].id;
  }

  // Poll for completion (up to 10 seconds, every 2 seconds)
  // If the job completes within this window, great. Otherwise the user
  // retries later and picks up the completed result.
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    await sleep(2000);

    const check = await query<{ status: string }>(
      'SELECT status FROM jobs_queue WHERE id = $1',
      [jobId],
    );

    if (check.rows.length === 0) break;

    if (check.rows[0].status === 'completed') {
      return await resolveCompletedJob(jobId, youtubeId);
    }

    if (check.rows[0].status === 'failed') {
      return null;  // Worker failed — fall through to Deepgram
    }
  }

  return null;  // Timeout — fall through to Deepgram
}

async function resolveCompletedJob(
  jobId: string,
  youtubeId: string,
): Promise<VideoDataWithSource> {
  const jobResult = await query<{ result: unknown; transcript_source: string }>(
    'SELECT result, transcript_source FROM jobs_queue WHERE id = $1',
    [jobId],
  );

  if (jobResult.rows.length === 0) {
    throw new AppError('TRANSCRIPT_UNAVAILABLE', 'Job record not found.', 404);
  }

  const segments = jobResult.rows[0].result as Array<{ start: number; duration: number; text: string }>;
  if (!segments || !Array.isArray(segments) || segments.length === 0) {
    throw new AppError('TRANSCRIPT_UNAVAILABLE', 'Job completed but result is empty.', 404);
  }

  // Get or create video metadata
  let videoDbId: string;
  let metadata: { youtubeId: string; title: string; channelName: string; durationSeconds: number };

  try {
    console.log(`[TIMING] [${youtubeId}] resolveCompletedJob: fetchMetadata() start`);
    console.time(`[TIMING] [${youtubeId}] resolveCompletedJob: fetchMetadata()`);
    metadata = await fetchMetadata(youtubeId);
    console.timeEnd(`[TIMING] [${youtubeId}] resolveCompletedJob: fetchMetadata()`);
  } catch {
    console.timeEnd(`[TIMING] [${youtubeId}] resolveCompletedJob: fetchMetadata()`);
    console.log(`[TIMING] [${youtubeId}] resolveCompletedJob: fetchMetadata() failed — using placeholder metadata`);
    // Use placeholder metadata if fetch fails
    metadata = {
      youtubeId,
      title: 'Unknown',
      channelName: 'Unknown',
      durationSeconds: 0,
    };
  }

  // Cache in database
  try {
    videoDbId = await cacheVideo({ metadata, transcript: segments });
  } catch {
    // If caching fails (e.g. duplicate), generate a fake UUID for the response
    videoDbId = '00000000-0000-0000-0000-000000000000';
  }

  return {
    metadata,
    transcript: segments,
    videoDbId,
    transcriptSource: 'deepgram',
  };
}

// ---------------------------------------------------------------------------
// Direct Deepgram Fallback (unchanged from original)
// ---------------------------------------------------------------------------

async function fallbackToDeepgram(
  youtubeId: string,
  youtubeUrl: string,
): Promise<VideoDataWithSource> {
  try {
    const dgResult = await fetchDeepgramTranscript(youtubeUrl);
    const metadata = await fetchMetadata(youtubeId);
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
    throw new AppError(
      'TRANSCRIPT_UNAVAILABLE',
      `Deepgram fallback failed: ${fallbackErr instanceof Error ? fallbackErr.message.slice(0, 120) : 'Unknown error'}`,
      404,
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isDeepgramConfigured(): boolean {
  const envKey = process.env.DEEPGRAM_API_KEY;
  if (envKey && envKey.length > 10 && envKey !== '***') return true;

  try {
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const { join } = require('node:path') as typeof import('node:path');
    const envContent = readFileSync(join(process.cwd(), '.env.local'), 'utf-8');
    const match = envContent.match(/^DEEPGRAM_API_KEY=(.+)$/m);
    if (match) {
      const key = match[1].trim();
      if (key.length > 10 && key !== '***') return true;
    }
  } catch { /* .env.local may not exist */ }

  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
