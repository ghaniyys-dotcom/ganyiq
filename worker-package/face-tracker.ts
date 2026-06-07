/**
 * worker/face-tracker.ts — Face tracking module for GANYIQ Worker V2
 *
 * Detects face positions in a video, applies smoothing, and generates
 * crop coordinates for vertical (9:16) Shorts rendering.
 *
 * Flow:
 *   1. Extract frames at 1fps
 *   2. Detect faces via bundled Python OpenCV script
 *   3. Apply moving-average smoothing
 *   4. Interpolate gaps (no-face frames)
 *   5. Group into segments with similar face positions
 *   6. Return segment crop coordinates
 *
 * If Python/OpenCV is not available → returns null (fallback to center crop).
 */

import { execSync, ExecSyncOptions } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';
import { platform } from 'os';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FaceSample {
  time: number;     // seconds
  cx: number | null; // face center X (pixels, null = no face)
  cy: number | null; // face center Y (pixels)
  w: number;        // face width
  h: number;        // face height
  face_count: number;
}

export interface CropSegment {
  startTime: number;  // seconds
  endTime: number;    // seconds
  cropX: number;      // X offset for ffmpeg crop (pixels in source frame)
  cropY: number;      // Y offset for ffmpeg crop
  hasFace: boolean;   // false = fallback to center crop
}

export interface TrackResult {
  segments: CropSegment[];
  totalSamples: number;
  faceSamples: number;
  faceRatio: number; // 0.0 - 1.0
}

// ---------------------------------------------------------------------------
// Exec helpers
// ---------------------------------------------------------------------------

const SHELL = platform() === 'win32' ? (process.env.COMSPEC || 'cmd.exe') : '/bin/sh';
const EXEC_OPTS: ExecSyncOptions = {
  stdio: 'pipe',
  timeout: 300_000,
  shell: SHELL,
  encoding: 'utf-8',
};

function log(tag: string, message: string): void {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] [FACE${tag.padEnd(7)}] ${message}`);
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const SAMPLE_RATE = 1.0; // 1 sample per second
const SMOOTHING_WINDOW = 3; // moving average window (frames)
const SEGMENT_THRESHOLD_PX = 40; // max face center movement within a segment
const VERTICAL_HEIGHT = 1920;
const VERTICAL_WIDTH = 1080;

// ---------------------------------------------------------------------------
// Step 1: Run face detection via Python OpenCV
// ---------------------------------------------------------------------------

function resolvePython(): string | null {
  // Try python3 first, then python
  try {
    execSync('python3 --version', { ...EXEC_OPTS, timeout: 5000 });
    return 'python3';
  } catch {
    try {
      execSync('python --version', { ...EXEC_OPTS, timeout: 5000 });
      return 'python';
    } catch {
      return null;
    }
  }
}

function checkOpenCV(pythonBin: string): boolean {
  try {
    const out = execSync(`${pythonBin} -c "import cv2; print(cv2.__version__)"`, {
      ...EXEC_OPTS,
      timeout: 5000,
    });
    log('INFO', `OpenCV ${(out as string).trim()} detected`);
    return true;
  } catch {
    return false;
  }
}

function runFaceDetection(
  videoPath: string,
  tempDir: string,
  sampleRate: number,
): FaceSample[] | null {
  const pythonBin = resolvePython();
  if (!pythonBin) {
    log('INFO', 'Python not found — face tracking unavailable, using center crop');
    return null;
  }

  if (!checkOpenCV(pythonBin)) {
    log('INFO', 'OpenCV not found — face tracking unavailable, using center crop');
    log('INFO', 'Install: pip install opencv-python');
    return null;
  }

  const scriptPath = join(resolve(__dirname || '.'), 'face-detect.py');
  if (!existsSync(scriptPath)) {
    log('INFO', `face-detect.py not found at ${scriptPath}`);
    return null;
  }

  const outputPath = join(tempDir, 'face_data.json');

  log('DETECT', `Running face detection on ${videoPath}...`);

  try {
    const cmd = `${pythonBin} "${scriptPath}" "${videoPath}" "${outputPath}" ${sampleRate}`;
    const out = execSync(cmd, { ...EXEC_OPTS, timeout: 600_000 }); // 10 min max
    log('DETECT', `Python output: ${(out as string).trim()}`);

    if (!existsSync(outputPath)) {
      throw new Error('face_data.json not produced');
    }

    const data: FaceSample[] = JSON.parse(readFileSync(outputPath, 'utf-8'));
    const faceCount = data.filter((s) => s.cx !== null).length;
    log('DETECT', `Got ${data.length} samples, ${faceCount} with faces`);

    return data;
  } catch (err) {
    const msg = (err as Error).message?.slice(0, 200);
    log('ERROR', `Face detection failed: ${msg}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Step 2: Smoothing (moving average)
// ---------------------------------------------------------------------------

function smoothSamples(samples: FaceSample[], windowSize: number): FaceSample[] {
  if (samples.length === 0) return [];

  const smoothed: FaceSample[] = [];
  const half = Math.floor(windowSize / 2);

  for (let i = 0; i < samples.length; i++) {
    const window = samples.slice(Math.max(0, i - half), Math.min(samples.length, i + half + 1));
    const validCxCy = window.filter((s) => s.cx !== null && s.cy !== null);

    if (validCxCy.length > 0) {
      const avgCx = validCxCy.reduce((sum, s) => sum + s.cx!, 0) / validCxCy.length;
      const avgCy = validCxCy.reduce((sum, s) => sum + s.cy!, 0) / validCxCy.length;
      const avgW = validCxCy.reduce((sum, s) => sum + s.w, 0) / validCxCy.length;
      const avgH = validCxCy.reduce((sum, s) => sum + s.h, 0) / validCxCy.length;
      smoothed.push({
        ...samples[i],
        cx: avgCx,
        cy: avgCy,
        w: Math.round(avgW),
        h: Math.round(avgH),
        face_count: validCxCy.length,
      });
    } else {
      // No face in window — keep as no-face
      smoothed.push({ ...samples[i], cx: null, cy: null, w: 0, h: 0, face_count: 0 });
    }
  }
  return smoothed;
}

// ---------------------------------------------------------------------------
// Step 3: Interpolate gaps (frames without faces)
// ---------------------------------------------------------------------------

function interpolateFaces(samples: FaceSample[]): FaceSample[] {
  const result: FaceSample[] = [...samples];

  let lastValid: FaceSample | null = null;
  let gapStart: number | null = null;

  for (let i = 0; i < result.length; i++) {
    if (result[i].cx !== null) {
      if (gapStart !== null && lastValid !== null) {
        // Fill gap by linear interpolation
        const gapEnd = i;
        const gapLen = gapEnd - gapStart;
        for (let j = 0; j < gapLen; j++) {
          const t = (j + 1) / (gapLen + 1);
          const idx = gapStart + j;
          result[idx] = {
            ...result[idx],
            cx: lastValid.cx! + (result[gapEnd].cx! - lastValid.cx!) * t,
            cy: lastValid.cy! + (result[gapEnd].cy! - lastValid.cy!) * t,
            w: Math.round(lastValid.w + (result[gapEnd].w - lastValid.w) * t),
            h: Math.round(lastValid.h + (result[gapEnd].h - lastValid.h) * t),
            face_count: 1,
          };
        }
      }
      lastValid = result[i];
      gapStart = null;
    } else if (lastValid !== null && gapStart === null) {
      gapStart = i;
    }
  }

  // If still no faces after interpolation, return as-is
  return result;
}

// ---------------------------------------------------------------------------
// Step 4: Group into segments
// ---------------------------------------------------------------------------

function buildSegments(
  samples: FaceSample[],
  sourceWidth: number,
  sourceHeight: number,
  segmentThresholdPx: number,
): CropSegment[] {
  if (samples.length === 0) {
    return [{ startTime: 0, endTime: 0, cropX: 0, cropY: 0, hasFace: false }];
  }

  // Target crop dimensions in source coordinates
  // 9:16 from 16:9 source: crop width = sourceHeight * 9/16, crop height = sourceHeight
  const cropH = sourceHeight; // full height
  const cropW = sourceHeight * (VERTICAL_WIDTH / VERTICAL_HEIGHT); // 720 * 1080/1920 = 405 for 720p

  // Default: center crop (fallback)
  const defaultCropX = (sourceWidth - cropW) / 2;
  const defaultCropY = 0;

  interface SegmentAccum {
    startTime: number;
    endTime: number;
    totalCx: number;
    totalCy: number;
    count: number;
    hasFace: boolean;
    lastCx: number | null;
    lastCy: number | null;
  }

  const segments: SegmentAccum[] = [];

  for (const sample of samples) {
    if (sample.cx === null || sample.cy === null) {
      // No face in this sample — start new segment or add to current
      if (segments.length === 0 || segments[segments.length - 1].hasFace) {
        segments.push({
          startTime: sample.time,
          endTime: sample.time,
          totalCx: 0,
          totalCy: 0,
          count: 0,
          hasFace: false,
          lastCx: null,
          lastCy: null,
        });
      } else {
        const last = segments[segments.length - 1];
        last.endTime = sample.time;
      }
      continue;
    }

    const current = segments.length > 0 ? segments[segments.length - 1] : null;

    if (
      current &&
      current.hasFace &&
      current.lastCx !== null &&
      current.lastCy !== null
    ) {
      const dx = Math.abs(sample.cx - current.lastCx);
      const dy = Math.abs(sample.cy - current.lastCy);
      const movement = Math.sqrt(dx * dx + dy * dy);

      if (movement <= segmentThresholdPx) {
        // Within threshold — extend current segment
        current.endTime = sample.time;
        current.totalCx += sample.cx;
        current.totalCy += sample.cy;
        current.count++;
        current.lastCx = sample.cx;
        current.lastCy = sample.cy;
      } else {
        // Movement exceeded — start new segment
        segments.push({
          startTime: sample.time,
          endTime: sample.time,
          totalCx: sample.cx,
          totalCy: sample.cy,
          count: 1,
          hasFace: true,
          lastCx: sample.cx,
          lastCy: sample.cy,
        });
      }
    } else if (current && !current.hasFace) {
      // Previous segment had no face — close it, start new
      segments.push({
        startTime: sample.time,
        endTime: sample.time,
        totalCx: sample.cx,
        totalCy: sample.cy,
        count: 1,
        hasFace: true,
        lastCx: sample.cx,
        lastCy: sample.cy,
      });
    } else {
      // First face segment
      segments.push({
        startTime: sample.time,
        endTime: sample.time,
        totalCx: sample.cx,
        totalCy: sample.cy,
        count: 1,
        hasFace: true,
        lastCx: sample.cx,
        lastCy: sample.cy,
      });
    }
  }

  // Convert accumulators to CropSegment[]
  const result: CropSegment[] = segments
    .filter((seg) => seg.endTime - seg.startTime >= 0.5) // ignore segments < 0.5s
    .map((seg) => {
    if (!seg.hasFace || seg.count === 0) {
      return {
        startTime: seg.startTime,
        endTime: seg.endTime,
        cropX: Math.round(defaultCropX),
        cropY: Math.round(defaultCropY),
        hasFace: false,
      };
    }

    const avgCx = seg.totalCx / seg.count;
    const avgCy = seg.totalCy / seg.count;

    // Calculate crop X so face center is at 50% width of crop window
    // cropX = faceCx - cropW/2, clamped to [0, sourceWidth - cropW]
    let cropX = avgCx - cropW / 2;
    cropX = Math.max(0, Math.min(sourceWidth - cropW, cropX));

    // Calculate crop Y — keep face in upper 2/3rds of frame
    // Put face at ~35% from top: cropY = faceCy - cropH * 0.35
    let cropY = avgCy - cropH * 0.35;
    cropY = Math.max(0, Math.min(sourceHeight - cropH, cropY));

    return {
      startTime: seg.startTime,
      endTime: seg.endTime,
      cropX: Math.round(cropX),
      cropY: Math.round(cropY),
      hasFace: true,
    };
  });

  return result;
}

// ---------------------------------------------------------------------------
// Step 5: Merge tiny segments with neighbors
// ---------------------------------------------------------------------------

function mergeTinySegments(segments: CropSegment[], minDuration: number): CropSegment[] {
  if (segments.length <= 1) return segments;

  const result: CropSegment[] = [];
  let i = 0;

  while (i < segments.length) {
    const seg = segments[i];
    const duration = seg.endTime - seg.startTime;

    if (duration < minDuration && i < segments.length - 1) {
      // Merge with next segment
      const next = segments[i + 1];
      result.push({
        startTime: seg.startTime,
        endTime: next.endTime,
        cropX: next.cropX,
        cropY: next.cropY,
        hasFace: next.hasFace || seg.hasFace,
      });
      i += 2;
    } else {
      result.push(seg);
      i++;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Step 6: Fill gaps between segments
// ---------------------------------------------------------------------------

/**
 * Ensure segments cover the full timeline without gaps.
 * Any gap between consecutive segments is filled with a fallback segment
 * using center-crop coordinates, so no portion of the source video is dropped.
 */
function fillSegmentGaps(
  segments: CropSegment[],
  sourceWidth: number,
  sourceHeight: number,
): CropSegment[] {
  if (segments.length <= 1) return segments;

  const cropH = sourceHeight;
  const cropW = sourceHeight * (VERTICAL_WIDTH / VERTICAL_HEIGHT);
  const defaultCropX = (sourceWidth - cropW) / 2;
  const defaultCropY = 0;

  const filled: CropSegment[] = [];

  for (let i = 0; i < segments.length; i++) {
    filled.push(segments[i]);

    // Check if there's a gap to the next segment
    if (i < segments.length - 1) {
      const gapStart = segments[i].endTime;
      const gapEnd = segments[i + 1].startTime;

      if (gapEnd > gapStart + 0.1) { // gap > 100ms
        log('SEGMENT', `Filling gap: ${gapStart.toFixed(1)}s-${gapEnd.toFixed(1)}s with center crop`);
        filled.push({
          startTime: gapStart,
          endTime: gapEnd,
          cropX: Math.round(defaultCropX),
          cropY: Math.round(defaultCropY),
          hasFace: false,
        });
      }
    }
  }

  return filled;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Analyze video and generate face-tracking crop segments for vertical mode.
 *
 * @param videoPath - Path to the source video file
 * @param tempDir - Temporary directory for frame extraction
 * @param sourceWidth - Width of source video in pixels (e.g., 1280)
 * @param sourceHeight - Height of source video (e.g., 720)
 * @returns TrackResult with segments, or null on failure/fallback
 */
export function analyzeFaces(
  videoPath: string,
  tempDir: string,
  sourceWidth: number,
  sourceHeight: number,
): TrackResult | null {
  // Step 1: Run face detection
  const rawSamples = runFaceDetection(videoPath, tempDir, SAMPLE_RATE);
  if (!rawSamples || rawSamples.length === 0) {
    log('RESULT', 'No face data — using center crop fallback');
    return null;
  }

  const faceSamples = rawSamples.filter((s) => s.cx !== null).length;
  const faceRatio = faceSamples / rawSamples.length;

  log('SMOOTH', `Raw: ${rawSamples.length} samples, ${faceSamples} faces (${(faceRatio * 100).toFixed(0)}%)`);

  // Step 2: Smooth
  const smoothed = smoothSamples(rawSamples, SMOOTHING_WINDOW);
  log('SMOOTH', `After smoothing: ${smoothed.filter((s) => s.cx !== null).length} faces`);

  // Step 3: Interpolate gaps
  const interpolated = interpolateFaces(smoothed);
  const interpFaces = interpolated.filter((s) => s.cx !== null).length;
  log('SMOOTH', `After interpolation: ${interpFaces}/${interpolated.length} samples have face data`);

  // Step 4: Build segments
  let segments = buildSegments(interpolated, sourceWidth, sourceHeight, SEGMENT_THRESHOLD_PX);
  log('SEGMENT', `Initial segments: ${segments.length}`);

  // Step 5: Merge tiny segments (< 2s)
  segments = mergeTinySegments(segments, 2.0);
  log('SEGMENT', `After merge: ${segments.length} segments`);

  // Step 6: Fill any timeline gaps with fallback segments
  segments = fillSegmentGaps(segments, sourceWidth, sourceHeight);
  log('SEGMENT', `After gap-fill: ${segments.length} segments`);

  return {
    segments,
    totalSamples: rawSamples.length,
    faceSamples: interpFaces,
    faceRatio: interpFaces / rawSamples.length,
  };
}
