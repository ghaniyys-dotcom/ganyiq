/**
 * GET /api/analyze/[id]/status
 *
 * Polling endpoint for async analysis progress.
 * Returns current status, stage, and (when complete) the full result.
 *
 * Response shapes:
 *   200 (processing): { analysisId, status: "processing", stage: string }
 *   200 (completed):  { analysisId, videoId, status: "completed", moments: [...] }
 *   200 (failed):     { analysisId, status: "failed", error: string }
 *   404:              { error: "NOT_FOUND" }
 */

import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/db/client';
import { secondsToTimestamp } from '@/lib/format';
import { computeExportStrategy } from '@/lib/export-strategy';
import { computeAllDisplayScores } from '@/lib/score-spread';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const { id } = await params;

    // Fetch analysis + video info
    const result = await query<{
      id: string;
      youtube_id: string;
      status: string;
      progress_stage: string | null;
      error_message: string | null;
      total_moments_found: number;
    }>(
      `SELECT a.id, v.youtube_id, a.status, a.progress_stage,
              a.error_message, a.total_moments_found
       FROM analyses a
       JOIN videos v ON v.id = a.video_id
       WHERE a.id = $1`,
      [id],
    );

    if (result.rows.length === 0) {
      return NextResponse.json(
        { error: 'NOT_FOUND', message: 'Analysis not found.' },
        { status: 404 },
      );
    }

    const row = result.rows[0];

    // If still processing, return status + stage only
    if (row.status === 'pending' || row.status === 'processing') {
      return NextResponse.json({
        analysisId: row.id,
        status: row.status,
        stage: row.progress_stage || 'queued',
      });
    }

    // If failed, return error
    if (row.status === 'failed') {
      return NextResponse.json({
        analysisId: row.id,
        status: 'failed',
        error: row.error_message || 'Analysis failed.',
      });
    }

    // Completed — fetch moments and return full result
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

    const moments = momentsResult.rows.map((m) => {
      const startTime = parseFloat(m.start_time);
      const endTime = parseFloat(m.end_time);
      return {
        startTime,
        endTime,
        worthClippingScore: parseFloat(m.worth_clipping_score),
        confidence: m.confidence,
        dnaTags: m.dna_tags as string[],
        reasoning: m.reasoning || '',
        rank: m.rank_position,
        tier: m.tier,
        startTimestamp: secondsToTimestamp(startTime),
        endTimestamp: secondsToTimestamp(endTime),
        transcriptExcerpt: m.transcript_excerpt || '',
        suggestedTitles: m.suggested_titles as Array<{ style: string; title: string }> || null,
        exportStrategy: null as Record<string, unknown> | null,
      };
    });

    // Apply score spread to address compression
    // Display scores use rank-based sqrt curve when raw scores are tight (<30pt range)
    const displayScores = computeAllDisplayScores(moments);
    for (const moment of moments) {
      const displayScore = displayScores.get(moment.rank);
      if (displayScore !== undefined) {
        (moment as any).displayScore = displayScore;
      }
    }

    // Compute export strategy for each moment (requires transcript timing data)
    try {
      const videoResult = await query<{ transcript: unknown }>(
        'SELECT transcript FROM videos WHERE id = (SELECT video_id FROM analyses WHERE id = $1)',
        [id],
      );
      if (videoResult.rows.length > 0 && videoResult.rows[0].transcript) {
        const transcript = videoResult.rows[0].transcript as Array<{ start: number; duration: number; text: string }>;
        if (Array.isArray(transcript) && transcript.length > 0) {
          for (const moment of moments) {
            try {
              (moment as any).exportStrategy = computeExportStrategy(
                transcript,
                moment.startTime,
                moment.endTime,
              );
            } catch { /* skip per-moment failures */ }
          }
        }
      }
    } catch { /* export strategy optional */ }

    // Fetch funnel metrics
    let funnel: Record<string, number> | null = null;
    try {
      const metricsResult = await query<Record<string, unknown>>(
        `SELECT transcript_words, transcript_segments, candidates_extracted,
                high_signal_candidates, elite_clips, candidates_ranked
         FROM analysis_metrics
         WHERE analysis_id = $1`,
        [id],
      );
      if (metricsResult.rows.length > 0) {
        const m = metricsResult.rows[0];
        funnel = {
          transcriptWords: (m.transcript_words as number) || 0,
          transcriptSegments: (m.transcript_segments as number) || 0,
          candidateMoments: (m.candidates_extracted as number) || 0,
          highSignalMoments: (m.high_signal_candidates as number) || 0,
          eliteMoments: (m.elite_clips as number) || 0,
          finalRecommendations: (m.candidates_ranked as number) || 0,
        };
      }
    } catch { /* funnel data optional */ }

    return NextResponse.json({
      analysisId: row.id,
      videoId: row.youtube_id,
      status: 'completed',
      moments,
      funnel,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('GET /api/analyze/[id]/status error:', message);
    return NextResponse.json(
      { error: 'INTERNAL_ERROR', message: 'Failed to fetch status.' },
      { status: 500 },
    );
  }
}
