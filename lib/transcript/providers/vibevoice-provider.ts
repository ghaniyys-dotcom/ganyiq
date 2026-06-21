/**
 * lib/transcript/providers/vibevoice-provider.ts — VibeVoice-ASR provider
 *
 * Connects to a remote VibeVoice vLLM server (on PC-GANY with GPU).
 * Uses OpenAI-compatible /v1/chat/completions endpoint.
 *
 * Architecture: MODE A
 *   Server (VPS): Deepgram primary, routing, fusion
 *   Worker (PC-GANY): VibeVoice inference via vLLM Docker
 *
 * VibeVoice-ASR produces Who (Speaker), When (Timestamps), What (Content)
 * in a single pass for up to 60 minutes of audio.
 *
 * See: https://github.com/microsoft/VibeVoice
 *      https://huggingface.co/microsoft/VibeVoice-ASR
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { AppError } from '../../errors';
import type {
  ProviderResult,
  TranscriptWord,
  TranscriptSegment,
  VibeVoiceConfig,
} from './types';

// ---------------------------------------------------------------------------
// Default Configuration
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: VibeVoiceConfig = {
  baseUrl: process.env.VIBEVOICE_API_URL || 'http://localhost:8000',
  apiKey: process.env.VIBEVOICE_API_KEY || '',
  model: 'microsoft/VibeVoice-ASR',
  timeoutMs: 600_000, // 10 min for long audio
  maxDurationSeconds: 3600, // 60 min
};

// ---------------------------------------------------------------------------
// VibeVoice API Response Types
// ---------------------------------------------------------------------------

interface VibeVoiceWord {
  word: string;
  start: number;
  end: number;
  speaker?: string;
  confidence?: number;
}

interface VibeVoiceSegment {
  start: number;
  end: number;
  text: string;
  speaker: string;
  words?: VibeVoiceWord[];
}

/** Parsed from the streaming response content */
interface VibeVoiceOutput {
  segments?: VibeVoiceSegment[];
  text?: string;
  language?: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Transcribe audio using VibeVoice-ASR via remote vLLM server.
 *
 * @param audioPath - Absolute path to audio/video file (on the machine running VibeVoice)
 * @param config - Optional config override
 * @returns Normalized ProviderResult
 */
export async function fetchVibeVoiceTranscript(
  audioPath: string,
  config?: Partial<VibeVoiceConfig>,
): Promise<ProviderResult> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const startTime = Date.now();

  // Validate audio file exists (local check)
  if (!existsSync(audioPath)) {
    throw new AppError(
      'ANALYSIS_FAILED',
      `VibeVoice audio file not found: ${audioPath}`,
      500,
    );
  }

  const apiKey = resolveApiKey(cfg);
  const url = `${cfg.baseUrl}/v1/chat/completions`;

  try {
    // Encode audio as base64 for the API
    const audioBase64 = readFileSync(audioPath).toString('base64');
    const mimeType = guessMimeType(audioPath);

    const payload = {
      model: cfg.model,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'audio',
              audio: {
                data: `data:${mimeType};base64,${audioBase64}`,
                format: mimeType.split('/')[1] || 'wav',
              },
            },
          ],
        },
      ],
      max_tokens: 8192,
      temperature: 0,
      stream: false,
    };

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(cfg.timeoutMs ?? 600_000),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new AppError(
        'ANALYSIS_FAILED',
        `VibeVoice HTTP ${response.status}: ${body.substring(0, 200)}`,
        502,
      );
    }

    const data = await response.json();
    const latencyMs = Date.now() - startTime;

    // Parse VibeVoice output from response
    const content = data?.choices?.[0]?.message?.content;
    if (!content) {
      throw new AppError(
        'ANALYSIS_FAILED',
        'VibeVoice returned empty response content.',
        502,
      );
    }

    const output = parseVibeVoiceOutput(content, latencyMs);
    return output;
  } catch (err: unknown) {
    if (err instanceof AppError) throw err;
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      throw new AppError(
        'ANALYSIS_FAILED',
        'VibeVoice request timed out.',
        504,
      );
    }
    throw new AppError(
      'ANALYSIS_FAILED',
      `VibeVoice request failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
      502,
    );
  }
}

// ---------------------------------------------------------------------------
// Output Parsing
// ---------------------------------------------------------------------------

/**
 * Parse VibeVoice ASR output from the LLM response content.
 * VibeVoice returns structured JSON with segments containing speaker/timestamps.
 */
function parseVibeVoiceOutput(
  content: string,
  latencyMs: number,
): ProviderResult {
  let parsed: VibeVoiceOutput;

  // Try to extract JSON from the content (may be wrapped in ```json blocks)
  try {
    const jsonMatch = content.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
    const jsonStr = jsonMatch ? jsonMatch[1] : content;
    parsed = JSON.parse(jsonStr);
  } catch {
    // If it's plain text, wrap it as a single segment
    parsed = { text: content.trim(), segments: [] };
  }

  const segments = normalizeSegments(parsed);
  const words = extractWords(parsed);
  const speakers = extractSpeakers(segments);
  const confidence = computeConfidence(segments);
  const durationSeconds = computeDuration(segments);

  return {
    transcript: parsed.text || segments.map(s => s.text).join(' '),
    segments,
    words,
    confidence,
    durationSeconds,
    speakers,
    providerName: 'vibevoice',
    latencyMs,
  };
}

function normalizeSegments(output: VibeVoiceOutput): TranscriptSegment[] {
  if (output.segments && output.segments.length > 0) {
    return output.segments.map((s) => ({
      start: s.start,
      duration: Math.max(0.5, (s.end || s.start + 5) - s.start),
      text: s.text,
      speaker: s.speaker || undefined,
      words: s.words?.map(w => ({
        word: w.word,
        start: w.start,
        end: w.end,
        confidence: w.confidence || 0.5,
        speaker: w.speaker || s.speaker || undefined,
      })),
    }));
  }

  // Fallback: single segment from full text
  if (output.text) {
    return [
      {
        start: 0,
        duration: 10,
        text: output.text.trim(),
        speaker: undefined,
      },
    ];
  }

  return [];
}

function extractWords(output: VibeVoiceOutput): TranscriptWord[] {
  const allWords: TranscriptWord[] = [];
  for (const seg of output.segments || []) {
    for (const w of seg.words || []) {
      allWords.push({
        word: w.word,
        start: w.start,
        end: w.end,
        confidence: w.confidence || 0.5,
        speaker: w.speaker || seg.speaker || undefined,
      });
    }
  }
  return allWords;
}

function extractSpeakers(segments: TranscriptSegment[]): string[] {
  const speakerSet = new Set<string>();
  for (const s of segments) {
    if (s.speaker) speakerSet.add(s.speaker);
  }
  return Array.from(speakerSet).sort();
}

function computeConfidence(segments: TranscriptSegment[]): number {
  if (segments.length === 0) return 0;
  // VibeVoice doesn't provide per-word confidence reliably
  // Return 0.8 as baseline (VibeVoice is generally high quality)
  return 0.8;
}

function computeDuration(segments: TranscriptSegment[]): number {
  if (segments.length === 0) return 0;
  const last = segments[segments.length - 1];
  return last.start + last.duration;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function guessMimeType(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() || '';
  const mimeMap: Record<string, string> = {
    wav: 'audio/wav',
    mp3: 'audio/mpeg',
    m4a: 'audio/mp4',
    mp4: 'video/mp4',
    flac: 'audio/flac',
    ogg: 'audio/ogg',
    opus: 'audio/ogg',
    webm: 'audio/webm',
  };
  return mimeMap[ext] || 'audio/wav';
}

function resolveApiKey(config: VibeVoiceConfig): string {
  if (config.apiKey && config.apiKey.length > 5) return config.apiKey;

  // Fallback: check environment
  const envKey = process.env.VIBEVOICE_API_KEY;
  if (envKey && envKey.length > 5) return envKey;

  return '';
}

// ---------------------------------------------------------------------------
// VibeVoice Health Check
// ---------------------------------------------------------------------------

export async function checkVibeVoiceHealth(
  config?: Partial<VibeVoiceConfig>,
): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const startTime = Date.now();

  try {
    const response = await fetch(`${cfg.baseUrl}/v1/models`, {
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      return {
        ok: false,
        latencyMs: Date.now() - startTime,
        error: `HTTP ${response.status}`,
      };
    }

    return {
      ok: true,
      latencyMs: Date.now() - startTime,
    };
  } catch (err: unknown) {
    return {
      ok: false,
      latencyMs: Date.now() - startTime,
      error: err instanceof Error ? err.message : 'Connection failed',
    };
  }
}
