import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/db/client';
import { authenticateWorker } from '@/lib/worker-auth';

/**
 * GET /api/workers/jobs/poll
 *
 * Atomically claim the next pending job using FOR UPDATE SKIP LOCKED.
 * Ensures multiple workers never get the same job.
 *
 * Headers: Authorization: Bearer <api_key>
 * Response (200): { job: { id, youtube_id, youtube_url, created_at } }
 * Response (204): No jobs available (empty body)
 * Response (401): { error, code }
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    // Authenticate — the worker passes its ID, and we verify the key
    const workerId = request.nextUrl.searchParams.get('worker_id');
    if (!workerId) {
      return NextResponse.json(
        { error: 'worker_id query parameter is required.', code: 'BAD_REQUEST' },
        { status: 400 },
      );
    }

    await authenticateWorker(workerId, request.headers.get('Authorization'));

    // Atomic claim: FOR UPDATE SKIP LOCKED ensures no conflicts
    const result = await query<{
      id: string;
      youtube_id: string;
      youtube_url: string;
      created_at: string;
    }>(
      `WITH next_job AS (
        SELECT id FROM jobs_queue
        WHERE status = 'pending' AND retry_count < max_retries
        ORDER BY created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      UPDATE jobs_queue
      SET status = 'claimed',
          worker_id = $1,
          claimed_at = NOW(),
          updated_at = NOW()
      WHERE id = (SELECT id FROM next_job)
      RETURNING id, youtube_id, youtube_url, created_at`,
      [workerId],
    );

    if (result.rows.length === 0) {
      return new NextResponse(null, { status: 204 });
    }

    const job = result.rows[0];

    return NextResponse.json({
      job: {
        id: job.id,
        youtubeId: job.youtube_id,
        youtubeUrl: job.youtube_url,
        createdAt: job.created_at,
      },
    });
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'status' in err) {
      const e = err as { status: number; body: Record<string, unknown> };
      return NextResponse.json(e.body, { status: e.status });
    }
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message, code: 'INTERNAL_ERROR' }, { status: 500 });
  }
}
