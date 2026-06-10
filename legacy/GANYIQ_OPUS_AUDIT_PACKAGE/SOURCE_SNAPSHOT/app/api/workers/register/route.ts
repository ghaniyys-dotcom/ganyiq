import { NextRequest, NextResponse } from 'next/server';
import { randomBytes } from 'crypto';
import { query } from '@/db/client';
import { hashApiKey } from '@/lib/worker-auth';

/**
 * POST /api/workers/register
 *
 * Register a new residential worker.
 * Returns a one-time API key (the caller must save it).
 *
 * Body: { worker_name: string }
 * Response (201): { worker_id, api_key, worker_name }
 * Response (409): { error: "Worker name already registered", code: "DUPLICATE_NAME" }
 * Response (400): { error: "worker_name is required", code: "BAD_REQUEST" }
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = await request.json();
    const workerName = body?.worker_name?.trim();

    if (!workerName || typeof workerName !== 'string' || workerName.length === 0) {
      return NextResponse.json(
        { error: 'worker_name is required.', code: 'BAD_REQUEST' },
        { status: 400 },
      );
    }

    if (workerName.length > 100) {
      return NextResponse.json(
        { error: 'worker_name must be 100 characters or fewer.', code: 'BAD_REQUEST' },
        { status: 400 },
      );
    }

    // Generate a random API key (32 bytes → 64 hex chars)
    const rawApiKey = randomBytes(32).toString('hex');
    const apiKeyHash = hashApiKey(rawApiKey);

    const result = await query<{ id: string }>(
      `INSERT INTO workers (worker_name, api_key_hash)
       VALUES ($1, $2)
       RETURNING id`,
      [workerName, apiKeyHash],
    );

    const workerId = result.rows[0].id;

    return NextResponse.json(
      {
        worker_id: workerId,
        api_key: rawApiKey,
        worker_name: workerName,
      },
      { status: 201 },
    );
  } catch (err: unknown) {
    // Detect unique constraint violation (PostgreSQL error code 23505)
    if (err instanceof Error && 'code' in err && (err as { code: string }).code === '23505') {
      return NextResponse.json(
        { error: 'Worker name already registered.', code: 'DUPLICATE_NAME' },
        { status: 409 },
      );
    }

    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json(
      { error: `Registration failed: ${message}`, code: 'INTERNAL_ERROR' },
      { status: 500 },
    );
  }
}
