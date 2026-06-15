/**
 * lib/timeline-serializer.ts — DecisionSegment → TimelineJSON
 *
 * Converts the Decision Engine's output (DecisionSegment[]) into
 * the renderer-agnostic TimelineJSON format.
 *
 * This is the bridge between:
 *   Decision Engine (decision-engine.ts)
 *   and
 *   Timeline JSON (the permanent contract)
 *
 * Every renderer (FFmpeg, Hybrid, WASM) consumes TimelineJSON.
 * No renderer should ever import DecisionSegment directly.
 */

import type {
  TimelineJSON,
  TimelineTrack,
  TimelineSegment,
  CropInstruction,
  LayoutInstruction,
  TransitionEffect,
  Keyframe,
  RenderHints,
} from './timeline-types';

// Import types from decision-engine (only types, no runtime dependency)
// Using type-only import to avoid bundling the full module
import type { DecisionSegment, DecisionMode } from '../worker/decision-engine';

// ---------------------------------------------------------------------------
// Default render hints
// ---------------------------------------------------------------------------

const DEFAULT_RENDER_HINTS: RenderHints = {
  width: 1080,
  height: 1920,
  fps: 30,
  audioSampleRate: 44100,
  codec: 'h264',
  container: 'mp4',
};

// ---------------------------------------------------------------------------
// Serializer
// ---------------------------------------------------------------------------

export interface SerializeOptions {
  /** Generator identifier. */
  generator?: 'RAW' | 'HOOK' | 'TREND' | 'STORY' | 'MANUAL';
  /** Render hints override. */
  renderHints?: Partial<RenderHints>;
  /** Source video identifier. */
  sourceVideo: string;
  /** Source video duration in seconds. */
  sourceDuration: number;
}

/**
 * Convert DecisionSegment[] (from Decision Engine) to TimelineJSON.
 *
 * Each segment becomes:
 *   1. A face_crop track (with camera crop + layout)
 *   2. An audio track
 *
 * All tracks are composited by zIndex for the final render.
 *
 * @param segments  - Decision Engine output segments
 * @param options   - Serialization options (source, generator, hints)
 * @returns         - Renderer-agnostic Timeline JSON
 */
export function segmentsToTimeline(
  projectId: string,
  segments: DecisionSegment[],
  options: SerializeOptions,
): TimelineJSON {
  if (segments.length === 0) {
    throw new Error('Cannot serialize empty segment array');
  }

  const tracks: TimelineTrack[] = [];
  let outputCursor = 0; // tracks current output time position

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const segDuration = seg.endTime - seg.startTime;

    if (segDuration <= 0) {
      console.warn(`[TIMELINE] Skipping segment ${i}: zero/negative duration (${segDuration}s)`);
      continue;
    }

    // ---- Track 1: Face Crop / Video ----
    const videoTrack = buildVideoTrack(seg, i, outputCursor, segDuration);
    tracks.push(videoTrack);

    // ---- Track 2: Audio ----
    const audioTrack = buildAudioTrack(seg, i, outputCursor, segDuration);
    tracks.push(audioTrack);

    outputCursor += segDuration;
  }

  const timeline: TimelineJSON = {
    version: 1,
    schema: 'ganyiq-timeline-v1',
    metadata: {
      projectId,
      sourceVideo: options.sourceVideo,
      sourceDuration: options.sourceDuration,
      createdAt: new Date().toISOString(),
      generator: options.generator || 'RAW',
    },
    duration: outputCursor,
    tracks,
    renderHints: {
      ...DEFAULT_RENDER_HINTS,
      ...options.renderHints,
    },
  };

  return timeline;
}

// ---------------------------------------------------------------------------
// Track Builders
// ---------------------------------------------------------------------------

function buildVideoTrack(
  seg: DecisionSegment,
  index: number,
  outputStart: number,
  duration: number,
): TimelineTrack {
  const segment: TimelineSegment = {
    id: `seg_${index}`,
    startTime: outputStart,
    endTime: outputStart + duration,
    sourceClip: {
      videoId: seg.crops[0] ? `crop_${seg.crops[0].faceId}` : 'source',
      offsetStart: seg.startTime,
      offsetEnd: seg.endTime,
    },
    crop: buildCropInstruction(seg),
    layout: buildLayoutInstruction(seg),
    transitionIn: buildTransitionEffect(seg),
    keyframes: buildZoomKeyframes(duration),
  };

  return {
    id: `track_face_${index}`,
    type: 'face_crop',
    zIndex: 1,
    enabled: true,
    segments: [segment],
  };
}

function buildAudioTrack(
  seg: DecisionSegment,
  index: number,
  outputStart: number,
  duration: number,
): TimelineTrack {
  return {
    id: `track_audio_${index}`,
    type: 'audio',
    zIndex: 0,
    enabled: true,
    segments: [{
      id: `aud_${index}`,
      startTime: outputStart,
      endTime: outputStart + duration,
      sourceClip: {
        videoId: 'source',
        offsetStart: seg.startTime,
        offsetEnd: seg.endTime,
      },
    }],
  };
}

// ---------------------------------------------------------------------------
// Helper Functions
// ---------------------------------------------------------------------------

/**
 * Build crop instruction from DecisionSegment's first face crop.
 * Uses EMA-smoothed crop coordinates when available.
 */
function buildCropInstruction(seg: DecisionSegment): CropInstruction | undefined {
  if (!seg.crops || seg.crops.length === 0) return undefined;

  const primaryCrop = seg.crops[0];
  // Default crop width/height approximates a 9:16 portrait frame from 16:9 source
  const fullHeight = 1920; // output height source-equivalent
  const cropWidth = Math.round(fullHeight * (1080 / 1920)); // ~1080

  return {
    x: primaryCrop.cropX ?? 0,
    y: primaryCrop.cropY ?? 0,
    width: cropWidth,
    height: fullHeight,
    zoomStart: 1.0,
    zoomEnd: 1.04, // 4% Ken Burns zoom
  };
}

/**
 * Build layout instruction from DecisionSegment's mode.
 */
function buildLayoutInstruction(seg: DecisionSegment): LayoutInstruction | undefined {
  // Map DecisionMode to LayoutInstruction mode
  const modeMap: Record<string, LayoutInstruction['mode']> = {
    single: 'fullscreen',
    split_2: 'split_2',
    split_3: 'split_3',
    split_4: 'split_4',
    listener_pip: 'pip',
    hero_reaction: 'hero_reaction',
    reaction_cut: 'fullscreen',
    wide_context: 'fullscreen',
  };

  const mode = modeMap[seg.mode] || 'fullscreen';

  // Build panel instructions for multi-face layouts
  const panels = seg.crops.length > 1
    ? seg.crops.map((crop, i) => ({
        faceIndex: i,
        x: 0,
        y: 0,
        width: 1080,
        height: 1920 / seg.crops.length,
      }))
    : undefined;

  return { mode, panels };
}

/**
 * Build transition effect from DecisionSegment's transitionOut.
 */
function buildTransitionEffect(seg: DecisionSegment): TransitionEffect | undefined {
  if (!seg.transitionOut) return undefined;

  return {
    type: seg.transitionOut.type === 'crossfade' ? 'crossfade' : 'none',
    duration: seg.transitionOut.duration,
  };
}

/**
 * Build Ken Burns zoom keyframes.
 * Creates a linear zoom from zoomStart to zoomEnd over the segment duration.
 */
function buildZoomKeyframes(duration: number): Keyframe[] {
  return [
    {
      time: 0,
      properties: { zoom: 1.0 },
      easing: 'linear',
    },
    {
      time: duration,
      properties: { zoom: 1.04 },
      easing: 'linear',
    },
  ];
}

// ---------------------------------------------------------------------------
// Convenience: Get all source time ranges from a timeline
// ---------------------------------------------------------------------------

export interface SourceTimeRange {
  offsetStart: number;
  offsetEnd: number;
}

/**
 * Extract all source time ranges from a timeline (for media pre-loading / CDN).
 */
export function getSourceTimeRanges(timeline: TimelineJSON): SourceTimeRange[] {
  const ranges: SourceTimeRange[] = [];

  for (const track of timeline.tracks) {
    for (const seg of track.segments) {
      if (seg.sourceClip) {
        ranges.push({
          offsetStart: seg.sourceClip.offsetStart,
          offsetEnd: seg.sourceClip.offsetEnd,
        });
      }
    }
  }

  // Deduplicate overlapping ranges
  return mergeOverlappingRanges(ranges);
}

function mergeOverlappingRanges(ranges: SourceTimeRange[]): SourceTimeRange[] {
  if (ranges.length === 0) return [];

  const sorted = [...ranges].sort((a, b) => a.offsetStart - b.offsetStart);
  const merged: SourceTimeRange[] = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1];
    const curr = sorted[i];

    if (curr.offsetStart <= last.offsetEnd) {
      // Overlapping — extend
      last.offsetEnd = Math.max(last.offsetEnd, curr.offsetEnd);
    } else {
      merged.push(curr);
    }
  }

  return merged;
}
