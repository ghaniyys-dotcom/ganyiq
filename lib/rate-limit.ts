/**
 * lib/rate-limit.ts — IP-based rate limiting for /api/analyze.
 *
 * Uses the existing analyses table to count requests from the same IP
 * within a rolling 24-hour window. Configurable via RATE_LIMIT_PER_DAY
 * environment variable (default: 10).
 *
 * DESIGN NOTES:
 * - Database-backed (not in-memory) so rate limits survive server restarts
 *   and work across multiple serverless function instances.
 * - Only counts completed + failed analyses. Pending status is reserved
 *   for future async processing and should not consume the rate limit.
 * - The rate limit window is a rolling 24-hour period, not calendar-day,
 *   so a burst at 11 PM doesn't reset at midnight.
 */

import { query } from '@/db/client';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default max analyses per IP per day when env var is not set. */
const DEFAULT_LIMIT = 10;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get the configured rate limit per IP per day.
 * Reads from RATE_LIMIT_PER_DAY env var. Falls back to DEFAULT_LIMIT.
 */
export function getRateLimitPerDay(): number {
  const envValue = process.env.RATE_LIMIT_PER_DAY;
  if (!envValue) return DEFAULT_LIMIT;
  const parsed = parseInt(envValue, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_LIMIT;
}

/**
 * Check if an IP address has exceeded the rate limit.
 *
 * Counts completed + failed analyses from this IP in the last 24 hours.
 * Does NOT count 'pending' analyses (reserved for future async pattern).
 *
 * @param ipAddress - Client IP address (from x-forwarded-for or x-real-ip)
 * @returns Object with:
 *   - exceeded: true if limit is reached
 *   - remaining: how many more analyses the IP is allowed
 *   - limit: the configured limit per day
 *   - resetAt: ISO timestamp when the oldest counted request falls out
 */
export async function checkRateLimit(ipAddress: string): Promise<{
  exceeded: boolean;
  remaining: number;
  limit: number;
  resetAt: string;
}> {
  const limit = getRateLimitPerDay();

  // Count non-pending analyses from this IP in the last 24 hours
  const result = await query<{ count: string; oldest: string | null }>(
    `SELECT
       COUNT(*) as count,
       MIN(created_at)::text as oldest
     FROM analyses
     WHERE ip_address = $1
       AND created_at > NOW() - INTERVAL '24 hours'
       AND status != 'pending'`,
    [ipAddress],
  );

  const row = result.rows[0];
  const count = parseInt(row?.count ?? '0', 10);
  const exceeded = count >= limit;
  const remaining = Math.max(0, limit - count);

  // Calculate when the rate limit resets (oldest + 24h, or now + 24h)
  let resetAt: string;
  if (row?.oldest) {
    const oldestDate = new Date(row.oldest);
    oldestDate.setHours(oldestDate.getHours() + 24);
    resetAt = oldestDate.toISOString();
  } else {
    const nextReset = new Date(Date.now() + 24 * 60 * 60 * 1000);
    resetAt = nextReset.toISOString();
  }

  return { exceeded, remaining, limit, resetAt };
}
