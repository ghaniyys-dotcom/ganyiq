/**
 * lib/transcript/providers/fasterwhisper-provider.ts — FasterWhisper transcription provider
 *
 * Calls worker/fasterwhisper-transcribe.py as a subprocess.
 * FasterWhisper provides word-level timestamps but NO speaker diarization.
 *
 * Intended as fallback when Deepgram and VibeVoice are both unavailable.
 * Runs on CPU by default (int8 quantized), can use CUDA if available.
 */

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { AppError } from '../../errors';
import type {
  ProviderResult,
  FasterWhisperConfig,
} from './types';

// ---------------------------------------------------------------------------
// Default Configuration
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: FasterWhisperConfig = {
  modelSize: process.env.FASTER_WHISPER_MODEL || 'small',
  device: process.env.FASTER_WHISPER_DEVICE || 'cpu',
  computeType: process.env.FASTER_WHISPER_COMPUTE || 'int8',
  language: process.env.FASTER_WHISPER_LANGUAGE || undefined,
  numThreads: parseInt(process.env.FASTER_WHISPER_THREADS || '4', 10),
};

/** Path to the Python transcription script */
const SCRIPT_PATH = process.env.FASTER_WHISPER_SCRIPT || './worker/fasterwhisper-transcribe.py';

/** Timeout per transcription (5 min for long audio on CPU) */
const WHISPER_TIMEOUT = 300_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface WhisperPythonOutput {
  error: string | null;
  transcript: string;
  segments: Array<{
    start: number;
    duration: number;
    text: string;
    speaker: string | null;
    words?: Array<{
      word: string;
      start: number;
      end: number;
      confidence: number;
      speaker: string | null;
    }>;
  }>;
  words: Array<{
    word: string;
    start: number;
    end: number;
    confidence: number;
    speaker: string | null;
  }>;
  confidence: number;
  durationSeconds: number;
  speakers: string[];
  providerName: string;
  latencyMs: number;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Transcribe audio using FasterWhisper (Python subprocess).
 * Uses CPU int8 by default — trades speed for broad compatibility.
 *
 * @param audioPath - Absolute path to audio file
 * @param config - Optional config override
 * @returns Normalized ProviderResult
 */
export async function fetchFasterWhisperTranscript(
  audioPath: string,
  config?: Partial<FasterWhisperConfig>,
): Promise<ProviderResult> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const startTime = Date.now();

  // Validate audio file
  if (!existsSync(audioPath)) {
    throw new AppError(
      'ANALYSIS_FAILED',
      `FasterWhisper audio file not found: ${audioPath}`,
      500,
    );
  }

  // Validate Python script exists
  const scriptPath = resolveScriptPath();
  if (!existsSync(scriptPath)) {
    throw new AppError(
      'ANALYSIS_FAILED',
      `FasterWhisper script not found at: ${scriptPath}`,
      500,
    );
  }

  try {
    const command = buildCommand(audioPath, cfg, scriptPath);
    const output = execSync(command, {
      timeout: WHISPER_TIMEOUT,
      maxBuffer: 50 * 1024 * 1024, // 50MB for long transcripts
      encoding: 'utf-8',
    });

    const parsed: WhisperPythonOutput = JSON.parse(output);

    if (parsed.error) {
      throw new AppError(
        'ANALYSIS_FAILED',
        `FasterWhisper error: ${parsed.error}`,
        502,
      );
    }

    const latencyMs = Date.now() - startTime;

    return {
      transcript: parsed.transcript,
      segments: parsed.segments.map(s => ({
        start: s.start,
        duration: s.duration,
        text: s.text,
        speaker: s.speaker ?? undefined,
        words: s.words?.map(w => ({
          word: w.word,
          start: w.start,
          end: w.end,
          confidence: w.confidence,
          speaker: w.speaker ?? undefined,
        })),
      })),
      words: parsed.words.map(w => ({
        word: w.word,
        start: w.start,
        end: w.end,
        confidence: w.confidence,
        speaker: w.speaker ?? undefined,
      })),
      confidence: parsed.confidence,
      durationSeconds: parsed.durationSeconds,
      speakers: parsed.speakers,
      providerName: 'fasterwhisper',
      latencyMs,
    };
  } catch (err: unknown) {
    if (err instanceof AppError) throw err;

    const msg = err instanceof Error ? err.message : 'Unknown error';
    if (msg.includes('ETIMEDOUT') || msg.includes('timed out')) {
      throw new AppError(
        'ANALYSIS_FAILED',
        'FasterWhisper timed out after 5 minutes.',
        504,
      );
    }

    throw new AppError(
      'ANALYSIS_FAILED',
      `FasterWhisper failed: ${msg.substring(0, 200)}`,
      502,
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildCommand(
  audioPath: string,
  config: FasterWhisperConfig,
  scriptPath: string,
): string {
  const parts = [
    'python3',
    `"${scriptPath}"`,
    `"${audioPath}"`,
    `--model-size`, config.modelSize || 'small',
    `--device`, config.device || 'cpu',
    `--compute-type`, config.computeType || 'int8',
  ];

  if (config.language) {
    parts.push('--language', config.language);
  }

  return parts.join(' ');
}

function resolveScriptPath(): string {
  // Try configured path first
  if (SCRIPT_PATH !== './worker/fasterwhisper-transcribe.py') {
    // Resolve relative to cwd
    if (SCRIPT_PATH.startsWith('./') || SCRIPT_PATH.startsWith('../')) {
      return require('node:path').join(process.cwd(), SCRIPT_PATH);
    }
    return SCRIPT_PATH;
  }

  // Default: check multiple locations
  const candidates = [
    require('node:path').join(process.cwd(), 'worker', 'fasterwhisper-transcribe.py'),
    require('node:path').join(__dirname, '..', '..', '..', 'worker', 'fasterwhisper-transcribe.py'),
    require('node:path').join(__dirname, '..', '..', '..', '..', 'worker', 'fasterwhisper-transcribe.py'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  // Return first candidate as default (error will be thrown by caller)
  return candidates[0];
}
