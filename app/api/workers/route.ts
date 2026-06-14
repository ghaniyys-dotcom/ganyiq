import { NextResponse } from 'next/server';
import { query } from '@/db/client';

export const dynamic = 'force-dynamic';

interface WorkerRow {
  id: string;
  worker_name: string;
  status: string;
  last_heartbeat: Date | null;
  jobs_completed: number;
  jobs_failed: number;
}

export async function GET(): Promise<NextResponse> {
  try {
    const result = await query<WorkerRow>(
      `SELECT id, worker_name, status, last_heartbeat, jobs_completed, jobs_failed
       FROM workers
       ORDER BY last_heartbeat DESC NULLS LAST`
    );

    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);

    const workers = result.rows.map(row => {
      // Evaluate actual online status based on heartbeat
      let calculatedStatus = row.status || 'offline';
      if (row.last_heartbeat) {
        const heartbeatTime = new Date(row.last_heartbeat);
        if (heartbeatTime > fiveMinutesAgo) {
          calculatedStatus = 'online';
        } else {
          calculatedStatus = 'offline';
        }
      } else {
        calculatedStatus = 'offline';
      }

      return {
        id: row.id,
        name: row.worker_name,
        status: calculatedStatus,
        lastHeartbeat: row.last_heartbeat ? row.last_heartbeat.toISOString() : null,
        jobsCompleted: Number(row.jobs_completed || 0),
        jobsFailed: Number(row.jobs_failed || 0),
      };
    });

    return NextResponse.json({ status: 'ok', workers });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown database error';
    return NextResponse.json(
      { status: 'error', error: message },
      { status: 500 }
    );
  }
}
