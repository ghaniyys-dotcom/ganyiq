/**
 * URL validation and video ID extraction for YouTube.
 *
 * Based on proof/src/index.ts — proven working with InnerTube API.
 *
 * Functions:
 *   validateYouTubeUrl(url)  → boolean  (no throw)
 *   extractVideoId(url)      → string   (throws AppError on failure)
 *   isValidUuid(id)          → boolean
 *   isValidEventType(type)   → boolean  (allow-list check)
 */

import { AppError } from '@/lib/errors';

// ---------------------------------------------------------------------------
// YouTube URL Validation
// ---------------------------------------------------------------------------

/**
 * YouTube URL patterns supported:
 *   - https://www.youtube.com/watch?v=VIDEO_ID
 *   - https://youtu.be/VIDEO_ID
 *   - https://www.youtube.com/embed/VIDEO_ID
 *   - https://youtube.com/watch?v=VIDEO_ID
 *   - https://m.youtube.com/watch?v=VIDEO_ID
 *   - Plain 11-char video ID
 */
const YOUTUBE_URL_PATTERNS = [
  /(?:youtube\.com\/watch\?v=)([^"&?/\s]{11})/i,
  /(?:youtu\.be\/)([^"&?/\s]{11})/i,
  /(?:youtube\.com\/embed\/)([^"&?/\s]{11})/i,
] as const;

const PLAIN_ID_REGEX = /^[A-Za-z0-9_-]{11}$/;

/**
 * Check whether a string is a valid YouTube URL or video ID.
 * Pure boolean — no side effects, no throws.
 */
export function validateYouTubeUrl(input: string): boolean {
  if (!input || typeof input !== 'string') return false;
  const trimmed = input.trim();
  if (!trimmed) return false;

  // Plain 11-char video ID
  if (PLAIN_ID_REGEX.test(trimmed)) return true;

  // Full URL with patterns
  for (const pattern of YOUTUBE_URL_PATTERNS) {
    if (pattern.test(trimmed)) return true;
  }

  return false;
}

/**
 * Extract a YouTube video ID from a URL or plain ID string.
 *
 * @throws AppError with code 'INVALID_URL' if extraction fails
 */
export function extractVideoId(input: string): string {
  if (!input || typeof input !== 'string') {
    throw new AppError(
      'INVALID_URL',
      'Input must be a non-empty string.',
      400,
    );
  }

  const trimmed = input.trim();

  // Plain 11-char video ID (fast path)
  if (PLAIN_ID_REGEX.test(trimmed)) {
    return trimmed;
  }

  // Full URL patterns
  for (const pattern of YOUTUBE_URL_PATTERNS) {
    const match = trimmed.match(pattern);
    if (match) return match[1];
  }

  throw new AppError(
    'INVALID_URL',
    `Cannot extract video ID from: "${input.slice(0, 120)}"`,
    400,
  );
}

// ---------------------------------------------------------------------------
// UUID Validation
// ---------------------------------------------------------------------------

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validate that a string is a UUID (v4 format).
 */
export function isValidUuid(id: string): boolean {
  if (!id || typeof id !== 'string') return false;
  return UUID_REGEX.test(id.trim());
}

// ---------------------------------------------------------------------------
// Event Type Validation
// ---------------------------------------------------------------------------

/**
 * Allowed event types for frontend tracking (POST /api/track).
 * Add new types here as tracking needs grow.
 */
const ALLOWED_EVENT_TYPES: ReadonlySet<string> = new Set([
  'timestamp_click',
  'copy_timestamp',
  'page_view',
  'analysis_started',
  'analysis_completed',
]);

/**
 * Check that an event type string is in the allow-list.
 */
export function isValidEventType(eventType: string): boolean {
  if (!eventType || typeof eventType !== 'string') return false;
  return ALLOWED_EVENT_TYPES.has(eventType);
}
