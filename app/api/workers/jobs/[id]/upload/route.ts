/**
 * POST /api/workers/jobs/[id]/upload
 *
 * Accept a rendered clip MP4 from a worker, save it to public/clips/,
 * update the clips_cache table, and mark the job as completed.
 *
 * Headers: Authorization: Bearer ***
 * Body: multipart/form-data
 *   - worker_id: string
 *   - start_time: number
 *   - end_time: number
 *   - duration_seconds: number
 *   - file: (binary MP4)
 *
 * Response (200): { status: "ok", url: "/clips/{filename}" }
 * Response (401/403): { error, code }
 * Response (404): { error: "Job not found or claimed by another worker", code: "NOT_FOUND" }
 */

import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/db/client';
import { authenticateWorker } from '@/lib/worker-auth';
import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const { id: jobId } = await params;

    // ── Parse multipart form ──────────────────────────────────────────────
    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      return NextResponse.json(
        { error: 'Expected multipart/form-data.', code: 'BAD_REQUEST' },
        { status: 400 },
      );
    }

    const workerId = formData.get('worker_id')?.toString();
    if (!workerId) {
      return NextResponse.json(
        { error: 'worker_id is required in form data.', code: 'BAD_REQUEST' },
        { status: 400 },
      );
    }

    // ── Authenticate worker ───────────────────────────────────────────────
    await authenticateWorker(workerId, request.headers.get('Authorization'));

    // ── Verify this worker owns the job ────────────────────────────────────
    const jobCheck = await query<{ worker_id: string; status: string; youtube_id: string }>(
      'SELECT worker_id, status, youtube_id FROM jobs_queue WHERE id = $1',
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

    if (job.worker_id !== workerId) {
      return NextResponse.json(
        { error: 'This job is claimed by another worker.', code: 'CROSS_WORKER_BLOCKED' },
        { status: 403 },
      );
    }

    // ── Extract metadata from form ────────────────────────────────────────
    const startTime = parseFloat(formData.get('start_time')?.toString() || '0');
    const endTime = parseFloat(formData.get('end_time')?.toString() || '0');
    const durationSeconds = parseFloat(formData.get('duration_seconds')?.toString() || '0');
    const file = formData.get('file') as File | null;

    if (!file) {
      return NextResponse.json(
        { error: 'file is required in form data.', code: 'BAD_REQUEST' },
        { status: 400 },
      );
    }

    // ── Validate file type ────────────────────────────────────────────────
    if (!file.name.endsWith('.mp4') && file.type !== 'video/mp4') {
      return NextResponse.json(
        { error: 'Only MP4 files are accepted.', code: 'INVALID_FILE_TYPE' },
        { status: 400 },
      );
    }

    // ── Ensure clips directory exists ─────────────────────────────────────
    const clipsDir = join(process.cwd(), 'public', 'clips');
    if (!existsSync(clipsDir)) {
      mkdirSync(clipsDir, { recursive: true });
    }

    // ── Save file ─────────────────────────────────────────────────────────
    const filename = file.name;
    const filePath = join(clipsDir, filename);
    const bytes = await file.arrayBuffer();
    const buffer = Buffer.from(bytes);
    writeFileSync(filePath, buffer);
    const fileSizeBytes = buffer.length;

    // ── Update clips_cache ────────────────────────────────────────────────
    const cacheUpdate = await query<{ id: string }>(
      `UPDATE clips_cache
       SET filename = $1,
           file_size_bytes = $2,
           duration_seconds = $3
       WHERE job_id = $4
       RETURNING id`,
      [filename, fileSizeBytes, durationSeconds, jobId],
    );

    if (cacheUpdate.rows.length === 0) {
      // No clips_cache entry found for this job — insert one
      await query(
        `INSERT INTO clips_cache (video_id, start_time, end_time, filename, file_size_bytes, duration_seconds, job_id, render_mode)
         VALUES (
           (SELECT video_id FROM moments m
            JOIN analyses a ON a.id = m.analysis_id
            JOIN videos v ON v.id = a.video_id
            WHERE v.youtube_id = $1
            LIMIT 1),
           $2, $3, $4, $5, $6, $7, 'landscape'
         )`,
        [job.youtube_id, startTime, endTime, filename, fileSizeBytes, durationSeconds, jobId],
      );
    }

    // ── Mark job completed (idempotent: only if still claimed) ──────────────
    const completeResult = await query<{ id: string }>(
      `UPDATE jobs_queue
       SET status = 'completed',
           completed_at = NOW(),
           updated_at = NOW()
       WHERE id = $1
         AND status = 'claimed'
         AND worker_id = $2
       RETURNING id`,
      [jobId, workerId],
    );

    // If job was already completed, don't double-increment stats
    // (file write is already done — no harm in duplicative file)
    if (completeResult.rows.length === 0) {
      // Job was either already completed or not claimed by this worker
      // Check if already completed
      const checkJob = await query<{ status: string }>(
        'SELECT status FROM jobs_queue WHERE id = $1', [jobId]
      );
      if (checkJob.rows[0]?.status === 'completed') {
        return NextResponse.json({
          status: 'ok',
          url: `/clips/${filename}`,
        });
      }
      return NextResponse.json(
        { error: 'Not authorized to complete this job.', code: 'CROSS_WORKER_BLOCKED' },
        { status: 403 },
      );
    }

    // ── Increment worker's completed count ────────────────────────────────
    await query(
      'UPDATE workers SET jobs_completed = jobs_completed + 1, updated_at = NOW() WHERE id = $1',
      [workerId],
    );

    return NextResponse.json({
      status: 'ok',
      url: `/clips/${filename}`,
    });
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'status' in err) {
      const e = err as { status: number; body: Record<string, unknown> };
      return NextResponse.json(e.body, { status: e.status });
    }
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('POST /api/workers/jobs/[id]/upload error:', message);
    return NextResponse.json({ error: message, code: 'INTERNAL_ERROR' }, { status: 500 });
  }
}
