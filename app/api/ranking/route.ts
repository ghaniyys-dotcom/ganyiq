import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/db/client';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const analysisId = searchParams.get('analysis_id');
  const limit = parseInt(searchParams.get('limit') || '50');

  try {
    let moments;

    if (analysisId) {
      const res = await query(
        `SELECT id, analysis_id, start_time, end_time, transcript_excerpt,
                information_gain, attention_capture, harm, final_score,
                worth_clipping_score, rank_position, tier
         FROM moments 
         WHERE analysis_id = $1 
         ORDER BY final_score DESC NULLS LAST, worth_clipping_score DESC
         LIMIT $2`,
        [analysisId, limit]
      );
      moments = res.rows;
    } else {
      // Latest analysis or all recent
      const res = await query(
        `SELECT m.id, m.analysis_id, m.start_time, m.end_time, m.transcript_excerpt,
                m.information_gain, m.attention_capture, m.harm, m.final_score,
                m.worth_clipping_score, m.rank_position, m.tier,
                v.youtube_id
         FROM moments m
         JOIN analyses a ON m.analysis_id = a.id
         JOIN videos v ON a.video_id = v.id
         ORDER BY m.final_score DESC NULLS LAST, m.worth_clipping_score DESC
         LIMIT $1`,
        [limit]
      );
      moments = res.rows;
    }

    // Compute final_score on the fly if not present (for backward compat)
    const ranked = moments.map((m: any) => {
      let finalScore = m.final_score;
      if (finalScore == null && m.information_gain != null) {
        finalScore = (m.information_gain * 5) + (m.attention_capture * 2) - (m.harm * 4);
      }
      return {
        ...m,
        final_score: finalScore != null ? Number(finalScore) : null,
        rank_by_final: true
      };
    });

    return NextResponse.json({
      success: true,
      count: ranked.length,
      ranked_by: 'final_score (IG*5 + AC*2 - H*4)',
      moments: ranked
    });
  } catch (error) {
    return NextResponse.json({ error: 'Ranking failed', details: String(error) }, { status: 500 });
  }
}
