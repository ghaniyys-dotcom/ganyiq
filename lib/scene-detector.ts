/**
 * lib/scene-detector.ts — Server-side scene detection
 *
 * Uses ffmpeg scene detection filter to identify hard cuts and visual transitions.
 * Runs on VPS after video download during analysis pipeline.
 *
 * Persists results to `scenes` table.
 */

import { execSync, exec } from 'child_process';
import { existsSync } from 'fs';
import { query } from '@/db/client';
import { promisify } from 'util';

const execAsync = promisify(exec);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VisualQualityResult {
  visual_quality_score: number;
  sharpness: number;
  brightness: number;
  exposure: number;
  face_visibility: number;
  blur_score: number;
  frames_analyzed: number;
}

export interface SceneBoundary {
  startTime: number;
  endTime: number;
  duration: number;
  score: number;
  transitionType: 'hard_cut' | 'fade' | 'dissolve' | 'unknown';
  avgBrightness?: number;
  avgSharpness?: number;
  visualQuality?: VisualQualityResult;
}

export interface SceneInfo {
  scene_index: number;
  start_time: number;
  end_time: number;
  duration: number;
  score: number;
  transition_type: string;
}

export interface SceneDetectResult {
  videoFile: string;
  videoDuration: number;
  totalScenes: number;
  scenes: SceneBoundary[];
  avgSceneDuration: number;
  minSceneDuration: number;
  maxSceneDuration: number;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const SCENE_DETECT_THRESHOLD = 0.2;
const MIN_SCENE_DURATION = 0.5;
const MAX_SCENES = 200;

// ---------------------------------------------------------------------------
// Scene Detection
// ---------------------------------------------------------------------------

/**
 /**
  * Detect scene boundaries asynchronously (non-blocking).
  * Preferred over detectScenes() when running in the main process.
  */
 export async function detectScenesAsync(videoFile: string): Promise<SceneDetectResult> {
   if (!existsSync(videoFile)) {
     console.warn(`[SCENE] Video not found: ${videoFile}`);
     return { videoFile, videoDuration: 0, totalScenes: 0, scenes: [], avgSceneDuration: 0, minSceneDuration: 0, maxSceneDuration: 0 };
   }

   const duration = await getVideoDurationAsync(videoFile);
   const sceneChanges = await getFfmpegSceneChangesAsync(videoFile);

   if (sceneChanges.length === 0) {
     return {
       videoFile,
       videoDuration: duration,
       totalScenes: 1,
       scenes: [{ startTime: 0, endTime: duration, duration, score: 0, transitionType: 'unknown' }],
       avgSceneDuration: duration,
       minSceneDuration: duration,
       maxSceneDuration: duration,
     };
   }

   const scenes: SceneBoundary[] = [];
   let sceneStart = 0;

   for (const change of sceneChanges) {
     const segDuration = change.time - sceneStart;
     if (segDuration >= MIN_SCENE_DURATION) {
       scenes.push({
         startTime: sceneStart,
         endTime: change.time,
         duration: segDuration,
         score: change.score,
         transitionType: classifyTransition(change.score),
       });
     }
     sceneStart = change.time;
     if (scenes.length >= MAX_SCENES) break;
   }

   const finalDuration = duration - sceneStart;
   if (finalDuration > 0) {
     scenes.push({
       startTime: sceneStart,
       endTime: duration,
       duration: finalDuration,
       score: 0,
       transitionType: 'unknown',
     });
   }

   const durations = scenes.map(s => s.duration);
   return {
     videoFile,
     videoDuration: duration,
     totalScenes: scenes.length,
     scenes,
     avgSceneDuration: durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : 0,
     minSceneDuration: durations.length > 0 ? Math.min(...durations) : 0,
     maxSceneDuration: durations.length > 0 ? Math.max(...durations) : 0,
   };
 }

 async function getVideoDurationAsync(videoFile: string): Promise<number> {
   try {
     const { stdout } = await execAsync(
       `ffprobe -v error -show_entries format=duration -of csv=p=0 "${videoFile}"`,
       { timeout: 30000 },
     );
     return parseFloat(stdout.trim()) || 0;
   } catch {
     return 0;
   }
 }

 async function getFfmpegSceneChangesAsync(videoFile: string): Promise<SceneChange[]> {
   try {
     const cmd = `ffmpeg -i "${videoFile}" -filter:v "select='gt(scene,${SCENE_DETECT_THRESHOLD})',showinfo" -f null - 2>&1`;
     const { stdout, stderr } = await execAsync(cmd, { timeout: 600000, maxBuffer: 100 * 1024 * 1024 });
     const output = stderr || stdout || '';

     const changes: SceneChange[] = [];
     const lines = output.split('\n');
     for (const line of lines) {
       const ptsMatch = line.match(/pts_time:([\d.]+)/);
       const sceneMatch = line.match(/scene:\s*([\d.]+)/i);
       if (ptsMatch) {
         changes.push({ time: parseFloat(ptsMatch[1]), score: sceneMatch ? parseFloat(sceneMatch[1]) : 0.5 });
       }
     }

     return changes.filter((c, i) => i === 0 || c.time - changes[i - 1].time > 0.1);
   } catch (err) {
     console.error('[SCENE] ffmpeg detection failed:', err);
     return [];
   }
 }

 /**
  * Detect scene boundaries from a video file using ffmpeg scene detection (SYNC).
  * Use detectScenesAsync() for non-blocking operation.
  */
 export function detectScenes(videoFile: string): SceneDetectResult {
   if (!existsSync(videoFile)) {
     console.warn(`[SCENE] Video not found: ${videoFile}`);
     return { videoFile, videoDuration: 0, totalScenes: 0, scenes: [], avgSceneDuration: 0, minSceneDuration: 0, maxSceneDuration: 0 };
   }

   const duration = getVideoDurationSync(videoFile);
   const sceneChanges = getFfmpegSceneChangesSync(videoFile);

   if (sceneChanges.length === 0) {
     return {
       videoFile,
       videoDuration: duration,
       totalScenes: 1,
       scenes: [{ startTime: 0, endTime: duration, duration, score: 0, transitionType: 'unknown' }],
       avgSceneDuration: duration,
       minSceneDuration: duration,
       maxSceneDuration: duration,
     };
   }

   const scenes: SceneBoundary[] = [];
   let sceneStart = 0;

  for (const change of sceneChanges) {
    const segDuration = change.time - sceneStart;
    if (segDuration >= MIN_SCENE_DURATION) {
      scenes.push({
        startTime: sceneStart,
        endTime: change.time,
        duration: segDuration,
        score: change.score,
        transitionType: classifyTransition(change.score),
      });
    }
    sceneStart = change.time;
    if (scenes.length >= MAX_SCENES) break;
  }

  const finalDuration = duration - sceneStart;
  if (finalDuration > 0) {
    scenes.push({
      startTime: sceneStart,
      endTime: duration,
      duration: finalDuration,
      score: 0,
      transitionType: 'unknown',
    });
  }

  const durations = scenes.map(s => s.duration);
  return {
    videoFile,
    videoDuration: duration,
    totalScenes: scenes.length,
    scenes,
    avgSceneDuration: durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : 0,
    minSceneDuration: durations.length > 0 ? Math.min(...durations) : 0,
    maxSceneDuration: durations.length > 0 ? Math.max(...durations) : 0,
  };
}

function getVideoDurationSync(videoFile: string): number {
  try {
    const output = execSync(
      `ffprobe -v error -show_entries format=duration -of csv=p=0 "${videoFile}"`,
      { timeout: 30000, encoding: 'utf-8' },
    );
    return parseFloat(output.trim()) || 0;
  } catch {
    return 0;
  }
}

interface SceneChange {
  time: number;
  score: number;
}

function getFfmpegSceneChangesSync(videoFile: string): SceneChange[] {
  try {
    const cmd = `ffmpeg -i "${videoFile}" -filter:v "select='gt(scene,${SCENE_DETECT_THRESHOLD})',showinfo" -f null - 2>&1`;
    const output = execSync(cmd, { timeout: 300000, maxBuffer: 50 * 1024 * 1024 }).toString();

    const changes: SceneChange[] = [];
    const lines = output.split('\n');
    for (const line of lines) {
      const ptsMatch = line.match(/pts_time:([\d.]+)/);
      const sceneMatch = line.match(/scene:\s*([\d.]+)/i);
      if (ptsMatch) {
        changes.push({ time: parseFloat(ptsMatch[1]), score: sceneMatch ? parseFloat(sceneMatch[1]) : 0.5 });
      }
    }

    return changes.filter((c, i) => i === 0 || c.time - changes[i - 1].time > 0.1);
  } catch (err) {
    console.error('[SCENE] ffmpeg detection failed:', err);
    return [];
  }
}

function classifyTransition(score: number): SceneBoundary['transitionType'] {
  if (score > 0.4) return 'hard_cut';
  if (score > 0.2) return 'dissolve';
  return 'fade';
}

/**
 * Legacy function: detect scenes from video, returns SceneInfo[] for backward compat.
 */
export function detectScenesFromVideo(videoPath: string): SceneInfo[] {
  const result = detectScenes(videoPath);
  return result.scenes.map((s, i) => ({
    scene_index: i,
    start_time: s.startTime,
    end_time: s.endTime,
    duration: s.duration,
    score: s.score,
    transition_type: s.transitionType,
  }));
}

/**
 * Find which scene a timestamp belongs to.
 */
export function getSceneAtTime(scenes: SceneBoundary[], timeSeconds: number): SceneBoundary | null {
  return scenes.find(s => timeSeconds >= s.startTime && timeSeconds < s.endTime) || null;
}

/**
 * Persist scene data to DB.
 */
export async function persistScenes(
  analysisId: string,
  videoId: string,
  scenes: SceneBoundary[],
): Promise<void> {
  if (!scenes.length) return;

  for (let i = 0; i < scenes.length; i++) {
    const s = scenes[i];
    try {
      await query(
        `INSERT INTO scenes (analysis_id, video_id, scene_index, start_time, end_time, duration, score, transition_type, avg_brightness, avg_sharpness)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (id) DO NOTHING`,
        [
          analysisId,
          videoId,
          i,
          s.startTime.toFixed(3),
          s.endTime.toFixed(3),
          s.duration.toFixed(3),
          s.score.toFixed(4),
          s.transitionType,
          s.avgBrightness?.toFixed(4) ?? null,
          s.avgSharpness?.toFixed(4) ?? null,
        ],
      );
    } catch (err) {
      console.error(`[SCENE DB] Failed to persist scene ${i}:`, err);
    }
  }
  console.log(`[SCENE] Persisted ${scenes.length} scenes for analysis ${analysisId}`);
}
