/**
 * GET /api/clips/[id]/status
 *
 * Poll the status of a clip render job.
 *
 * Returns: { clipId, status, clipUrl?, error? }
 * Status values: pending → processing → ready | failed
 */

import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/db/client';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const { id } = await params;

    const result = await query<{
      id: string;
      filename: string;
      start_time: string;
      end_time: string;
      job_id: string;
      created_at: string;
    }>(
      `SELECT cc.id, cc.filename, cc.start_time, cc.end_time, cc.job_id, cc.created_at
       FROM clips_cache cc
       WHERE cc.id = $1`,
      [id],
    );

    if (result.rows.length === 0) {
      return NextResponse.json({ error: 'Clip not found.', code: 'NOT_FOUND' }, { status: 404 });
    }

    const clip = result.rows[0];

    // If clip has a filename, it's ready
    if (clip.filename && clip.filename.length > 0) {
      return NextResponse.json({
        clipId: clip.id,
        status: 'ready',
        clipUrl: `/clips/${clip.filename}`,
        startTime: parseFloat(clip.start_time),
        endTime: parseFloat(clip.end_time),
      });
    }

    // Check job status
    if (clip.job_id) {
      const jobResult = await query<{ status: string; error_message: string | null }>(
        'SELECT status, error_message FROM jobs_queue WHERE id = $1',
        [clip.job_id],
      );

      if (jobResult.rows.length > 0) {
        const job = jobResult.rows[0];

        if (job.status === 'completed') {
          // Job completed but no filename → clip render failed silently
          return NextResponse.json({
            clipId: clip.id,
            status: 'failed',
            error: job.error_message || 'Clip rendering completed but output file is missing.',
          });
        }

        if (job.status === 'claimed') {
          return NextResponse.json({
            clipId: clip.id,
            status: 'processing',
          });
        }

        if (job.status === 'failed' || job.status === 'error') {
          return NextResponse.json({
            clipId: clip.id,
            status: 'failed',
            error: job.error_message || 'Unknown error',
          });
        }
      }
    }

    // Default: still pending
    return NextResponse.json({
      clipId: clip.id,
      status: 'pending',
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message, code: 'INTERNAL_ERROR' }, { status: 500 });
  }
}
