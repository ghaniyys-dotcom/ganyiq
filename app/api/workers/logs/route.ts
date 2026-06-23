/**
 * POST /api/workers/logs — receive log entries from remote workers.
 *
 * Body: { worker_name: string, lines: string[], timestamp: string }
 * Stores to: /tmp/worker-logs/<worker_name>.log (append)
 *
 * This endpoint is fire-and-forget — no auth, no DB writes.
 * Used by the Hermes VPS to monitor LAPTOP-GANY/PC-GANY worker output.
 */

import { NextRequest, NextResponse } from 'next/server';
import { appendFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

const LOG_DIR = '/tmp/worker-logs';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { worker_name, lines, timestamp } = body || {};

    if (!worker_name || !Array.isArray(lines)) {
      return NextResponse.json(
        { error: 'worker_name (string) and lines (array) required.' },
        { status: 400 },
      );
    }

    // Ensure log directory
    if (!existsSync(LOG_DIR)) {
      mkdirSync(LOG_DIR, { recursive: true });
    }

    const logFile = join(LOG_DIR, `${worker_name}.log`);
    const ts = timestamp || new Date().toISOString();

    for (const line of lines) {
      appendFileSync(logFile, `[${ts}] ${line}\n`, 'utf-8');
    }

    // Truncate log to last 10000 lines if it gets too big
    const stats = existsSync(logFile) ? require('fs').statSync(logFile) : null;
    if (stats && stats.size > 1024 * 1024) {
      // >1MB — trim to last 5000 lines
      const content = require('fs').readFileSync(logFile, 'utf-8');
      const allLines = content.split('\n');
      if (allLines.length > 10000) {
        require('fs').writeFileSync(logFile, allLines.slice(-5000).join('\n') + '\n', 'utf-8');
      }
    }

    return NextResponse.json({ received: lines.length });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.error('POST /api/workers/logs error:', msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

/**
 * GET /api/workers/logs — retrieve stored logs for a worker.
 * Query: ?worker_name=<name>&tail=<N>
 * Default: last 200 lines.
 */
export async function GET(request: NextRequest) {
  const worker_name = request.nextUrl.searchParams.get('worker_name') || 'LAPTOP-GANY';
  const tailLines = parseInt(request.nextUrl.searchParams.get('tail') || '200', 10);

  const logFile = join(LOG_DIR, `${worker_name}.log`);
  if (!existsSync(logFile)) {
    return NextResponse.json({ lines: [], total: 0, file: logFile });
  }

  const content = require('fs').readFileSync(logFile, 'utf-8');
  const allLines = content.split('\n').filter(Boolean);
  const sliced = allLines.slice(-tailLines);

  return NextResponse.json({ lines: sliced, total: allLines.length, file: logFile, tail: tailLines });
}
