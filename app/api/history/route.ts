/**
 * GET /api/history
 *
 * Returns the 5 most recent completed analyses for the current user.
 * Uses IP-based identity (abstracted via getUserIdentity).
 *
 * Response (200):
 *   {
 *     "analyses": [{
 *       "analysisId": "uuid",
 *       "videoId": "youtube-id",
 *       "title": "Video Title",
 *       "channelName": "Channel",
 *       "thumbnailUrl": "https://img.youtube.com/vi/{id}/mqdefault.jpg",
 *       "createdAt": "2026-06-05T...",
 *       "totalMoments": 7,
 *       "avgScore": 82
 *     }, ...]
 *   }
 */

import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/db/client';
import { getUserIdentity } from '@/lib/user-identity';

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const identity = getUserIdentity(request);
    const ipPrefix = 'ip:';
    const ipAddress = identity.startsWith(ipPrefix) ? identity.slice(ipPrefix.length) : 'unknown';

    const result = await query<{
      id: string;
      youtube_id: string;
      title: string;
      channel_name: string;
      created_at: string;
      total_moments_found: number;
      avg_score: number | null;
    }>(
      `SELECT
         a.id,
         v.youtube_id,
         v.title,
         v.channel_name,
         a.created_at,
         a.total_moments_found,
         ROUND(AVG(m.worth_clipping_score), 0)::int AS avg_score
       FROM analyses a
       JOIN videos v ON v.id = a.video_id
       LEFT JOIN moments m ON m.analysis_id = a.id
       WHERE a.ip_address = $1
         AND a.status = 'completed'
       GROUP BY a.id, v.youtube_id, v.title, v.channel_name,
                a.created_at, a.total_moments_found
       ORDER BY a.created_at DESC
       LIMIT 5`,
      [ipAddress],
    );

    const analyses = result.rows.map((row) => ({
      analysisId: row.id,
      videoId: row.youtube_id,
      title: row.title || row.youtube_id,
      channelName: row.channel_name || 'Unknown',
      thumbnailUrl: `https://img.youtube.com/vi/${row.youtube_id}/mqdefault.jpg`,
      createdAt: row.created_at,
      totalMoments: row.total_moments_found || 0,
      avgScore: row.avg_score,
    }));

    return NextResponse.json({ analyses });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('GET /api/history error:', message);
    return NextResponse.json({ analyses: [] });
  }
}
