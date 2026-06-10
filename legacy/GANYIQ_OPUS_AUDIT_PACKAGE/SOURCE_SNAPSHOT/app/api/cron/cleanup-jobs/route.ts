import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/db/client';

/**
 * GET /api/cron/cleanup-jobs
 *
 * Cron-triggered cleanup that:
 * 1. Releases claimed jobs where the claiming worker hasn't had a heartbeat
 *    in 5 minutes (stale claimed jobs → pending for retry/redistribution)
 * 2. Marks workers as offline if their last heartbeat was >5 minutes ago
 *
 * Headers: x-cron-secret (must match CRON_SECRET env var)
 * Response (200): { stale_released, workers_offlined, timestamp }
 * Response (401): { error: "Invalid cron secret", code: "UNAUTHORIZED" }
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  // Verify cron secret
  const cronSecret = request.headers.get('x-cron-secret');
  const expectedSecret = process.env.CRON_SECRET;

  if (!expectedSecret || cronSecret !== expectedSecret) {
    return NextResponse.json(
      { error: 'Invalid or missing cron secret.', code: 'UNAUTHORIZED' },
      { status: 401 },
    );
  }

  try {
    // 1. Release stale claimed jobs (>5 minutes without heartbeat from claiming worker)
    const staleRelease = await query<{ count: string }>(
      `UPDATE jobs_queue
       SET status = 'pending',
           worker_id = NULL,
           claimed_at = NULL,
           retry_count = retry_count + 1,
           updated_at = NOW()
       WHERE id IN (
         SELECT j.id FROM jobs_queue j
         LEFT JOIN workers w ON j.worker_id = w.id
         WHERE j.status = 'claimed'
           AND (
             w.last_heartbeat IS NULL
             OR w.last_heartbeat < NOW() - INTERVAL '5 minutes'
           )
       )
       RETURNING id`,
    );

    // 2. Mark workers with stale heartbeats as offline
    const staleWorkers = await query<{ count: string }>(
      `UPDATE workers
       SET status = 'offline', updated_at = NOW()
       WHERE status = 'online'
         AND last_heartbeat < NOW() - INTERVAL '5 minutes'
       RETURNING id`,
    );

    const releasedCount = staleRelease.rows.length;
    const offlinedCount = staleWorkers.rows.length;

    return NextResponse.json({
      status: 'ok',
      stale_released: releasedCount,
      workers_offlined: offlinedCount,
      timestamp: new Date().toISOString(),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json(
      { error: `Cleanup failed: ${message}`, code: 'INTERNAL_ERROR' },
      { status: 500 },
    );
  }
}
