/**
 * worker/face-tracker.ts — Multi-face tracking module for GANYIQ Worker V2
 *
 * V2 Architecture:
 *   Orchestrates the full V2 pipeline:
 *     1. face-detect-v2.py (YOLOv8-face ONNX) → detections with landmarks
 *     2. tracker.py (ByteTrack + Kalman) → stable face IDs
 *     3. speaker-detector.ts (AV-ASD) → active speaker detection
 *     4. Rendering Decision Engine → multi-crop segments with smart layouts
 *
 * Falls back to V1 pipeline (Haar Cascade + greedy tracking) gracefully.
 */

import { execSync, ExecSyncOptions } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';
import { platform } from 'os';
import { runTracker, type TrackerResult } from './tracker';
import { detectSpeakers, type SpeakerDetectionResult, type SpeakerFrame } from './speaker-detector';
import { processDecisionEngine, type DecisionSegment } from './decision-engine';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single face instance within a frame. */
export interface FaceInfo {
  id: number;         // persistent identity across frames
  cx: number;         // center X (pixels in source frame)
  cy: number;         // center Y
  w: number;          // face width
  h: number;          // face height
  confidence?: number; // detection confidence (V2)
  landmarks?: { le: [number,number]; re: [number,number]; n: [number,number]; lm: [number,number]; rm: [number,number] };
}

/** Raw sample from face-detect.py V2.4A format. */
interface RawMultiSample {
  time: number;
  face_count: number;
  faces: Array<{
    cx: number | null;
    cy: number | null;
    w: number;
    h: number;
  }>;
}

/** Processed sample with face IDs assigned. */
export interface MultiFaceSample {
  time: number;
  faces: FaceInfo[];      // all faces in this frame with persistent IDs
  face_count: number;
}

/** Single-face sample for backward compat with segment building. */
interface DominantFaceSample {
  time: number;
  cx: number;          // dominant face center X
  cy: number;          // dominant face center Y
  w: number;
  h: number;
  face_count: number;
  confidence: number;  // 0.0 - 1.0
  hasFace: boolean;
}

export interface CropSegment {
  startTime: number;
  endTime: number;
  cropX: number;
  cropY: number;
  hasFace: boolean;
  /** Active speaker face ID at this segment (V2) */
  activeSpeakerId?: number | null;
  /** Audio event during this segment (V2) */
  audioEvent?: 'normal' | 'laughter' | 'gasp' | 'silence' | 'emotion_peak' | 'applause';
  /** Speaker turn detected at segment boundary */
  turnDetected?: boolean;
}

/** Multi-crop segment for Dynamic Split Screen (V2.5 / P1.1). */
export interface MultiCropSegment {
  startTime: number;
  endTime: number;
  crops: Array<{
    cropX: number;
    cropY: number;
    faceId: number;
    confidence: number;
    /** True if this crop is a listener reaction cut (P1.1). */
    isReaction?: boolean;
  }>;
  /** Transition smoothing into this segment (P1.1). */
  transitionIn?: {
    type: 'crossfade' | 'none';
    duration: number;
  };
  /** Layout mode for this segment (P1.1+ split-screen intelligence). */
  mode?: 'single' | 'split_2' | 'split_3' | 'split_4' | 'reaction_cut' | 'listener_pip' | 'hero_reaction' | 'wide_context';
}

export interface TrackResult {
  segments: CropSegment[];
  totalSamples: number;
  faceSamples: number;
  faceRatio: number;
  multiFaces?: MultiFaceSample[];  // all faces data for split screen
  /** V2 speaker detection result (optional) */
  speakerData?: SpeakerDetectionResult;
  /** Whether V2 pipeline was used */
  usedV2?: boolean;
  /** P1.1 Decision Engine output — enhanced segments with reaction cuts, EMA, layout switching */
  decisionSegments?: DecisionSegment[];
  /** How many reaction cuts were inserted */
  totalReactionCuts?: number;
  /** How many layout switches occurred */
  totalLayoutSwitches?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SAMPLE_RATE = 1.0;
const SMOOTHING_WINDOW = 3;
const SEGMENT_THRESHOLD_PX = 40;
const DEAD_ZONE_PX = 30;          // ignore crop changes < 30px
const MIN_HOLD_FRAMES = 1;        // hold camera at least 1 second
const DOMINANT_SWITCH_RATIO = 1.2; // new face must be 20% more dominant
const IDENTITY_MATCH_DIST = 100;   // max euclidean dist for same identity
const IDENTITY_TIMEOUT_FRAMES = 3; // forget ID after 3s absence
const CONFIDENCE_LOCK_THRESHOLD = 0.25; // lower: real faces score ~10-25/100
const VERTICAL_HEIGHT = 1920;
const VERTICAL_WIDTH = 1080;

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

// ============================================================================
// V2 PIPELINE ORCHESTRATOR
// ============================================================================

/**
 * Run V2 face detection (YOLOv8-face ONNX) with ByteTrack tracking.
 * Returns detected + tracked frames, or null if V2 pipeline unavailable.
 */
function runV2Detection(
  videoPath: string,
  tempDir: string,
  sampleRate: number,
  clipStart?: number,
  clipEnd?: number,
): TrackerResult | null {
  const pythonBin = resolvePython();
  if (!pythonBin) {
    log('V2', 'Python not found — skipping V2 pipeline');
    return null;
  }

  if (!checkOpenCV(pythonBin)) {
    log('V2', 'OpenCV not found — skipping V2 pipeline');
    return null;
  }

  // Try V2 detector first (YOLOv8-face), fall back to V1 (Haar)
  const v2ScriptPath = join(resolve(__dirname || '.'), 'face-detect-v2.py');
  const v1ScriptPath = join(resolve(__dirname || '.'), 'face-detect.py');
  const scriptPath = existsSync(v2ScriptPath) ? v2ScriptPath : v1ScriptPath;

  if (!existsSync(scriptPath)) {
    log('V2', 'No face detection script found');
    return null;
  }

  const isV2 = scriptPath === v2ScriptPath;
  const outputPath = join(tempDir, 'face_data.json');
  log('V2', `Running ${isV2 ? 'YOLOv8-face (V2)' : 'Haar Cascade (V1)'} detection`);

  try {
    let cmd = `${pythonBin} "${scriptPath}" "${videoPath}" "${outputPath}" ${sampleRate}`;
    if (clipStart !== undefined && clipEnd !== undefined) {
      cmd += ` --start-time ${clipStart} --end-time ${clipEnd}`;
    }
    const out = execSync(cmd, { ...EXEC_OPTS, timeout: 600_000 });
    log('V2', `Python output: ${(out as string).trim()}`);

    if (!existsSync(outputPath)) {
      throw new Error('face_data.json not produced');
    }

    // Run ByteTrack tracker
    log('V2', 'Running ByteTrack tracker...');
    const trackResult = runTracker(outputPath, tempDir);

    if (trackResult && trackResult.trackedFrames.length > 0) {
      log('V2', `Tracker: ${trackResult.trackedFrames.length} frames, ${trackResult.uniqueIds} unique IDs (${trackResult.usedPython ? 'Python' : 'JS fallback'})`);
      return trackResult;
    }

    return null;
  } catch (err) {
    const msg = (err as Error).message?.slice(0, 200);
    log('V2_WARN', `V2 detection failed: ${msg}`);
    return null;
  }
}

// ============================================================================
// V1 PIPELINE (legacy) — Keep existing code below
// ============================================================================

// ---------------------------------------------------------------------------
// Step 1: Run face detection via Python OpenCV (V2.4A — all faces)
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

function checkOpenCV(pythonBin: string): boolean {
  try {
    const out = execSync(`${pythonBin} -c "import cv2; print(cv2.__version__)"`, {
      ...EXEC_OPTS, timeout: 5000,
    });
    log('INFO', `OpenCV ${(out as string).trim()} detected`);
    return true;
  } catch {
    return false;
  }
}

function runV1FaceDetection(
  videoPath: string,
  tempDir: string,
  sampleRate: number,
  clipStart?: number,
  clipEnd?: number,
): RawMultiSample[] | null {
  const pythonBin = resolvePython();
  if (!pythonBin) {
    log('INFO', 'Python not found — face tracking unavailable, using center crop');
    return null;
  }

  if (!checkOpenCV(pythonBin)) {
    log('INFO', 'OpenCV not found — face tracking unavailable, using center crop');
    return null;
  }

  const scriptPath = join(resolve(__dirname || '.'), 'face-detect.py');
  if (!existsSync(scriptPath)) {
    log('INFO', `face-detect.py not found at ${scriptPath}`);
    return null;
  }

  const outputPath = join(tempDir, 'face_data_v1.json');
  log('DETECT', `Running V1 face detection on ${videoPath}...`);

  try {
    let cmd = `${pythonBin} "${scriptPath}" "${videoPath}" "${outputPath}" ${sampleRate}`;
    if (clipStart !== undefined && clipEnd !== undefined) {
      cmd += ` --start-time ${clipStart} --end-time ${clipEnd}`;
    }
    const out = execSync(cmd, { ...EXEC_OPTS, timeout: 600_000 });

    if (!existsSync(outputPath)) {
      throw new Error('face_data_v1.json not produced');
    }

    const data: RawMultiSample[] = JSON.parse(readFileSync(outputPath, 'utf-8'));
    const faceCount = data.filter((s) => s.face_count > 0).length;
    log('DETECT', `V1: ${data.length} samples, ${faceCount} with faces`);
    return data;
  } catch (err) {
    const msg = (err as Error).message?.slice(0, 200);
    log('ERROR', `V1 detection failed: ${msg}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Step 2: Track face identity across frames (V2.4A — new)
// ---------------------------------------------------------------------------

/**
 * Assign persistent IDs to faces across frames by spatial proximity.
 *
 * Algorithm:
 *   1. Sort faces left-to-right in each frame
 *   2. Match each face to the closest face from previous frame (euclidean dist)
 *   3. If dist < IDENTITY_MATCH_DIST → same identity
 *   4. If no match → assign new ID
 *   5. If ID not seen for IDENTITY_TIMEOUT_FRAMES → recycle
 */
function trackFaceIdentity(samples: RawMultiSample[]): MultiFaceSample[] {
  let nextId = 0;
  let prevFaces: Array<{ id: number; cx: number; cy: number }> = [];
  const lastSeen: Map<number, number> = new Map(); // id → last frame index
  const result: MultiFaceSample[] = [];

  for (let fi = 0; fi < samples.length; fi++) {
    const sample = samples[fi];
    const currentFaces = sample.faces.filter((f) => f.cx !== null && f.cy !== null);

    // Sort left-to-right
    currentFaces.sort((a, b) => a.cx! - b.cx!);

    const matchedIds: Set<number> = new Set();
    const assignedFaces: FaceInfo[] = [];

    for (const face of currentFaces) {
      // Find closest previous face
      let bestMatch: number | null = null;
      let bestDist = IDENTITY_MATCH_DIST;

      for (const prev of prevFaces) {
        if (matchedIds.has(prev.id)) continue; // already matched this frame
        const dx = face.cx! - prev.cx;
        const dy = face.cy! - prev.cy;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < bestDist) {
          bestDist = dist;
          bestMatch = prev.id;
        }
      }

      if (bestMatch !== null) {
        matchedIds.add(bestMatch);
        assignedFaces.push({
          id: bestMatch,
          cx: face.cx!,
          cy: face.cy!,
          w: face.w,
          h: face.h,
        });
        lastSeen.set(bestMatch, fi);
      } else {
        // New identity
        const newId = nextId++;
        assignedFaces.push({
          id: newId,
          cx: face.cx!,
          cy: face.cy!,
          w: face.w,
          h: face.h,
        });
        lastSeen.set(newId, fi);
      }
    }

    // Remove stale identities (not seen for too long)
    for (const [id, lastFrame] of lastSeen) {
      if (fi - lastFrame > IDENTITY_TIMEOUT_FRAMES) {
        lastSeen.delete(id);
      }
    }

    result.push({
      time: sample.time,
      face_count: assignedFaces.length,
      faces: assignedFaces,
    });

    // Prepare for next frame
    prevFaces = assignedFaces.map((f) => ({ id: f.id, cx: f.cx, cy: f.cy }));
  }

  return result;
}

// ---------------------------------------------------------------------------
// Step 3: Smooth per-face identity (V2.4A — no cross-face averaging!)
// ---------------------------------------------------------------------------

/**
 * Smooth positions WITHIN each face identity.
 *
 * Key difference from V2: instead of averaging ALL cx values in the window
 * (which mixes Face A and Face B together → produces mid-air coordinates),
 * we group by face ID first, then smooth each face's trajectory independently.
 */
function smoothPerFace(samples: MultiFaceSample[], windowSize: number): MultiFaceSample[] {
  if (samples.length === 0) return [];

  const half = Math.floor(windowSize / 2);

  return samples.map((sample, idx) => {
    if (sample.faces.length === 0) return sample;

    const smoothedFaces: FaceInfo[] = [];

    for (const face of sample.faces) {
      // Collect all occurrences of this face ID within the window
      const windowSamples: FaceInfo[] = [];
      for (let wi = Math.max(0, idx - half); wi <= Math.min(samples.length - 1, idx + half); wi++) {
        const match = samples[wi].faces.find((f) => f.id === face.id);
        if (match) windowSamples.push(match);
      }

      if (windowSamples.length > 0) {
        const avgCx = windowSamples.reduce((sum, f) => sum + f.cx, 0) / windowSamples.length;
        const avgCy = windowSamples.reduce((sum, f) => sum + f.cy, 0) / windowSamples.length;
        const avgW = Math.round(windowSamples.reduce((sum, f) => sum + f.w, 0) / windowSamples.length);
        const avgH = Math.round(windowSamples.reduce((sum, f) => sum + f.h, 0) / windowSamples.length);
        smoothedFaces.push({ id: face.id, cx: avgCx, cy: avgCy, w: avgW, h: avgH });
      } else {
        smoothedFaces.push(face);
      }
    }

    return { ...sample, faces: smoothedFaces };
  });
}

// ---------------------------------------------------------------------------
// Step 4: Interpolate gaps per-face (V2.4A — identity-aware)
// ---------------------------------------------------------------------------

function interpolatePerFace(samples: MultiFaceSample[]): MultiFaceSample[] {
  if (samples.length === 0) return [];

  // Collect unique face IDs seen across all frames
  const allIds = new Set<number>();
  for (const s of samples) {
    for (const f of s.faces) allIds.add(f.id);
  }

  const result: MultiFaceSample[] = samples.map((s) => ({ ...s, faces: [...s.faces] }));

  for (const faceId of allIds) {
    let lastValid: { cx: number; cy: number; w: number; h: number } | null = null;
    let gapStart: number | null = null;

    for (let i = 0; i < result.length; i++) {
      const face = result[i].faces.find((f) => f.id === faceId);

      if (face) {
        if (gapStart !== null && lastValid !== null) {
          // Fill gap with linear interpolation
          const gapEnd = i;
          const gapLen = gapEnd - gapStart;
          for (let j = 0; j < gapLen; j++) {
            const t = (j + 1) / (gapLen + 1);
            const idx = gapStart + j;
            result[idx].faces.push({
              id: faceId,
              cx: lastValid.cx + (face.cx - lastValid.cx) * t,
              cy: lastValid.cy + (face.cy - lastValid.cy) * t,
              w: Math.round(lastValid.w + (face.w - lastValid.w) * t),
              h: Math.round(lastValid.h + (face.h - lastValid.h) * t),
            });
            // Sort faces by id for consistency
            result[idx].faces.sort((a, b) => a.id - b.id);
          }
        }
        lastValid = { cx: face.cx, cy: face.cy, w: face.w, h: face.h };
        gapStart = null;
      } else if (lastValid !== null && gapStart === null) {
        gapStart = i;
      }
    }
  }

  // Re-sort faces by X position (left-to-right) for consistent ordering
  for (let i = 0; i < result.length; i++) {
    result[i].faces.sort((a, b) => a.cx - b.cx);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Step 5: Select dominant face (V2.4A — new camera target logic)
// ---------------------------------------------------------------------------

interface FaceDominance {
  faceId: number;
  cx: number;
  cy: number;
  w: number;
  h: number;
  score: number;       // dominance score 0-100
  faceSizeScore: number;
  centerScore: number;
  stabilityScore: number;
}

/**
 * Calculate dominance score for each face in a frame.
 *
 * Factors:
 *   - faceSizeScore (0-40): larger face = closer to camera = more dominant
 *   - centerScore (0-30): face near frame center is more likely the subject
 *   - stabilityScore (0-30): face with same ID seen recently = more stable
 */
function calculateDominance(
  face: FaceInfo,
  frameIndex: number,
  sourceWidth: number,
  sourceHeight: number,
  faceHistory: Map<number, number>, // faceId → consecutive frames seen
): FaceDominance {
  // Face size score: relative to frame area, scaled realistically
  // A 200x200 face in 720p = ~4.3% of frame → score ~30
  const frameArea = sourceWidth * sourceHeight;
  const faceArea = face.w * face.h;
  const relativeSize = faceArea / frameArea;
  const faceSizeScore = Math.min(40, relativeSize * 700);

  // Center score: prefer faces closer to middle
  const frameCx = sourceWidth / 2;
  const frameCy = sourceHeight / 2;
  const distFromCenter = Math.sqrt(
    Math.pow((face.cx - frameCx) / sourceWidth, 2) +
    Math.pow((face.cy - frameCy) / sourceHeight, 2)
  );
  const centerScore = Math.max(0, 30 * (1 - Math.min(1, distFromCenter * 3)));

  // Stability score: face seen consistently = higher score
  const consecutive = faceHistory.get(face.id) || 1;
  const stabilityScore = Math.min(30, consecutive * 3);

  const score = faceSizeScore + centerScore + stabilityScore;

  return {
    faceId: face.id,
    cx: face.cx,
    cy: face.cy,
    w: face.w,
    h: face.h,
    score: Math.round(score),
    faceSizeScore: Math.round(faceSizeScore),
    centerScore: Math.round(centerScore),
    stabilityScore: Math.round(stabilityScore),
  };
}

/**
 * Track which face to follow across frames.
 * Maintains state: currentTarget, hold counter, last known position.
 */
interface CameraState {
  targetFaceId: number | null;    // which face ID we're currently following
  holdCounter: number;            // frames held on current target
  lastKnownCx: number;            // true face tracking position (always updated)
  lastKnownCy: number;
  cameraCx: number;               // camera output position (only updated on significant move)
  cameraCy: number;
  lastKnownHasFace: boolean;
  consecutiveNoFace: number;      // frames without any face
}

/**
 * Select the camera target frame-by-frame.
 * Returns the dominant face sample to use for segment building.
 */
function selectCameraTarget(
  samples: MultiFaceSample[],
  sourceWidth: number,
  sourceHeight: number,
): DominantFaceSample[] {
  const defaultCropX = (sourceWidth - sourceHeight * (VERTICAL_WIDTH / VERTICAL_HEIGHT)) / 2;
  const output: DominantFaceSample[] = [];
  const faceHistory: Map<number, number> = new Map(); // faceId → consecutive frames

  const state: CameraState = {
    targetFaceId: null,
    holdCounter: 0,
    lastKnownCx: defaultCropX,
    lastKnownCy: 0,
    cameraCx: defaultCropX,
    cameraCy: 0,
    lastKnownHasFace: false,
    consecutiveNoFace: 0,
  };

  for (let fi = 0; fi < samples.length; fi++) {
    const sample = samples[fi];

    // Update face history
    const seenIds = new Set(sample.faces.map((f) => f.id));
    for (const id of seenIds) {
      faceHistory.set(id, (faceHistory.get(id) || 0) + 1);
    }
    // Decay unseen IDs
    for (const [id, count] of faceHistory) {
      if (!seenIds.has(id)) {
        faceHistory.set(id, Math.max(0, count - 1));
      }
    }

    if (sample.faces.length === 0) {
      // No faces in this frame
      state.consecutiveNoFace++;
      state.holdCounter = Math.max(0, state.holdCounter - 1);

      if (state.lastKnownHasFace && state.consecutiveNoFace < IDENTITY_TIMEOUT_FRAMES) {
        // Lock to last known position — don't jump to center!
        output.push({
          time: sample.time,
          cx: state.lastKnownCx,
          cy: state.lastKnownCy,
          w: 0,
          h: 0,
          face_count: 0,
          confidence: Math.max(0, 1 - state.consecutiveNoFace * 0.3),
          hasFace: false,
        });
      } else {
        // Truly lost — use center as last resort
        output.push({
          time: sample.time,
          cx: defaultCropX,
          cy: 0,
          w: 0,
          h: 0,
          face_count: 0,
          confidence: 0,
          hasFace: false,
        });
      }
      continue;
    }

    // Calculate dominance for each face
    state.consecutiveNoFace = 0;
    const dominanceScores = sample.faces.map((face) =>
      calculateDominance(face, fi, sourceWidth, sourceHeight, faceHistory)
    );
    dominanceScores.sort((a, b) => b.score - a.score);
    const best = dominanceScores[0];

    // Decision: should we switch target?
    let shouldSwitch = false;

    if (state.targetFaceId === null) {
      // No current target — take the best
      shouldSwitch = true;
    } else if (state.holdCounter < MIN_HOLD_FRAMES) {
      // Still in hold period — keep current
      const currentTarget = dominanceScores.find((d) => d.faceId === state.targetFaceId);
      if (currentTarget) {
        shouldSwitch = false;
      } else {
        // Current target is gone — switch
        shouldSwitch = true;
      }
    } else {
      // Past hold period — check if new face is significantly better
      const currentTarget = dominanceScores.find((d) => d.faceId === state.targetFaceId);
      if (!currentTarget) {
        shouldSwitch = true;
      } else if (best.score > currentTarget.score * DOMINANT_SWITCH_RATIO) {
        shouldSwitch = true;
      } else {
        shouldSwitch = false;
      }
    }

    if (shouldSwitch) {
      state.targetFaceId = best.faceId;
      state.holdCounter = 0;
    } else {
      state.holdCounter++;
    }

    // Get current target position
    const target = dominanceScores.find((d) => d.faceId === state.targetFaceId) || best;
    const confidence = target.score / 100;

    // Apply dead zone: don't move camera for tiny movements
    // The dead zone prevents OUTPUT jitter by keeping the camera steady when
    // face moves < DEAD_ZONE_PX. Internal tracking state always updates to the
    // true face position so that accumulated displacement eventually exceeds
    // the threshold and the camera corrects to the new position.
    if (state.lastKnownHasFace) {
      const dx = target.cx - state.cameraCx;
      const dy = target.cy - state.cameraCy;
      if (Math.sqrt(dx * dx + dy * dy) < DEAD_ZONE_PX) {
        // Update internal tracking state (true face position)
        state.lastKnownCx = target.cx;
        state.lastKnownCy = target.cy;
        // Output the steady camera position (no jitter)
        output.push({
          time: sample.time,
          cx: state.cameraCx,
          cy: state.cameraCy,
          w: target.w,
          h: target.h,
          face_count: sample.faces.length,
          confidence,
          hasFace: true,
        });
        continue;
      }
    }

    // Update last known face position
    state.lastKnownCx = target.cx;
    state.lastKnownCy = target.cy;
    // Update camera output position (face moved beyond dead zone)
    state.cameraCx = target.cx;
    state.cameraCy = target.cy;
    state.lastKnownHasFace = true;

    output.push({
      time: sample.time,
      cx: target.cx,
      cy: target.cy,
      w: target.w,
      h: target.h,
      face_count: sample.faces.length,
      confidence,
      hasFace: true,
    });
  }

  const faceSamples = output.filter((s) => s.hasFace).length;
  log('DOMINANT', `Camera target: ${faceSamples}/${output.length} frames with face, ` +
    `last target ID: ${state.targetFaceId ?? 'none'}`);

  return output;
}

// ---------------------------------------------------------------------------
// Step 6: Build segments from dominant face samples
// ---------------------------------------------------------------------------

function buildSegments(
  samples: DominantFaceSample[],
  sourceWidth: number,
  sourceHeight: number,
  segmentThresholdPx: number,
): CropSegment[] {
  if (samples.length === 0) {
    return [{ startTime: 0, endTime: 0, cropX: 0, cropY: 0, hasFace: false }];
  }

  const cropH = sourceHeight;
  const cropW = sourceHeight * (VERTICAL_WIDTH / VERTICAL_HEIGHT);
  const defaultCropX = (sourceWidth - cropW) / 2;

  // Last known good position — NOT center crop fallback!
  let lastGoodCx = defaultCropX;
  let lastGoodCy = 0;

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
    if (!sample.hasFace) {
      // No face at all — lock to last known good position, not center crop
      const cx = lastGoodCx;
      const cy = lastGoodCy;

      if (segments.length === 0 || segments[segments.length - 1].hasFace) {
        segments.push({
          startTime: sample.time,
          endTime: sample.time,
          totalCx: cx,
          totalCy: cy,
          count: 1,
          hasFace: true,       // Report as face segment (locked position)
          lastCx: cx,
          lastCy: cy,
        });
      } else {
        const last = segments[segments.length - 1];
        last.endTime = sample.time;
        last.totalCx = (last.totalCx * last.count + cx) / (last.count + 1);
        last.totalCy = (last.totalCy * last.count + cy) / (last.count + 1);
        last.count++;
        last.lastCx = cx;
        last.lastCy = cy;
      }
      continue;
    }

    // Face IS present — ALWAYS update position (even with low confidence)
    // Confidence only affects target switching, not whether to use the position

    // Calculate crop X for this face position
    // cropX = faceCx - cropW/2, clamped to [0, sourceWidth - cropW]
    let targetCropX = sample.cx - cropW / 2;
    targetCropX = Math.max(0, Math.min(sourceWidth - cropW, targetCropX));

    let targetCropY = sample.cy - cropH * 0.35;
    targetCropY = Math.max(0, Math.min(sourceHeight - cropH, targetCropY));

    // Store CROP position (not face center) so that no-face fallback
    // at line 670 uses the correct crop coordinate.
    // This MUST be after targetCropX/Y calculation.
    lastGoodCx = targetCropX;
    lastGoodCy = targetCropY;

    const current = segments.length > 0 ? segments[segments.length - 1] : null;

    if (
      current &&
      current.hasFace &&
      current.lastCx !== null &&
      current.lastCy !== null
    ) {
      const dx = Math.abs(targetCropX - current.lastCx);
      const dy = Math.abs(targetCropY - current.lastCy);
      const movement = Math.sqrt(dx * dx + dy * dy);

      if (movement <= segmentThresholdPx) {
        // Within threshold — extend current segment
        current.endTime = sample.time;
        current.totalCx += targetCropX;
        current.totalCy += targetCropY;
        current.count++;
        current.lastCx = targetCropX;
        current.lastCy = targetCropY;
      } else {
        // Movement exceeded — start new segment
        segments.push({
          startTime: sample.time,
          endTime: sample.time,
          totalCx: targetCropX,
          totalCy: targetCropY,
          count: 1,
          hasFace: true,
          lastCx: targetCropX,
          lastCy: targetCropY,
        });
      }
    } else {
      // First segment or starting after a no-face segment
      segments.push({
        startTime: sample.time,
        endTime: sample.time,
        totalCx: targetCropX,
        totalCy: targetCropY,
        count: 1,
        hasFace: true,
        lastCx: targetCropX,
        lastCy: targetCropY,
      });
    }
  }

  // Convert accumulators to CropSegment[]
  const result: CropSegment[] = segments
    .filter((seg) => seg.endTime - seg.startTime >= 0.5)
    .map((seg) => {
      if (!seg.hasFace || seg.count === 0) {
        return {
          startTime: seg.startTime,
          endTime: seg.endTime,
          cropX: Math.round(lastGoodCx),
          cropY: Math.round(lastGoodCy),
          hasFace: false,
        };
      }

      const avgCx = seg.totalCx / seg.count;
      const avgCy = seg.totalCy / seg.count;

      return {
        startTime: seg.startTime,
        endTime: seg.endTime,
        cropX: Math.round(avgCx),
        cropY: Math.round(avgCy),
        hasFace: true,
      };
    });

  return result;
}

// ---------------------------------------------------------------------------
// Step 7: Merge tiny segments
// ---------------------------------------------------------------------------

function mergeTinySegments(segments: CropSegment[], minDuration: number): CropSegment[] {
  if (segments.length <= 1) return segments;

  const result: CropSegment[] = [];
  let i = 0;

  while (i < segments.length) {
    const seg = segments[i];
    const duration = seg.endTime - seg.startTime;

    if (duration < minDuration && i < segments.length - 1) {
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
// Step 8: Fill remaining gaps
// ---------------------------------------------------------------------------

function fillSegmentGaps(
  segments: CropSegment[],
  sourceWidth: number,
  sourceHeight: number,
): CropSegment[] {
  if (segments.length <= 1) return segments;

  const cropH = sourceHeight;
  const cropW = sourceHeight * (VERTICAL_WIDTH / VERTICAL_HEIGHT);
  const defaultCropX = (sourceWidth - cropW) / 2;

  const filled: CropSegment[] = [];

  for (let i = 0; i < segments.length; i++) {
    filled.push(segments[i]);

    if (i < segments.length - 1) {
      const gapStart = segments[i].endTime;
      const gapEnd = segments[i + 1].startTime;

      if (gapEnd > gapStart + 0.1) {
        // Use interpolation between segment endpoints, not center crop
        const midCx = Math.round((segments[i].cropX + segments[i + 1].cropX) / 2);
        const midCy = Math.round((segments[i].cropY + segments[i + 1].cropY) / 2);
        log('SEGMENT', `Filling gap: ${gapStart.toFixed(1)}s-${gapEnd.toFixed(1)}s with interpolated crop`);
        filled.push({
          startTime: gapStart,
          endTime: gapEnd,
          cropX: midCx,
          cropY: midCy,
          hasFace: segments[i].hasFace || segments[i + 1].hasFace,
        });
      }
    }
  }

  return filled;
}

// ---------------------------------------------------------------------------
// V2 Pipeline Orchestrator
// ---------------------------------------------------------------------------

/**
 * Run V2 speaker detection pipeline (AV-ASD) and merge with tracking data.
 */
function runV2SpeakerDetection(
  videoPath: string,
  verifiedFrames: MultiFaceSample[],
  tempDir: string,
  envHfToken?: string,
  envDeepgramKey?: string,
): SpeakerDetectionResult | null {
  try {
    // Convert MultiFaceSample[] to TrackedFrame[] (the format speaker-detector expects)
    const trackedFrames = verifiedFrames.map(mf => ({
      time: mf.time,
      faces: mf.faces.map(f => ({
        id: f.id,
        cx: f.cx,
        cy: f.cy,
        w: f.w,
        h: f.h,
        confidence: f.confidence || 0.5,
        landmarks: f.landmarks as any,
      })),
      faceCount: mf.face_count,
    }));

    const result = detectSpeakers(
      videoPath,
      trackedFrames,
      tempDir,
      envHfToken,
      envDeepgramKey,
    );

    log('V2_ASD', `Speaker detection: ${result.totalSpeakers} speakers, ${result.frames.length} frames`);
    return result;
  } catch (err) {
    log('V2_WARN', `Speaker detection failed: ${(err as Error).message?.slice(0, 120)}`);
    return null;
  }
}

/**
 * Convert V2 tracked frames (from ByteTrack) to the internal MultiFaceSample format.
 */
function trackedFramesToMultiFaceSamples(trackerResult: TrackerResult): MultiFaceSample[] {
  return trackerResult.trackedFrames.map(tf => ({
    time: tf.time,
    face_count: tf.faceCount,
    faces: tf.faces.map(f => ({
      id: f.id,
      cx: f.cx,
      cy: f.cy,
      w: f.w,
      h: f.h,
      confidence: f.confidence,
      landmarks: f.landmarks,
    })),
  }));
}

/**
 * Convert V2 speaker frames into CropSegments enriched with speaker/event data.
 * Uses the Rendering Decision Engine (P1.1) for:
 *   - EMA-smooth camera transitions
 *   - Reaction cut scheduling
 *   - Smart layout switching (SINGLE ↔ SPLIT_2)
 *
 * Backward compatible: returns both the legacy CropSegment[] (dominant face path)
 * and the new DecisionSegment[] (for the full-featured renderer).
 */
function buildV2Segments(
  speakerFrames: SpeakerFrame[],
  sourceWidth: number,
  sourceHeight: number,
): { segments: CropSegment[]; multiFaces: MultiFaceSample[]; decisionSegments: DecisionSegment[] } {
  // ── Decision Engine (P1.1) ──
  const decisionResult = processDecisionEngine(speakerFrames, sourceWidth, sourceHeight);
  const decisionSegments = decisionResult.segments;

  // ── Legacy backward-compatible segments (dominant face path) ──
  const cropH = sourceHeight;
  const cropW = sourceHeight * (VERTICAL_WIDTH / VERTICAL_HEIGHT);

  interface V2SegmentAccum {
    startTime: number;
    endTime: number;
    cropX: number;
    cropY: number;
    hasFace: boolean;
    activeSpeakerId: number | null;
    audioEvent: string;
    turnDetected: boolean;
    faceCount: number;
    count: number;
    lastCx: number | null;
    lastCy: number | null;
  }

  const segmentsAccum: V2SegmentAccum[] = [];
  let lastActiveSpeakerId: number | null = null;

  for (const frame of speakerFrames) {
    const t = frame.time;

    let targetCropX: number;
    let targetCropY: number;

    if (frame.activeSpeakerId !== null) {
      const activeFace = frame.faces.find(f => f.id === frame.activeSpeakerId);
      if (activeFace) {
        targetCropX = Math.max(0, Math.min(sourceWidth - cropW, activeFace.cx - cropW / 2));
        targetCropY = Math.max(0, Math.min(sourceHeight - cropH, activeFace.cy - cropH * 0.35));
      } else {
        targetCropX = frame.faces[0]?.cx ?? sourceWidth / 2;
        targetCropY = (frame.faces[0]?.cy ?? sourceHeight / 2) - cropH * 0.35;
      }
    } else if (frame.faces.length > 0) {
      targetCropX = Math.max(0, Math.min(sourceWidth - cropW, frame.faces[0].cx - cropW / 2));
      targetCropY = Math.max(0, Math.min(sourceHeight - cropH, frame.faces[0].cy - cropH * 0.35));
    } else {
      continue;
    }

    targetCropX = Math.round(targetCropX);
    targetCropY = Math.round(targetCropY);

    const current = segmentsAccum.length > 0 ? segmentsAccum[segmentsAccum.length - 1] : null;
    lastActiveSpeakerId = frame.activeSpeakerId ?? lastActiveSpeakerId;

    if (current && current.lastCx !== null && current.lastCy !== null) {
      const movement = Math.sqrt(
        (targetCropX - current.lastCx) ** 2 + (targetCropY - current.lastCy) ** 2
      );

      if (movement <= 40 && !frame.turnDetected) {
        current.endTime = t;
        current.cropX += targetCropX;
        current.cropY += targetCropY;
        current.count++;
        current.lastCx = targetCropX;
        current.lastCy = targetCropY;
        if (frame.audioEvent !== 'normal') current.audioEvent = frame.audioEvent;
        current.turnDetected = current.turnDetected || frame.turnDetected;
        continue;
      }
    }

    segmentsAccum.push({
      startTime: t,
      endTime: t,
      cropX: targetCropX,
      cropY: targetCropY,
      hasFace: frame.faces.length > 0,
      activeSpeakerId: frame.activeSpeakerId,
      audioEvent: frame.audioEvent,
      turnDetected: frame.turnDetected,
      faceCount: frame.faceCount,
      count: 1,
      lastCx: targetCropX,
      lastCy: targetCropY,
    });
  }

  const segments: CropSegment[] = segmentsAccum
    .filter(seg => seg.endTime - seg.startTime >= 0.5)
    .map(seg => ({
      startTime: seg.startTime,
      endTime: seg.endTime,
      cropX: Math.round(seg.cropX / seg.count),
      cropY: Math.round(seg.cropY / seg.count),
      hasFace: seg.hasFace,
      activeSpeakerId: seg.activeSpeakerId,
      audioEvent: seg.audioEvent as any,
      turnDetected: seg.turnDetected,
    }));

  const merged = mergeTinySegments(segments, 2.0);
  const filled = fillSegmentGaps(merged, sourceWidth, sourceHeight);

  // Build multiFaces for backward compat
  const multiFaces: MultiFaceSample[] = speakerFrames.map(sf => ({
    time: sf.time,
    face_count: sf.faceCount,
    faces: sf.faces.map(f => ({
      id: f.id,
      cx: f.cx,
      cy: f.cy,
      w: f.w,
      h: f.h,
      confidence: f.confidence,
      landmarks: f.landmarks,
    })),
  }));

  return { segments: filled, multiFaces, decisionSegments };
}

// ---------------------------------------------------------------------------
// Public API (V2 with fallback)
// ---------------------------------------------------------------------------

/**
 * Analyze video and generate multi-face tracking crop segments.
 *
 * V2 Pipeline (tried first):
 *   face-detect-v2.py → tracker.py → speaker-detector.ts → segments
 *
 * V1 Fallback (if V2 unavailable):
 *   face-detect.py → identity tracking → dominant face → segments
 *
 * @param videoPath - Path to the source video file
 * @param tempDir - Temporary directory
 * @param sourceWidth - Width of source video in pixels
 * @param sourceHeight - Height of source video
 * @param clipStart - Clip start time in seconds
 * @param clipEnd - Clip end time in seconds
 * @param hfToken - HuggingFace token for speaker diarization (optional)
 * @returns TrackResult with segments, or null on failure/fallback
 */
export function analyzeFaces(
  videoPath: string,
  tempDir: string,
  sourceWidth: number,
  sourceHeight: number,
  clipStart?: number,
  clipEnd?: number,
  hfToken?: string,
  deepgramKey?: string,
): TrackResult | null {
  // ── TRY V2 PIPELINE FIRST ──
  log('V2', 'Attempting V2 pipeline (YOLOv8-face + ByteTrack + AV-ASD)...');
  const trackerResult = runV2Detection(videoPath, tempDir, SAMPLE_RATE, clipStart, clipEnd);

  if (trackerResult && trackerResult.trackedFrames.length > 0) {
    log('V2', 'V2 detection + tracking succeeded. Running AV-ASD...');

    // Convert to MultiFaceSample format
    const verifiedFrames = trackedFramesToMultiFaceSamples(trackerResult);

    // Run V2 speaker detection
    const speakerData = runV2SpeakerDetection(
      videoPath,
      verifiedFrames,
      tempDir,
      hfToken,
      deepgramKey,
    );

    // Build segments from speaker data using Decision Engine (P1.1)
    if (speakerData && speakerData.frames.length > 0) {
      const { segments, multiFaces, decisionSegments } = buildV2Segments(
        speakerData.frames,
        sourceWidth,
        sourceHeight,
      );

      // Count reaction cuts and layout switches from decision segments
      const reactionCuts = decisionSegments.filter(s => s.mode === 'reaction_cut').length;
      const layoutSwitches = decisionSegments.length > 1 ? decisionSegments.length - 1 : 0;

      log('V2', `V2 pipeline complete: ${segments.length} legacy segments, ${speakerData.totalSpeakers} speakers, ` +
        `${reactionCuts} reaction cuts, ${layoutSwitches} layout switches`);
      return {
        segments,
        multiFaces,
        decisionSegments,
        totalReactionCuts: reactionCuts,
        totalLayoutSwitches: layoutSwitches,
        totalSamples: speakerData.frames.length,
        faceSamples: speakerData.frames.filter(f => f.faceCount > 0).length,
        faceRatio: speakerData.frames.length > 0
          ? speakerData.frames.filter(f => f.faceCount > 0).length / speakerData.frames.length
          : 0,
        speakerData,
        usedV2: true,
      };
    }

    // Speaker detection failed — use V1-style dominant face approach with V2 tracking data
    log('V2', 'AV-ASD unavailable, using dominant face fallback with V2 tracking');
    const interpolated = interpolatePerFace(verifiedFrames);
    const dominantSamples = selectCameraTarget(interpolated, sourceWidth, sourceHeight);
    let segments = buildSegments(dominantSamples, sourceWidth, sourceHeight, SEGMENT_THRESHOLD_PX);
    segments = mergeTinySegments(segments, 2.0);
    segments = fillSegmentGaps(segments, sourceWidth, sourceHeight);

    return {
      segments,
      multiFaces: interpolated,
      totalSamples: trackerResult.totalFrames,
      faceSamples: dominantSamples.filter(s => s.hasFace).length,
      faceRatio: dominantSamples.length > 0
        ? dominantSamples.filter(s => s.hasFace).length / dominantSamples.length
        : 0,
      usedV2: true,
    };
  }

  // ── V1 FALLBACK ──
  log('V2', 'V2 pipeline unavailable — falling back to V1 (Haar Cascade + greedy tracking)');

  const rawSamples = runV1FaceDetection(videoPath, tempDir, SAMPLE_RATE, clipStart, clipEnd);
  if (!rawSamples || rawSamples.length === 0) {
    log('RESULT', 'No face data — using center crop fallback');
    return null;
  }

  const totalFrames = rawSamples.length;
  const framesWithFaces = rawSamples.filter((s) => s.face_count > 0).length;

  // Run V1 identity tracking pipeline
  const withIdentity = trackFaceIdentity(rawSamples);
  const smoothed = smoothPerFace(withIdentity, SMOOTHING_WINDOW);
  const interpolated = interpolatePerFace(smoothed);
  const dominantSamples = selectCameraTarget(interpolated, sourceWidth, sourceHeight);

  let segments = buildSegments(dominantSamples, sourceWidth, sourceHeight, SEGMENT_THRESHOLD_PX);
  segments = mergeTinySegments(segments, 2.0);
  segments = fillSegmentGaps(segments, sourceWidth, sourceHeight);

  const faceSamples = dominantSamples.filter((s) => s.hasFace).length;
  log('V1', `V1 fallback complete: ${segments.length} segments, ${framesWithFaces}/${totalFrames} face frames`);

  return {
    segments,
    multiFaces: interpolated,
    totalSamples: totalFrames,
    faceSamples,
    faceRatio: totalFrames > 0 ? faceSamples / totalFrames : 0,
    usedV2: false,
  };
}
