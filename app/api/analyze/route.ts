/**
 * POST /api/analyze
 *
 * Main analysis endpoint. Accepts a YouTube URL and:
 *   1. Immediately returns { analysisId, status: "processing" }
 *   2. Runs the analysis pipeline in the background
 *   3. Frontend polls GET /api/analyze/[id]/status for progress
 *
 * Pipeline:
 *   1. Validate URL → extract YouTube ID
 *   2. Check rate limit
 *   3. Create analysis record (status='pending')
 *   4. Return immediately
 *   5. Background: fetch transcript, LLM analysis, ranking, store results
 *
 * Response (202):
 *   {
 *     "analysisId": "uuid",
 *     "status": "processing"
 *   }
 *
 * Error codes:
 *   400 INVALID_URL
 *   429 RATE_LIMITED
 */

import { NextRequest, NextResponse } from 'next/server';
import { AppError } from '@/lib/errors';
import { query } from '@/db/client';
import { validateYouTubeUrl, extractVideoId } from '@/lib/validators';
import { runAnalysisPipeline } from '@/lib/analyze-pipeline';
import { checkRateLimit } from '@/lib/rate-limit';

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
      return error(400, 'INVALID_URL', 'Invalid YouTube URL. Supported formats:\n  • https://www.youtube.com/watch?v=VIDEO_ID\n  • https://youtu.be/VIDEO_ID\n  • https://youtube.com/embed/VIDEO_ID');
    }

    let youtubeId: string;
    try {
      youtubeId = extractVideoId(trimmedUrl);
    } catch (e) {
      if (e instanceof AppError) return error(e.statusCode, e.code, e.message);
      return error(400, 'INVALID_URL', 'Could not extract video ID from the provided URL.');
    }

    // ---- 2. Check rate limit ----
    const ipAddress = extractClientIp(request);
    try {
      const rateLimitCheck = await checkRateLimit(ipAddress);
      if (rateLimitCheck.exceeded) {
        return NextResponse.json(
          { error: 'RATE_LIMITED', message: `Rate limit exceeded. Maximum ${rateLimitCheck.limit} analyses per IP per day.`, remaining: 0, resetAt: rateLimitCheck.resetAt },
          { status: 429, headers: { 'X-RateLimit-Limit': String(rateLimitCheck.limit), 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': rateLimitCheck.resetAt } },
        );
      }
    } catch {
      console.error('Rate limit check failed — proceeding without limit');
    }

    // ---- 3. Ensure video exists in DB (creates if new) ----
    let videoDbId: string;
    try {
      // We need at minimum the video_id to create the analysis.
      // fetchVideoDataWithFallback does this, but it's expensive.
      // Instead, upsert a minimal video record and let the background
      // pipeline fill in the details.
      const existing = await query<{ id: string }>(
        'SELECT id FROM videos WHERE youtube_id = $1',
        [youtubeId],
      );
      if (existing.rows.length > 0) {
        videoDbId = existing.rows[0].id;
      } else {
        // Insert minimal record — background pipeline will update metadata
        const inserted = await query<{ id: string }>(
          `INSERT INTO videos (youtube_id, title, channel_name, duration_seconds)
           VALUES ($1, $2, $3, $4)
           RETURNING id`,
          [youtubeId, `Processing ${youtubeId}`, 'Unknown', 0],
        );
        videoDbId = inserted.rows[0].id;
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Database error';
      return error(500, 'ANALYSIS_FAILED', `Failed to prepare database: ${message.slice(0, 120)}`);
    }

    // ---- 4. Create analysis record with status='pending' ----
    let analysisId: string;
    try {
      const result = await query<{ id: string }>(
        `INSERT INTO analyses
           (video_id, ip_address, status, progress_stage, llm_model, prompt_version)
         VALUES ($1, $2, 'pending', 'queued', $3, $4)
         RETURNING id`,
        [videoDbId, ipAddress, 'deepseek-v4-flash', 'v2-compact'],
      );
      analysisId = result.rows[0].id;
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Database error';
      return error(500, 'ANALYSIS_FAILED', `Failed to create analysis record: ${message.slice(0, 120)}`);
    }

    // ---- 5. Return immediately ----
    // The full analysis runs in the background.
    // We intentionally don't await it — fire and forget.
    runAnalysisPipeline(analysisId, youtubeId, trimmedUrl, ipAddress).catch((err) => {
      console.error(`[ASYNC] Unhandled pipeline error for ${analysisId}:`, err);
    });

    return NextResponse.json(
      { analysisId, status: 'processing' },
      { status: 202 },
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Unknown error';
    console.error('Unexpected error in POST /api/analyze:', message);
    return error(500, 'INTERNAL_ERROR', 'An unexpected error occurred. Please try again.');
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractClientIp(request: NextRequest): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim();
  const realIp = request.headers.get('x-real-ip');
  if (realIp) return realIp.trim();
  return 'unknown';
}

function error(status: number, code: string, message: string): NextResponse {
  return NextResponse.json({ error: code, message }, { status });
}
