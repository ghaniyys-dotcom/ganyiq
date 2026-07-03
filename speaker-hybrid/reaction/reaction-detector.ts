/**
 * Reaction Detector
 *
 * Detects listener reactions (nod, smile, surprise, blink)
 * using facial landmarks. Used to improve dynamic split decisions.
 */

import type { FaceLandmark } from '../core/types';

export interface ReactionConfig {
  lipMovementThreshold: number;
  eyeBlinkThreshold: number;
  headMovementThreshold: number;
}

export const defaultReactionConfig: ReactionConfig = {
  lipMovementThreshold: 0.08,
  eyeBlinkThreshold: 0.15,
  headMovementThreshold: 0.12
};

export type ReactionType = 'nod' | 'smile' | 'surprise' | 'blink' | 'none';

/**
 * Detect reaction from a sequence of landmarks
 */
export function detectReaction(
  sequence: FaceLandmark[],
  config: Partial<ReactionConfig> = {}
): ReactionType {
  const cfg = { ...defaultReactionConfig, ...config };

  if (sequence.length < 3) return 'none';

  // TODO: Implement actual reaction detection
  return 'none';
}