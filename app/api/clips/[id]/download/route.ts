/**
 * GET /api/clips/[id]/download
 *
 * Download a rendered clip MP4 file.
 * Serves from public/clips/ via redirect.
 *
 * Response: 302 redirect to /clips/{filename}
 * or 404 if not ready.
 */

import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/db/client';
import { existsSync } from 'fs';
import { join } from 'path';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const { id } = await params;

    const result = await query<{ filename: string }>(
      'SELECT filename FROM clips_cache WHERE id = $1',
      [id],
    );

    if (result.rows.length === 0) {
      return NextResponse.json({ error: 'Clip not found.', code: 'NOT_FOUND' }, { status: 404 });
    }

    const filename = result.rows[0].filename;

    if (!filename || filename.length === 0) {
      return NextResponse.json(
        { error: 'Clip not ready yet.', code: 'NOT_READY' },
        { status: 425 }, // 425 Too Early
      );
    }

    // Serve via redirect to public file
    const filePath = join(process.cwd(), 'public', 'clips', filename);
    if (!existsSync(filePath)) {
      return NextResponse.json(
        { error: 'Clip file not found on disk.', code: 'FILE_MISSING' },
        { status: 404 },
      );
    }

    // Redirect to the static file
    return NextResponse.redirect(new URL(`/clips/${filename}`, request.url));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message, code: 'INTERNAL_ERROR' }, { status: 500 });
  }
}
