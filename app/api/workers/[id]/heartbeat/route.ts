import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/db/client';
import { authenticateWorker } from '@/lib/worker-auth';

/**
 * POST /api/workers/[id]/heartbeat
 *
 * Worker keeps itself alive. Must be called every 60 seconds.
 *
 * Headers: Authorization: Bearer <api_key>
 * Body (optional): { version?: string }
 * Response (200): { status: "ok", worker: { id, name, status, last_heartbeat } }
 * Response (401): { error, code }
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const { id } = await params;
    const authResult = await authenticateWorker(id, request.headers.get('Authorization'));

    // Optional: update version if provided
    let versionUpdate = '';
    try {
      const body = await request.json();
      if (body?.version) {
        versionUpdate = body.version;
      }
    } catch { /* no body or not JSON — ignore */ }

    if (versionUpdate) {
      await query(
        'UPDATE workers SET status = $1, last_heartbeat = NOW(), version = $2, updated_at = NOW() WHERE id = $3',
        ['online', versionUpdate, id],
      );
    } else {
      await query(
        'UPDATE workers SET status = $1, last_heartbeat = NOW(), updated_at = NOW() WHERE id = $2',
        ['online', id],
      );
    }

    return NextResponse.json({
      status: 'ok',
      worker: {
        id: authResult.worker.id,
        name: authResult.worker.worker_name,
        status: 'online',
        last_heartbeat: new Date().toISOString(),
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
