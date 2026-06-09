/**
 * lib/analyze-pipeline.ts — Background analysis pipeline runner.
 *
 * Extracted from POST /api/analyze for async execution.
 * Each stage updates the database progress so the status endpoint
 * can return real-time progress to the frontend.
 */

import { query } from '@/db/client';
import { AppError } from '@/lib/errors';
import { validateYouTubeUrl, extractVideoId } from '@/lib/validators';
import { fetchVideoDataWithFallback } from '@/lib/transcript-service';
import { analyzeTranscript } from '@/lib/analyzer';
import { rankMoments, getDedupConfig } from '@/lib/ranking';
import { PROMPT_VERSION_V2C as PROMPT_VERSION } from '@/lib/prompt';
import { detectGenre } from '@/lib/genre-detector';
import { checkRateLimit } from '@/lib/rate-limit';
import type { RankedMoment } from '@/lib/types';

// ---------------------------------------------------------------------------
// Progress stages
// ---------------------------------------------------------------------------

type Stage =
  | 'fetching_transcript'
  | 'extracting_candidates'
  | 'batch_analysis'
  | 'multi_pass'
  | 'ranking'
  | 'storing_results';

const STAGES: Stage[] = [
  'fetching_transcript',
  'extracting_candidates',
  'batch_analysis',
  'multi_pass',
  'ranking',
  'storing_results',
];

function stageIndex(stage: Stage): number {
  return STAGES.indexOf(stage);
}

// ---------------------------------------------------------------------------
// DB progress updater
// ---------------------------------------------------------------------------

async function setStage(analysisId: string, stage: Stage): Promise<void> {
  await query(
    'UPDATE analyses SET status = $1, progress_stage = $2 WHERE id = $3',
    ['processing', stage, analysisId],
  );
}

async function setFailed(analysisId: string, errorMessage: string): Promise<void> {
  await query(
    'UPDATE analyses SET status = $1, progress_stage = $2, error_message = $3 WHERE id = $4',
    ['failed', 'failed', errorMessage.slice(0, 500), analysisId],
  );
}

// ---------------------------------------------------------------------------
// Pipeline runner
// ---------------------------------------------------------------------------

/**
 * Run the full analysis pipeline and store results in DB.
 * Designed to be called in a background microtask (no HTTP response expected).
 *
 * @param analysisId  - UUID from the analyses table
 * @param youtubeId   - 11-char YouTube video ID
 * @param rawUrl      - The original YouTube URL submitted by the user
 * @param ipAddress   - Client IP for rate limit tracking
 */
export async function runAnalysisPipeline(
  analysisId: string,
  youtubeId: string,
  rawUrl: string,
  ipAddress: string,
): Promise<void> {
  const startTime = Date.now();

  try {
    // ---- Stage 1: Fetch transcript ----
    await setStage(analysisId, 'fetching_transcript');
    console.time(`[PROFILE] ${youtubeId} 1_fetch_transcript`);
    const videoData = await fetchVideoDataWithFallback(youtubeId, rawUrl);
    console.timeEnd(`[PROFILE] ${youtubeId} 1_fetch_transcript`);

    // ---- Stage 2: Extract candidates ----
    await setStage(analysisId, 'extracting_candidates');
    console.time(`[PROFILE] ${youtubeId} 2_analyze_transcript`);
    const analysisResult = await analyzeTranscript(videoData.metadata, videoData.transcript);
    console.timeEnd(`[PROFILE] ${youtubeId} 2_analyze_transcript`);

    // ---- Stage 3: Ranking + Dedup ----
    await setStage(analysisId, 'ranking');
    console.time(`[PROFILE] ${youtubeId} 3_ranking`);
    const rawMoments = analysisResult.moments;
    const servingModel = analysisResult.model;
    const genreProfile = detectGenre(videoData.metadata.title, videoData.metadata.channelName);
    const dedupConfig = getDedupConfig(genreProfile.dedupWindow);
    const rankedMoments: RankedMoment[] = rankMoments(rawMoments, videoData.transcript, dedupConfig, genreProfile);
    const processingTimeMs = Date.now() - startTime;
    const totalMomentsFound = rankedMoments.length;
    console.timeEnd(`[PROFILE] ${youtubeId} 3_ranking`);

    // ---- Stage 4: Store results ----
    await setStage(analysisId, 'storing_results');
    console.time(`[PROFILE] ${youtubeId} 4_db_save`);
    const rawResponseJson = analysisResult.rawResponse
      ? JSON.stringify(analysisResult.rawResponse)
      : null;

    await query(
      `UPDATE analyses SET
         total_moments_found = $1,
         processing_time_ms = $2,
         llm_model = $3,
         prompt_version = $4,
         status = 'completed',
         progress_stage = 'completed',
         raw_llm_response = $5::jsonb
       WHERE id = $6`,
      [
        totalMomentsFound,
        processingTimeMs,
        servingModel,
        PROMPT_VERSION,
        rawResponseJson,
        analysisId,
      ],
    );

    // Store moments
    for (const m of rankedMoments) {
      await query(
        `INSERT INTO moments
           (analysis_id, start_time, end_time, worth_clipping_score,
            confidence, dna_tags, reasoning, transcript_excerpt,
            rank_position, tier)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10)`,
        [
          analysisId,
          m.startTime,
          m.endTime,
          m.worthClippingScore,
          m.confidence,
          JSON.stringify(m.dnaTags),
          m.reasoning,
          m.transcriptExcerpt,
          m.rank,
          m.tier,
        ],
      );
    }

    console.log(`[ASYNC] Analysis ${analysisId} completed: ${totalMomentsFound} moments in ${processingTimeMs}ms`);
    console.timeEnd(`[PROFILE] ${youtubeId} 4_db_save`);

    // ---- Phase 5D: Store metrics ----
    try {
      const tokenEstimate = analysisResult.rawResponse
        ? JSON.stringify(analysisResult.rawResponse).length * 0.75
        : 0;
      const llmCallEstimate = analysisResult.model ? 1 : 0;
      await query(
        `INSERT INTO analysis_metrics
           (analysis_id, video_duration_seconds, transcript_segments,
            candidates_extracted, candidates_validated, candidates_ranked,
            candidates_deduped, final_clips, elite_clips,
            runtime_ms, total_tokens, llm_calls, estimated_cost)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          analysisId,
          Math.round(videoData.metadata.durationSeconds),
          videoData.transcript.length,
          rawMoments.length,
          rawMoments.length,
          rankedMoments.length,
          rawMoments.length - rankedMoments.length,
          rankedMoments.length,
          rankedMoments.filter(m => m.tier === 'elite').length,
          processingTimeMs,
          Math.round(tokenEstimate),
          llmCallEstimate,
          Number((tokenEstimate * 0.00000015).toFixed(8)), // ~$0.15/1M tokens
        ],
      );
    } catch (e) {
      console.error(`[METRICS] Failed to store metrics for ${analysisId}:`, e);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error(`[ASYNC] Analysis ${analysisId} failed:`, message);
    await setFailed(analysisId, message);
  }
}

/**
 * Get analysis metadata for the POST handler (rate limit etc.).
 * This runs synchronously in the request path before backgrounding the work.
 */
export async function getVideoMetadataForQuery(
  youtubeId: string,
  rawUrl: string,
): Promise<{ videoDbId: string; transcriptSource: string }> {
  const videoData = await fetchVideoDataWithFallback(youtubeId, rawUrl);
  return {
    videoDbId: videoData.videoDbId,
    transcriptSource: videoData.transcriptSource,
  };
}
