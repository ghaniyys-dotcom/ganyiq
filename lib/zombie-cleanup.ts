/**
 * lib/zombie-cleanup.ts — Startup zombie analysis cleanup.
 *
 * Called during application startup (imported by the first API route load).
 * Automatically fails any analysis stuck in 'processing' state for >1 hour.
 * These happen when the Node.js process crashes mid-pipeline (previously
 * from uncaughtException due to missing pool.on('error') handler).
 */
import { query } from '@/db/client';

let cleanupRun = false;

export async function cleanupZombieAnalyses(): Promise<{
  cleaned: number;
  skipped: boolean;
}> {
  if (cleanupRun) {
    return { cleaned: 0, skipped: true };
  }
  cleanupRun = true;

  try {
    const result = await query(
      `UPDATE analyses
       SET status = 'failed',
           progress_stage = 'failed',
           error_message = 'Zombie cleanup: analysis exceeded 1 hour without completion (process likely crashed).'
       WHERE status = 'processing'
         AND created_at < NOW() - INTERVAL '1 hour'
       RETURNING id`,
    );
    const count = result.rowCount ?? 0;
    if (count > 0) {
      console.log(`[ZOMBIE] Cleaned ${count} stuck analyses (status=processing for >1 hour)`);
    }
    return { cleaned: count, skipped: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.error(`[ZOMBIE] Cleanup failed: ${msg}`);
    return { cleaned: 0, skipped: false };
  }
}
