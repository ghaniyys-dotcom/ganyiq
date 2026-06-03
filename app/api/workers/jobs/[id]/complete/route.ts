import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/db/client';
import { authenticateWorker } from '@/lib/worker-auth';

/**
 * POST /api/workers/jobs/[id]/complete
 *
 * Submit a successful transcript result for a claimed job.
 * Result segments are cached in the videos table for instant retries.
 *
 * Headers: Authorization: Bearer <api_key>
 * Body: {
 *   segments: Array<{ start: number; duration: number; text: string }>,
 *   full_transcript?: string,
 *   confidence?: number,
 *   duration_ms?: number
 * }
 * Response (200): { status: "ok", job_id, segments_count }
 * Response (401/403): { error, code }
 * Response (404): { error: "Job not found or already completed", code: "NOT_FOUND" }
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const { id: jobId } = await params;
    const body = await request.json();

    // Parse the worker_id from the body (worker must identify itself)
    const workerId = body?.worker_id;
    if (!workerId) {
      return NextResponse.json(
        { error: 'worker_id is required in body.', code: 'BAD_REQUEST' },
        { status: 400 },
      );
    }

    const authResult = await authenticateWorker(workerId, request.headers.get('Authorization'));

    // Verify this worker owns the job
    const jobCheck = await query<{ worker_id: string; status: string; youtube_id: string; youtube_url: string }>(
      'SELECT worker_id, status, youtube_id, youtube_url FROM jobs_queue WHERE id = $1',
      [jobId],
    );

    if (jobCheck.rows.length === 0) {
      return NextResponse.json(
        { error: 'Job not found.', code: 'NOT_FOUND' },
        { status: 404 },
      );
    }

    const job = jobCheck.rows[0];

    if (job.status === 'completed') {
      return NextResponse.json(
        { error: 'Job is already completed.', code: 'ALREADY_COMPLETED' },
        { status: 409 },
      );
    }

    if (job.worker_id !== authResult.worker.id) {
      return NextResponse.json(
        { error: 'This job is claimed by another worker.', code: 'CROSS_WORKER_BLOCKED' },
        { status: 403 },
      );
    }

    // Validate segments
    const segments = body?.segments;
    if (!Array.isArray(segments) || segments.length === 0) {
      return NextResponse.json(
        { error: 'segments array is required and must not be empty.', code: 'BAD_REQUEST' },
        { status: 400 },
      );
    }

    // Update the job with results
    const segmentsJson = JSON.stringify(segments);
    const fullTranscript = body?.full_transcript || segments.map((s: { text: string }) => s.text).join(' ');
    const confidence = body?.confidence ?? null;
    const durationMs = body?.duration_ms ?? null;

    await query(
      `UPDATE jobs_queue
       SET status = 'completed',
           result = $1::jsonb,
           transcript_source = 'deepgram',
           full_transcript = $2,
           confidence = $3,
           duration_ms = $4,
           completed_at = NOW(),
           updated_at = NOW()
       WHERE id = $5`,
      [segmentsJson, fullTranscript, confidence, durationMs, jobId],
    );

    // Increment worker's completed count
    await query(
      'UPDATE workers SET jobs_completed = jobs_completed + 1, updated_at = NOW() WHERE id = $1',
      [workerId],
    );

    return NextResponse.json({
      status: 'ok',
      job_id: jobId,
      segments_count: segments.length,
      transcript_source: 'deepgram',
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
