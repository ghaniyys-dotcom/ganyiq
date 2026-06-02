/**
 * Utility formatting functions for ganyIQ.
 *
 * Core logic reused from proof/src/index.ts (fmtTime function).
 * Extracted and expanded with edge-case handling.
 */

// ---------------------------------------------------------------------------
// Timestamp Formatting
// ---------------------------------------------------------------------------

/**
 * Convert a time value in seconds to a human-readable timestamp string.
 *
 * | Input (seconds) | Output    |
 * |-----------------|-----------|
 * |               0 |    "0:00" |
 * |              30 |    "0:30" |
 * |             125 |   "2:05"  |
 * |           3661 |   "1:01:01" |
 * |          734.5  |   "12:14" |
 *
 * @param seconds - Elapsed time in seconds (non-negative).
 * @returns Formatted timestamp string (e.g., "34:02" or "1:01:01").
 * @throws Error if seconds is negative.
 */
export function secondsToTimestamp(seconds: number): string {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) {
    throw new Error(
      `Invalid input: seconds must be a finite number, got ${typeof seconds}`,
    );
  }

  if (seconds < 0) {
    throw new Error(
      `Invalid input: seconds must be non-negative, got ${seconds}`,
    );
  }

  // Clamp to a reasonable maximum (99 hours = 356,400 seconds)
  // This prevents overflow issues with extremely large values
  const clamped = Math.min(Math.max(0, seconds), 356_400);
  const totalSeconds = Math.floor(clamped);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }

  return `${minutes}:${String(secs).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Duration Formatting
// ---------------------------------------------------------------------------

/**
 * Format a duration in seconds as a concise human-readable string.
 *
 * | Input (seconds) | Output    |
 * |-----------------|-----------|
 * |              30 |   "30s"   |
 * |             120 |   "2m"    |
 * |             150 |   "2m 30s"|
 * |            3661 |   "1h 1m" |
 *
 * @param seconds - Duration in seconds (non-negative).
 * @returns Concise duration string.
 */
export function formatDuration(seconds: number): string {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) {
    return '0s';
  }

  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;

  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (secs > 0 || parts.length === 0) parts.push(`${secs}s`);

  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// Number Formatting
// ---------------------------------------------------------------------------

/**
 * Format a number with thousand separators.
 *
 * @example
 *   formatNumber(1234567) // "1,234,567"
 *   formatNumber(42)      // "42"
 */
export function formatNumber(value: number): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '0';
  return Math.round(value).toLocaleString('en-US');
}

/**
 * Clamp a numeric score to the valid 0-100 range.
 * Returns an integer between 0 and 100.
 */
export function clampScore(value: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}
