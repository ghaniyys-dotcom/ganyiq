/**
 * worker/clip-renderer.ts — Clip rendering module for GANYIQ Worker
 *
 * Handles video caching, ffmpeg cutting, and MP4 upload for clip jobs.
 * Called by worker/index.ts when jobType === 'clip'.
 *
 * Video caching: Full video files cached locally by videoId.
 *   cache/{videoId}.mp4 — the full video
 *   cache/manifest.json — tracking metadata (cachedAt, size)
 *   TTL: 7 days | Max cache: 50GB
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { execSync } from 'child_process';
import { platform } from 'os';

// ---------------------------------------------------------------------------
// Interfaces (mirrors the types in worker/index.ts)
// ---------------------------------------------------------------------------
interface EnvConfig {
  GANYIQ_API_URL: string;
  DEEPGRAM_API_KEY: string;
  WORKER_NAME: string;
  POLL_INTERVAL_MS: number;
  FFMPEG_LOCATION?: string;
  WORKER_ID?: string;
  WORKER_API_KEY?: string;
}

interface Job {
  id: string;
  youtubeId: string;
  youtubeUrl: string;
  createdAt: string;
  jobType?: string;
  clipParams?: {
    videoId: string;
    startTime: number;
    endTime: number;
  };
}

// ---------------------------------------------------------------------------
// Exec options & utilities (mirrors constants in worker/index.ts)
// ---------------------------------------------------------------------------
const SHELL = platform() === 'win32' ? (process.env.COMSPEC || 'cmd.exe') : '/bin/sh';
const EXEC_OPTS = {
  stdio: 'pipe' as const,
  timeout: 300_000,
  shell: SHELL,
  encoding: 'utf-8' as const,
};

const TEMP_DIR = join(resolve(__dirname || '.'), 'temp');

function log(tag: string, message: string): void {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] [${tag.padEnd(10)}] ${message}`);
}

// =========================================================================
// CLIP RENDERING
// =========================================================================

const CACHE_DIR = join(resolve(__dirname || '.'), 'cache');
const CACHE_MANIFEST = join(CACHE_DIR, 'manifest.json');
const CACHE_MAX_GB = 50;
const CACHE_TTL_DAYS = 7;

interface CacheEntry {
  cachedAt: string;       // ISO timestamp
  sizeBytes: number;
  path: string;
}

interface ClipParams {
  videoId: string;
  startTime: number;
  endTime: number;
}

function loadCacheManifest(): Record<string, CacheEntry> {
  if (!existsSync(CACHE_MANIFEST)) return {};
  try {
    return JSON.parse(readFileSync(CACHE_MANIFEST, 'utf-8'));
  } catch {
    return {};
  }
}

function saveCacheManifest(manifest: Record<string, CacheEntry>): void {
  if (!existsSync(CACHE_DIR)) execSync(`mkdir -p "${CACHE_DIR}"`, EXEC_OPTS);
  writeFileSync(CACHE_MANIFEST, JSON.stringify(manifest, null, 2), 'utf-8');
}

function getCachedVideoPath(videoId: string): string | null {
  const manifest = loadCacheManifest();
  const entry = manifest[videoId];
  if (!entry) return null;

  const cachedPath = join(CACHE_DIR, `${videoId}.mp4`);
  if (!existsSync(cachedPath)) {
    // File missing — remove from manifest
    delete manifest[videoId];
    saveCacheManifest(manifest);
    return null;
  }

  // Check TTL
  const cachedAt = new Date(entry.cachedAt).getTime();
  const ageDays = (Date.now() - cachedAt) / (1000 * 60 * 60 * 24);
  if (ageDays > CACHE_TTL_DAYS) {
    log('CACHE', `Cache expired for ${videoId} (${ageDays.toFixed(1)} days old)`);
    try { execSync(`del /f "${cachedPath}"`, EXEC_OPTS); } catch { /* windows */ }
    try { execSync(`rm -f "${cachedPath}"`, { ...EXEC_OPTS, shell: '/bin/sh' }); } catch { /* unix */ }
    delete manifest[videoId];
    saveCacheManifest(manifest);
    return null;
  }

  log('CACHE', `Cache HIT for ${videoId} (${ageDays.toFixed(1)} days old)`);
  return cachedPath;
}

function addToCache(videoId: string, filePath: string): void {
  const manifest = loadCacheManifest();
  const stats = execSync(
    platform() === 'win32' ? `dir /-c "${filePath}"` : `stat -c%s "${filePath}"`,
    { ...EXEC_OPTS, encoding: 'utf-8' }
  );
  const sizeMatch = stats.match(/\d+/);
  const sizeBytes = sizeMatch ? parseInt(sizeMatch[0], 10) : 0;

  manifest[videoId] = {
    cachedAt: new Date().toISOString(),
    sizeBytes,
    path: filePath,
  };

  saveCacheManifest(manifest);
  log('CACHE', `Cached ${videoId} (${(sizeBytes / 1024 / 1024).toFixed(1)} MB)`);

  // Enforce max cache size
  enforceCacheLimit();
}

function enforceCacheLimit(): void {
  const manifest = loadCacheManifest();
  let totalBytes = 0;
  const entries = Object.entries(manifest).map(([id, entry]) => {
    totalBytes += entry.sizeBytes;
    return { id, ...entry, cachedAt: new Date(entry.cachedAt).getTime() };
  });

  const maxBytes = CACHE_MAX_GB * 1024 * 1024 * 1024;
  if (totalBytes <= maxBytes) return;

  // Remove oldest entries until under limit
  entries.sort((a, b) => a.cachedAt - b.cachedAt);
  for (const entry of entries) {
    if (totalBytes <= maxBytes) break;
    const filePath = join(CACHE_DIR, `${entry.id}.mp4`);
    try { execSync(`del /f "${filePath}"`, EXEC_OPTS); } catch { try { execSync(`rm -f "${filePath}"`, { ...EXEC_OPTS, shell: '/bin/sh' }); } catch {} }
    delete manifest[entry.id];
    totalBytes -= entry.sizeBytes;
    log('CACHE', `Evicted ${entry.id} (cache limit)`);
  }
  saveCacheManifest(manifest);
}

export async function renderClip(
  job: Job & { jobType?: string; clipParams?: ClipParams },
  env: EnvConfig,
): Promise<void> {
  const params = job.clipParams;
  if (!params) throw new Error('clip_params missing from job');

  const { videoId, startTime, endTime } = params;
  const videoUrl = job.youtubeUrl;

  log('CLIP', `Rendering clip ${videoId} ${startTime}s-${endTime}s`);

  // Ensure cache directory
  if (!existsSync(CACHE_DIR)) execSync(`mkdir -p "${CACHE_DIR}"`, EXEC_OPTS);
  if (!existsSync(TEMP_DIR)) execSync(`mkdir -p "${TEMP_DIR}"`, EXEC_OPTS);

  // 1. Get video (cached or download)
  let videoPath = getCachedVideoPath(videoId);
  if (!videoPath) {
    videoPath = join(CACHE_DIR, `${videoId}.mp4`);
    log('YTDLP', `Downloading video: ${videoUrl}`);
    const ffmpegFlag = env.FFMPEG_LOCATION ? `--ffmpeg-location "${env.FFMPEG_LOCATION}"` : '';
    execSync(
      `yt-dlp --remote-components ejs:github --extractor-args "youtube:player_client=android" ${ffmpegFlag} -f "best[height<=720]" -o "${videoPath}" "${videoUrl}" --no-playlist --quiet`,
      EXEC_OPTS,
    );
    addToCache(videoId, videoPath);
  }

  // 2. ffmpeg cut
  const outputFilename = `${videoId}_${Math.round(startTime)}s_${Math.round(endTime)}s.mp4`;
  const outputPath = join(TEMP_DIR, outputFilename);
  log('FFMPEG', `Cutting ${startTime}s-${endTime}s → ${outputFilename}`);

  const durationSec = endTime - startTime;
  const ffmpegPath = env.FFMPEG_LOCATION
    ? `"${env.FFMPEG_LOCATION}/ffmpeg"`
    : 'ffmpeg';

  execSync(
    `${ffmpegPath} -y -ss ${startTime} -to ${endTime} -i "${videoPath}" -c copy -movflags +faststart "${outputPath}"`,
    { ...EXEC_OPTS, timeout: 120_000 },
  );

  // Verify output
  if (!existsSync(outputPath)) {
    throw new Error('ffmpeg cut produced no output file');
  }
  const outputStats = execSync(
    platform() === 'win32' ? `dir /-c "${outputPath}"` : `stat -c%s "${outputPath}"`,
    { ...EXEC_OPTS, encoding: 'utf-8' }
  );
  const sizeMatch = outputStats.match(/\d+/);
  const fileSizeBytes = sizeMatch ? parseInt(sizeMatch[0], 10) : 0;
  log('FFMPEG', `Output: ${outputFilename} (${(fileSizeBytes / 1024 / 1024).toFixed(1)} MB, ${durationSec}s)`);

  // 3. Upload to VPS
  log('UPLOAD', `Uploading ${outputFilename}...`);
  const uploadUrl = `${env.GANYIQ_API_URL}/api/workers/jobs/${job.id}/upload`;

  // Build multipart form
  const boundary = `----FormBoundary${Date.now()}`;
  const fileBuffer = readFileSync(outputPath);
  const encoder = new TextEncoder();
  const crlf = '\r\n';

  let body = '';
  body += `--${boundary}${crlf}`;
  body += `Content-Disposition: form-data; name="worker_id"${crlf}${crlf}${env.WORKER_ID}${crlf}`;
  body += `--${boundary}${crlf}`;
  body += `Content-Disposition: form-data; name="start_time"${crlf}${crlf}${startTime}${crlf}`;
  body += `--${boundary}${crlf}`;
  body += `Content-Disposition: form-data; name="end_time"${crlf}${crlf}${endTime}${crlf}`;
  body += `--${boundary}${crlf}`;
  body += `Content-Disposition: form-data; name="duration_seconds"${crlf}${crlf}${durationSec}${crlf}`;
  body += `--${boundary}${crlf}`;
  body += `Content-Disposition: form-data; name="file"; filename="${outputFilename}"${crlf}`;
  body += `Content-Type: video/mp4${crlf}${crlf}`;

  const bodyPrefix = encoder.encode(body);
  const bodySuffix = encoder.encode(`${crlf}--${boundary}--${crlf}`);
  const totalLength = bodyPrefix.length + fileBuffer.length + bodySuffix.length;

  const uploadResponse = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.WORKER_API_KEY}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': String(totalLength),
    },
    body: (() => {
      const { Readable } = require('stream');
      const { ReadableStream } = require('stream/web');
      const chunks = [bodyPrefix, fileBuffer, bodySuffix];
      return new Blob(chunks);
    })(),
  });

  if (!uploadResponse.ok) {
    const errBody = await uploadResponse.text();
    throw new Error(`Upload failed (${uploadResponse.status}): ${errBody.slice(0, 200)}`);
  }

  const uploadData = await uploadResponse.json();
  log('CLIP', `✅ Clip ready: ${uploadData.url}`);

  // Cleanup temp clip file
  try { execSync(`del /f "${outputPath}"`, EXEC_OPTS); } catch { try { execSync(`rm -f "${outputPath}"`, { ...EXEC_OPTS, shell: '/bin/sh' }); } catch {} }
}
