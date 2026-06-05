/**
 * lib/user-identity.ts — Identity abstraction layer.
 *
 * Currently IP-based. Designed to be replaced with cookies, session, or JWT
 * without rewriting any route handler.
 *
 * Usage:
 *   const identity = getUserIdentity(request);
 *   // "ip:68.183.231.223"
 *
 * Future (cookie-based):
 *   const sid = request.cookies.get('sid')?.value;
 *   if (sid) return `session:${sid}`;
 *   return `ip:${extractClientIp(request)}`;
 *
 * Future (auth):
 *   const token = request.headers.get('authorization');
 *   const user = verifyToken(token);
 *   return `auth:${user.id}`;
 */

import type { NextRequest } from 'next/server';

export type UserIdentity = string;

/**
 * Extract a stable user identity from the incoming request.
 * Returns a namespaced string: "ip:X.X.X.X"
 */
export function getUserIdentity(request: NextRequest): UserIdentity {
  const ip = extractClientIp(request);
  return `ip:${ip}`;
}

/**
 * Extract client IP from request headers.
 * Handles proxy chains via x-forwarded-for.
 */
function extractClientIp(request: NextRequest): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }
  const realIp = request.headers.get('x-real-ip');
  if (realIp) return realIp.trim();
  return 'unknown';
}
