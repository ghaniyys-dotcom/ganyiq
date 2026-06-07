/**
 * POST /api/clips
 *
 * Create a clip generation job for a specific moment.
 *
 * Flow:
 *   1. Look up moment by analysisId + momentIndex
 *   2. Check clips_cache for existing render
 *   3. If cached → return ready immediately
 *   4. If not → create job in jobs_queue (job_type='clip')
 *
 * Body: { analysisId: string, momentIndex: number }
 * Response (200): { clipId, status: "ready", clipUrl }
 * Response (201): { clipId, status: "pending" }
 * Response (404): { error, code }
 */

import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/db/client';

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = await request.json();
    const { analysisId, momentIndex, renderMode } = body || {};

    if (!analysisId || typeof momentIndex !== 'number') {
      return NextResponse.json(
        { error: 'analysisId (string) and momentIndex (number) are required.', code: 'BAD_REQUEST' },
        { status: 400 },
      );
    }

    const validRenderModes = ['landscape', 'vertical', 'vertical-split'];
    const finalRenderMode = validRenderModes.includes(renderMode) ? renderMode : 'landscape';

    // 1. Look up the moment
    const momentResult = await query<{
      id: string;
      start_time: string;
      end_time: string;
      video_id: string;
      youtube_id: string;
      youtube_url?: string;
    }>(
      `SELECT m.id, m.start_time, m.end_time, a.video_id, v.youtube_id
       FROM moments m
       JOIN analyses a ON a.id = m.analysis_id
       JOIN videos v ON v.id = a.video_id
       WHERE m.analysis_id = $1 AND m.rank_position = $2`,
      [analysisId, momentIndex],
    );

    if (momentResult.rows.length === 0) {
      return NextResponse.json(
        { error: 'Moment not found.', code: 'NOT_FOUND' },
        { status: 404 },
      );
    }

    const moment = momentResult.rows[0];

    // 2. Check clips_cache (include render_mode in cache key)
    const cacheResult = await query<{ id: string; filename: string }>(
      `SELECT id, filename FROM clips_cache
       WHERE video_id = $1 AND start_time = $2 AND end_time = $3 AND render_mode = $4
       LIMIT 1`,
      [moment.video_id, moment.start_time, moment.end_time, finalRenderMode],
    );

    if (cacheResult.rows.length > 0) {
      // Cache hit — return existing clip
      return NextResponse.json({
        clipId: cacheResult.rows[0].id,
        status: 'ready',
        clipUrl: `/clips/${cacheResult.rows[0].filename}`,
      });
    }

    // 3. Create clip job in queue
    const clipParams = {
      videoId: moment.video_id,
      startTime: parseFloat(moment.start_time),
      endTime: parseFloat(moment.end_time),
      renderMode: finalRenderMode,
    };

    const youtubeUrl = `https://www.youtube.com/watch?v=${moment.youtube_id}`;

    const jobResult = await query<{ id: string }>(
      `INSERT INTO jobs_queue (youtube_id, youtube_url, status, job_type, clip_params)
       VALUES ($1, $2, 'pending', 'clip', $3::jsonb)
       RETURNING id`,
      [moment.youtube_id, youtubeUrl, JSON.stringify(clipParams)],
    );

    const jobId = jobResult.rows[0].id;

    // 4. Create clips_cache entry (pending, will be updated by worker)
    const cacheInsert = await query<{ id: string }>(
      `INSERT INTO clips_cache (video_id, start_time, end_time, filename, job_id, render_mode)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [moment.video_id, moment.start_time, moment.end_time, '', jobId, finalRenderMode],
    );

    return NextResponse.json(
      {
        clipId: cacheInsert.rows[0].id,
        status: 'pending',
      },
      { status: 201 },
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('POST /api/clips error:', message);
    return NextResponse.json({ error: message, code: 'INTERNAL_ERROR' }, { status: 500 });
  }
}
