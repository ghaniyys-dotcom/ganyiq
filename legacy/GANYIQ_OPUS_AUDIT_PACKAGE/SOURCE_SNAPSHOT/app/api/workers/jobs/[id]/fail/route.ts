import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/db/client';
import { authenticateWorker } from '@/lib/worker-auth';

/**
 * POST /api/workers/jobs/[id]/fail
 *
 * Report that a job failed. Triggers retry logic if retry_count < max_retries.
 *
 * Headers: Authorization: Bearer <api_key>
 * Body: {
 *   worker_id: string,
 *   error_message?: string
 * }
 * Response (200): { status: "ok", job_id, will_retry: boolean, retry_count, max_retries }
 * Response (401/403): { error, code }
 * Response (404): { error: "Job not found", code: "NOT_FOUND" }
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const { id: jobId } = await params;
    const body = await request.json();

    const workerId = body?.worker_id;
    if (!workerId) {
      return NextResponse.json(
        { error: 'worker_id is required in body.', code: 'BAD_REQUEST' },
        { status: 400 },
      );
    }

    await authenticateWorker(workerId, request.headers.get('Authorization'));

    // Verify this worker owns the job
    const jobCheck = await query<{ worker_id: string; status: string; retry_count: number }>(
      'SELECT worker_id, status, retry_count FROM jobs_queue WHERE id = $1',
      [jobId],
    );

    if (jobCheck.rows.length === 0) {
      return NextResponse.json(
        { error: 'Job not found.', code: 'NOT_FOUND' },
        { status: 404 },
      );
    }

    const job = jobCheck.rows[0];

    if (job.worker_id !== workerId) {
      return NextResponse.json(
        { error: 'This job is claimed by another worker.', code: 'CROSS_WORKER_BLOCKED' },
        { status: 403 },
      );
    }

    const errorMessage = body?.error_message || 'Unknown error';
    const newRetryCount = job.retry_count + 1;
    const willRetry = newRetryCount < 3; // max_retries = 3

    const newStatus = willRetry ? 'pending' : 'failed';

    await query(
      `UPDATE jobs_queue
       SET status = $1,
           error_message = $2,
           retry_count = $3,
           worker_id = $4,
           claimed_at = NULL,
           updated_at = NOW()
       WHERE id = $5`,
      [newStatus, errorMessage, newRetryCount, willRetry ? null : workerId, jobId],
    );

    // Increment worker's failed count
    await query(
      'UPDATE workers SET jobs_failed = jobs_failed + 1, updated_at = NOW() WHERE id = $1',
      [workerId],
    );

    return NextResponse.json({
      status: 'ok',
      job_id: jobId,
      will_retry: willRetry,
      retry_count: newRetryCount,
      max_retries: 3,
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
