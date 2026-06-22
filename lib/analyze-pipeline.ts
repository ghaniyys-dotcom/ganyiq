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
import { generateAllTitlesForAnalysis } from '@/lib/title-generator';
import type { RankedMoment } from '@/lib/types';
import { enrichWithJudgeV2, isJudgeV2Enabled, createJudgeLlm } from '@/lib/judge-integration';
import { detectScenes, detectScenesAsync, persistScenes } from '@/lib/scene-detector';
import { computeViralScore } from '@/lib/viral-moment-detector';
import { scoreClipQuality } from '@/lib/visual-quality-scorer';
import { generateBrollCandidates } from '@/lib/broll-engine';
import { exec } from 'child_process';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { promisify } from 'util';

const execAsync = promisify(exec);

// ---------------------------------------------------------------------------
// Progress stages
// ---------------------------------------------------------------------------

type Stage =
  | 'fetching_transcript'
  | 'extracting_candidates'
  | 'batch_analysis'
  | 'multi_pass'
  | 'judging'
  | 'ranking'
  | 'storing_results'
  | 'scene_detection'
  | 'viral_scoring'
  | 'visual_scoring'
  | 'broll_generation';

const STAGES: Stage[] = [
  'fetching_transcript',
  'extracting_candidates',
  'batch_analysis',
  'multi_pass',
  'judging',
  'ranking',
  'storing_results',
  'scene_detection',
  'viral_scoring',
  'visual_scoring',
  'broll_generation',
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
    const analysisResult = await analyzeTranscript(videoData.metadata, videoData.transcript, analysisId);
    console.timeEnd(`[PROFILE] ${youtubeId} 2_analyze_transcript`);

    // ---- Stage 3a: Judge V2 (feature-flagged) ----
    let momentsForRanking = analysisResult.moments;
    let judgeTiming = '';

    if (isJudgeV2Enabled()) {
      await setStage(analysisId, 'judging');
      console.time(`[PROFILE] ${youtubeId} 3a_judge_v2`);
      const judgeLlm = createJudgeLlm();
      const enrichedMoments = await enrichWithJudgeV2(
        analysisResult.moments,
        videoData.transcript,
        judgeLlm,
      );

      // Count how many got judge scores
      const judgedCount = enrichedMoments.filter(m => m.judgeResult).length;
      console.log(`[JUDGE-V2] Enriched ${judgedCount}/${enrichedMoments.length} moments`);
      console.timeEnd(`[PROFILE] ${youtubeId} 3a_judge_v2`);
      momentsForRanking = enrichedMoments;
    } else {
      console.log('[JUDGE-V2] DISABLED — using V1 worthClippingScore');
    }

    // ---- Stage 3b: Ranking ----
    await setStage(analysisId, 'ranking');
    console.time(`[PROFILE] ${youtubeId} 3_ranking`);
    const rawMoments = momentsForRanking;
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
         raw_llm_response = $5::jsonb,
         transcript_provider = $6,
         speaker_count = $7,
         provider_latency_ms = $8,
         provider_fallback_reason = $9
       WHERE id = $10`,
      [
        totalMomentsFound,
        processingTimeMs,
        servingModel,
        PROMPT_VERSION,
        rawResponseJson,
        (videoData as any).transcriptProvider || null,
        (videoData as any).speakerCount ?? null,
        (videoData as any).providerLatencyMs ?? null,
        (videoData as any).providerFallbackReason || null,
        analysisId,
      ],
    );

    // Store moments
    const insertedMomentIds: string[] = [];
    console.log(`[DB SAVE] Inserting ${rankedMoments.length} ranked moments from ranking`);
    for (const m of rankedMoments) {
      const result = await query<{ id: string }>(
        `INSERT INTO moments
           (analysis_id, start_time, end_time, worth_clipping_score,
            confidence, dna_tags, reasoning, transcript_excerpt,
            rank_position, tier,
            information_gain, attention_capture, harm, final_score,
            viral_score, hook_strength, surprise_level, novelty_score, emotional_intensity, audience_relevance,
            visual_quality_score, sharpness, brightness, exposure, face_visibility, blur_score)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12, $13, $14,
                 $15, $16, $17, $18, $19, $20,
                 $21, $22, $23, $24, $25, $26)
         RETURNING id`,
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
          (m as any).information_gain ?? null,
          (m as any).attention_capture ?? null,
          (m as any).harm ?? null,
          (m as any).final_score ?? null,
          (m as any).viral_score ?? null,
          (m as any).hook_strength ?? null,
          (m as any).surprise_level ?? null,
          (m as any).novelty_score ?? null,
          (m as any).emotional_intensity ?? null,
          (m as any).audience_relevance ?? null,
          (m as any).visual_quality_score ?? null,
          (m as any).sharpness ?? null,
          (m as any).brightness ?? null,
          (m as any).exposure ?? null,
          (m as any).face_visibility ?? null,
          (m as any).blur_score ?? null,
        ],
      );
      insertedMomentIds.push(result.rows[0].id);

      // Log evaluator output
      try {
        if ((m as any).information_gain !== undefined) {
          await query(
            `INSERT INTO evaluator_logs 
             (moment_id, analysis_id, clip_id, transcript, information_gain, attention_capture, harm, final_score, reasoning, timestamp)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())`,
            [
              result.rows[0].id,
              analysisId,
              (m as any).clipId || `m-${insertedMomentIds.length}`,
              m.transcriptExcerpt,
              (m as any).information_gain,
              (m as any).attention_capture,
              (m as any).harm,
              (m as any).final_score,
              (m as any).reasoning || null,
            ]
          );
        }
      } catch (logErr) {
        console.error('[EVAL LOG] Failed to log evaluator output:', logErr);
      }
    }

    console.log(`[DB SAVE] Successfully inserted ${insertedMomentIds.length} moments for analysis ${analysisId}`);
    console.log(`[ASYNC] Analysis ${analysisId} completed: ${totalMomentsFound} moments in ${processingTimeMs}ms`);
    console.timeEnd(`[PROFILE] ${youtubeId} 4_db_save`);

    // -----------------------------------------------------------------------
    // NEW: Server-side Scene Detection (Stage 4a)
    // Requires video download. Runs after moments are persisted.
    // -----------------------------------------------------------------------
    let videoPath = '';
    try {
      await setStage(analysisId, 'scene_detection');
      console.time(`[PROFILE] ${youtubeId} 4a_download_video`);

      // Download video for scene detection + visual quality analysis
      const tmpDir = '/tmp/ganyiq-scene';
      if (!existsSync(tmpDir)) {
        try { mkdirSync(tmpDir, { recursive: true }); } catch {}
      }
      videoPath = `${tmpDir}/${youtubeId}.mp4`;

      if (!existsSync(videoPath)) {
        const cookieFile = '/root/GANYIQ/cookies.txt';
        const cookieArg = existsSync(cookieFile) ? `--cookies "${cookieFile}"` : '';
        // Download up to 720p for analysis (quality > 480p, file < 200MB)
        const dlCmd = `yt-dlp ${cookieArg} -f "bestvideo[height<=720][vcodec^=avc1]+bestaudio[ext=m4a]/best[height<=720]" -o "${videoPath}" "${rawUrl}" --no-playlist --quiet`;
        console.log(`[SCENE] Starting video download (async, 10min timeout)...`);
        await execAsync(dlCmd, { timeout: 600000, maxBuffer: 50 * 1024 * 1024 });
        console.log(`[SCENE] Downloaded video: ${videoPath} (${existsSync(videoPath) ? 'OK' : 'MISSING'})`);
      } else {
        console.log(`[SCENE] Using cached video: ${videoPath}`);
      }
      console.timeEnd(`[PROFILE] ${youtubeId} 4a_download_video`);

      // Run scene detection
      if (existsSync(videoPath)) {
        console.time(`[PROFILE] ${youtubeId} 4b_detect_scenes`);
        const sceneResult = await detectScenesAsync(videoPath);
        console.log(`[SCENE] Detected ${sceneResult.totalScenes} scenes (avg ${sceneResult.avgSceneDuration.toFixed(1)}s)`);

        // Persist scenes to DB
        const videoId = (videoData as any).videoDbId || youtubeId;
        await persistScenes(analysisId, videoId, sceneResult.scenes);
        console.timeEnd(`[PROFILE] ${youtubeId} 4b_detect_scenes`);
      }
    } catch (sceneErr) {
      // Scene detection failure is NON-FATAL — analysis already completed
      console.warn(`[SCENE] Non-fatal error: ${sceneErr instanceof Error ? sceneErr.message.slice(0, 200) : 'Unknown'}`);
    }

    // -----------------------------------------------------------------------
    // NEW: Server-side Viral Scoring (Stage 4c)
    // Text-based analysis of each moment's transcript excerpt
    // -----------------------------------------------------------------------
    try {
      await setStage(analysisId, 'viral_scoring');
      console.time(`[PROFILE] ${youtubeId} 4c_viral_scoring`);

      // DETECT dimension mismatch: rankedMoments vs insertedMomentIds
      if (rankedMoments.length !== insertedMomentIds.length) {
        console.warn(`[VIRAL] ⚠️ DIMENSION MISMATCH: rankedMoments=${rankedMoments.length}, insertedMomentIds=${insertedMomentIds.length}. Scoring limited to ${Math.min(rankedMoments.length, insertedMomentIds.length)} moments`);
      }

      for (let i = 0; i < rankedMoments.length && i < insertedMomentIds.length; i++) {
        const m = rankedMoments[i];
        const transcriptText = m.transcriptExcerpt || '';
        const viral = computeViralScore(transcriptText);

        await query(
          `UPDATE moments SET
             viral_score = $1, hook_strength = $2, surprise_level = $3,
             novelty_score = $4, emotional_intensity = $5, audience_relevance = $6
           WHERE id = $7`,
          [
            viral.viral_score,
            viral.components.hookStrength,
            viral.components.surpriseLevel,
            viral.components.noveltyScore,
            viral.components.emotionalIntensity,
            viral.components.audienceRelevance,
            insertedMomentIds[i],
          ],
        );
      }
      console.log(`[VIRAL] Scored ${Math.min(rankedMoments.length, insertedMomentIds.length)} moments`);
      console.timeEnd(`[PROFILE] ${youtubeId} 4c_viral_scoring`);
    } catch (viralErr) {
      console.warn(`[VIRAL] Non-fatal error: ${viralErr instanceof Error ? viralErr.message.slice(0, 200) : 'Unknown'}`);
    }

    // -----------------------------------------------------------------------
    // NEW: Server-side Visual Quality Scoring (Stage 4d)
    // Frame analysis per clip time range from downloaded video
    // -----------------------------------------------------------------------
    try {
      await setStage(analysisId, 'visual_scoring');
      console.time(`[PROFILE] ${youtubeId} 4d_visual_scoring`);

      if (existsSync(videoPath)) {
        for (let i = 0; i < rankedMoments.length && i < insertedMomentIds.length; i++) {
          const m = rankedMoments[i];
          try {
            const quality = await scoreClipQuality(videoPath, m.startTime, m.endTime);
            // Clamp values to prevent numeric field overflow (DB columns are numeric(5,4) / numeric(4,1))
            const clamp = (val: number | undefined | null, min: number, max: number): number | null => {
              if (val === null || val === undefined || isNaN(val)) return null;
              return Math.min(max, Math.max(min, val));
            };
            await query(
              `UPDATE moments SET
                 visual_quality_score = $1, sharpness = $2, brightness = $3,
                 exposure = $4, face_visibility = $5, blur_score = $6
               WHERE id = $7`,
              [
                clamp(quality.visual_quality_score, 0, 999.9),
                clamp(quality.sharpness, 0, 99.9999),
                clamp(quality.brightness, 0, 99.9999),
                clamp(quality.exposure, 0, 99.9999),
                clamp(quality.face_visibility, 0, 99.9999),
                clamp(quality.blur_score, 0, 99.9999),
                insertedMomentIds[i],
              ],
            );
          } catch (clipErr) {
            console.warn(`[VISUAL] Moment ${i} scoring failed: ${clipErr instanceof Error ? clipErr.message : 'Unknown'}`);
          }
        }
        console.log(`[VISUAL] Scored visual quality for ${Math.min(rankedMoments.length, insertedMomentIds.length)} moments`);

        // Cleanup downloaded video
        try { rmSync(videoPath, { force: true }); } catch {}
      }
      console.timeEnd(`[PROFILE] ${youtubeId} 4d_visual_scoring`);
    } catch (visualErr) {
      console.warn(`[VISUAL] Non-fatal error: ${visualErr instanceof Error ? visualErr.message.slice(0, 200) : 'Unknown'}`);
    }

    // -----------------------------------------------------------------------
    // NEW: Server-side B-roll Generation (Stage 4e)
    // Generates b-roll candidates per moment from scenes + transcript keywords
    // -----------------------------------------------------------------------
    try {
      await setStage(analysisId, 'broll_generation');
      console.time(`[PROFILE] ${youtubeId} 4e_broll_generation`);

      for (let i = 0; i < rankedMoments.length && i < insertedMomentIds.length; i++) {
        const m = rankedMoments[i];
        const mId = insertedMomentIds[i];
        const videoId = (videoData as any).videoDbId || youtubeId;

        try {
          await generateBrollCandidates(
            analysisId,
            videoId,
            [], // scenes array (empty — already stored in DB, broll engine works from transcript keywords)
            videoData.transcript,
            mId,
            m.startTime,
            m.endTime,
          );
        } catch (brollErr) {
          console.warn(`[BROLL] Moment ${i} generation failed: ${brollErr instanceof Error ? brollErr.message : 'Unknown'}`);
        }
      }
      console.log(`[BROLL] Generated candidates for ${Math.min(rankedMoments.length, insertedMomentIds.length)} moments`);
      console.timeEnd(`[PROFILE] ${youtubeId} 4e_broll_generation`);
    } catch (brollErr) {
      console.warn(`[BROLL] Non-fatal error: ${brollErr instanceof Error ? brollErr.message.slice(0, 200) : 'Unknown'}`);
    }

    // -----------------------------------------------------------------------
    // Mark analysis as fully completed (including all new stages)
    // -----------------------------------------------------------------------
    try {
      await query(
        'UPDATE analyses SET status = $1, progress_stage = $2 WHERE id = $3 AND status = $4',
        ['completed', 'completed', analysisId, 'processing'],
      );
      console.log(`[PIPELINE] Analysis ${analysisId} fully completed with all stages`);
    } catch (finalErr) {
      console.warn(`[PIPELINE] Failed to mark analysis completed: ${finalErr instanceof Error ? finalErr.message : 'Unknown'}`);
    }

    // ---- Phase 5D: Store metrics ----
    try {
      const tokenEstimate = analysisResult.rawResponse
        ? JSON.stringify(analysisResult.rawResponse).length * 0.75
        : 0;
      const llmCallEstimate = analysisResult.model ? 1 : 0;
      const highSignalCount = rawMoments.filter(m => m.worthClippingScore >= 70).length;
      const transcriptWordCount = videoData.transcript.reduce((sum, seg) => sum + (seg.text?.split(/\s+/).length || 0), 0);
      await query(
        `INSERT INTO analysis_metrics
           (analysis_id, video_duration_seconds, transcript_segments,
            candidates_extracted, candidates_validated, candidates_ranked,
            candidates_deduped, high_signal_candidates,
            final_clips, elite_clips, transcript_words,
            runtime_ms, total_tokens, llm_calls, estimated_cost)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [
          analysisId,
          Math.round(videoData.metadata.durationSeconds),
          videoData.transcript.length,
          rawMoments.length,
          rawMoments.length,
          rankedMoments.length,
          rawMoments.length - rankedMoments.length,
          highSignalCount,
          rankedMoments.length,
          rankedMoments.filter(m => m.tier === 'elite').length,
          transcriptWordCount,
          processingTimeMs,
          Math.round(tokenEstimate),
          llmCallEstimate,
          Number((tokenEstimate * 0.00000015).toFixed(8)), // ~$0.15/1M tokens
        ],
      );
    } catch (e) {
      console.error(`[METRICS] Failed to store metrics for ${analysisId}:`, e);
    }

    // ---- Generate AI title suggestions for each moment (fire & forget) ----
    // Don't block pipeline completion on title generation
    (async () => {
      try {
        const momentsForTitle: Array<{
          id: string;
          startTime: number;
          endTime: number;
          worthClippingScore: number;
          dnaTags: string[];
          reasoning: string;
          transcriptExcerpt: string;
        }> = rankedMoments.map((m, i) => ({
          id: insertedMomentIds[i],
          startTime: m.startTime,
          endTime: m.endTime,
          worthClippingScore: m.worthClippingScore,
          dnaTags: m.dnaTags,
          reasoning: m.reasoning,
          transcriptExcerpt: m.transcriptExcerpt,
        }));
        await generateAllTitlesForAnalysis(
          analysisId,
          momentsForTitle,
          videoData.metadata.title,
          videoData.metadata.channelName,
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        console.error(`[TITLES] Title generation failed for ${analysisId}: ${msg.slice(0, 200)}`);
      }
    })();

    // ---- Stage 5: V2 Shadow Runner (feature-flagged, fire-and-forget) ----
    // Runs V2 Fusion pipeline silently alongside V1.
    // Feature flags:
    //   V2_MULTI_GENERATOR_SHADOW=true → enables live shadow execution
    //   V2_MULTI_GENERATOR_OUTPUT=false → V1 remains user-visible output
    //
    // Shadow is fire-and-forget — NEVER blocks V1 completion or propagates errors.
    (async () => {
      if (process.env.V2_MULTI_GENERATOR_SHADOW !== 'true') return;
      try {
        const { runShadowPipeline } = await import('@/lib/v2-shadow-runner');
        const { rows: v1Moments } = await query<{
          start_time: number; end_time: number;
          worth_clipping_score: number; tier: string; transcript_excerpt: string;
        }>(
          `SELECT start_time, end_time, worth_clipping_score, tier, transcript_excerpt
           FROM moments WHERE analysis_id = $1 ORDER BY worth_clipping_score DESC`,
          [analysisId],
        );
        const result = await runShadowPipeline(
          youtubeId,
          videoData.transcript.map(s => ({
            start: typeof s.start === 'number' ? s.start : 0,
            duration: typeof s.duration === 'number' ? s.duration : 1,
            text: s.text ?? '',
          })),
          analysisId,
          v1Moments.map(m => ({
            startTime: Number(m.start_time),
            endTime: Number(m.end_time),
            worthClippingScore: Number(m.worth_clipping_score),
            tier: m.tier,
            transcriptExcerpt: m.transcript_excerpt,
          })),
        );
        if (result.success) {
          console.log(`[SHADOW] ✅ ${youtubeId} — ${result.latencyMs}ms, ${result.fusionTop5.length} clips`);
        } else {
          console.warn(`[SHADOW] ⚠ ${youtubeId} — ${result.errorStage}: ${result.error}`);
        }
      } catch (err: any) {
        // Shadow failure is NON-FATAL — V1 already completed successfully
        console.error(`[SHADOW] ❌ ${youtubeId} — ${err.message?.slice(0, 200)}`);
      }
    })();

    return; // Pipeline complete
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
