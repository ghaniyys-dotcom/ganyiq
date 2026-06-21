import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/db/client';

export async function GET(req: NextRequest) {
  try {
    // Get recent moments with scores
    const res = await query(`
      SELECT 
        m.id,
        m.transcript_excerpt,
        m.information_gain,
        m.attention_capture,
        m.harm,
        m.final_score,
        m.viral_score,
        m.hook_strength,
        m.surprise_level,
        m.novelty_score,
        m.emotional_intensity,
        m.audience_relevance,
        m.visual_quality_score,
        m.category,
        v.youtube_id
      FROM moments m
      LEFT JOIN analyses a ON m.analysis_id = a.id
      LEFT JOIN videos v ON a.video_id = v.id
      WHERE m.final_score IS NOT NULL
      ORDER BY m.final_score DESC
      LIMIT 200
    `);

    const moments = res.rows;

    if (moments.length === 0) {
      return NextResponse.json({ message: "No scored moments yet. Run analyses to populate." });
    }

    const sorted = [...moments].sort((a, b) => (b.final_score || 0) - (a.final_score || 0));

    const top = sorted.slice(0, 20);
    const bottom = sorted.slice(-20).reverse();

    // Distributions
    const igs = moments.map(m => m.information_gain).filter(Boolean);
    const acs = moments.map(m => m.attention_capture).filter(Boolean);
    const harms = moments.map(m => m.harm).filter(Boolean);
    const finals = moments.map(m => m.final_score).filter(Boolean);

    const avg = (arr: number[]) => arr.length ? (arr.reduce((s, v) => s + v, 0) / arr.length).toFixed(2) : '0';

    // Category distribution (if available, else from source or default)
    const categoryCounts: Record<string, number> = {};
    moments.forEach(m => {
      const cat = m.category || 'unknown';
      categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
    });

    const top10Percent = Math.ceil(sorted.length * 0.1);
    const topCats = sorted.slice(0, top10Percent).map(m => m.category || 'unknown');
    const topCatDist: Record<string, number> = {};
    topCats.forEach(c => topCatDist[c] = (topCatDist[c] || 0) + 1);

    const bottom10Percent = Math.ceil(sorted.length * 0.1);
    const bottomCats = sorted.slice(-bottom10Percent).map(m => m.category || 'unknown');
    const bottomCatDist: Record<string, number> = {};
    bottomCats.forEach(c => bottomCatDist[c] = (bottomCatDist[c] || 0) + 1);

    return NextResponse.json({
      total_scored: moments.length,
      top_clips: top,
      bottom_clips: bottom,
      distributions: {
        information_gain: { mean: avg(igs), min: Math.min(...igs), max: Math.max(...igs) },
        attention_capture: { mean: avg(acs) },
        harm: { mean: avg(harms) },
        final_score: { mean: avg(finals), min: Math.min(...finals), max: Math.max(...finals) },
        viral_score: { mean: avg(moments.map(m => m.viral_score).filter(Boolean)) }
      },
      category_distribution: categoryCounts,
      top_10_percent_categories: topCatDist,
      bottom_10_percent_categories: bottomCatDist,
      evaluator_fallback_active: true,
      notes: "Frozen evaluator unchanged. Viral score, visual quality separate. Phase 1 Tier 1 features added."
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
