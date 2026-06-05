/**
 * POST /api/analyze
 *
 * Main analysis endpoint. Accepts a YouTube URL and returns scored,
 * ranked worth-clipping moments.
 *
 * Pipeline:
 *   1. Validate URL → extract YouTube ID
 *   2. Check rate limit
 *   3. Fetch video data (metadata + transcript) with DB caching
 *   4. Run LLM analysis (DeepSeek V4 Flash) → RawMoment[]
 *   5. Deterministic ranking + tier assignment → RankedMoment[]
 *   6. Store analysis + moments in PostgreSQL
 *   7. Return structured response
 *
 * Response (200):
 *   {
 *     "analysisId": "uuid",
 *     "videoId": "youtube-11-char-id",
 *     "moments": [ { ...RankedMoment }, ... ]
 *   }
 *
 * Error codes:
 *   400 INVALID_URL
 *   404 TRANSCRIPT_UNAVAILABLE
 *   429 RATE_LIMITED
 *   500 ANALYSIS_FAILED
 */

import { NextRequest, NextResponse } from 'next/server';
import { AppError } from '@/lib/errors';
import { query } from '@/db/client';
import { validateYouTubeUrl, extractVideoId } from '@/lib/validators';
import { fetchVideoDataWithFallback } from '@/lib/transcript-service';
import { analyzeTranscript } from '@/lib/analyzer';
import { rankMoments } from '@/lib/ranking';
import { PROMPT_VERSION } from '@/lib/prompt';
import { checkRateLimit, getRateLimitPerDay } from '@/lib/rate-limit';
import type { RankedMoment } from '@/lib/types';

// ---------------------------------------------------------------------------
// POST /api/analyze
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest): Promise<NextResponse> {
  const startTime = Date.now();

  try {
    // ---- 1. Parse and validate input ----
    const body: unknown = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return error(400, 'INVALID_REQUEST', 'Request body must be a JSON object with a "url" field.');
    }

    const { url } = body as Record<string, unknown>;
    if (!url || typeof url !== 'string' || url.trim().length === 0) {
      return error(400, 'INVALID_URL', 'The "url" field is required and must be a non-empty string.');
    }

    const trimmedUrl = url.trim();

    if (!validateYouTubeUrl(trimmedUrl)) {
      return error(
        400,
        'INVALID_URL',
        'Invalid YouTube URL. Supported formats:\n' +
        '  • https://www.youtube.com/watch?v=VIDEO_ID\n' +
        '  • https://youtu.be/VIDEO_ID\n' +
        '  • https://youtube.com/embed/VIDEO_ID',
      );
    }

    let youtubeId: string;
    try {
      youtubeId = extractVideoId(trimmedUrl);
    } catch (e) {
      if (e instanceof AppError) {
        return error(e.statusCode, e.code, e.message);
      }
      return error(400, 'INVALID_URL', 'Could not extract video ID from the provided URL.');
    }

    // ---- 2. Check rate limit (before expensive operations) ----
    const ipAddress = extractClientIp(request);

    let rateLimitCheck: Awaited<ReturnType<typeof checkRateLimit>>;
    try {
      rateLimitCheck = await checkRateLimit(ipAddress);
    } catch {
      // Rate limit check failure should not block the request.
      // Log and proceed without rate limiting.
      console.error('Rate limit check failed — proceeding without limit');
      rateLimitCheck = { exceeded: false, remaining: 999, limit: 999, resetAt: '' };
    }

    if (rateLimitCheck.exceeded) {
      return NextResponse.json(
        {
          error: 'RATE_LIMITED',
          message: `Rate limit exceeded. Maximum ${rateLimitCheck.limit} analyses per IP per day. Resets at ${rateLimitCheck.resetAt}.`,
          remaining: 0,
          resetAt: rateLimitCheck.resetAt,
        },
        {
          status: 429,
          headers: {
            'X-RateLimit-Limit': String(rateLimitCheck.limit),
            'X-RateLimit-Remaining': '0',
            'X-RateLimit-Reset': rateLimitCheck.resetAt,
          },
        },
      );
    }

    // ---- 3. Fetch video data (with DB caching + Deepgram fallback) ----
    let videoData: Awaited<ReturnType<typeof fetchVideoDataWithFallback>>;
    try {
      videoData = await fetchVideoDataWithFallback(youtubeId, trimmedUrl);
    } catch (e) {
      if (e instanceof AppError) {
        return error(e.statusCode, e.code, e.message);
      }
      return error(500, 'ANALYSIS_FAILED', 'Failed to fetch video data. Please try again.');
    }

    // ---- 3. Run LLM analysis ----
    let analysisResult: Awaited<ReturnType<typeof analyzeTranscript>>;
    try {
      analysisResult = await analyzeTranscript(videoData.metadata, videoData.transcript);
    } catch (e) {
      if (e instanceof AppError) {
        return error(e.statusCode, e.code, e.message);
      }
      return error(500, 'ANALYSIS_FAILED', 'AI analysis failed. Please try again.');
    }

    // ---- 4. Deterministic ranking + tier assignment ----
    const rawMoments = analysisResult.moments;
    const servingModel = analysisResult.model;
    const rankedMoments: RankedMoment[] = rankMoments(rawMoments, videoData.transcript);
    const processingTimeMs = Date.now() - startTime;
    const totalMomentsFound = rankedMoments.length;

    // ---- 5. Store analysis in database ----
    let analysisId: string;
    try {
      const result = await query<{ id: string }>(
        `INSERT INTO analyses
           (video_id, ip_address, total_moments_found, processing_time_ms,
            llm_model, prompt_version, status, error_message, transcript_source)
         VALUES ($1, $2, $3, $4, $5, $6, 'completed', NULL, $7)
         RETURNING id`,
        [
          videoData.videoDbId,
          ipAddress,
          totalMomentsFound,
          processingTimeMs,
          servingModel,
          PROMPT_VERSION,
          videoData.transcriptSource,
        ],
      );
      analysisId = result.rows[0].id;
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Database error';
      return error(500, 'ANALYSIS_FAILED', `Failed to save analysis: ${message.slice(0, 120)}`);
    }

    // ---- 6. Store moments in database ----
    try {
      await storeMoments(analysisId, rankedMoments);
    } catch (e) {
      // Moments storage failure is non-fatal — the analysis record exists.
      // Log and continue.
      console.error('Failed to store moments:', e instanceof Error ? e.message : e);
    }

    // ---- 7. Return response ----
    return NextResponse.json(
      {
        analysisId,
        videoId: youtubeId,
        moments: rankedMoments,
      },
      { status: 200 },
    );
  } catch (e) {
    // Catch-all for unexpected errors
    const message = e instanceof Error ? e.message : 'Unknown error';
    console.error('Unexpected error in POST /api/analyze:', message);
    return error(500, 'INTERNAL_ERROR', 'An unexpected error occurred. Please try again.');
  }
}

// ---------------------------------------------------------------------------
// Database: Batch Store Moments
// ---------------------------------------------------------------------------

/**
 * Insert all ranked moments into the database.
 *
 * Uses individual INSERT statements (not multi-row) for clarity and safety.
 * At MVP scale (max 15 moments per analysis), the overhead is negligible.
 */
async function storeMoments(
  analysisId: string,
  moments: RankedMoment[],
): Promise<void> {
  for (const m of moments) {
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
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the client IP address from the request.
 *
 * Next.js/Vercel provides the real client IP via x-forwarded-for.
 * Falls back to 'unknown' if unavailable.
 */
function extractClientIp(request: NextRequest): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    // x-forwarded-for can be a comma-separated list (proxy chain).
    // The first address is the original client.
    return forwarded.split(',')[0].trim();
  }

  const realIp = request.headers.get('x-real-ip');
  if (realIp) return realIp.trim();

  return 'unknown';
}

/**
 * Return a structured error response with the given HTTP status and error code.
 */
function error(
  status: number,
  code: string,
  message: string,
): NextResponse {
  return NextResponse.json({ error: code, message }, { status });
}
