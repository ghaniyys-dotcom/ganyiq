/**
 * worker/scene-detector.ts — Scene detection module for GANYIQ
 *
 * Uses ffmpeg scene detection filter to identify hard cuts and visual transitions.
 * Also uses ffprobe for frame-level analysis.
 *
 * Output: SceneBoundary[] with metadata about each detected scene.
 */

import { execSync, exec } from 'child_process';
import { existsSync, writeFileSync } from 'fs';
import { resolve, join, basename } from 'path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SceneBoundary {
  /** Start time in seconds */
  startTime: number;
  /** End time in seconds */
  endTime: number;
  /** Duration in seconds */
  duration: number;
  /** Scene change score (0-1 from ffmpeg scene detect, or custom) */
  score: number;
  /** Type of transition: 'hard_cut' | 'fade' | 'dissolve' | 'unknown' */
  transitionType: 'hard_cut' | 'fade' | 'dissolve' | 'unknown';
  /** Average brightness of scene (0-255) */
  avgBrightness?: number;
  /** Average blur score (lower = blurrier) */
  avgSharpness?: number;
}

export interface SceneDetectResult {
  videoFile: string;
  videoDuration: number;
  totalScenes: number;
  scenes: SceneBoundary[];
  /** Average scene duration */
  avgSceneDuration: number;
  /** Shortest scene */
  minSceneDuration: number;
  /** Longest scene */
  maxSceneDuration: number;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const SCENE_DETECT_THRESHOLD = 0.2; // Lower = more sensitive (0.1-0.4 typical)
const MIN_SCENE_DURATION = 0.5; // Filter out sub-0.5s scenes (usually noise)
const MAX_SCENES = 200; // Safety cap

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

let ffmpegPath = 'ffmpeg';
let ffprobePath = 'ffprobe';

export function setFFmpegPaths(ffmpeg: string, ffprobe: string) {
  ffmpegPath = ffmpeg;
  ffprobePath = ffprobe;
}

/**
 * Detect scene boundaries from a video file using ffmpeg scene detection.
 * Returns parsed SceneBoundary[] with types and scores.
 */
export async function detectScenes(videoFile: string): Promise<SceneDetectResult> {
  if (!existsSync(videoFile)) {
    throw new Error(`Video file not found: ${videoFile}`);
  }

  // Get video duration
  const duration = await getVideoDuration(videoFile);

  // Step 1: Use ffmpeg scene detection filter to get raw scene change scores
  const sceneChanges = await getFfmpegSceneChanges(videoFile);

  if (sceneChanges.length === 0) {
    // Fallback: treat whole video as one scene
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

  // Step 2: Build scene segments from scene change points
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

  // Final scene
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

  // Step 3: Compute per-scene visual quality (brightness, sharpness) for a sample
  const sceneStats = await computeSceneStats(videoFile, scenes);

  const durations = scenes.map(s => s.duration);
  return {
    videoFile,
    videoDuration: duration,
    totalScenes: scenes.length,
    scenes: sceneStats,
    avgSceneDuration: durations.reduce((a, b) => a + b, 0) / durations.length,
    minSceneDuration: Math.min(...durations),
    maxSceneDuration: Math.max(...durations),
  };
}

/**
 * Get video duration using ffprobe.
 */
async function getVideoDuration(videoFile: string): Promise<number> {
  return new Promise((resolve, reject) => {
    exec(
      `${ffprobePath} -v error -show_entries format=duration -of csv=p=0 "${videoFile}"`,
      (err, stdout) => {
        if (err) return reject(err);
        resolve(parseFloat(stdout.trim()) || 0);
      }
    );
  });
}

/**
 * Use ffmpeg scene detection filter to get scene change timestamps with scores.
 * Returns array of { time, score } sorted by time.
 */
async function getFfmpegSceneChanges(videoFile: string): Promise<Array<{ time: number; score: number }>> {
  return new Promise((resolvePromise, reject) => {
    // ffmpeg scene detection filter outputs scores per frame
    // We parse the log to find scene changes above threshold
    const cmd = `${ffmpegPath} -i "${videoFile}" -filter:v "select='gt(scene,${SCENE_DETECT_THRESHOLD})',showinfo" -f null - 2>&1`;
    
    exec(cmd, { timeout: 300000 }, (err, stdout, stderr) => {
      // ffmpeg outputs scene info to stderr
      const output = (stderr || '') + (stdout || '');
      const changes: Array<{ time: number; score: number }> = [];
      
      // Parse lines like: [Parsed_showinfo_1 @ ...] pts:12345 pts_time:30.5 duration:...
      const lines = output.split('\n');
      for (const line of lines) {
        // Match pts_time for each selected frame
        const ptsMatch = line.match(/pts_time:([\d.]+)/);
        const sceneMatch = line.match(/scene:\s*([\d.]+)/i);
        
        if (ptsMatch) {
          const time = parseFloat(ptsMatch[1]);
          changes.push({ time, score: sceneMatch ? parseFloat(sceneMatch[1]) : 0.5 });
        }
      }
      
      // Deduplicate and sort
      const unique = changes.filter((c, i) => i === 0 || c.time - changes[i - 1].time > 0.1);
      resolvePromise(unique);
    });
  });
}

/**
 * Classify transition type based on score.
 * Hard cuts → high sudden score
 * Fades/dissolves → gradual score accumulation
 */
function classifyTransition(score: number): SceneBoundary['transitionType'] {
  if (score > 0.4) return 'hard_cut';
  if (score > 0.2) return 'dissolve';
  return 'fade';
}

/**
 * Compute visual stats per scene (brightness, sharpness) by sampling frames.
 * Can be async-heavy; we might limit to 1 frame per scene for speed.
 */
async function computeSceneStats(videoFile: string, scenes: SceneBoundary[]): Promise<SceneBoundary[]> {
  const updated: SceneBoundary[] = [];

  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    try {
      const stats = await getFrameStats(videoFile, scene.startTime);
      updated.push({
        ...scene,
        avgBrightness: stats.brightness,
        avgSharpness: stats.sharpness,
      });
    } catch {
      updated.push(scene);
    }
  }

  return updated;
}

/**
 * Extract brightness and sharpness from a single frame at a given time.
 * Uses ffmpeg to extract frame → analyze with ffmpeg signalstats + blur.
 */
async function getFrameStats(videoFile: string, timeSeconds: number): Promise<{ brightness: number; sharpness: number }> {
  return new Promise((resolvePromise, reject) => {
    // Extract a single frame and analyze
    const cmd = `${ffmpegPath} -ss ${timeSeconds} -i "${videoFile}" -vframes 1 -f rawvideo -pix_fmt gray - |
                 ${ffmpegPath} -f rawvideo -pixel_format gray -video_size 1920x1080 -i pipe: -vf "signalstats,metadata=print" -f null - 2>&1`;
    
    exec(cmd, { timeout: 30000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        resolvePromise({ brightness: 128, sharpness: 0.5 }); // Defaults on error
        return;
      }
      
      const output = (stderr || '') + (stdout || '');
      
      // Parse brightness from signalstats: YMIN, YMAX, YAVG
      const yavgMatch = output.match(/YAVG:\s*(\d+)/);
      const brightness = yavgMatch ? parseInt(yavgMatch[1]) : 128;
      
      // Estimate sharpness from blur detection
      const blurMatch = output.match(/blur:\s*([\d.]+)/i);
      const sharpness = blurMatch ? 1 - parseFloat(blurMatch[1]) : 0.5;
      
      resolvePromise({ brightness: brightness / 255, sharpness });
    });
  });
}

/**
 * Find which scene a timestamp belongs to.
 */
export function getSceneAtTime(scenes: SceneBoundary[], timeSeconds: number): SceneBoundary | null {
  return scenes.find(s => timeSeconds >= s.startTime && timeSeconds < s.endTime) || null;
}

/**
 * Filter scene list to remove tiny noise scenes and merge adjacent similar scenes.
 */
export function cleanScenes(scenes: SceneBoundary[], minDuration: number = 1.0): SceneBoundary[] {
  if (scenes.length <= 1) return scenes;
  
  const cleaned: SceneBoundary[] = [scenes[0]];
  
  for (let i = 1; i < scenes.length; i++) {
    const current = scenes[i];
    const prev = cleaned[cleaned.length - 1];
    
    if (current.duration < minDuration) {
      // Merge tiny scene with previous
      prev.endTime = current.endTime;
      prev.duration = prev.endTime - prev.startTime;
    } else {
      cleaned.push(current);
    }
  }
  
  return cleaned;
}
