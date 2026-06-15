/**
 * lib/timeline-types.ts — GANYIQ V2 Timeline JSON Schema
 *
 * This is the PERMANENT contract between Decision Layer and Render Layer.
 * Every subsystem (Judge Engine, Multi Generator, Stitching, Ranking, Renderer)
 * must emit or consume this format.
 *
 * Architecture:
 *   Decision Engine → Timeline JSON → Renderer (FFmpeg / Hybrid / WASM)
 *
 * Version: 1
 * Schema: ganyiq-timeline-v1
 *
 * Track types (inspired by Opus editingScript.tracks):
 *   face_crop      — Cropped face region from source video
 *   caption        — Word-level subtitle track
 *   text_overlay   — Hook text, title overlays
 *   emoji          — Emoji overlay track
 *   broll          — B-roll footage overlay
 *   audio          — Audio track (source or voiceover)
 *   transition     — Transition effects between segments
 */

// ---------------------------------------------------------------------------
// Timeline Root
// ---------------------------------------------------------------------------

export interface TimelineJSON {
  /** Schema version. Must be 1 for ganyiq-timeline-v1. */
  version: 1;
  /** Schema identifier for backward compatibility. */
  schema: 'ganyiq-timeline-v1';
  /** Project and source metadata. */
  metadata: TimelineMetadata;
  /** Total duration in seconds. */
  duration: number;
  /** Ordered array of parallel tracks. Composited by zIndex. */
  tracks: TimelineTrack[];
  /** Renderer hints (resolution, fps, etc.) */
  renderHints?: RenderHints;
}

export interface TimelineMetadata {
  /** Unique project/analysis ID. */
  projectId: string;
  /** Source video identifier (YouTube ID or local path). */
  sourceVideo: string;
  /** Source video duration in seconds. */
  sourceDuration: number;
  /** ISO timestamp of timeline creation. */
  createdAt: string;
  /** Generator that produced this clip. */
  generator?: 'RAW' | 'HOOK' | 'TREND' | 'STORY' | 'MANUAL';
  /** Judge result for this clip (populated by Judge Engine V2). */
  judgeResult?: JudgeResult;
}

// ---------------------------------------------------------------------------
// Track
// ---------------------------------------------------------------------------

export type TrackType =
  | 'face_crop'
  | 'caption'
  | 'text_overlay'
  | 'emoji'
  | 'broll'
  | 'audio'
  | 'transition';

export interface TimelineTrack {
  /** Unique track identifier within this timeline. */
  id: string;
  /** Track type determines how this track is rendered. */
  type: TrackType;
  /** Compositing order. Higher = on top. */
  zIndex: number;
  /** Whether this track is active in the composition. */
  enabled: boolean;
  /** Ordered segments within this track. */
  segments: TimelineSegment[];
}

// ---------------------------------------------------------------------------
// Segment
// ---------------------------------------------------------------------------

export interface TimelineSegment {
  /** Unique segment identifier. */
  id: string;
  /** Start time within the OUTPUT timeline (not source). */
  startTime: number;
  /** End time within the OUTPUT timeline. */
  endTime: number;
  /** Source clip for video/audio tracks. */
  sourceClip?: SourceClip;
  /** Camera crop instruction. */
  crop?: CropInstruction;
  /** Layout instruction for multi-face composition. */
  layout?: LayoutInstruction;
  /** Word-level subtitle content (for caption tracks). */
  text?: WordLevelSubtitle[];
  /** Overlay content (for text_overlay / emoji tracks). */
  overlay?: OverlayContent;
  /** Transition effect at the START of this segment. */
  transitionIn?: TransitionEffect;
  /** Keyframe animations within this segment. */
  keyframes?: Keyframe[];
}

export interface SourceClip {
  /** Source video identifier (references TimelineMetadata.sourceVideo). */
  videoId: string;
  /** Start offset within the source video in seconds. */
  offsetStart: number;
  /** End offset within the source video in seconds. */
  offsetEnd: number;
}

// ---------------------------------------------------------------------------
// Camera & Layout
// ---------------------------------------------------------------------------

export interface CropInstruction {
  /** X position of crop center in source pixels. */
  x: number;
  /** Y position of crop center in source pixels. */
  y: number;
  /** Crop width in source pixels. */
  width: number;
  /** Crop height in source pixels. */
  height: number;
  /** Ken Burns effect: zoom at segment start (1.0 = no zoom). */
  zoomStart?: number;
  /** Ken Burns effect: zoom at segment end (1.04 = 4% growth). */
  zoomEnd?: number;
}

export interface LayoutInstruction {
  /** Composition mode. */
  mode: 'fullscreen' | 'split_2' | 'split_3' | 'split_4' | 'pip' | 'hero_reaction';
  /** Panel instructions for multi-face layouts. */
  panels?: PanelInstruction[];
}

export interface PanelInstruction {
  /** Face index reference. */
  faceIndex: number;
  /** Panel X position in output coordinates. */
  x: number;
  /** Panel Y position in output coordinates. */
  y: number;
  /** Panel width in output coordinates. */
  width: number;
  /** Panel height in output coordinates. */
  height: number;
}

// ---------------------------------------------------------------------------
// Subtitles
// ---------------------------------------------------------------------------

export interface WordLevelSubtitle {
  /** Full text of this subtitle segment. */
  text: string;
  /** Start time within the OUTPUT timeline. */
  startTime: number;
  /** End time within the OUTPUT timeline. */
  endTime: number;
  /** Word-level timing for karaoke-style highlighting. */
  words: WordTimestamp[];
  /** Speaker label (from diarization). */
  speaker?: string;
  /** Emphasis style for this segment. */
  emphasis?: 'normal' | 'bold' | 'highlight' | 'filler';
}

export interface WordTimestamp {
  /** The word text. */
  word: string;
  /** Start time within the OUTPUT timeline in seconds. */
  start: number;
  /** End time within the OUTPUT timeline in seconds. */
  end: number;
}

// ---------------------------------------------------------------------------
// Overlays
// ---------------------------------------------------------------------------

export interface OverlayContent {
  /** Overlay type. */
  type: 'text' | 'emoji' | 'image' | 'rive';
  /** Text content (for text overlays like hooks). */
  text?: string;
  /** Emoji character (for emoji overlays). */
  emoji?: string;
  /** Image URL (for image/broll overlays). */
  imageUrl?: string;
  /** Rive animation URL. */
  riveUrl?: string;
  /** Position in output coordinates (0-1 normalized or pixel). */
  position: { x: number; y: number };
  /** Size in output coordinates. */
  size?: { width: number; height: number };
  /** Entry animation. */
  animation?: 'fade_in' | 'slide_in' | 'scale_in' | 'none';
  /** Color (hex) for text overlays. */
  color?: string;
  /** Font size for text overlays. */
  fontSize?: number;
}

// ---------------------------------------------------------------------------
// Transitions & Keyframes
// ---------------------------------------------------------------------------

export interface TransitionEffect {
  /** Transition type. */
  type: 'crossfade' | 'slide' | 'fade' | 'none';
  /** Transition duration in seconds. */
  duration: number;
}

export interface Keyframe {
  /** Time within the segment in seconds (0 = segment start). */
  time: number;
  /** Keyframe property values. */
  properties: KeyframeProperties;
  /** Easing function. */
  easing?: 'linear' | 'ease_in' | 'ease_out' | 'ease_in_out';
}

export interface KeyframeProperties {
  /** Crop X position. */
  cropX?: number;
  /** Crop Y position. */
  cropY?: number;
  /** Zoom level. */
  zoom?: number;
  /** Opacity (0-1). */
  opacity?: number;
  /** X position in output. */
  positionX?: number;
  /** Y position in output. */
  positionY?: number;
  /** Horizontal scale. */
  scaleX?: number;
  /** Vertical scale. */
  scaleY?: number;
}

// ---------------------------------------------------------------------------
// Render Hints
// ---------------------------------------------------------------------------

export interface RenderHints {
  /** Output resolution width in pixels. */
  width: number;
  /** Output resolution height in pixels. */
  height: number;
  /** Output framerate. */
  fps: number;
  /** Audio sample rate. */
  audioSampleRate: number;
  /** Output codec. */
  codec?: 'h264' | 'h265' | 'vp9';
  /** Output container. */
  container?: 'mp4' | 'webm';
}

// ---------------------------------------------------------------------------
// Judge Result (Phase 1)
// ---------------------------------------------------------------------------

export interface JudgeResult {
  /** Hook strength score (0-10). Internal float precision. */
  hookScore: number;
  /** Coherence score (0-10). */
  coherenceScore: number;
  /** Connection/relatability score (0-10). */
  connectionScore: number;
  /** Trend/timeliness score (0-10). */
  trendScore: number;
  /** Sponsorship detection score (0-10). Always 0 on free tier. */
  sponsorshipScore: number;
  /** Raw sum of all component scores. */
  rawScore: number;
  /** User-facing curved score (0-100). */
  curvedScore: number;
  /** LLM model used for judging. */
  judgeModel: string;
  /** Judge engine version. */
  judgeVersion: string;
  /** ISO timestamp of judging. */
  judgeTimestamp: string;
  /** Hook dimension reasoning. */
  hookComment?: string;
  /** Coherence dimension reasoning. */
  coherenceComment?: string;
  /** Connection dimension reasoning. */
  connectionComment?: string;
  /** Trend dimension reasoning. */
  trendComment?: string;
}
