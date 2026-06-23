/**
 * POST /api/workers/jobs/[id]/scene-complete
 *
 * Receives scene detection and visual quality results from a worker.
 * Creates scenes in DB, updates moments with visual scores.
 *
 * Body: {
 *   worker_id: string,
 *   youtube_id: string,
 *   analysis_id: string,
 *   scenes: Array<{ scene_index, start_time, end_time, duration, score, transition_type }>,
 *   moments: Array<{ rank_position, visual_quality_score, sharpness, brightness,
 *                    exposure, face_visibility, blur_score }>
 * }
 *
 * Response (200): { scenes_inserted, moments_updated }
 * Response (400/401/404): { error, code }
 */
import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/db/client';
import { authenticateWorker } from '@/lib/worker-auth';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const jobId = (await params).id;
    if (!jobId) {
      return NextResponse.json({ error: 'Job ID is required.', code: 'BAD_REQUEST' }, { status: 400 });
    }

    // Authenticate
    const authHeader = request.headers.get('Authorization');
    const body = await request.json();
    const { worker_id, analysis_id, youtube_id, scenes, moments } = body || {};

    if (!worker_id) {
      return NextResponse.json({ error: 'worker_id is required.', code: 'BAD_REQUEST' }, { status: 400 });
    }
    if (!analysis_id) {
      return NextResponse.json({ error: 'analysis_id is required.', code: 'BAD_REQUEST' }, { status: 400 });
    }
    await authenticateWorker(worker_id, authHeader);

    // Track results
    let scenesInserted = 0;
    let momentsUpdated = 0;
    const errors: string[] = [];

    // 1. Insert scenes (if provided)
    if (Array.isArray(scenes) && scenes.length > 0) {
      try {
        // Delete existing scenes for this analysis (re-run safe)
        await query('DELETE FROM scenes WHERE analysis_id = $1', [analysis_id]);

        for (const s of scenes) {
          await query(
            `INSERT INTO scenes
             (analysis_id, video_id, scene_index, start_time, end_time, duration, score, transition_type, avg_brightness, avg_sharpness)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [
              analysis_id,
              youtube_id || '',
              s.scene_index || 0,
              s.start_time || 0,
              s.end_time || 0,
              s.duration || 0,
              s.score || 0,
              s.transition_type || 'unknown',
              s.avg_brightness ?? null,
              s.avg_sharpness ?? null,
            ],
          );
          scenesInserted++;
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        errors.push(`scenes_insert: ${errMsg}`);
        console.error(`[SCENE-COMPLETE] Failed to insert scenes: ${errMsg}`);
      }
    }

    // 2. Update moments visual quality scores (if provided)
    if (Array.isArray(moments) && moments.length > 0) {
      for (const m of moments) {
        if (typeof m.rank_position !== 'number') continue;
        try {
          await query(
            `UPDATE moments SET
               visual_quality_score = $1,
               sharpness = $2,
               brightness = $3,
               exposure = $4,
               face_visibility = $5,
               blur_score = $6
             WHERE analysis_id = $7 AND rank_position = $8`,
            [
              m.visual_quality_score ?? null,
              m.sharpness ?? null,
              m.brightness ?? null,
              m.exposure ?? null,
              m.face_visibility ?? null,
              m.blur_score ?? null,
              analysis_id,
              m.rank_position,
            ],
          );
          momentsUpdated++;
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          errors.push(`moment_update[${m.rank_position}]: ${errMsg}`);
        }
      }
    }

    // 3. Mark job as completed
    await query(
      `UPDATE jobs_queue SET status = 'completed', result = $1::jsonb, updated_at = NOW(), completed_at = NOW()
       WHERE id = $2`,
      [JSON.stringify({ scenes_inserted: scenesInserted, moments_updated: momentsUpdated }), jobId],
    );

    // 4. Update worker stats
    await query(
      `UPDATE workers SET jobs_completed = jobs_completed + 1 WHERE id = $1`,
      [worker_id],
    );

    console.log(`[SCENE-COMPLETE] Job ${jobId}: ${scenesInserted} scenes, ${momentsUpdated} moments updated`);

    return NextResponse.json({
      scenes_inserted: scenesInserted,
      moments_updated: momentsUpdated,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[SCENE-COMPLETE] Error:', message);
    return NextResponse.json({ error: message, code: 'INTERNAL_ERROR' }, { status: 500 });
  }
}
