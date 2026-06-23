/**
 * Patch: Fix apiPost timeout and add retry for scene-complete
 *
 * Changes in worker/index.ts:
 * 1. Increase apiPost timeout from 120s to 180s
 * 2. Add automatic retry (3 attempts, 5s backoff) for scene-complete POST
 * 3. Better error logging
 */

// ============================================================
// CHANGE 1: apiPost function — increase timeout from 120s→180s
// ============================================================
// Replace the apiPost function:
// FROM:  const timeoutId = setTimeout(() => controller.abort(), 120_000);
// TO:    const timeoutId = setTimeout(() => controller.abort(), 180_000);

// ============================================================
// CHANGE 2: Retry wrapper around scene-complete POST
// ============================================================
// Replace the POST call in handleSceneVideo:
//
// FROM:
//   const resp = await apiPost(
//     `/api/workers/jobs/${job.id}/scene-complete`,
//     { worker_id, analysis_id, youtube_id, scenes, moments },
//     env.WORKER_API_KEY,
//   );
//   if (resp.ok) { ... }
//
// TO:
//   // Retry scene-complete POST up to 3 times
//   let lastError = '';
//   for (let attempt = 1; attempt <= 3; attempt++) {
//     try {
//       if (attempt > 1) {
//         log('SCENE', `  Retry attempt ${attempt}/3...`);
//         await new Promise(r => setTimeout(r, 5000 * attempt));
//       }
//       const resp = await apiPost(
//         `/api/workers/jobs/${job.id}/scene-complete`,
//         { worker_id, analysis_id, youtube_id, scenes, moments },
//         env.WORKER_API_KEY,
//       );
//       if (resp.ok) {
//         const data = await resp.json();
//         log('SCENE', `✅ Done: ${data.scenes_inserted} scenes, ${data.moments_updated} moments updated`);
//         lastError = '';
//         break;
//       } else {
//         const errText = await resp.text().catch(() => '(no body)');
//         lastError = `HTTP ${resp.status}: ${errText.slice(0, 300)}`;
//         log('SCENE', `❌ Attempt ${attempt} failed: ${lastError}`);
//       }
//     } catch (netErr) {
//       lastError = netErr instanceof Error ? netErr.message : String(netErr);
//       log('SCENE', `❌ Attempt ${attempt} network error: ${lastError}`);
//     }
//   }
//   if (lastError) {
//     throw new Error(`scene-complete failed after 3 retries: ${lastError}`);
//   }
