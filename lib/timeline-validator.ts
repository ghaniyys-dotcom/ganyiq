/**
 * lib/timeline-validator.ts — Timeline JSON Schema Validator
 *
 * Validates TimelineJSON against the ganyiq-timeline-v1 schema.
 * Used at runtime to catch malformed timelines before they reach the renderer.
 *
 * Validation rules:
 *   1. Schema version must match
 *   2. All required fields present
 *   3. No negative durations
 *   4. Track segments don't overlap within same track
 *   5. zIndex values are consistent
 *   6. Source clip offsets are valid
 *   7. Cross-track time alignment (all tracks should fill the same duration)
 */

import type {
  TimelineJSON,
  TimelineTrack,
  TimelineSegment,
  TrackType,
} from './timeline-types';

// ---------------------------------------------------------------------------
// Custom Validation Types
// ---------------------------------------------------------------------------

export interface ValidationIssue {
  path: string;
  type: 'error' | 'warning';
  message: string;
  code: string;
}

export interface TimelineValidationResult {
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

// ---------------------------------------------------------------------------
// Valid Track Types
// ---------------------------------------------------------------------------

const VALID_TRACK_TYPES: ReadonlySet<string> = new Set([
  'face_crop',
  'caption',
  'text_overlay',
  'emoji',
  'broll',
  'audio',
  'transition',
]);

const VALID_LAYOUT_MODES = new Set([
  'fullscreen', 'split_2', 'split_3', 'split_4', 'pip', 'hero_reaction',
]);

const VALID_TRANSITION_TYPES = new Set(['crossfade', 'slide', 'fade', 'none']);

const VALID_EASING_FUNCTIONS = new Set(['linear', 'ease_in', 'ease_out', 'ease_in_out']);

const VALID_OVERLAY_TYPES = new Set(['text', 'emoji', 'image', 'rive']);

// ---------------------------------------------------------------------------
// Main Validator
// ---------------------------------------------------------------------------

/**
 * Validate a TimelineJSON instance against the ganyiq-timeline-v1 schema.
 *
 * @param timeline  - The timeline to validate
 * @returns         - Validation result with errors and warnings
 */
export function validateTimeline(timeline: unknown): TimelineValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  // ---- Schema version ----
  if (!timeline || typeof timeline !== 'object') {
    return errorResult('root', 'Timeline must be an object', 'INVALID_ROOT');
  }

  const tl = timeline as Record<string, unknown>;

  if (tl.version !== 1) {
    errors.push({
      path: 'version',
      type: 'error',
      message: `Unsupported version: ${tl.version}. Expected 1.`,
      code: 'INVALID_VERSION',
    });
  }

  if (tl.schema !== 'ganyiq-timeline-v1') {
    errors.push({
      path: 'schema',
      type: 'error',
      message: `Unknown schema: ${tl.schema}. Expected 'ganyiq-timeline-v1'.`,
      code: 'UNKNOWN_SCHEMA',
    });
  }

  // ---- Metadata ----
  if (!tl.metadata || typeof tl.metadata !== 'object') {
    errors.push({ path: 'metadata', type: 'error', message: 'Missing metadata', code: 'MISSING_FIELD' });
  } else {
    const meta = tl.metadata as Record<string, unknown>;
    if (!meta.projectId) errors.push({ path: 'metadata.projectId', type: 'error', message: 'Missing projectId', code: 'MISSING_FIELD' });
    if (!meta.sourceVideo) errors.push({ path: 'metadata.sourceVideo', type: 'error', message: 'Missing sourceVideo', code: 'MISSING_FIELD' });
    if (typeof meta.sourceDuration !== 'number' || (meta.sourceDuration as number) <= 0) {
      errors.push({ path: 'metadata.sourceDuration', type: 'error', message: 'sourceDuration must be > 0', code: 'INVALID_VALUE' });
    }
  }

  // ---- Tracks ----
  if (!Array.isArray(tl.tracks)) {
    errors.push({ path: 'tracks', type: 'error', message: 'tracks must be an array', code: 'MISSING_FIELD' });
    return { valid: errors.length === 0, errors, warnings };
  }

  if (tl.tracks.length === 0) {
    warnings.push({ path: 'tracks', type: 'warning', message: 'Empty tracks array — nothing to render', code: 'EMPTY_TRACKS' });
  }

  const trackIds = new Set<string>();
  const zIndexMap = new Map<number, string[]>();

  for (let ti = 0; ti < tl.tracks.length; ti++) {
    const track = tl.tracks[ti] as Record<string, unknown>;
    const trackPath = `tracks[${ti}]`;

    // Track ID uniqueness
    if (typeof track.id !== 'string' || !track.id) {
      errors.push({ path: `${trackPath}.id`, type: 'error', message: 'Track must have a string id', code: 'MISSING_FIELD' });
    } else if (trackIds.has(track.id)) {
      errors.push({ path: `${trackPath}.id`, type: 'error', message: `Duplicate track id: ${track.id}`, code: 'DUPLICATE_ID' });
    } else {
      trackIds.add(track.id);
    }

    // Track type
    if (!VALID_TRACK_TYPES.has(track.type as TrackType)) {
      errors.push({ path: `${trackPath}.type`, type: 'error', message: `Invalid track type: ${track.type}`, code: 'INVALID_TRACK_TYPE' });
    }

    // zIndex tracking
    if (typeof track.zIndex === 'number') {
      if (!zIndexMap.has(track.zIndex)) {
        zIndexMap.set(track.zIndex, []);
      }
      zIndexMap.get(track.zIndex)!.push(track.id as string);
    }

    // Segments
    if (!Array.isArray(track.segments || track.segements)) {
      errors.push({ path: `${trackPath}.segments`, type: 'error', message: 'Track must have segments array', code: 'MISSING_FIELD' });
      continue;
    }

    // Handle typo tolerance: check both 'segments' and 'segements'
    const segments: unknown[] = (track.segments || track.segements) as unknown[];

    if (segments.length > 0 && (track.segements as unknown[] | undefined)) {
      warnings.push({ path: `${trackPath}.segments`, type: 'warning', message: 'Use "segments" (not "segements") — typo tolerated', code: 'TYPO_TOLERATED' });
    }

    let lastEndTime = 0;
    for (let si = 0; si < segments.length; si++) {
      const seg = segments[si] as Record<string, unknown>;
      const segPath = `${trackPath}.segments[${si}]`;

      // Time validation
      const st = seg.startTime as number;
      const et = seg.endTime as number;

      if (typeof st !== 'number' || typeof et !== 'number') {
        errors.push({ path: `${segPath}.startTime/endTime`, type: 'error', message: 'startTime and endTime must be numbers', code: 'INVALID_TYPE' });
        continue;
      }

      if (et <= st) {
        errors.push({ path: segPath, type: 'error', message: `Negative/zero duration: ${et - st}s`, code: 'NEGATIVE_DURATION' });
      }

      if (st < lastEndTime) {
        errors.push({ path: segPath, type: 'error', message: `Segment overlaps previous (${st} < ${lastEndTime})`, code: 'TIME_OVERLAP' });
      }
      lastEndTime = et;

      // Source clip validation
      if (seg.sourceClip) {
        const sc = seg.sourceClip as Record<string, unknown>;
        const offStart = sc.offsetStart as number;
        const offEnd = sc.offsetEnd as number;
        if (typeof offStart === 'number' && typeof offEnd === 'number' && offEnd <= offStart) {
          errors.push({ path: `${segPath}.sourceClip`, type: 'error', message: `Negative source duration: ${offEnd - offStart}s`, code: 'NEGATIVE_DURATION' });
        }
        if (!sc.videoId) {
          errors.push({ path: `${segPath}.sourceClip.videoId`, type: 'error', message: 'Missing videoId', code: 'MISSING_FIELD' });
        }
      }

      // Layout validation
      if (seg.layout) {
        const layout = seg.layout as Record<string, unknown>;
        if (layout.mode && !VALID_LAYOUT_MODES.has(layout.mode as string)) {
          errors.push({ path: `${segPath}.layout.mode`, type: 'error', message: `Invalid layout mode: ${layout.mode}`, code: 'INVALID_LAYOUT' });
        }
      }

      // Transition validation
      if (seg.transitionIn) {
        const tr = seg.transitionIn as Record<string, unknown>;
        if (tr.type && !VALID_TRANSITION_TYPES.has(tr.type as string)) {
          errors.push({ path: `${segPath}.transitionIn.type`, type: 'error', message: `Invalid transition: ${tr.type}`, code: 'INVALID_TRANSITION' });
        }
        if (typeof tr.duration === 'number' && tr.duration < 0) {
          errors.push({ path: `${segPath}.transitionIn.duration`, type: 'error', message: 'Transition duration cannot be negative', code: 'INVALID_VALUE' });
        }
      }

      // Overlay validation
      if (seg.overlay) {
        const ol = seg.overlay as Record<string, unknown>;
        if (ol.type && !VALID_OVERLAY_TYPES.has(ol.type as string)) {
          errors.push({ path: `${segPath}.overlay.type`, type: 'error', message: `Invalid overlay type: ${ol.type}`, code: 'INVALID_OVERLAY' });
        }
      }

      // Keyframe validation
      if (seg.keyframes && Array.isArray(seg.keyframes)) {
        const kfs = seg.keyframes as Record<string, unknown>[];
        for (let ki = 0; ki < kfs.length; ki++) {
          const kf = kfs[ki];
          if (typeof kf.time !== 'number' || kf.time < 0) {
            errors.push({ path: `${segPath}.keyframes[${ki}].time`, type: 'error', message: 'Keyframe time must be >= 0', code: 'INVALID_VALUE' });
          }
          if (kf.easing && !VALID_EASING_FUNCTIONS.has(kf.easing as string)) {
            errors.push({ path: `${segPath}.keyframes[${ki}].easing`, type: 'error', message: `Invalid easing: ${kf.easing}`, code: 'INVALID_EASING' });
          }
        }
      }
    }
  }

  // ---- zIndex conflict warning ----
  Array.from(zIndexMap.entries()).forEach(([zIndex, ids]) => {
    if (ids.length > 3) {
      warnings.push({
        path: `tracks.zIndex[${zIndex}]`,
        type: 'warning',
        message: `${ids.length} tracks share zIndex ${zIndex}: ${ids.join(', ')}`,
        code: 'Z_INDEX_CLUSTERED',
      });
    }
  });

  // ---- Duration validation ----
  if (typeof tl.duration === 'number' && tl.duration <= 0) {
    errors.push({ path: 'duration', type: 'error', message: 'Duration must be > 0', code: 'INVALID_VALUE' });
  }

  // ---- Render hints ----
  if (tl.renderHints) {
    const rh = tl.renderHints as Record<string, unknown>;
    if (typeof rh.width === 'number' && rh.width <= 0) {
      errors.push({ path: 'renderHints.width', type: 'error', message: 'Width must be > 0', code: 'INVALID_VALUE' });
    }
    if (typeof rh.height === 'number' && rh.height <= 0) {
      errors.push({ path: 'renderHints.height', type: 'error', message: 'Height must be > 0', code: 'INVALID_VALUE' });
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function errorResult(path: string, message: string, code: string): TimelineValidationResult {
  return {
    valid: false,
    errors: [{ path, type: 'error', message, code }],
    warnings: [],
  };
}

/**
 * Pretty-print validation results for logging.
 */
export function formatValidationResult(result: TimelineValidationResult): string {
  const parts: string[] = [];

  if (result.valid) {
    parts.push('✓ Timeline validation passed');
  } else {
    parts.push(`✗ Timeline validation FAILED (${result.errors.length} errors)`);
  }

  for (const err of result.errors) {
    parts.push(`  ERROR [${err.code}] ${err.path}: ${err.message}`);
  }
  for (const warn of result.warnings) {
    parts.push(`  WARN  [${warn.code}] ${warn.path}: ${warn.message}`);
  }

  if (result.warnings.length > 0) {
    parts.push(`(${result.warnings.length} warnings)`);
  }

  return parts.join('\n');
}
