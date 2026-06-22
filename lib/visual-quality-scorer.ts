/**
 * lib/visual-quality-scorer.ts — Wraps the worker's Python visual quality scorer
 *
 * Calls visual-quality-scorer.py as a subprocess.
 * Handles failures gracefully — returns default values on error, never crashes.
 */

import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { SceneBoundary, VisualQualityResult } from './scene-detector';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_RESULT: VisualQualityResult = {
  visual_quality_score: 5,
  sharpness: 0,
  brightness: 128,
  exposure: 0,
  face_visibility: 0,
  blur_score: 0,
  frames_analyzed: 0,
};

const PYTHON_SCRIPT = '/root/GANYIQ/worker/visual-quality-scorer.py';
const PYTHON_BIN = 'python3';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Call the Python scorer as a subprocess and parse the JSON result.
 */
function runPythonScorer(videoPath: string, startTime: number, endTime: number): VisualQualityResult {
  // Validate inputs
  if (!videoPath || !existsSync(videoPath)) {
    console.warn(`[VQ] Video not found: ${videoPath}`);
    return { ...DEFAULT_RESULT };
  }

  if (typeof startTime !== 'number' || typeof endTime !== 'number' || startTime < 0 || endTime <= startTime) {
    console.warn(`[VQ] Invalid time range: ${startTime} - ${endTime}`);
    return { ...DEFAULT_RESULT };
  }

  if (!existsSync(PYTHON_SCRIPT)) {
    console.warn(`[VQ] Python script not found: ${PYTHON_SCRIPT}`);
    return { ...DEFAULT_RESULT };
  }

  try {
    const cmd = `${PYTHON_BIN} "${PYTHON_SCRIPT}" "${videoPath}" ${startTime} ${endTime}`;
    const stdout = execSync(cmd, { timeout: 120000, maxBuffer: 10 * 1024 * 1024 }).toString().trim();
    const parsed = JSON.parse(stdout);

    // The Python script may return { output: "...", error: "..." } or { visual_quality_score: ..., ... }
    if (parsed.error && !parsed.visual_quality_score) {
      console.warn(`[VQ] Python scorer error for ${videoPath} [${startTime}-${endTime}]: ${parsed.error}`);
      return { ...DEFAULT_RESULT };
    }

    return {
      visual_quality_score: typeof parsed.visual_quality_score === 'number' ? parsed.visual_quality_score : DEFAULT_RESULT.visual_quality_score,
      sharpness:            typeof parsed.sharpness === 'number'            ? parsed.sharpness            : DEFAULT_RESULT.sharpness,
      brightness:           typeof parsed.brightness === 'number'           ? parsed.brightness           : DEFAULT_RESULT.brightness,
      exposure:             typeof parsed.exposure === 'number'             ? parsed.exposure             : DEFAULT_RESULT.exposure,
      face_visibility:      typeof parsed.face_visibility === 'number'      ? parsed.face_visibility      : DEFAULT_RESULT.face_visibility,
      blur_score:           typeof parsed.blur_score === 'number'           ? parsed.blur_score           : DEFAULT_RESULT.blur_score,
      frames_analyzed:      typeof parsed.frames_analyzed === 'number'      ? parsed.frames_analyzed      : DEFAULT_RESULT.frames_analyzed,
    };
  } catch (err) {
    console.warn(`[VQ] Scorer subprocess failed for ${videoPath} [${startTime}-${endTime}]:`, err instanceof Error ? err.message : String(err));
    return { ...DEFAULT_RESULT };
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Score the visual quality of a specific clip within a video.
 *
 * @param videoPath - Absolute path to the video file.
 * @param startTime - Clip start time in seconds.
 * @param endTime   - Clip end time in seconds.
 * @returns VisualQualityResult with scores, or defaults on failure.
 */
export function scoreClipQuality(
  videoPath: string,
  startTime: number,
  endTime: number,
): Promise<VisualQualityResult> {
  return Promise.resolve(runPythonScorer(videoPath, startTime, endTime));
}

/**
 * Score visual quality for every scene in an array of SceneBoundary objects.
 * Attaches the visual quality scores as a `visualQuality` field on each scene.
 *
 * @param videoPath - Absolute path to the video file.
 * @param scenes    - Array of SceneBoundary objects (must have startTime / endTime).
 * @returns The same SceneBoundary[] (new references) with scores attached, or
 *          the original scenes if the scorer fails.
 */
export function scoreVideoScenes(
  videoPath: string,
  scenes: SceneBoundary[],
): Promise<SceneBoundary[]> {
  if (!Array.isArray(scenes) || scenes.length === 0) {
    return Promise.resolve(scenes || []);
  }

  const updated = scenes.map((scene) => {
    const quality = runPythonScorer(videoPath, scene.startTime, scene.endTime);
    return {
      ...scene,
      visualQuality: quality,
    };
  });

  return Promise.resolve(updated);
}
