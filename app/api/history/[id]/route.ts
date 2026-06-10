/**
 * GET /api/history/[id]
 *
 * Re-open a previous analysis. Returns EXACTLY the same shape as
 * POST /api/analyze so the frontend can do:
 *   setResult(data); setStage('done');
 * with zero transformation.
 *
 * Response (200):
 *   { analysisId, videoId, moments: [...] }
 *
 * Each moment:
 *   { startTime, endTime, worthClippingScore, confidence, dnaTags,
 *     reasoning, rank, tier, startTimestamp, endTimestamp, transcriptExcerpt }
 *
 * Error codes:
 *   404 NOT_FOUND — analysis does not exist
 *   403 FORBIDDEN — analysis belongs to another user
 */

import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/db/client';
import { getUserIdentity } from '@/lib/user-identity';
import { secondsToTimestamp } from '@/lib/format';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const { id } = await params;
    const identity = getUserIdentity(request);
    const ipPrefix = 'ip:';
    const ipAddress = identity.startsWith(ipPrefix) ? identity.slice(ipPrefix.length) : null;

    // 1. Fetch analysis + video info + verify ownership
    const analysisResult = await query<{
      id: string;
      youtube_id: string;
      ip_address: string;
      status: string;
    }>(
      `SELECT a.id, v.youtube_id, a.ip_address, a.status
       FROM analyses a
       JOIN videos v ON v.id = a.video_id
       WHERE a.id = $1`,
      [id],
    );

    if (analysisResult.rows.length === 0) {
      return NextResponse.json(
        { error: 'NOT_FOUND', message: 'Analysis not found.' },
        { status: 404 },
      );
    }

    const analysis = analysisResult.rows[0];

    // 2. Verify ownership (IP-based)
    if (ipAddress && analysis.ip_address && analysis.ip_address !== ipAddress) {
      return NextResponse.json(
        { error: 'FORBIDDEN', message: 'This analysis does not belong to you.' },
        { status: 403 },
      );
    }

    // 3. Fetch moments
    const momentsResult = await query<{
      start_time: string;
      end_time: string;
      worth_clipping_score: string;
      confidence: string;
      dna_tags: unknown;
      reasoning: string;
      transcript_excerpt: string;
      rank_position: number;
      tier: string;
      suggested_titles: unknown;
    }>(
      `SELECT start_time, end_time, worth_clipping_score, confidence,
              dna_tags, reasoning, transcript_excerpt, rank_position, tier,
              suggested_titles
       FROM moments
       WHERE analysis_id = $1
       ORDER BY rank_position`,
      [id],
    );

    // 4. Build moments array — identical shape to POST /api/analyze
    const moments = momentsResult.rows.map((row) => {
      const startTime = parseFloat(row.start_time);
      const endTime = parseFloat(row.end_time);
      return {
        startTime,
        endTime,
        worthClippingScore: parseFloat(row.worth_clipping_score),
        confidence: row.confidence,
        dnaTags: row.dna_tags as string[],
        reasoning: row.reasoning || '',
        rank: row.rank_position,
        tier: row.tier,
        startTimestamp: secondsToTimestamp(startTime),
        endTimestamp: secondsToTimestamp(endTime),
        transcriptExcerpt: row.transcript_excerpt || '',
        suggestedTitles: row.suggested_titles as Array<{ style: string; title: string }> || null,
      };
    });

    return NextResponse.json({
      analysisId: analysis.id,
      videoId: analysis.youtube_id,
      moments,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('GET /api/history/[id] error:', message);
    return NextResponse.json(
      { error: 'INTERNAL_ERROR', message: 'Failed to load analysis.' },
      { status: 500 },
    );
  }
}
