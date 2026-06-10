/**
 * worker/tracker.ts — ByteTrack + Kalman face tracker integration for GANYIQ V2.
 *
 * Orchestrates Python ByteTrack tracker. Falls back to TS-side greedy matching
 * with exponential moving average (EMA) smoothing when Python is unavailable.
 *
 * Flow:
 *   1. Run face-detect-v2.py → get detections with landmarks
 *   2. Run tracker.py → get tracked faces with persistent IDs
 *   3. If tracker.py unavailable → fallback tracker in TS
 *   4. Return TrackedFaceSample[] for decision engine
 */

import { execSync, ExecSyncOptions } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { platform } from 'os';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FaceLandmarks {
  le: [number, number];  // left eye
  re: [number, number];  // right eye
  n: [number, number];   // nose
  lm: [number, number];  // left mouth
  rm: [number, number];  // right mouth
}

export interface FaceDetection {
  cx: number;
  cy: number;
  w: number;
  h: number;
  confidence: number;
  landmarks?: FaceLandmarks;
}

export interface TrackedFace extends FaceDetection {
  id: number;  // persistent identity
}

export interface TrackedFrame {
  time: number;
  faces: TrackedFace[];
  faceCount: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SHELL = platform() === 'win32' ? (process.env.COMSPEC || 'cmd.exe') : '/bin/sh';
const EXEC_OPTS: ExecSyncOptions = {
  stdio: 'pipe',
  timeout: 120_000,
  shell: SHELL,
  encoding: 'utf-8',
} as const;

function log(tag: string, message: string): void {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] [TRACK${tag.padEnd(6)}] ${message}`);
}

// ============================================================================
// Python Tracker Orchestration
// ============================================================================

/**
 * Run the Python ByteTrack tracker.
 * Returns tracked frames or null if Python unavailable.
 */
function runPythonTracker(
  tempDir: string,
  faceDataPath: string,
): TrackedFrame[] | null {
  const pythonBin = resolvePython();
  if (!pythonBin) {
    log('INFO', 'Python not found for tracker — using JS fallback');
    return null;
  }

  const trackerScript = join(resolve(__dirname || '.'), 'tracker.py');
  if (!existsSync(trackerScript)) {
    log('INFO', 'tracker.py not found — using JS fallback');
    return null;
  }

  const outputPath = join(tempDir, 'tracked_faces.json');

  try {
    const cmd = `${pythonBin} "${trackerScript}" "${faceDataPath}" "${outputPath}"`;
    execSync(cmd, { ...EXEC_OPTS, timeout: 120_000 });
    log('RUN', `Python tracker completed`);

    if (!existsSync(outputPath)) {
      throw new Error('tracked_faces.json not produced');
    }

    const data = JSON.parse(readFileSync(outputPath, 'utf-8')) as Array<{
      time: number;
      face_count: number;
      faces: TrackedFace[];
    }>;

    return data.map(s => ({
      time: s.time,
      faces: s.faces,
      faceCount: s.face_count,
    }));
  } catch (err) {
    log('WARN', `Python tracker failed: ${(err as Error).message?.slice(0, 120)}`);
    return null;
  }
}

// ============================================================================
// JavaScript Fallback Tracker
// ============================================================================

/**
 * Kalman filter state for a single tracked face (JS fallback).
 */
class FaceTrackState {
  id: number;
  cx: number;
  cy: number;
  w: number;
  h: number;
  vx: number;
  vy: number;
  confidence: number;
  landmarks?: FaceLandmarks;
  framesSinceUpdate: number;
  hitStreak: number;

  constructor(id: number, detection: FaceDetection) {
    this.id = id;
    this.cx = detection.cx;
    this.cy = detection.cy;
    this.w = detection.w;
    this.h = detection.h;
    this.vx = 0;
    this.vy = 0;
    this.confidence = detection.confidence;
    this.landmarks = detection.landmarks;
    this.framesSinceUpdate = 0;
    this.hitStreak = 1;
  }

  predict(dt: number = 1.0): void {
    this.cx += this.vx * dt;
    this.cy += this.vy * dt;
    this.framesSinceUpdate++;
    // Dampen velocity
    this.vx *= 0.9;
    this.vy *= 0.9;
  }

  update(detection: FaceDetection): void {
    // Estimate velocity
    this.vx = (detection.cx - this.cx) * 0.3;
    this.vy = (detection.cy - this.cy) * 0.3;

    // EMA update (alpha = 0.4 for responsive tracking)
    const alpha = 0.4;
    this.cx = this.cx + alpha * (detection.cx - this.cx);
    this.cy = this.cy + alpha * (detection.cy - this.cy);
    this.w = Math.round(this.w + alpha * (detection.w - this.w));
    this.h = Math.round(this.h + alpha * (detection.h - this.h));
    this.confidence = detection.confidence;
    this.landmarks = detection.landmarks;
    this.framesSinceUpdate = 0;
    this.hitStreak++;
  }
}

/**
 * JS fallback tracker using IoU matching + Kalman-style prediction.
 */
class JsFallbackTracker {
  private tracks: Map<number, FaceTrackState> = new Map();
  private nextId: number = 0;
  private readonly maxLost: number = 5;
  private readonly iouThreshold: number = 0.2;
  private readonly matchDistance: number = 150;

  computeIoU(a: FaceDetection, b: FaceDetection): number {
    const ax1 = a.cx - a.w / 2, ay1 = a.cy - a.h / 2;
    const ax2 = a.cx + a.w / 2, ay2 = a.cy + a.h / 2;
    const bx1 = b.cx - b.w / 2, by1 = b.cy - b.h / 2;
    const bx2 = b.cx + b.w / 2, by2 = b.cy + b.h / 2;

    const xi1 = Math.max(ax1, bx1);
    const yi1 = Math.max(ay1, by1);
    const xi2 = Math.min(ax2, bx2);
    const yi2 = Math.min(ay2, by2);

    if (xi2 <= xi1 || yi2 <= yi1) return 0;

    const intersection = (xi2 - xi1) * (yi2 - yi1);
    const union = a.w * a.h + b.w * b.h - intersection;
    return intersection / Math.max(union, 1);
  }

  update(detections: FaceDetection[]): TrackedFace[] {
    // Predict all tracks forward
    for (const [, track] of this.tracks) {
      track.predict();
    }

    const matchedIds = new Set<number>();

    // Match by IoU
    for (const det of detections) {
      let bestMatch: number | null = null;
      let bestIoU = this.iouThreshold;

      for (const [id, track] of this.tracks) {
        if (matchedIds.has(id)) continue;
        if (track.framesSinceUpdate > this.maxLost) continue;

        const iou = this.computeIoU(det, {
          cx: track.cx, cy: track.cy, w: track.w, h: track.h, confidence: track.confidence,
        });
        if (iou > bestIoU) {
          bestIoU = iou;
          bestMatch = id;
        }
      }

      if (bestMatch !== null) {
        matchedIds.add(bestMatch);
        const track = this.tracks.get(bestMatch)!;
        track.update(det);
      } else {
        // Try distance-based matching for unmatched detections
        let bestDistMatch: number | null = null;
        let bestDist = this.matchDistance;

        for (const [id, track] of this.tracks) {
          if (matchedIds.has(id)) continue;
          if (track.framesSinceUpdate > this.maxLost) continue;

          const dx = det.cx - track.cx;
          const dy = det.cy - track.cy;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < bestDist) {
            bestDist = dist;
            bestDistMatch = id;
          }
        }

        if (bestDistMatch !== null) {
          matchedIds.add(bestDistMatch);
          const track = this.tracks.get(bestDistMatch)!;
          track.update(det);
        } else {
          // New track
          const newId = this.nextId++;
          this.tracks.set(newId, new FaceTrackState(newId, det));
          matchedIds.add(newId);
        }
      }
    }

    // Remove lost tracks
    for (const [id, track] of this.tracks) {
      if (track.framesSinceUpdate > this.maxLost && !matchedIds.has(id)) {
        this.tracks.delete(id);
      }
    }

    // Build output
    return Array.from(this.tracks.values())
      .filter(t => matchedIds.has(t.id))
      .map(t => ({
        id: t.id,
        cx: Math.round(t.cx * 10) / 10,
        cy: Math.round(t.cy * 10) / 10,
        w: Math.round(t.w),
        h: Math.round(t.h),
        confidence: t.confidence,
        landmarks: t.landmarks,
      }));
  }

  reset(): void {
    this.tracks.clear();
    this.nextId = 0;
  }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Tracker result with both tracked frames and summary stats.
 */
export interface TrackerResult {
  trackedFrames: TrackedFrame[];
  totalFrames: number;
  totalTrackedFaces: number;
  uniqueIds: number;
  usedPython: boolean;
}

/**
 * Run full tracking pipeline on face detection data.
 *
 * @param faceDataPath - Path to face detection JSON
 * @param tempDir - Temp directory for intermediate files
 * @returns TrackerResult
 */
export function runTracker(
  faceDataPath: string,
  tempDir: string,
): TrackerResult {
  // Try Python tracker first
  const pythonResult = runPythonTracker(tempDir, faceDataPath);

  if (pythonResult) {
    const uniqueIds = new Set<number>();
    let totalTrackedFaces = 0;
    for (const frame of pythonResult) {
      totalTrackedFaces += frame.faceCount;
      for (const face of frame.faces) {
        uniqueIds.add(face.id);
      }
    }

    log('RESULT', `Python tracker: ${pythonResult.length} frames, ${uniqueIds.size} unique IDs`);
    return {
      trackedFrames: pythonResult,
      totalFrames: pythonResult.length,
      totalTrackedFaces,
      uniqueIds: uniqueIds.size,
      usedPython: true,
    };
  }

  // Fallback: JS tracker
  log('FALLBACK', 'Using JS fallback tracker');
  const tracker = new JsFallbackTracker();

  const rawData = JSON.parse(readFileSync(faceDataPath, 'utf-8')) as Array<{
    time: number;
    face_count: number;
    faces: FaceDetection[];
  }>;

  const trackedFrames: TrackedFrame[] = [];
  const uniqueIds = new Set<number>();

  for (const sample of rawData) {
    const tracked = tracker.update(sample.faces);
    for (const face of tracked) uniqueIds.add(face.id);
    trackedFrames.push({
      time: sample.time,
      faces: tracked,
      faceCount: tracked.length,
    });
  }

  const totalTrackedFaces = trackedFrames.reduce((s, f) => s + f.faceCount, 0);

  log('RESULT', `JS fallback: ${trackedFrames.length} frames, ${uniqueIds.size} unique IDs`);
  return {
    trackedFrames,
    totalFrames: trackedFrames.length,
    totalTrackedFaces,
    uniqueIds: uniqueIds.size,
    usedPython: false,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolvePython(): string | null {
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
