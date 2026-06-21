/**
 * Transcript Authentication Health Check
 *
 * Provides startup and runtime visibility into whether the system
 * can successfully authenticate with YouTube for transcript fetching.
 *
 * Status levels:
 *   healthy  — cookies.txt exists + SAPISID present + required cookies present
 *   warning  — cookies.txt exists but some non-critical cookies missing
 *   failed   — cookies.txt missing or SAPISID missing (transcript acquisition will fail)
 */

import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

export type TranscriptAuthStatus = 'healthy' | 'warning' | 'failed';

export interface TranscriptAuthHealth {
  status: TranscriptAuthStatus;
  cookiesFileExists: boolean;
  sapisidPresent: boolean;
  requiredCookiesPresent: boolean;
  missingCookies: string[];
  message: string;
}

/** Critical cookies required for SAPISIDHASH authentication */
const REQUIRED_AUTH_COOKIES = [
  'SAPISID',
  '__Secure-3PAPISID',
  'LOGIN_INFO',
] as const;

/**
 * Resolve the cookie file path (duplicated from cookies.ts to avoid circular import).
 */
function resolveCookiePath(): string | null {
  const fromEnv = process.env.COOKIE_FILE;
  if (fromEnv) {
    const resolved = path.resolve(fromEnv);
    if (existsSync(resolved)) return resolved;
    const alt = path.resolve(process.cwd(), fromEnv);
    if (existsSync(alt)) return alt;
    return null;
  }
  const defaultPath = path.resolve(process.cwd(), 'cookies.txt');
  if (existsSync(defaultPath)) return defaultPath;
  return null;
}

/**
 * Perform transcript authentication health check.
 * This is fast (no network calls) and safe to run on every health probe.
 */
export function getTranscriptAuthStatus(): TranscriptAuthHealth {
  const sourcePath = resolveCookiePath();
  const cookiesFileExists = !!sourcePath && existsSync(sourcePath);

  if (!cookiesFileExists) {
    return {
      status: 'failed',
      cookiesFileExists: false,
      sapisidPresent: false,
      requiredCookiesPresent: false,
      missingCookies: REQUIRED_AUTH_COOKIES as unknown as string[],
      message: 'cookies.txt not found — transcript acquisition will fail for all new videos',
    };
  }

  // Parse the file to check for SAPISID and other required cookies
  let content = '';
  try {
    content = readFileSync(sourcePath, 'utf-8');
  } catch {
    return {
      status: 'failed',
      cookiesFileExists: true,
      sapisidPresent: false,
      requiredCookiesPresent: false,
      missingCookies: REQUIRED_AUTH_COOKIES as unknown as string[],
      message: 'cookies.txt exists but cannot be read',
    };
  }

  const lines = content.split('\n');
  const foundCookies = new Set<string>();

  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const parts = trimmed.split('\t');
    if (parts.length < 7) continue;
    const name = parts[5];
    if (REQUIRED_AUTH_COOKIES.includes(name as any)) {
      foundCookies.add(name);
    }
  }

  const sapisidPresent = foundCookies.has('SAPISID');
  const missingCookies = REQUIRED_AUTH_COOKIES.filter(c => !foundCookies.has(c));

  let status: TranscriptAuthStatus = 'healthy';
  let message = 'Transcript authentication ready';

  if (!sapisidPresent) {
    status = 'failed';
    message = 'SAPISID cookie missing — SAPISIDHASH auth will fail (LOGIN_REQUIRED on all new videos)';
  } else if (missingCookies.length > 0) {
    status = 'warning';
    message = `Some required auth cookies missing: ${missingCookies.join(', ')}`;
  }

  return {
    status,
    cookiesFileExists: true,
    sapisidPresent,
    requiredCookiesPresent: missingCookies.length === 0,
    missingCookies,
    message,
  };
}
