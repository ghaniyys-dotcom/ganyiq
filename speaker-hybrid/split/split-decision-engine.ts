/**
 * Split Decision Engine
 *
 * Decides the optimal visual layout based on speaker activity
 * and detected reactions.
 */

import type { SpeakerTimeline } from '../core/types';

export interface SplitConfig {
  maxSpeakersInSplit: number;
  reactionWeight: number;
  minSpeakerDuration: number;
}

export const defaultSplitConfig: SplitConfig = {
  maxSpeakersInSplit: 2,
  reactionWeight: 0.35,
  minSpeakerDuration: 1.2
};

export interface SplitDecision {
  layout: 'full' | 'split-2' | 'split-3' | 'pip' | 'dynamic';
  activeSpeakers: string[];
  reason: string;
  confidence: number;
}

/**
 * Decide the best split/layout
 */
export function decideSplit(
  timeline: SpeakerTimeline[],
  reactions: any[] = [],
  config: Partial<SplitConfig> = {}
): SplitDecision {
  const cfg = { ...defaultSplitConfig, ...config };

  if (!timeline.length) {
    return {
      layout: 'full',
      activeSpeakers: [],
      reason: 'No activity detected',
      confidence: 0.3
    };
  }

  // TODO: Implement smart split logic
  return {
    layout: 'full',
    activeSpeakers: [],
    reason: 'Default',
    confidence: 0.4
  };
}