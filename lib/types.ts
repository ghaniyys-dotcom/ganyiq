// Core types used across all ganyIQ modules.
// This file is the single source of truth for all shared TypeScript types.

export interface VideoMetadata {
  youtubeId: string;
  title: string;
  channelName: string;
  durationSeconds: number;
}

export interface TranscriptSegment {
  start: number;      // seconds
  duration: number;    // seconds
  text: string;
  speaker?: string;    // optional speaker label (from Deepgram diarization)
}

export interface VideoData {
  metadata: VideoMetadata;
  transcript: TranscriptSegment[];
}

export type DnaTag =
  | 'hookPower' | 'curiosity' | 'controversy' | 'emotion'
  | 'humor' | 'storytelling' | 'authority' | 'money'
  | 'shock' | 'educational' | 'motivation' | 'relatability'
  | 'vulnerability' | 'inspiration';

export type ConfidenceLevel = 'high' | 'medium' | 'low';
export type MomentTier = 'elite' | 'secondary';

export interface RawMoment {
  startTime: number;
  endTime: number;
  worthClippingScore: number;
  confidence: ConfidenceLevel;
  dnaTags: DnaTag[];
  reasoning: string;
  /** V2 Judge Engine result (optional, set by judge-integration.ts) */
  judgeResult?: import('./judge-types').JudgeResult;
}

export interface RankedMoment extends RawMoment {
  rank: number;
  tier: MomentTier;
  startTimestamp: string;  // "34:02"
  endTimestamp: string;    // "34:58"
  transcriptExcerpt: string;
}

export interface AnalysisResult {
  analysisId: string;
  video: VideoMetadata & { durationMinutes: number };
  totalMomentsFound: number;
  processingTimeMs: number;
  eliteMoments: RankedMoment[];
  secondaryMoments: RankedMoment[];
}

export interface AnalysisError {
  error: string;     // Error code
  message: string;   // Human-readable message
}

// V2 Timeline Architecture — re-exported for convenience
export type { TimelineJSON, TrackType, TimelineTrack, TimelineSegment } from './timeline-types';
// V2 Judge Engine types
export type { JudgeResult } from './judge-types';
