/**
 * lib/transcript/providers/types.ts — Shared types for all transcript providers
 *
 * Normalized interface that every provider emits.
 * Downstream pipeline consumes these types, never raw provider output.
 */

// ---------------------------------------------------------------------------
// Word-level transcript (rich — the new standard)
// ---------------------------------------------------------------------------

export interface TranscriptWord {
  word: string;
  start: number;       // seconds
  end: number;         // seconds
  confidence: number;  // 0-1
  speaker?: string;    // speaker label from diarization
}

export interface TranscriptSegment {
  start: number;       // seconds
  duration: number;    // seconds
  text: string;
  speaker?: string;    // speaker label
  words?: TranscriptWord[];  // word-level timestamps
}

// ---------------------------------------------------------------------------
// Provider output (normalized)
// ---------------------------------------------------------------------------

export interface ProviderResult {
  /** Full plain-text transcript */
  transcript: string;
  /** Segments grouped by time */
  segments: TranscriptSegment[];
  /** Word-level detail (if available) */
  words: TranscriptWord[];
  /** Overall confidence 0-1 */
  confidence: number;
  /** Estimated duration of source audio in seconds */
  durationSeconds: number;
  /** Unique speaker labels detected */
  speakers: string[];
  /** Provider that produced this result */
  providerName: ProviderName;
  /** Latency in milliseconds */
  latencyMs: number;
}

export type ProviderName = 'deepgram' | 'vibevoice' | 'fasterwhisper' | 'youtube' | 'worker';

// ---------------------------------------------------------------------------
// Provider configuration
// ---------------------------------------------------------------------------

export interface VibeVoiceConfig {
  /** Base URL of the vLLM VibeVoice server */
  baseUrl: string;
  /** API key if required */
  apiKey?: string;
  /** Model name on the server */
  model?: string;
  /** Request timeout in ms */
  timeoutMs?: number;
  /** Max audio duration in seconds */
  maxDurationSeconds?: number;
}

export interface FasterWhisperConfig {
  /** Model size: 'tiny', 'base', 'small', 'medium', 'large-v3' */
  modelSize?: string;
  /** Device: 'cpu', 'cuda', 'auto' */
  device?: string;
  /** Compute type: 'float16', 'int8', 'float32' */
  computeType?: string;
  /** Language hint */
  language?: string;
  /** Number of inference threads */
  numThreads?: number;
}

// ---------------------------------------------------------------------------
// Fallback / routing types
// ---------------------------------------------------------------------------

export interface FallbackResult {
  success: boolean;
  result?: ProviderResult;
  error?: string;
  providerUsed: ProviderName;
  fallbacksAttempted: ProviderName[];
  totalLatencyMs: number;
}

export type RoutingDecision = {
  provider: ProviderName;
  reason: string;
};

export type ConversationType = 'monologue' | 'interview' | 'podcast' | 'panel' | 'unknown';
