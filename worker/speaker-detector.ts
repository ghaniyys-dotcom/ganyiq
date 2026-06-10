/**
 * worker/speaker-detector.ts — Audio-Visual Active Speaker Detection for GANYIQ V2.
 *
 * Fuses audio diarization with visual face tracking to determine:
 *   - Active speaker per frame
 *   - Listener faces
 *   - Audio events (laughter, gasp, emotional peak)
 *   - Speaker turn detection
 *
 * Flow:
 *   1. Run diarize.py (Python) → speaker segments
 *   2. Run transcribe.py (Python) → word-level timestamps
 *   3. For each tracked face, compute lip motion energy from landmarks
 *   4. Align audio speaker labels with visual data
 *   5. Detect audio events from energy/transcript analysis
 */

import { execSync, ExecSyncOptions } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { platform } from 'os';
import type { TrackedFrame, TrackedFace, FaceLandmarks } from './tracker';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AudioEventType = 'normal' | 'laughter' | 'gasp' | 'silence' | 'emotion_peak' | 'applause';

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
  speakerLabel?: string;               // from diarization (e.g., "SPEAKER_00")
  turnDetected: boolean;               // speaker just changed
}

export interface SpeakerDetectionResult {
  frames: SpeakerFrame[];
  speakerSegments: SpeakerLabel[];
  wordTimestamps: WordTimestamp[];
  totalSpeakers: number;
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

function log(tag: string, message: string): void {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] [SPEAKER${tag.padEnd(4)}] ${message}`);
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
// Audio Energy Detection
// ============================================================================

/**
 * Simple keyword/event detection from transcript words.
 */
function detectAudioEventFromWords(
  words: WordTimestamp[],
  currentTime: number,
  timeWindow: number = 2.0,
): { event: AudioEventType; confidence: number } {
  const nearbyWords = words.filter(
    w => Math.abs(w.start - currentTime) < timeWindow || Math.abs(w.end - currentTime) < timeWindow
  );

  const text = nearbyWords.map(w => w.word.toLowerCase()).join(' ');

  // Laughter indicators
  const laughterPatterns = [
    /haha/i, /hehe/i, /lol/i, /😂/, /hahaha/i,
    /(?:that'?s|it'?s|this is) (?:funny|hilarious)/i,
    /(?:laugh|giggle|chuckle)/i,
  ];
  for (const pat of laughterPatterns) {
    if (pat.test(text)) {
      return { event: 'laughter', confidence: 0.7 };
    }
  }

  // Gasp/surprise indicators
  const gaspPatterns = [
    /(?:oh my god|oh my|wow|really|seriously|no way|are you kidding|what the|holy)/i,
    /(?:gasp|shock|surprised|unbelievable)/i,
  ];
  for (const pat of gaspPatterns) {
    if (pat.test(text)) {
      return { event: 'gasp', confidence: 0.6 };
    }
  }

  // Emotional indicators
  const emotionPatterns = [
    /(?:i'?m sorry|i'?m crying|this is so|that'?s so|i can'?t|unbelievable|incredible)/i,
    /(?:beautiful|heartbreaking|touching|emotional|crying|tears)/i,
  ];
  for (const pat of emotionPatterns) {
    if (pat.test(text)) {
      return { event: 'emotion_peak', confidence: 0.5 };
    }
  }

  return { event: 'normal', confidence: 1.0 };
}

// ============================================================================
// Main Detection Function
// ============================================================================

/**
 * Run full AV-ASD pipeline.
 *
 * @param videoPath - Path to the source video file
 * @param trackedFrames - Tracked face frames from tracker
 * @param tempDir - Temp directory for intermediate files
 * @param hfToken - HuggingFace token (for PyAnnote)
 * @param deepgramKey - Deepgram API key (fallback for Whisper transcription)
 * @returns SpeakerDetectionResult
 */
export function detectSpeakers(
  videoPath: string,
  trackedFrames: TrackedFrame[],
  tempDir: string,
  hfToken?: string,
  deepgramKey?: string,
): SpeakerDetectionResult {
  // Step 1: Run diarization
  const speakerSegments = runDiarization(videoPath, tempDir, hfToken);
  log('DIARIZE', `${speakerSegments.length} segments, ${countSpeakers(speakerSegments)} speakers`);

  // Step 2: Run word-level transcription (Whisper → Deepgram fallback)
  const wordTimestamps = runTranscription(videoPath, tempDir, deepgramKey);
  log('TRANSCRIBE', `${wordTimestamps.length} words`);

  // Step 3: Fuse speaker + face tracking data
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

    // Detect audio event from words
    const audioEvent = detectAudioEventFromWords(wordTimestamps, t);

    speakerFrames.push({
      ...frame,
      activeSpeakerId,
      listenerIds,
      audioEvent: audioEvent.event,
      audioEventConfidence: audioEvent.confidence,
      speakerLabel: activeSegment?.speaker,
      turnDetected,
    });
  }

  const eventCounts: Record<string, number> = {};
  for (const f of speakerFrames) {
    eventCounts[f.audioEvent] = (eventCounts[f.audioEvent] || 0) + 1;
  }
  log('EVENTS', JSON.stringify(eventCounts));

  return {
    frames: speakerFrames,
    speakerSegments,
    wordTimestamps,
    totalSpeakers: countSpeakers(speakerSegments),
  };
}

// ============================================================================
// Python Orchestration (Diarization + Transcription)
// ============================================================================

function runDiarization(
  videoPath: string,
  tempDir: string,
  hfToken?: string,
): SpeakerLabel[] {
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
    if (hfToken) cmd += ` --hf-token "${hfToken}"`;
    execSync(cmd, { ...EXEC_OPTS, timeout: 300_000 });
    log('DIARIZE', `Python diarization completed`);

    if (!existsSync(outputPath)) return [];

    return JSON.parse(readFileSync(outputPath, 'utf-8'));
  } catch (err) {
    log('WARN', `Diarization failed: ${(err as Error).message?.slice(0, 120)}`);
    return [];
  }
}

function runTranscription(
  videoPath: string,
  tempDir: string,
  deepgramKey?: string,
): WordTimestamp[] {
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
    execSync(cmd, { ...EXEC_OPTS, timeout: 600_000 });
    log('TRANSCRIBE', `Python transcription completed`);

    if (!existsSync(outputPath)) return [];

    const data = JSON.parse(readFileSync(outputPath, 'utf-8'));
    log('TRANSCRIBE', `Source: ${data.source || 'unknown'}, ${data.words?.length || 0} words`);
    return data.words || [];
  } catch (err) {
    log('WARN', `Transcription failed: ${(err as Error).message?.slice(0, 120)}`);
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
