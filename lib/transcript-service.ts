/**
 * lib/transcript-service.ts — Orchestration layer for transcript acquisition.
 *
 * Uses the new provider architecture:
 *   provider-router → fallback-chain → providers → fusion
 *
 * Flow:
 *   fetchVideoDataWithFallback()
 *     ├─ determineProvider() — choose best provider based on content
 *     ├─ transcribeWithFallback() — run DG → VV → FW in order
 *     ├─ fuseTranscripts() — merge Deepgram words + VibeVoice speakers
 *     └─ return VideoDataWithProvider
 */

import { query } from '@/db/client';
import { fetchVideoData, fetchMetadata, cacheVideo } from '@/lib/youtube';
import { AppError } from '@/lib/errors';
import type { VideoData } from '@/lib/types';
import { transcribeWithFallback } from './transcript/fallback-chain';
import { determineProvider } from './transcript/provider-router';
import { fuseTranscripts } from './transcript/fusion/deepgram-vibevoice-fusion';
import type {
  ProviderResult,
  ProviderName,
  TranscriptSegment,
  TranscriptWord,
} from './transcript/providers/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VideoDataWithSource extends VideoData {
  videoDbId: string;
  transcriptSource: 'youtube' | 'deepgram' | 'vibevoice' | 'fasterwhisper' | 'worker';
  /** Provider that served the transcript */
  transcriptProvider: ProviderName;
  /** Number of unique speakers detected */
  speakerCount: number;
  /** Provider latency in ms */
  providerLatencyMs: number;
  /** Why fallback was needed (if any) */
  providerFallbackReason?: string;
  /** Word-level transcript (with speaker labels) */
  words: TranscriptWord[];
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
    return {
      ...data,
      transcriptSource: 'youtube',
      transcriptProvider: 'youtube',
      speakerCount: 0,
      providerLatencyMs: 0,
      words: [],
    };
  } catch (err) {
    console.timeEnd(`[TIMING] [${youtubeId}] fetchVideoData()`);
    const originalError = err instanceof AppError ? err : undefined;
    if (originalError && originalError.code !== 'TRANSCRIPT_UNAVAILABLE') {
      console.log(`[TIMING] [${youtubeId}] fetchVideoData() error (${originalError.code}): ${originalError.message.slice(0, 100)}`);
    }
    console.log(`[TIMING] [${youtubeId}] YouTube transcript unavailable — trying provider chain`);
  }

  // ---- Step 2: Try worker queue (for residential IP download) ----
  console.log(`[TIMING] [${youtubeId}] tryWorkerQueue() start`);
  console.time(`[TIMING] [${youtubeId}] tryWorkerQueue()`);
  const workerResult = await tryWorkerQueue(youtubeId, youtubeUrl);
  console.timeEnd(`[TIMING] [${youtubeId}] tryWorkerQueue()`);
  if (workerResult) {
    console.log(`[TIMING] [${youtubeId}] Worker queue returned result (transcript_source=${workerResult.transcriptSource}, ${workerResult.transcript.length} segments)`);
    return workerResult;
  }
  console.log(`[TIMING] [${youtubeId}] Worker queue returned null — trying provider chain`);

  // ---- Step 3: Provider chain (Deepgram → VibeVoice → FasterWhisper) ----
  console.log(`[TIMING] [${youtubeId}] Provider chain start`);
  console.time(`[TIMING] [${youtubeId}] provider_chain`);
  const providerResult = await runProviderChain(youtubeId, youtubeUrl);
  console.timeEnd(`[TIMING] [${youtubeId}] provider_chain`);

  if (providerResult.success && providerResult.result) {
    // Get or create video metadata
    const metadata = await getOrCreateMetadata(youtubeId, providerResult.result);
    // Cache video
    const videoDbId = await cacheVideo({
      metadata,
      transcript: providerResult.result.segments,
    });

    return {
      metadata,
      transcript: providerResult.result.segments,
      videoDbId,
      transcriptSource: providerResult.providerUsed === 'deepgram' ? 'deepgram' : 'vibevoice',
      transcriptProvider: providerResult.providerUsed,
      speakerCount: providerResult.result.speakers.length,
      providerLatencyMs: providerResult.totalLatencyMs,
      providerFallbackReason: providerResult.result.providerName !== determineBestProvider(youtubeId)
        ? `Primary provider failed, used: ${providerResult.providerUsed}`
        : undefined,
      words: providerResult.result.words,
    };
  }

  throw new AppError('TRANSCRIPT_UNAVAILABLE', 'No transcript could be acquired from any provider.', 404);
}

// ---------------------------------------------------------------------------
// Provider Chain Runner
// ---------------------------------------------------------------------------

async function runProviderChain(
  youtubeId: string,
  youtubeUrl: string,
): Promise<{
  success: boolean;
  result?: ProviderResult;
  providerUsed: ProviderName;
  totalLatencyMs: number;
}> {
  // Determine preferred provider
  const preferred = determineBestProvider(youtubeId);

  // Run fallback chain — tries Deepgram first, then VibeVoice, then FasterWhisper
  const result = await transcribeWithFallback({
    youtubeUrl,
    forceVibeVoice: preferred === 'vibevoice',
    enableFasterWhisper: true,
  });

  return {
    success: result.success,
    result: result.result,
    providerUsed: result.providerUsed,
    totalLatencyMs: result.totalLatencyMs,
  };
}

function determineBestProvider(_youtubeId: string): ProviderName {
  // Default to Deepgram for now (VibeVoice requires GPU server)
  // Router would use speaker count / metadata when available
  return 'deepgram';
}

async function getOrCreateMetadata(
  youtubeId: string,
  providerResult: ProviderResult,
): Promise<{ youtubeId: string; title: string; channelName: string; durationSeconds: number }> {
  try {
    return await fetchMetadata(youtubeId);
  } catch {
    // Use estimated duration from provider result
    return {
      youtubeId,
      title: 'Unknown',
      channelName: 'Unknown',
      durationSeconds: Math.max(1, Math.ceil(providerResult.durationSeconds)),
    };
  }
}

// ---------------------------------------------------------------------------
// Worker Queue Path (unchanged)
// ---------------------------------------------------------------------------

async function tryWorkerQueue(
  youtubeId: string,
  youtubeUrl: string,
): Promise<VideoDataWithSource | null> {
  const workers = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM workers
     WHERE status IN ('online', 'offline')`,
  );

  const workerCount = parseInt(workers.rows[0]?.count || '0');
  if (workerCount === 0) return null;

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
    if (job.status === 'completed') {
      return await resolveCompletedJob(jobId, youtubeId);
    }
  } else {
    const inserted = await query<{ id: string }>(
      `INSERT INTO jobs_queue (youtube_id, youtube_url)
       VALUES ($1, $2)
       RETURNING id`,
      [youtubeId, youtubeUrl],
    );
    jobId = inserted.rows[0].id;
  }

  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    await sleep(3000);

    const check = await query<{ status: string }>(
      'SELECT status FROM jobs_queue WHERE id = $1',
      [jobId],
    );

    if (check.rows.length === 0) break;

    if (check.rows[0].status === 'completed') {
      return await resolveCompletedJob(jobId, youtubeId);
    }

    if (check.rows[0].status === 'failed') {
      return null;
    }
  }

  return null;
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

  let videoDbId: string;
  let metadata: { youtubeId: string; title: string; channelName: string; durationSeconds: number };

  try {
    metadata = await fetchMetadata(youtubeId);
  } catch {
    const lastSeg = segments[segments.length - 1];
    const estimatedDuration = lastSeg
      ? Math.ceil(lastSeg.start + lastSeg.duration)
      : 0;
    metadata = {
      youtubeId,
      title: 'Unknown',
      channelName: 'Unknown',
      durationSeconds: estimatedDuration || 1,
    };
  }

  try {
    videoDbId = await cacheVideo({ metadata, transcript: segments });
  } catch {
    videoDbId = '00000000-0000-0000-0000-000000000000';
  }

  return {
    metadata,
    transcript: segments,
    videoDbId,
    transcriptSource: 'worker',
    transcriptProvider: 'worker',
    speakerCount: 0,
    providerLatencyMs: 0,
    words: [],
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
