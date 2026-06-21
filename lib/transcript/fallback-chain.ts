/**
 * lib/transcript/fallback-chain.ts — Automatic fallback transcription
 *
 * Implements the fallback chain:
 *   Deepgram → VibeVoice → FasterWhisper
 *
 * Tries providers in order until one succeeds or all fail.
 * Never crashes — always returns a result or a detailed failure.
 *
 * Persists: provider_used, provider_fallback_reason
 */

import { AppError } from '../errors';
import { fetchDeepgramTranscript } from '../deepgram';
import { fetchVibeVoiceTranscript } from './providers/vibevoice-provider';
import { fetchFasterWhisperTranscript } from './providers/fasterwhisper-provider';
import type {
  ProviderResult,
  ProviderName,
  FallbackResult,
} from './providers/types';
import type { RoutingInput } from './provider-router';
import { determineProvider, vibevoiceWouldAddValue } from './provider-router';
import { deepgramToProviderResult } from './fusion/deepgram-to-provider';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FallbackOptions {
  /** YouTube URL for Deepgram download */
  youtubeUrl: string;
  /** Path to local audio file (for VibeVoice/FasterWhisper) */
  audioPath?: string;
  /** Routing hints */
  routing?: RoutingInput;
  /** Whether to prefer VibeVoice even for single-speaker */
  forceVibeVoice?: boolean;
  /** Whether to use FasterWhisper as fallback */
  enableFasterWhisper?: boolean;
  /** VibeVoice server config overrides */
  vibevoiceConfig?: Record<string, unknown>;
  /** FasterWhisper config overrides */
  fasterWhisperConfig?: Record<string, unknown>;
}

export interface FallbackReport {
  success: boolean;
  result?: ProviderResult;
  error?: string;
  providerUsed: ProviderName;
  fallbacksAttempted: ProviderName[];
  totalLatencyMs: number;
}

// ---------------------------------------------------------------------------
// Fallback Chain
// ---------------------------------------------------------------------------

/**
 * Run the fallback transcription chain.
 *
 * Order:
 *   1. Deepgram (via YouTube URL, downloads audio)
 *   2. VibeVoice (via local audio path, remote vLLM server)
 *   3. FasterWhisper (local CPU inference)
 *
 * Never crashes. Always returns a FallbackResult.
 */
export async function transcribeWithFallback(
  options: FallbackOptions,
): Promise<FallbackReport> {
  const startTime = Date.now();
  const fallbacksAttempted: ProviderName[] = [];
  const {
    youtubeUrl,
    audioPath,
    routing,
    forceVibeVoice,
    enableFasterWhisper = true,
  } = options;

  // ---- Determine preferred provider ----
  let preferredProvider: ProviderName = 'deepgram';
  if (forceVibeVoice) {
    preferredProvider = 'vibevoice';
  } else if (routing) {
    preferredProvider = determineProvider(routing).provider;
  }

  // Build ordered provider list based on preference
  const providerOrder = buildProviderOrder(preferredProvider, enableFasterWhisper);

  // ---- Try providers in order ----
  for (const provider of providerOrder) {
    try {
      let result: ProviderResult;

      switch (provider) {
        case 'deepgram': {
          result = await tryDeepgram(youtubeUrl);
          break;
        }
        case 'vibevoice': {
          if (!audioPath) {
            fallbacksAttempted.push('vibevoice');
            continue; // Skip if no audio file
          }
          result = await tryVibeVoice(audioPath, options.vibevoiceConfig);
          break;
        }
        case 'fasterwhisper': {
          if (!audioPath) {
            fallbacksAttempted.push('fasterwhisper');
            continue; // Skip if no audio file
          }
          result = await tryFasterWhisper(audioPath, options.fasterWhisperConfig);
          break;
        }
        default:
          continue;
      }

      // Success
      return {
        success: true,
        result,
        providerUsed: provider,
        fallbacksAttempted,
        totalLatencyMs: Date.now() - startTime,
      };
    } catch (err) {
      fallbacksAttempted.push(provider);
      console.log(`[FALLBACK] ${provider} failed: ${err instanceof Error ? err.message.slice(0, 100) : 'Unknown'}`);
      // Continue to next provider
    }
  }

  // All providers failed
  return {
    success: false,
    error: `All providers failed. Attempted: ${fallbacksAttempted.join(', ')}`,
    providerUsed: fallbacksAttempted[fallbacksAttempted.length - 1] || 'deepgram',
    fallbacksAttempted,
    totalLatencyMs: Date.now() - startTime,
  };
}

// ---------------------------------------------------------------------------
// Individual Provider Attempts
// ---------------------------------------------------------------------------

async function tryDeepgram(youtubeUrl: string): Promise<ProviderResult> {
  const dgResult = await fetchDeepgramTranscript(youtubeUrl);
  return deepgramToProviderResult(dgResult);
}

async function tryVibeVoice(
  audioPath: string,
  config?: Record<string, unknown>,
): Promise<ProviderResult> {
  const vibevoiceConfig = config as any;
  return await fetchVibeVoiceTranscript(audioPath, vibevoiceConfig);
}

async function tryFasterWhisper(
  audioPath: string,
  config?: Record<string, unknown>,
): Promise<ProviderResult> {
  const fwConfig = config as any;
  return await fetchFasterWhisperTranscript(audioPath, fwConfig);
}

// ---------------------------------------------------------------------------
// Provider Order Builder
// ---------------------------------------------------------------------------

function buildProviderOrder(
  preferred: ProviderName,
  enableFasterWhisper: boolean,
): ProviderName[] {
  const order: ProviderName[] = [];

  // Preferred first
  if (preferred === 'vibevoice') {
    order.push('vibevoice', 'deepgram');
  } else {
    order.push('deepgram', 'vibevoice');
  }

  // FasterWhisper is always last (slowest, no diarization)
  if (enableFasterWhisper) {
    order.push('fasterwhisper');
  }

  return order;
}
