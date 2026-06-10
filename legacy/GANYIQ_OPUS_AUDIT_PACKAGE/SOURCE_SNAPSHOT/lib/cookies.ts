/**
 * lib/cookies.ts — YouTube Cookie Authentication
 *
 * Parses Netscape-format cookies.txt files exported from browser
 * cookie managers (e.g., "Get cookies.txt" Chrome extension).
 *
 * Used by lib/youtube.ts to authenticate InnerTube API calls
 * when the VPS IP is blocked by YouTube's bot detection.
 *
 * COOKIE_FILE env var:
 *   Path to a Netscape-format cookies.txt file containing YouTube session cookies.
 *   Default: (none — cookies disabled)
 *   Example: /var/www/ganyiq/cookies.txt
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface YoutubeCookies {
  /** Cookie header string, ready to attach to HTTP requests */
  header: string;
  /** Number of YouTube-relevant cookies found */
  count: number;
  /** Cookie names found (for debugging) */
  names: string[];
  /** Path to the cookie file */
  sourcePath: string | null;
  /** Whether cookies are considered valid (non-empty header) */
  valid: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Cookie names required for YouTube API access */
const REQUIRED_YOUTUBE_COOKIES = ['SAPISID', '__Secure-3PAPISID', '__Secure-3PSID', 'LOGIN_INFO'];

/** Cookie names from optional YouTube domains */
const YOUTUBE_DOMAINS = ['.youtube.com', 'youtube.com', '.google.com'];

// ---------------------------------------------------------------------------
// Default cookie file path
// ---------------------------------------------------------------------------

/**
 * Resolve the cookie file path from environment or default.
 * Priority:
 *   1. COOKIE_FILE env var (absolute or relative to project root)
 *   2. {projectRoot}/cookies.txt
 *   3. null (no cookies)
 */
function resolveCookiePath(): string | null {
  const fromEnv = process.env.COOKIE_FILE;
  if (fromEnv) {
    const resolved = path.resolve(fromEnv);
    if (fs.existsSync(resolved)) return resolved;
    // Try relative to CWD
    const alt = path.resolve(process.cwd(), fromEnv);
    if (fs.existsSync(alt)) return alt;
    return null;
  }

  // Default: check project root
  const defaultPath = path.resolve(process.cwd(), 'cookies.txt');
  if (fs.existsSync(defaultPath)) return defaultPath;

  return null;
}

// ---------------------------------------------------------------------------
// Cookie Parser
// ---------------------------------------------------------------------------

/**
 * Parse a Netscape-format cookies.txt file.
 *
 * Format (tab-separated):
 *   domain  domainFlag  path  secureFlag  expiration  name  value
 *
 * Lines starting with # are comments.
 * Empty lines are ignored.
 */
function parseNetscapeCookieFile(filePath: string): Map<string, string> {
  const cookies = new Map<string, string>();
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');

  for (let raw of lines) {
    raw = raw.trim();
    if (!raw || raw.startsWith('#')) continue;

    const parts = raw.split('\t');
    if (parts.length < 7) {
      // Try space-separated as fallback
      const spaceParts = raw.split(/\s+/);
      if (spaceParts.length >= 7) {
        const name = spaceParts[5];
        const value = spaceParts.slice(6).join(' ');
        if (name && value) cookies.set(name, value);
      }
      continue;
    }

    const domain = parts[0];
    const name = parts[5];
    const value = parts.slice(6).join(' ');

    // Only keep YouTube and Google cookies
    if (domain.includes('youtube.com') || domain.includes('.google.com') || domain.includes('google.com')) {
      cookies.set(name, value);
    }
  }

  return cookies;
}

// ---------------------------------------------------------------------------
// Cookie Header Builder
// ---------------------------------------------------------------------------

/**
 * Build a Cookie header string from parsed cookies.
 *
 * Filters to only include cookies relevant for YouTube authentication
 * (SAPISID, PSID, SSID, HSID, APISID, LOGIN_INFO, etc.)
 */
function buildCookieHeader(cookies: Map<string, string>): string {
  const parts: string[] = [];
  const included = new Set<string>();

  // First pass: required cookies (in priority order)
  const priorityOrder = [
    'SAPISID', '__Secure-3PAPISID', '__Secure-3PSID',
    '__Secure-3PSIDCC', 'LOGIN_INFO', 'VISITOR_INFO1_LIVE',
    'PREF', 'HSID', 'SSID', 'APISID', 'SID', 'SIDCC',
    '__Secure-1PSID', '__Secure-1PAPISID',
  ];

  for (const name of priorityOrder) {
    if (cookies.has(name) && !included.has(name)) {
      parts.push(`${encodeURIComponent(name)}=${encodeURIComponent(cookies.get(name)!)}`);
      included.add(name);
    }
  }

  // Second pass: any remaining YouTube cookies not already included
  for (const [name] of cookies) {
    if (!included.has(name)) {
      parts.push(`${encodeURIComponent(name)}=${encodeURIComponent(cookies.get(name)!)}`);
      included.add(name);
    }
  }

  return parts.join('; ');
}

// ---------------------------------------------------------------------------
// Cookie Check
// ---------------------------------------------------------------------------

/**
 * Check if the cookie header contains the key authentication cookies.
 */
function hasRequiredCookies(header: string): boolean {
  return REQUIRED_YOUTUBE_COOKIES.some(name =>
    header.includes(encodeURIComponent(name)),
  );
}

// ---------------------------------------------------------------------------
// Main Export
// ---------------------------------------------------------------------------

let cachedCookies: YoutubeCookies | null = null;
let lastCheckTime = 0;
const CACHE_TTL_MS = 60_000; // Re-check file every 60 seconds

/**
 * Load YouTube cookies from the configured cookies.txt file.
 *
 * Results are cached for CACHE_TTL_MS to avoid parsing the file on every request.
 * Call clearCookieCache() to force re-read (e.g., after cookie rotation).
 *
 * @returns YoutubeCookies object (always valid — check .valid to see if usable)
 */
export function loadYoutubeCookies(): YoutubeCookies {
  const now = Date.now();
  if (cachedCookies && now - lastCheckTime < CACHE_TTL_MS) {
    return cachedCookies;
  }

  const sourcePath = resolveCookiePath();

  if (!sourcePath) {
    cachedCookies = {
      header: '',
      count: 0,
      names: [],
      sourcePath: null,
      valid: false,
    };
    lastCheckTime = now;
    return cachedCookies;
  }

  try {
    const parsed = parseNetscapeCookieFile(sourcePath);
    const header = buildCookieHeader(parsed);
    const names = [...parsed.keys()];
    const valid = header.length > 10;

    cachedCookies = {
      header,
      count: parsed.size,
      names,
      sourcePath,
      valid,
    };

    if (valid) {
      const hasRequired = hasRequiredCookies(header);
      const missingCount = REQUIRED_YOUTUBE_COOKIES.filter(
        n => !parsed.has(n),
      ).length;

      if (!hasRequired || missingCount > 0) {
        // This is informational — some cookies may not be needed depending
        // on authentication mechanism used by YouTube
        if (DEBUG_COOKIE) {
          console.log(`[COOKIES] Loaded ${parsed.size} cookies from ${sourcePath}, missing ${missingCount} required`);
        }
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[COOKIES] Failed to load cookies from ${sourcePath}: ${msg}`);
    cachedCookies = {
      header: '',
      count: 0,
      names: [],
      sourcePath,
      valid: false,
    };
  }

  lastCheckTime = now;
  return cachedCookies;
}

/** Debug flag for cookie logging */
const DEBUG_COOKIE = process.env.DEBUG_COOKIE === 'true' || process.env.DEBUG_TRANSCRIPT === 'true';

/**
 * Clear the cached cookie data, forcing a re-read on the next call.
 * Call this after the user uploads a new cookies.txt file.
 */
export function clearCookieCache(): void {
  cachedCookies = null;
  lastCheckTime = 0;
}

/**
 * Get diagnostic info about current cookie state (for debugging).
 */
export function getCookieDiagnostics(): Record<string, unknown> {
  const c = loadYoutubeCookies();
  return {
    valid: c.valid,
    count: c.count,
    names: c.names,
    sourcePath: c.sourcePath,
    headerPreview: c.header ? c.header.slice(0, 80) + '...' : '(empty)',
    hasRequired: hasRequiredCookies(c.header),
    timestamp: new Date().toISOString(),
  };
}
