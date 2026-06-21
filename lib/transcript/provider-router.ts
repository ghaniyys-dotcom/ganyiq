/**
 * lib/transcript/provider-router.ts — Deterministic provider routing
 *
 * Routes transcription requests to the optimal provider based on:
 * - Speaker count (from diarization pre-pass or metadata)
 * - Conversation type (monologue, interview, podcast, panel)
 * - Audio characteristics
 *
 * Rules (deterministic, no LLM):
 *   Single speaker    → Deepgram (fastest, most accurate ASR)
 *   Interview         → VibeVoice (best speaker separation)
 *   Podcast           → VibeVoice (best speaker separation)
 *   Panel discussion  → VibeVoice (best speaker separation)
 *   Unknown           → Deepgram (safe default)
 *
 * Detection sources (NO LLM):
 *   - Pre-existing transcript metadata
 *   - Audio file duration
 *   - Pre-pass speaker count (if diarization available)
 *   - Default fallback
 */

import type {
  ProviderName,
  ConversationType,
  RoutingDecision,
} from './providers/types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Thresholds for conversation type classification */
const THRESHOLDS = {
  /** Duration in seconds above which we consider multi-speaker possible */
  MIN_DURATION_FOR_MULTI_SPEAKER: 120, // 2 minutes
  /** If we have zero speaker info, assume monologue */
  UNSPEAKERED_ASSUMPTION: 'monologue' as ConversationType,
} as const;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Determine which provider to use for a given audio/video.
 *
 * @param options - Detection inputs
 * @returns Routing decision with provider and reason
 */
export function determineProvider(
  options: RoutingInput,
): RoutingDecision {
  const conversationType = classifyConversation(options);

  return routeByType(conversationType, options);
}

/**
 * Route to a specific provider based on conversation type.
 */
export function routeByType(
  conversationType: ConversationType,
  _options: RoutingInput,
): RoutingDecision {
  switch (conversationType) {
    case 'monologue':
      return {
        provider: 'deepgram',
        reason: `Single speaker (${conversationType}) → Deepgram (fastest ASR)`,
      };
    case 'interview':
      return {
        provider: 'vibevoice',
        reason: `Interview detected → VibeVoice (best speaker separation)`,
      };
    case 'podcast':
      return {
        provider: 'vibevoice',
        reason: `Podcast detected → VibeVoice (best speaker separation)`,
      };
    case 'panel':
      return {
        provider: 'vibevoice',
        reason: `Panel discussion detected → VibeVoice (multi-speaker optimized)`,
      };
    case 'unknown':
    default:
      return {
        provider: 'deepgram',
        reason: 'Conversation type unknown → Deepgram (safe default)',
      };
  }
}

// ---------------------------------------------------------------------------
// Conversation Type Classification
// ---------------------------------------------------------------------------

export interface RoutingInput {
  /** Estimated speaker count (0 if unknown) */
  speakerCount?: number;
  /** Video/audio duration in seconds */
  durationSeconds?: number;
  /** Title or description (may contain clues) */
  title?: string;
  /** Channel/playlist name */
  channelName?: string;
  /** Pre-existing segments (if already available) */
  segmentCount?: number;
  /** Audio file format */
  audioFormat?: string;
}

/**
 * Classify conversation type using ONLY deterministic rules.
 * NO LLM calls, NO pattern matching on title text (unreliable).
 */
export function classifyConversation(
  input: RoutingInput,
): ConversationType {
  const { speakerCount, durationSeconds, segmentCount } = input;

  // If we have actual speaker count from pre-pass or metadata
  if (speakerCount !== undefined && speakerCount > 0) {
    return classifyBySpeakerCount(speakerCount);
  }

  // If we have segment count from existing transcript
  if (segmentCount !== undefined && segmentCount > 0) {
    // For very short content (<2 min), assume monologue
    if (durationSeconds !== undefined && durationSeconds < THRESHOLDS.MIN_DURATION_FOR_MULTI_SPEAKER) {
      return 'monologue';
    }
    // Many short segments could indicate dialogue
    if (segmentCount > 20) {
      return 'podcast'; // Likely multi-speaker
    }
  }

  // For long-form content with no speaker info
  if (durationSeconds !== undefined && durationSeconds > THRESHOLDS.MIN_DURATION_FOR_MULTI_SPEAKER) {
    return 'unknown'; // Could be anything — use safe default
  }

  // Default: assume single speaker
  return THRESHOLDS.UNSPEAKERED_ASSUMPTION;
}

/**
 * Classify by known speaker count.
 * This is the most reliable signal.
 */
function classifyBySpeakerCount(count: number): ConversationType {
  if (count <= 1) return 'monologue';
  if (count === 2) return 'interview';
  if (count >= 3 && count <= 4) return 'podcast';
  if (count >= 5) return 'panel';
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Deepgram ↔ VibeVoice Decision Helper
// ---------------------------------------------------------------------------

/**
 * Determine if VibeVoice would add value for this content.
 * VibeVoice is only beneficial for multi-speaker content.
 */
export function vibevoiceWouldAddValue(
  speakerCount?: number,
  durationSeconds?: number,
): boolean {
  // If we know there are 2+ speakers, VibeVoice adds value
  if (speakerCount !== undefined && speakerCount >= 2) return true;

  // For long content with unknown speakers, VibeVoice may help
  if (
    speakerCount === undefined &&
    durationSeconds !== undefined &&
    durationSeconds > THRESHOLDS.MIN_DURATION_FOR_MULTI_SPEAKER
  ) {
    return true; // Unknown but long — worth trying
  }

  // Single speaker or short content: VibeVoice doesn't add value
  return false;
}

/**
 * Get the best provider pair for a given input.
 * Returns primary + secondary recommendation.
 */
export function getProviderRecommendation(
  input: RoutingInput,
): { primary: ProviderName; secondary: ProviderName; reason: string } {
  const decision = determineProvider(input);

  // Primary is the router's choice
  const primary = decision.provider;

  // Secondary is always the other provider (for fallback)
  const secondary: ProviderName = primary === 'deepgram' ? 'vibevoice' : 'deepgram';

  return {
    primary,
    secondary,
    reason: decision.reason,
  };
}
