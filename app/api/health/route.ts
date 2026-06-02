import { NextResponse } from 'next/server';
import { Pool } from 'pg';

/**
 * GET /api/health
 *
 * Readiness probe for the ganyIQ backend.
 *
 * Returns 200 with database connectivity status on success.
 * Returns 503 with error detail if the database is unreachable.
 *
 * Response (200):
 *   { "status": "ok", "database": "connected", "timestamp": "2026-06-01T12:00:00.000Z" }
 *
 * Response (503):
 *   { "status": "error", "database": "disconnected", "error": "…", "timestamp": "…" }
 */
export async function GET(): Promise<NextResponse> {
  const timestamp = new Date().toISOString();
  let pool: Pool | null = null;

  try {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      return NextResponse.json(
        {
          status: 'error',
          database: 'unconfigured',
          error: 'DATABASE_URL environment variable is not set.',
          timestamp,
        },
        { status: 503 }
      );
    }

    pool = new Pool({ connectionString });
    await pool.query('SELECT 1');

    return NextResponse.json(
      {
        status: 'ok',
        database: 'connected',
        timestamp,
      },
      { status: 200 }
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown database error';

    return NextResponse.json(
      {
        status: 'error',
        database: 'disconnected',
        error: message,
        timestamp,
      },
      { status: 503 }
    );
  } finally {
    if (pool) {
      await pool.end().catch(() => {});
    }
  }
}
