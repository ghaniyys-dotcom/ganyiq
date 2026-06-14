/**
 * worker/speaker-detector.ts — Audio-Visual Active Speaker Detection for GANYIQ V3.
 *
 * Fuses audio diarization with visual face tracking to determine:
 *   - Active speaker per frame
 *   - Listener faces
 *   - Audio events (laughter, gasp, applause, silence) — REALTIME AUDIO ANALYSIS
 *   - Speaker turn detection
 *
 * V3 Upgrade:
 *   REPLACED text-only keyword matching (detectAudioEventFromWords) with
 *   librosa-based audio reaction detection (reaction-detector.py).
 *   This detects ACTUAL acoustic events (laughter waveform, applause
 *   spectral pattern, gasp energy burst) rather than relying on people
 *   SAYING "haha" or "wow".
 *
 * Flow:
 *   1. Run diarize.py (Python) → speaker segments
 *   2. Run transcribe.py (Python) → word-level timestamps
 *   3. Run reaction-detector.py (Python) → audio events (NEW V3)
 *   4. For each tracked face, compute lip motion energy from landmarks
 *   5. Align audio speaker labels with visual data
 *   6. Merge reaction-detector events into SpeakerFrames (replaces keyword matching)
 */

import { exec, execSync, ExecSyncOptions } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { platform } from 'os';
import { logMemoryStart, logMemoryEnd } from './memory-profiler';
import { isEnabled } from './features';

function execAsync(cmd: string, options: any): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(cmd, options, (error: any, stdout: any, stderr: any) => {
      if (error) {
        const stderrStr = typeof stderr === 'string' ? stderr : (stderr as any)?.toString('utf-8') || '';
        const stdoutStr = typeof stdout === 'string' ? stdout : (stdout as any)?.toString('utf-8') || '';
        const err = new Error(`Command failed: ${cmd}\nError: ${error.message}\nStderr: ${stderrStr}\nStdout: ${stdoutStr}`);
        (err as any).stderr = stderrStr;
        (err as any).stdout = stdoutStr;
        reject(err);
      } else {
        resolve(typeof stdout === 'string' ? stdout : (stdout as any).toString('utf-8') || '');
      }
    });
  });
}
import type { TrackedFrame, TrackedFace, FaceLandmarks } from './tracker';
import { ParticipantRegistry } from './participant-registry';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AudioEventType = 'normal' | 'laughter' | 'gasp' | 'silence' | 'emotion_peak' | 'applause';
export type VisualEventType = 'normal' | 'smile' | 'laugh_visual' | 'surprise_visual' | 'head_nod' | 'head_shake' | 'no_face';

/** Audio event from reaction-detector.py. */
export interface ReactionEvent {
  time: number;
  event_type: AudioEventType;
  confidence: number;
  duration: number;
  end_time: number;
}

/** Time series point from reaction-detector.py for frame-level lookup. */
interface ReactionTimeSeries {
  times: number[];
  energy: number[];
  spectral_centroid?: number[];
  zero_crossing_rate: number[];
  event_labels: number[];
}

/** Full reaction detector output. */
interface ReactionDetectorResult {
  source: string;
  sample_rate_hz: number;
  events: ReactionEvent[];
  time_series: ReactionTimeSeries;
}

export interface SpeakerLabel {
  speaker: string;
  start: number;
  end: number;
}

export interface WordTimestamp {
  word: string;
  start: number;
  end: number;
  confidence: number;
}

export interface SpeakerFrame extends TrackedFrame {
  activeSpeakerId: number | null;      // face ID of current speaker
  listenerIds: number[];                // face IDs of listeners
  audioEvent: AudioEventType;
  audioEventConfidence: number;
  /** Visual reaction event from face landmark analysis (MAR, smile, surprise, head pose). */
  visualEvent: VisualEventType;
  /** Confidence of the visual reaction event. */
  visualEventConfidence: number;
  speakerLabel?: string;               // from diarization (e.g., "SPEAKER_00")
  turnDetected: boolean;               // speaker just changed
}

export interface SpeakerDetectionResult {
  frames: SpeakerFrame[];
  speakerSegments: SpeakerLabel[];
  wordTimestamps: WordTimestamp[];
  totalSpeakers: number;
  /** Audio reaction events detected by librosa/energy analysis (V3). */
  reactionEvents: ReactionEvent[];
  /** Source of reaction detection ('librosa' | 'energy' | 'none') */
  reactionSource: string;
  /** Visual reaction events detected from face landmarks (P0.2). */
  visualEvents: VisualReactionEvent[];
  /** Source of visual detection ('visual' | 'none') */
  visualSource: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SHELL = platform() === 'win32' ? (process.env.COMSPEC || 'cmd.exe') : '/bin/sh';
const EXEC_OPTS: ExecSyncOptions = {
  stdio: 'pipe',
  timeout: 180_000,
  shell: SHELL,
  encoding: 'utf-8',
} as const;

/** Map from reaction-detector.py event label integers to AudioEventType. */
const EVENT_LABEL_MAP: Record<number, AudioEventType> = {
  0: 'normal',
  1: 'laughter',
  2: 'gasp',
  3: 'applause',
  4: 'emotion_peak',
  [-1]: 'silence',
};

function log(tag: string, message: string): void {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] [SPEAKER${tag.padEnd(4)}] ${message}`);
}

// ============================================================================
// P0.2: Visual Reaction Detection (from Face Landmarks)
// ============================================================================

/**
 * Visual event from face landmark analysis.
 * Mirrors the event structure from visual-reaction-detector.py.
 */
export interface VisualReactionEvent {
  time: number;
  event_type: VisualEventType;
  confidence: number;
  duration: number;
  end_time: number;
  face_id: number | null;
}

/** Time series data from visual reaction analysis. */
interface VisualTimeSeries {
  times: number[];
  mar: number[];
  smile_score: number[];
  surprise_score: number[];
  head_nod_score: number[];
  head_shake_score: number[];
  event_labels: number[];
}

interface VisualReactionResult {
  source: string;
  analysis_window_hz: number;
  events: VisualReactionEvent[];
  time_series: VisualTimeSeries;
}

/** Visual event label constants matching visual-reaction-detector.py. */
const VIS_EVENT_NORMAL = 0;
const VIS_EVENT_SMILE = 1;
const VIS_EVENT_LAUGH = 2;
const VIS_EVENT_SURPRISE = 3;
const VIS_EVENT_NOD = 4;
const VIS_EVENT_SHAKE = 5;
const VIS_EVENT_NO_FACE = -1;

const VIS_EVENT_LABEL_MAP: Record<number, VisualEventType> = {
  [VIS_EVENT_NORMAL]: 'normal',
  [VIS_EVENT_SMILE]: 'smile',
  [VIS_EVENT_LAUGH]: 'laugh_visual',
  [VIS_EVENT_SURPRISE]: 'surprise_visual',
  [VIS_EVENT_NOD]: 'head_nod',
  [VIS_EVENT_SHAKE]: 'head_shake',
  [VIS_EVENT_NO_FACE]: 'no_face',
};

/**
 * Map visual event types to audio event types for decision engine compatibility.
 * The decision engine uses audioEvent to trigger reaction cuts, so we map
 * visual events to their closest audio counterparts for seamless integration.
 */
const VIS_TO_AUDIO_MAP: Record<VisualEventType, AudioEventType> = {
  'normal': 'normal',
  'smile': 'emotion_peak',       // positive emotional moment
  'laugh_visual': 'laughter',    // visual confirmation of laughter
  'surprise_visual': 'gasp',     // surprise = gasp equivalent
  'head_nod': 'normal',          // subtle, not reaction-cut worthy
  'head_shake': 'normal',        // subtle, not reaction-cut worthy
  'no_face': 'normal',
};

/** MAR (Mouth Aspect Ratio) thresholds. */
const MAR_CLOSED = 0.35;
const MAR_OPEN = 0.55;
const MAR_LAUGH = 0.70;

/** Smile thresholds. */
const SMILE_WIDTH_RATIO = 1.12;       // mouth must be 12% wider than sliding average
const SMILE_RAISE_MIN = 0.015;         // min mouth corner elevation relative to face height

/** Surprise thresholds. */
const SURPRISE_MULTIPLIER = 1.12;      // inter-eye must be 12% above baseline
const MAR_SURPRISE_MIN = 0.50;         // min MAR for surprise

/** EMA smoothing for feature signals. */
const VIS_EMA_ALPHA = 0.15;
const VIS_BASELINE_ADAPT_RATE = 0.02;

/** Head movement detection. */
const NOD_WINDOW_FRAMES = 12;
const SHAKE_WINDOW_FRAMES = 10;
const OSC_AMPLITUDE_MIN = 0.02;

// ---------------------------------------------------------------------------
// Helpers for visual detection
// ---------------------------------------------------------------------------

function vdist(a: [number, number], b: [number, number]): number {
  return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2);
}

interface FaceFeatures {
  mouthWidth: number;
  mouthHeight: number;
  mar: number;
  interEyeDist: number;
  noseOffsetX: number;
  noseOffsetY: number;
  mouthCornerElevation: number;
  headAngle: number;
  faceHeight: number;
}

function computeFaceFeatures(landmarks: FaceLandmarks): FaceFeatures {
  const le: [number, number] = landmarks.le;
  const re: [number, number] = landmarks.re;
  const n: [number, number] = landmarks.n;
  const lm: [number, number] = landmarks.lm;
  const rm: [number, number] = landmarks.rm;

  const mouthWidth = vdist(lm, rm);
  const mouthCenterY = (lm[1] + rm[1]) / 2;
  const mouthHeight = Math.abs(mouthCenterY - n[1]);
  const mar = mouthWidth > 0 ? mouthHeight / mouthWidth : 0;

  const interEyeDist = vdist(le, re);

  const eyeMidX = (le[0] + re[0]) / 2;
  const eyeMidY = (le[1] + re[1]) / 2;

  const noseOffsetX = n[0] - eyeMidX;
  const noseOffsetY = n[1] - eyeMidY;

  const mouthCornerY = (lm[1] + rm[1]) / 2;
  const mouthCornerElevation = eyeMidY - mouthCornerY;

  const headAngle = Math.atan2(re[1] - le[1], re[0] - le[0]);
  const faceHeight = interEyeDist * 3.0;

  return { mouthWidth, mouthHeight, mar, interEyeDist,
    noseOffsetX, noseOffsetY, mouthCornerElevation, headAngle, faceHeight };
}

// ---------------------------------------------------------------------------
// Baseline Tracker
// ---------------------------------------------------------------------------

class VisBaselineTracker {
  private baseline: number | null = null;
  private std: number = 0;
  private readonly alpha: number;

  constructor(alpha: number = VIS_BASELINE_ADAPT_RATE) {
    this.alpha = alpha;
  }

  update(value: number): number {
    if (this.baseline === null) {
      this.baseline = value;
      return 0;
    }
    const deviation = value - this.baseline;
    this.baseline += this.alpha * deviation;
    this.std = 0.9 * this.std + 0.1 * Math.abs(deviation);
    return deviation;
  }

  getBaseline(): number | null { return this.baseline; }
}

// ---------------------------------------------------------------------------
// Oscillation Detector (for head nods/shakes)
// ---------------------------------------------------------------------------

class VisOscillationDetector {
  private buffer: Array<{ value: number; time: number }> = [];
  private readonly maxSize: number;
  private readonly amplitudeMin: number;
  private lastZc: number | null = null;
  private zcSign: number = 0;
  private zcPeriods: number[] = [];
  public score: number = 0;
  public active: boolean = false;

  constructor(maxSize: number, amplitudeMin: number) {
    this.maxSize = maxSize;
    this.amplitudeMin = amplitudeMin;
  }

  push(value: number, time: number): number {
    this.buffer.push({ value, time });
    if (this.buffer.length > this.maxSize) this.buffer.shift();

    if (this.buffer.length < 3) return 0;

    // Detect zero crossing
    const prev = this.buffer[this.buffer.length - 2];
    const curr = this.buffer[this.buffer.length - 1];

    if (prev.value * curr.value < 0) {
      const currentSign = curr.value > 0 ? 1 : -1;
      if (this.zcSign !== 0 && currentSign !== this.zcSign) {
        // Valid crossing
        const zcTime = this.interpolateZc(prev, curr);
        if (this.lastZc !== null) {
          const period = zcTime - this.lastZc;
          this.zcPeriods.push(period);
          if (this.zcPeriods.length > 5) this.zcPeriods.shift();
        }
        this.lastZc = zcTime;
      }
      this.zcSign = currentSign;
    }

    // Compute oscillation score
    if (this.zcPeriods.length >= 2) {
      const avgPeriod = this.zcPeriods.reduce((a, b) => a + b, 0) / this.zcPeriods.length;
      const periodVariance = this.zcPeriods.reduce((sum, p) => sum + (p - avgPeriod) ** 2, 0) / this.zcPeriods.length;
      const periodConsistency = Math.max(0, 1 - Math.min(1, Math.sqrt(periodVariance) / Math.max(avgPeriod, 0.01)));

      const values = this.buffer.map(b => b.value);
      const amplitude = Math.max(...values) - Math.min(...values);

      if (amplitude >= this.amplitudeMin && avgPeriod < 2.0) {
        this.score = Math.min(1, (amplitude / this.amplitudeMin) * 0.5 + periodConsistency * 0.5);
        this.active = this.score > 0.4;
      } else {
        this.score *= 0.9;
        if (this.score < 0.1) this.active = false;
      }
    }

    return this.score;
  }

  private interpolateZc(a: { value: number; time: number }, b: { value: number; time: number }): number {
    if (Math.abs(b.value - a.value) < 1e-10) return (a.time + b.time) / 2;
    const t = -a.value / (b.value - a.value);
    return a.time + t * (b.time - a.time);
  }

  reset(): void {
    this.buffer = [];
    this.lastZc = null;
    this.zcSign = 0;
    this.zcPeriods = [];
    this.score = 0;
    this.active = false;
  }
}

// ---------------------------------------------------------------------------
// Visual Reaction Detector
// ---------------------------------------------------------------------------

/**
 * Run visual reaction detection on tracked face frames with landmarks.
 *
 * Processes each frame's face landmarks to detect:
 *   - Smile (mouth corners raised + mouth wider)
 *   - Laugh visual (high MAR = jaw dropped open)
 *   - Surprise visual (high MAR + wide eyes + head tilt back)
 *   - Head nod (rhythmic vertical oscillation)
 *   - Head shake (rhythmic horizontal oscillation)
 *
 * @param trackedFrames - Array of tracked frames with face landmarks
 * @returns VisualReactionResult with events and time-series data
 */
function detectVisualReactions(
  trackedFrames: TrackedFrame[],
): VisualReactionResult {
  if (!trackedFrames || trackedFrames.length === 0) {
    return { source: 'none', analysis_window_hz: 0, events: [], time_series: { times: [], mar: [], smile_score: [], surprise_score: [], head_nod_score: [], head_shake_score: [], event_labels: [] } };
  }

  // Per-face state
  const baselines: Map<number, {
    mar: VisBaselineTracker;
    mouthWidth: VisBaselineTracker;
    interEye: VisBaselineTracker;
    mouthElevation: VisBaselineTracker;
    noseOffsetX: VisBaselineTracker;
    noseOffsetY: VisBaselineTracker;
  }> = new Map();

  const smoothFeatures: Map<number, {
    marSmooth: number;
    smileScoreSmooth: number;
    surpriseScoreSmooth: number;
  }> = new Map();

  const oscillators: Map<number, {
    nod: VisOscillationDetector;
    shake: VisOscillationDetector;
  }> = new Map();

  const smoothMouthWidth: Map<number, number> = new Map();
  const smoothInterEye: Map<number, number> = new Map();

  // Calibration period
  const calibrationFrames = Math.max(5, Math.floor(trackedFrames.length / 4));

  // Per-frame data
  const times: number[] = [];
  const marValues: number[] = [];
  const smileScores: number[] = [];
  const surpriseScores: number[] = [];
  const nodScores: number[] = [];
  const shakeScores: number[] = [];
  const frameLabels: number[] = [];
  const frameConfidences: number[] = [];

  for (let fi = 0; fi < trackedFrames.length; fi++) {
    const frame = trackedFrames[fi];
    const t = frame.time;
    times.push(t);

    if (!frame.faces || frame.faces.length === 0) {
      frameLabels.push(VIS_EVENT_NO_FACE);
      frameConfidences.push(1.0);
      marValues.push(0);
      smileScores.push(0);
      surpriseScores.push(0);
      nodScores.push(0);
      shakeScores.push(0);
      continue;
    }

    // Process primary face (highest confidence)
    const primaryFace = frame.faces.reduce((best, f) =>
      (f.confidence || 0) > (best.confidence || 0) ? f : best
    );
    const faceId = primaryFace.id;
    const landmarks = primaryFace.landmarks;

    if (!landmarks) {
      frameLabels.push(VIS_EVENT_NORMAL);
      frameConfidences.push(0);
      marValues.push(0);
      smileScores.push(0);
      surpriseScores.push(0);
      nodScores.push(0);
      shakeScores.push(0);
      continue;
    }

    const features = computeFaceFeatures(landmarks);

    // Initialize per-face trackers
    if (!baselines.has(faceId)) {
      baselines.set(faceId, {
        mar: new VisBaselineTracker(),
        mouthWidth: new VisBaselineTracker(),
        interEye: new VisBaselineTracker(),
        mouthElevation: new VisBaselineTracker(),
        noseOffsetX: new VisBaselineTracker(),
        noseOffsetY: new VisBaselineTracker(),
      });
      smoothFeatures.set(faceId, { marSmooth: features.mar, smileScoreSmooth: 0, surpriseScoreSmooth: 0 });
      oscillators.set(faceId, { nod: new VisOscillationDetector(NOD_WINDOW_FRAMES, OSC_AMPLITUDE_MIN), shake: new VisOscillationDetector(SHAKE_WINDOW_FRAMES, OSC_AMPLITUDE_MIN) });
      smoothMouthWidth.set(faceId, features.mouthWidth);
      smoothInterEye.set(faceId, features.interEyeDist);
    }

    const bl = baselines.get(faceId)!;
    const sf = smoothFeatures.get(faceId)!;

    // Update baselines
    const marDev = bl.mar.update(features.mar);
    const mwDev = bl.mouthWidth.update(features.mouthWidth);
    const ieDev = bl.interEye.update(features.interEyeDist);
    const meDev = bl.mouthElevation.update(features.mouthCornerElevation);
    const noxDev = bl.noseOffsetX.update(features.noseOffsetX);
    const noyDev = bl.noseOffsetY.update(features.noseOffsetY);

    // --- Smile detection ---
    const smileMouthRaised = meDev > SMILE_RAISE_MIN * features.faceHeight;
    const smileMouthWider = features.mouthWidth > (smoothMouthWidth.get(faceId) || 1) * SMILE_WIDTH_RATIO;
    const smileMarOk = features.mar < MAR_OPEN;

    let smileScore = 0;
    if (smileMouthRaised && smileMouthWider && smileMarOk) {
      const widthRatio = features.mouthWidth / Math.max(smoothMouthWidth.get(faceId) || 1, 1);
      const raiseAmount = meDev / Math.max(features.faceHeight, 1);
      smileScore = Math.min(1, (widthRatio - 1) * 3 + raiseAmount * 20);
    }
    sf.smileScoreSmooth += VIS_EMA_ALPHA * (smileScore - sf.smileScoreSmooth);
    smileScores.push(Number(sf.smileScoreSmooth.toFixed(4)));

    // --- MAR / Laugh ---
    const marSmooth = sf.marSmooth + VIS_EMA_ALPHA * (features.mar - sf.marSmooth);
    sf.marSmooth = marSmooth;
    marValues.push(Number(marSmooth.toFixed(4)));

    // --- Surprise detection ---
    const interEyeRatio = features.interEyeDist / Math.max(smoothInterEye.get(faceId) || 1, 1);
    const surpriseMarOk = features.mar > MAR_SURPRISE_MIN;
    const surpriseEyesWide = interEyeRatio > SURPRISE_MULTIPLIER;
    const headTiltBack = noyDev > 0 && Math.abs(noyDev) > 0.01 * features.faceHeight;

    let surpriseScore = 0;
    if (surpriseMarOk && (surpriseEyesWide || headTiltBack)) {
      surpriseScore = (
        Math.min(1, Math.max(0, features.mar - MAR_SURPRISE_MIN) * 2) * 0.4 +
        Math.min(1, Math.max(0, interEyeRatio - 1) * 5) * 0.3 +
        (headTiltBack ? 0.3 : 0)
      );
    }
    sf.surpriseScoreSmooth += VIS_EMA_ALPHA * (surpriseScore - sf.surpriseScoreSmooth);
    surpriseScores.push(Number(sf.surpriseScoreSmooth.toFixed(4)));

    // --- Head nod/shake detection ---
    const nodVal = noyDev / Math.max(features.faceHeight, 1);
    const shakeVal = noxDev / Math.max(features.interEyeDist, 1);

    const nodOsc = oscillators.get(faceId)!.nod.push(nodVal, t);
    const shakeOsc = oscillators.get(faceId)!.shake.push(shakeVal, t);
    nodScores.push(Number(nodOsc.toFixed(4)));
    shakeScores.push(Number(shakeOsc.toFixed(4)));

    // Update smoothing baselines
    const currMw = smoothMouthWidth.get(faceId) || features.mouthWidth;
    smoothMouthWidth.set(faceId, currMw + VIS_EMA_ALPHA * (features.mouthWidth - currMw));
    const currIe = smoothInterEye.get(faceId) || features.interEyeDist;
    smoothInterEye.set(faceId, currIe + VIS_EMA_ALPHA * (features.interEyeDist - currIe));

    // --- Classify frame ---
    if (fi < calibrationFrames) {
      frameLabels.push(VIS_EVENT_NORMAL);
      frameConfidences.push(0);
      continue;
    }

    // Build scored event candidates
    const candidates: Array<{ label: number; confidence: number }> = [];

    // Laugh visual: very high MAR
    if (features.mar > MAR_LAUGH || (marSmooth > MAR_LAUGH && sf.smileScoreSmooth > 0.3)) {
      const conf = Math.min(0.95, (features.mar - MAR_LAUGH) * 2 + sf.smileScoreSmooth * 0.3);
      candidates.push({ label: VIS_EVENT_LAUGH, confidence: conf });
    }

    // Surprise: high MAR + wide eyes + head tilt
    if (sf.surpriseScoreSmooth > 0.4) {
      candidates.push({ label: VIS_EVENT_SURPRISE, confidence: sf.surpriseScoreSmooth });
    }

    // Smile: raised + wide mouth corners
    if (sf.smileScoreSmooth > 0.4 && features.mar < MAR_OPEN) {
      candidates.push({ label: VIS_EVENT_SMILE, confidence: sf.smileScoreSmooth });
    }

    // Head nod
    if (nodOsc > 0.5) {
      candidates.push({ label: VIS_EVENT_NOD, confidence: nodOsc });
    }

    // Head shake
    if (shakeOsc > 0.5) {
      candidates.push({ label: VIS_EVENT_SHAKE, confidence: shakeOsc });
    }

    if (candidates.length > 0) {
      candidates.sort((a, b) => b.confidence - a.confidence);
      frameLabels.push(candidates[0].label);
      frameConfidences.push(candidates[0].confidence);
    } else {
      frameLabels.push(VIS_EVENT_NORMAL);
      frameConfidences.push(0);
    }
  }

  // Merge contiguous events
  const events = mergeVisualEvents(frameLabels, frameConfidences, times, trackedFrames);

  if (events.length > 0) {
    const typeCounts: Record<string, number> = {};
    for (const evt of events) {
      typeCounts[evt.event_type] = (typeCounts[evt.event_type] || 0) + 1;
    }
    log('VISUAL', `Events: ${JSON.stringify(typeCounts)}`);
  }

  return {
    source: 'visual',
    analysis_window_hz: 0,
    events,
    time_series: {
      times: times.map(t => Number(t.toFixed(2))),
      mar: marValues,
      smile_score: smileScores,
      surprise_score: surpriseScores,
      head_nod_score: nodScores,
      head_shake_score: shakeScores,
      event_labels: frameLabels,
    },
  };
}

/**
 * Merge contiguous frames with the same visual event label into events.
 */
function mergeVisualEvents(
  labels: number[],
  confidences: number[],
  times: number[],
  trackedFrames: TrackedFrame[],
): VisualReactionEvent[] {
  const events: VisualReactionEvent[] = [];
  const minDuration = 0.3;
  const maxGapFrames = 2;

  let i = 0;
  while (i < labels.length) {
    const label = labels[i];
    if (label === VIS_EVENT_NORMAL || label === VIS_EVENT_NO_FACE) { i++; continue; }

    let eventStart = i;
    let eventEnd = i;
    let confSum = 0;
    let confCount = 0;
    const faceIds = new Set<number>();

    let gapCount = 0;
    let j = i + 1;
    while (j < labels.length) {
      if (labels[j] === label) {
        eventEnd = j;
        confSum += confidences[j];
        confCount++;
        gapCount = 0;
        if (j < trackedFrames.length) {
          for (const face of trackedFrames[j].faces) {
            faceIds.add(face.id);
          }
        }
      } else if (labels[j] === VIS_EVENT_NORMAL) {
        gapCount++;
        if (gapCount > maxGapFrames) break;
      } else {
        break;
      }
      j++;
    }

    const duration = times[Math.min(eventEnd + 1, times.length - 1)] - times[eventStart];
    if (duration >= minDuration) {
      const avgConf = Math.min(0.95, Math.max(0.1, confSum / Math.max(confCount, 1)));
      const eventType = VIS_EVENT_LABEL_MAP[label] || 'normal';
      events.push({
        time: Number(times[eventStart].toFixed(2)),
        event_type: eventType,
        confidence: Number(avgConf.toFixed(3)),
        duration: Number(duration.toFixed(2)),
        end_time: Number(times[Math.min(eventEnd, times.length - 1)].toFixed(2)),
        face_id: faceIds.size > 0 ? Math.max(...faceIds) : null,
      });
    }

    i = eventEnd + 1 > i ? eventEnd + 1 : i + 1;
  }

  // Deduplicate overlapping events
  const deduped: VisualReactionEvent[] = [];
  for (const evt of events) {
    if (deduped.length > 0 && evt.event_type === deduped[deduped.length - 1].event_type) {
      const prev = deduped[deduped.length - 1];
      const gap = evt.time - (prev.time + prev.duration);
      if (gap < 0.3 && evt.face_id === prev.face_id) {
        prev.duration = evt.time + evt.duration - prev.time;
        prev.end_time = evt.end_time;
        prev.confidence = Math.max(prev.confidence, evt.confidence);
        continue;
      }
    }
    deduped.push(evt);
  }

  return deduped;
}

/**
 * Look up the visual event at a given time.
 */
function lookupVisualEvent(
  time: number,
  visualResult: VisualReactionResult | null,
): { event: VisualEventType; confidence: number } {
  if (!visualResult || !visualResult.events) {
    return { event: 'normal', confidence: 0 };
  }

  for (const evt of visualResult.events) {
    if (time >= evt.time && time <= evt.end_time) {
      return { event: evt.event_type, confidence: evt.confidence };
    }
  }

  return { event: 'normal', confidence: 0 };
}

/**
 * Merge a visual event into the audio event for decision engine consumption.
 * Visual events can reinforce or override audio events when the visual signal
 * is stronger (e.g., silent laughter, off-mic surprise).
 */
function mergeAudioAndVisualEvents(
  audioEvent: AudioEventType,
  audioConfidence: number,
  visualEvent: VisualEventType,
  visualConfidence: number,
): { event: AudioEventType; confidence: number } {
  // Map visual to audio equivalent
  const mappedVisual = VIS_TO_AUDIO_MAP[visualEvent] || 'normal';

  // If visual is normal or no_face, use audio as-is
  if (visualEvent === 'normal' || visualEvent === 'no_face') {
    return { event: audioEvent, confidence: audioConfidence };
  }

  // If audio is also normal but visual detects something → use visual
  if ((audioEvent === 'normal' || audioEvent === 'silence') && visualConfidence > 0.4) {
    return { event: mappedVisual, confidence: visualConfidence };
  }

  // Both detect events → reinforce (use higher confidence)
  if (mappedVisual === audioEvent) {
    // Same event type → boost confidence
    return { event: audioEvent, confidence: Math.min(1, audioConfidence + visualConfidence * 0.3) };
  }

  // Different events → use whichever has higher confidence
  if (visualConfidence > audioConfidence * 1.2) {
    return { event: mappedVisual, confidence: visualConfidence };
  }

  return { event: audioEvent, confidence: audioConfidence };
}

// ============================================================================
// Lip Motion Energy Computation
// ============================================================================

/**
 * Estimate lip motion energy from face landmarks.
 * Uses the vertical distance between nose tip and mouth center,
 * and mouth width-to-height ratio changes over time.
 *
 * Higher values = more lip movement = likely speaking.
 */
function computeLipMotionEnergy(
  landmarks: FaceLandmarks,
  prevLandmarks?: FaceLandmarks,
): number {
  if (!prevLandmarks) return 0;

  const mouthHeight = (lm: FaceLandmarks): number => {
    const noseY = lm.n[1];
    const mouthCenterY = (lm.lm[1] + lm.rm[1]) / 2;
    return Math.abs(mouthCenterY - noseY);
  };

  const mouthWidth = (lm: FaceLandmarks): number => {
    return Math.abs(lm.lm[0] - lm.rm[0]);
  };

  // Change in mouth opening
  const heightDelta = Math.abs(mouthHeight(landmarks) - mouthHeight(prevLandmarks));
  const widthChange = Math.abs(mouthWidth(landmarks) - mouthWidth(prevLandmarks));

  // Normalize by face size
  const faceSize = Math.max(1, Math.abs(landmarks.re[0] - landmarks.le[0]));

  return (heightDelta + widthChange * 0.5) / faceSize;
}

// ============================================================================
// V3: Audio Reaction Detection via librosa
// ============================================================================

/**
 * Run reaction-detector.py (librosa/energy-based audio event analysis).
 *
 * Replaces the text-only keyword matching with real audio signal processing.
 * Detects: laughter, gasp, applause, silence, emotion_peak.
 *
 * @returns ReactionDetectorResult with events and time-series data, or null.
 */
/**
 * Run visual reaction detection on tracked face frames.
 * Processes landmarks in-memory (no Python subprocess needed).
 * Produces face events: smile, laugh_visual, surprise_visual, head_nod, head_shake.
 */
function runVisualReactionDetection(
  trackedFrames: TrackedFrame[],
): VisualReactionResult | null {
  if (!trackedFrames || trackedFrames.length === 0) {
    log('VISUAL', 'No tracked frames — skipping visual detection');
    return null;
  }

  // Check if frames have landmarks
  let hasLandmarks = false;
  for (const frame of trackedFrames) {
    for (const face of frame.faces) {
      if (face.landmarks && face.landmarks.le) {
        hasLandmarks = true;
        break;
      }
    }
    if (hasLandmarks) break;
  }

  if (!hasLandmarks) {
    log('VISUAL', 'No face landmarks available — skipping visual detection');
    return null;
  }

  log('VISUAL', 'Running visual reaction detection (MAR, smile, surprise, head pose)...');
  const result = detectVisualReactions(trackedFrames);

  log('VISUAL', `Complete: ${result.events.length} visual events`);
  return result;
}

async function runReactionDetection(
  videoPath: string,
  tempDir: string,
): Promise<ReactionDetectorResult | null> {
  const pythonBin = resolvePython();
  if (!pythonBin) {
    log('REACT', 'Python not found for reaction detection — skipping');
    return null;
  }

  const script = join(resolve(__dirname || '.'), 'reaction-detector.py');
  if (!existsSync(script)) {
    log('REACT', 'reaction-detector.py not found — skipping');
    return null;
  }

  const outputPath = join(tempDir, 'reaction_events.json');

  try {
    const cmd = `${pythonBin} "${script}" "${videoPath}" "${outputPath}"`;
    await execAsync(cmd, { ...EXEC_OPTS, timeout: 600_000 });
    log('REACT', `Python reaction detection completed`);

    if (!existsSync(outputPath)) {
      log('REACT', 'No output file produced');
      return null;
    }

    const data: ReactionDetectorResult = JSON.parse(readFileSync(outputPath, 'utf-8'));

    // Count event types for logging
    const typeCounts: Record<string, number> = {};
    for (const evt of data.events || []) {
      typeCounts[evt.event_type] = (typeCounts[evt.event_type] || 0) + 1;
    }

    log('REACT', `Source: ${data.source}, events: ${JSON.stringify(typeCounts)}`);
    return data;
  } catch (err) {
    log('WARN', `Reaction detection failed: ${(err as Error).message?.slice(0, 120)}`);
    return null;
  }
}

/**
 * Look up the audio event at a given time from the reaction detector output.
 *
 * First tries the events list (higher-level, merged events), then falls back
 * to the time_series event_labels for frame-level granularity.
 */
function lookupAudioEvent(
  time: number,
  reactionResult: ReactionDetectorResult | null,
): { event: AudioEventType; confidence: number; energy: number } {
  if (!reactionResult || !reactionResult.events) {
    return { event: 'normal', confidence: 1.0, energy: 0 };
  }

  // Strategy 1: Check merged events
  for (const evt of reactionResult.events) {
    if (time >= evt.time && time <= evt.end_time) {
      return {
        event: evt.event_type,
        confidence: evt.confidence,
        energy: 0,
      };
    }
  }

  // Strategy 2: Check time_series for frame-level labels
  const ts = reactionResult.time_series;
  if (ts && ts.times && ts.times.length > 0 && ts.event_labels && ts.event_labels.length > 0) {
    // Binary search for closest time
    let lo = 0;
    let hi = ts.times.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (ts.times[mid] < time) lo = mid + 1;
      else hi = mid;
    }

    const idx = Math.min(lo, ts.event_labels.length - 1);
    const label = ts.event_labels[idx];
    const eventType = EVENT_LABEL_MAP[label] || 'normal';
    const energy = ts.energy && idx < ts.energy.length ? ts.energy[idx] : 0;

    if (eventType !== 'normal') {
      return { event: eventType, confidence: 0.6, energy };
    }
  }

  return { event: 'normal', confidence: 1.0, energy: 0 };
}

// ============================================================================
// Main Detection Function
// ============================================================================

/**
 * Run full AV-ASD pipeline with V3 audio reaction detection.
 *
 * @param videoPath - Path to the source video file
 * @param trackedFrames - Tracked face frames from tracker
 * @param tempDir - Temp directory for intermediate files
 * @param hfToken - HuggingFace token (for PyAnnote)
 * @param deepgramKey - Deepgram API key (fallback for Whisper transcription)
 * @returns SpeakerDetectionResult
 */
export async function detectSpeakers(
  videoPath: string,
  trackedFrames: TrackedFrame[],
  tempDir: string,
  hfToken?: string,
  deepgramKey?: string,
  clipStart?: number,
  clipEnd?: number,
): Promise<SpeakerDetectionResult> {
  // Estimate speaker count from tracked faces (unique face IDs)
  const uniqueFaceIds = new Set<number>();
  for (const frame of trackedFrames) {
    for (const face of frame.faces) {
      uniqueFaceIds.add(face.id);
    }
  }
  const estimatedSpeakers = Math.max(2, Math.min(uniqueFaceIds.size, 6));
  log('DIARIZE', `Face detection found ${uniqueFaceIds.size} unique faces — estimating ${estimatedSpeakers} speakers`);

  // Step 1: Run diarization with estimated speaker count
  let speakerSegments: SpeakerLabel[] = [];
  if (isEnabled('DIARIZATION')) {
    logMemoryStart('diarization');
    speakerSegments = await runDiarization(videoPath, tempDir, hfToken, estimatedSpeakers, deepgramKey);
    log('DIARIZE', speakerSegments.length + ' segments, ' + countSpeakers(speakerSegments) + ' speakers');
    logMemoryEnd('diarization');
  } else {
    log('DIARIZE', 'DIARIZATION disabled by feature flag — skipping');
  }

  // Step 2: Run word-level transcription (Whisper → Deepgram fallback)
  logMemoryStart('transcription');
  const wordTimestamps = await runTranscription(videoPath, tempDir, deepgramKey, clipStart, clipEnd);
  log('TRANSCRIBE', `${wordTimestamps.length} words`);
  logMemoryEnd('transcription');

  // Step 3 [V3]: Run AUDIO-BASED reaction detection (replaces text keyword matching)
  let reactionResult: ReactionDetectorResult | null = null;
  let reactionSource = 'none';
  let visualResult: VisualReactionResult | null = null;
  let visualSource = 'none';
  if (isEnabled('REACTION_DETECTION')) {
    logMemoryStart('reaction-detection');
    reactionResult = await runReactionDetection(videoPath, tempDir);
    reactionSource = reactionResult?.source || 'none';
    if (reactionResult && reactionResult.events.length > 0) {
      const eventTypes = [...new Set(reactionResult.events.map(e => e.event_type))];
      log('AUDIO_EVENT', `V3 audio detection: ${reactionResult.events.length} events ` +
        `(types: ${eventTypes.join(', ')}), source=${reactionResult.source}`);
    } else {
      log('AUDIO_EVENT', 'No audio events detected (clip may be silent or reaction-detector unavailable)');
    }

    // Step 3b [P0.2]: Run VISUAL-BASED reaction detection from face landmarks
    if (isEnabled('VISUAL_REACTION')) {
      visualResult = runVisualReactionDetection(trackedFrames);
      visualSource = visualResult?.source || 'none';
      if (visualResult && visualResult.events.length > 0) {
        const eventTypes = [...new Set(visualResult.events.map(e => e.event_type))];
        log('VISUAL', 'P0.2 visual detection: ' + visualResult.events.length + ' events ' +
          '(types: ' + eventTypes.join(', ') + '), source=' + visualResult.source);
      } else {
        log('VISUAL', 'No visual events detected (no landmarks or no faces)');
      }
    } else {
      log('VISUAL', 'VISUAL_REACTION disabled by feature flag');
    }
    logMemoryEnd('reaction-detection');
  } // end if REACTION_DETECTION

  // Step 4: Fuse speaker + face tracking data
  const speakerFrames: SpeakerFrame[] = [];
  let lastActiveSpeakerId: number | null = null;
  let turnDetected = false;

  for (let fi = 0; fi < trackedFrames.length; fi++) {
    const frame = trackedFrames[fi];
    const t = frame.time;

    // Find active speaker segment at this time
    const activeSegment = speakerSegments.find(s => t >= s.start && t < s.end);

    // Compute lip motion for each face
    const prevFrame = fi > 0 ? trackedFrames[fi - 1] : null;
    let maxLipFace: TrackedFace | null = null;
    let maxLipMotion = 0;

    for (const face of frame.faces) {
      const prevFace = prevFrame?.faces.find(f => f.id === face.id);
      const lm = face.landmarks;
      const prevLm = prevFace?.landmarks as FaceLandmarks | undefined;

      if (lm && prevLm) {
        const motion = computeLipMotionEnergy(lm, prevLm);
        if (motion > maxLipMotion) {
          maxLipMotion = motion;
          maxLipFace = face;
        }
      }
    }

    // Determine active speaker:
    // Visual: face with highest lip motion
    // Audio: from diarization
    // Fusion: if audio says someone is speaking AND that face has high lip motion, use it
    let activeSpeakerId: number | null = null;
    let listenerIds: number[] = [];

    if (frame.faces.length > 0) {
      if (maxLipFace && maxLipMotion > 0.02) {
        // Lip motion detected — this is likely the speaker
        activeSpeakerId = maxLipFace.id;
        listenerIds = frame.faces
          .filter(f => f.id !== maxLipFace.id)
          .map(f => f.id);
      } else if (activeSegment && frame.faces.length > 0) {
        // Audio says someone is speaking, but no clear lip motion
        // Pick the face closest to frame center
        const sorted = [...frame.faces].sort(
          (a, b) => Math.abs(a.cx - 640) + Math.abs(a.cy - 360) -
                    (Math.abs(b.cx - 640) + Math.abs(b.cy - 360))
        );
        activeSpeakerId = sorted[0].id;
        listenerIds = sorted.slice(1).map(f => f.id);
      } else {
        // No clear signal — first face is "speaker", rest are listeners
        activeSpeakerId = frame.faces[0].id;
        listenerIds = frame.faces.slice(1).map(f => f.id);
      }
    }

    // Detect speaker turn
    turnDetected = activeSpeakerId !== null &&
                   lastActiveSpeakerId !== null &&
                   activeSpeakerId !== lastActiveSpeakerId;
    if (turnDetected) {
      log('TURN', `Speaker turn at ${t}s: ${lastActiveSpeakerId} → ${activeSpeakerId}`);
    }
    lastActiveSpeakerId = activeSpeakerId ?? lastActiveSpeakerId;

    // V3: Detect audio event from librosa/energy analysis (replaces keyword matching)
    const audioEvent = lookupAudioEvent(t, reactionResult);

    // P0.2: Detect visual event from face landmarks
    const visualEvent = lookupVisualEvent(t, visualResult);

    // Merge visual + audio events: visual can reinforce or override audio
    const mergedEvent = mergeAudioAndVisualEvents(
      audioEvent.event, audioEvent.confidence,
      visualEvent.event, visualEvent.confidence,
    );

    speakerFrames.push({
      ...frame,
      activeSpeakerId,
      listenerIds,
      audioEvent: mergedEvent.event,
      audioEventConfidence: mergedEvent.confidence,
      visualEvent: visualEvent.event,
      visualEventConfidence: visualEvent.confidence,
      speakerLabel: activeSegment?.speaker,
      turnDetected,
    });
  }

  const eventCounts: Record<string, number> = {};
  for (const f of speakerFrames) {
    eventCounts[f.audioEvent] = (eventCounts[f.audioEvent] || 0) + 1;
  }
  log('EVENTS', JSON.stringify(eventCounts));

  // Step 4b: Map raw face track IDs to stable participant IDs using ParticipantRegistry
  const registry = new ParticipantRegistry();
  registry.ingestTrackedFrames(trackedFrames);
  registry.ingestSpeakerSegments(speakerSegments);
  registry.buildParticipants();
  const participantMap = registry.getParticipantMap();
  const totalSpeakers = registry.getParticipantCount();

  log('V2_ASD', `Participant Registry built: ${totalSpeakers} stable participants consolidated from ${registry.getConfidenceMetrics().averageFragmentation.toFixed(1)}x average fragmentation`);

  for (const frame of speakerFrames) {
    if (frame.activeSpeakerId !== null) {
      const stableId = participantMap.get(frame.activeSpeakerId);
      if (stableId !== undefined) {
        frame.activeSpeakerId = stableId;
      }
    }
    frame.listenerIds = frame.listenerIds.map(id => {
      const stableId = participantMap.get(id);
      return stableId !== undefined ? stableId : id;
    });
    for (const face of frame.faces) {
      const stableId = participantMap.get(face.id);
      if (stableId !== undefined) {
        face.id = stableId;
      }
    }
  }

  return {
    frames: speakerFrames,
    speakerSegments,
    wordTimestamps,
    totalSpeakers: totalSpeakers,
    reactionEvents: reactionResult?.events || [],
    reactionSource,
    visualEvents: visualResult?.events || [],
    visualSource,
  };
}

// ============================================================================
// Python Orchestration (Diarization + Transcription)
// ============================================================================

async function runDiarization(
  videoPath: string,
  tempDir: string,
  hfToken?: string,
  estimatedSpeakers?: number,
  deepgramKey?: string,
): Promise<SpeakerLabel[]> {
  const pythonBin = resolvePython();
  if (!pythonBin) {
    log('INFO', 'Python not found for diarization — no speaker labels');
    return [];
  }

  const script = join(resolve(__dirname || '.'), 'diarize.py');
  if (!existsSync(script)) {
    log('INFO', 'diarize.py not found — no speaker labels');
    return [];
  }

  const outputPath = join(tempDir, 'speaker_segments.json');

  try {
    let cmd = `${pythonBin} "${script}" "${videoPath}" "${outputPath}"`;
    if (deepgramKey) {
      cmd += ` --deepgram-key "${deepgramKey}"`;
      log('DG', `DEEPGRAM_API_KEY provided (length=${deepgramKey.length}) — Deepgram diarization enabled`);
    } else {
      log('DG', 'DEEPGRAM_API_KEY not provided — Deepgram diarization skipped');
    }
    if (hfToken) {
      cmd += ` --hf-token "${hfToken}"`;
      log('HF', `HF_TOKEN provided (length=${hfToken.length}) — PyAnnote enabled`);
    } else {
      log('HF', 'HF_TOKEN not provided — PyAnnote skipped');
    }
    if (estimatedSpeakers && estimatedSpeakers > 1) {
      cmd += ` --num-speakers ${estimatedSpeakers}`;
      log('SPEAKERS', `Estimated ${estimatedSpeakers} speakers from face data`);
    }
    await execAsync(cmd, { ...EXEC_OPTS, timeout: 300_000 });
    log('DIARIZE', `Python diarization completed`);

    if (!existsSync(outputPath)) {
      log('WARN', 'diarize.py produced no output file');
      return [];
    }

    const raw = JSON.parse(readFileSync(outputPath, 'utf-8'));

    // New format: { segments: [...], metadata: { strategy, num_speakers, ... } }
    if (raw.metadata) {
      log('DIARIZE', `strategy=${raw.metadata.strategy} speakers=${raw.metadata.num_speakers} segments=${raw.metadata.num_segments}`);
      return raw.segments || [];
    }

    // Legacy format: direct array
    log('DIARIZE', `Legacy format: ${raw.length} segments`);
    return Array.isArray(raw) ? raw : [];
  } catch (err) {
    const execErr = err as any;
    const errorMsg = (execErr.message || String(err)).slice(0, 500);
    const stderrStr = execErr.stderr ? execErr.stderr.toString().slice(0, 1000) : '';
    log('WARN', `Diarization failed: ${errorMsg}`);
    if (stderrStr) log('WARN', `diarize.py stderr: ${stderrStr}`);
    return [];
  }
}

async function runTranscription(
  videoPath: string,
  tempDir: string,
  deepgramKey?: string,
  clipStart?: number,
  clipEnd?: number,
): Promise<WordTimestamp[]> {
  const pythonBin = resolvePython();
  if (!pythonBin) {
    log('INFO', 'Python not found for transcription — no word timestamps');
    return [];
  }

  const script = join(resolve(__dirname || '.'), 'transcribe.py');
  if (!existsSync(script)) {
    log('INFO', 'transcribe.py not found — no word timestamps');
    return [];
  }

  const outputPath = join(tempDir, 'transcription.json');

  try {
    let cmd = `${pythonBin} "${script}" "${videoPath}" "${outputPath}"`;
    if (deepgramKey) {
      cmd += ` --deepgram-key "${deepgramKey}"`;
    }
    if (clipStart !== undefined && clipEnd !== undefined) {
      cmd += ` --clip-start ${clipStart} --clip-end ${clipEnd}`;
    }
    await execAsync(cmd, { ...EXEC_OPTS, timeout: 600_000 });
    log('TRANSCRIBE', `Python transcription completed`);

    if (!existsSync(outputPath)) return [];

    const data = JSON.parse(readFileSync(outputPath, 'utf-8'));
    const words = (data.words || []) as WordTimestamp[];
    // Log first 20 timestamps to verify timeline
    if (words.length > 0) {
      const samples = words.slice(0, 20).map(w => `${w.word}@${w.start}-${w.end}`);
      log('TIMESTAMPS', `First 20 word timestamps (raw): ${samples.join(', ')}`);
      const lastWord = words[words.length - 1];
      log('TIMESTAMPS', `Last word: ${lastWord.word}@${lastWord.start}-${lastWord.end}, duration=${(lastWord.end - words[0].start).toFixed(1)}s`);
    }
    // Normalize: Deepgram returns clip-relative timestamps (0-based for extracted clip).
    // Subtitle renderer expects absolute video timestamps.
    if (clipStart !== undefined && clipStart > 0 && words.length > 0) {
      log('NORMALIZE', `Adding clipStart offset ${clipStart}s to ${words.length} word timestamps`);
      for (const w of words) {
        w.start += clipStart;
        w.end += clipStart;
      }
      // Re-log after normalization
      if (words.length > 0) {
        const samples = words.slice(0, 3).map(w => `${w.word}@${w.start.toFixed(2)}-${w.end.toFixed(2)}`);
        log('TIMESTAMPS', `After normalize: ${samples.join(', ')}`);
      }
    }
    log('TRANSCRIBE', `Source: ${data.source || 'unknown'}, ${words.length} words`);
    return words;
  } catch (err) {
    const error = err as any;
    log('WARN', `Transcription failed: ${error.message}\nStderr: ${error.stderr || ''}\nStdout: ${error.stdout || ''}`);
    return [];
  }
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

function countSpeakers(segments: SpeakerLabel[]): number {
  return new Set(segments.map(s => s.speaker)).size;
}
