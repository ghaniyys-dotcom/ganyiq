import { NextResponse } from 'next/server';
import { Pool } from 'pg';
import { getTranscriptAuthStatus } from '@/lib/transcript-health';

/**
 * GET /api/health
 *
 * Readiness probe for the ganyIQ backend.
 *
 * Returns 200 with database connectivity + transcript auth status on success.
 * Returns 503 with error detail if the database is unreachable.
 *
 * Response (200):
 *   {
 *     "status": "ok",
 *     "database": "connected",
 *     "transcript_auth": "healthy" | "warning" | "failed",
 *     "timestamp": "..."
 *   }
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

    // Transcript auth health check (fast, no network)
    const transcriptAuth = getTranscriptAuthStatus();

    return NextResponse.json(
      {
        status: 'ok',
        database: 'connected',
        transcript_auth: transcriptAuth.status,
        transcript_auth_details: {
          message: transcriptAuth.message,
          cookies_file_exists: transcriptAuth.cookiesFileExists,
          sapisid_present: transcriptAuth.sapisidPresent,
          missing_cookies: transcriptAuth.missingCookies,
        },
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
