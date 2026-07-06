/**
 * worker/python-clip-renderer.ts — Python Pipeline Clip Renderer
 *
 * Bridges index.ts with the Python speaker-hybrid pipeline.
 * Downloads video → cuts segment → calls Python pipeline → uploads result.
 *
 * Usage (from index.ts):
 *   import { renderClipV2 } from './python-clip-renderer';
 *   await renderClipV2(job, env, () => sendHeartbeat(env));
 */

import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';
import { execSync } from 'child_process';
import { platform } from 'os';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WORKER_DIR = resolve(__dirname || '.');
const SHELL: string = platform() === 'win32'
  ? (process.env.COMSPEC || 'cmd.exe')
  : '/bin/sh';

const EXEC_OPTS = {
  stdio: 'pipe' as const,
  timeout: 300_000,
  shell: SHELL,
  encoding: 'utf-8' as const,
};

const CACHE_DIR = join(WORKER_DIR, 'cache');
const CACHE_MANIFEST = join(CACHE_DIR, 'manifest.json');
const TEMP_DIR = join(WORKER_DIR, 'temp');
const CACHE_MAX_GB = 50;
const CACHE_TTL_DAYS = 7;

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

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
    renderMode?: string;
  };
}

interface EnvConfig {
  GANYIQ_API_URL: string;
  DEEPGRAM_API_KEY: string;
  WORKER_NAME: string;
  POLL_INTERVAL_MS: number;
  FFMPEG_LOCATION?: string;
  WORKER_ID?: string;
  WORKER_API_KEY?: string;
  HF_TOKEN?: string;
}

interface CacheEntry {
  cachedAt: string;
  sizeBytes: number;
  path: string;
}

export type HeartbeatFn = () => Promise<void>;

// ---------------------------------------------------------------------------
// FFmpeg Path Resolution
// ---------------------------------------------------------------------------

function resolveFfmpegBin(location: string | undefined, binary: string): string {
  if (!location) return binary;
  const norm = location.replace(/[/\\]+$/, '');
  const exeSuffix = platform() === 'win32' ? '.exe' : '';
  const binaryName = `${binary}${exeSuffix}`;
  if (norm.endsWith(binaryName)) return norm;
  return join(norm, binaryName);
}

// ---------------------------------------------------------------------------
// Cache Helpers
// ---------------------------------------------------------------------------

function loadCacheManifest(): Record<string, CacheEntry> {
  if (!existsSync(CACHE_MANIFEST)) return {};
  try {
    return JSON.parse(readFileSync(CACHE_MANIFEST, 'utf-8'));
  } catch {
    return {};
  }
}

function saveCacheManifest(manifest: Record<string, CacheEntry>): void {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(CACHE_MANIFEST, JSON.stringify(manifest, null, 2), 'utf-8');
}

function getCachedVideoPath(videoId: string): string | null {
  const manifest = loadCacheManifest();
  const entry = manifest[videoId];
  if (!entry) return null;

  const cachedPath = join(CACHE_DIR, `${videoId}.mp4`);
  if (!existsSync(cachedPath)) {
    delete manifest[videoId];
    saveCacheManifest(manifest);
    return null;
  }

  const cachedAt = new Date(entry.cachedAt).getTime();
  const ageDays = (Date.now() - cachedAt) / (1000 * 60 * 60 * 24);
  if (ageDays > CACHE_TTL_DAYS) {
    log('CACHE', `Expired: ${videoId} (${ageDays.toFixed(1)} days)`);
    try { unlinkSync(cachedPath); } catch {}
    delete manifest[videoId];
    saveCacheManifest(manifest);
    return null;
  }

  log('CACHE', `HIT: ${videoId} (${ageDays.toFixed(1)} days old)`);
  return cachedPath;
}

function addToCache(videoId: string, filePath: string): void {
  const manifest = loadCacheManifest();
  let sizeBytes = 0;
  try {
    const stats = execSync(
      platform() === 'win32'
        ? `for %I in ("${filePath}") do @echo %~zI`
        : `stat -c%s "${filePath}"`,
      { ...EXEC_OPTS, encoding: 'utf-8' },
    );
    sizeBytes = parseInt(stats.trim(), 10) || 0;
  } catch {
    sizeBytes = 0;
  }

  manifest[videoId] = {
    cachedAt: new Date().toISOString(),
    sizeBytes,
    path: filePath,
  };

  saveCacheManifest(manifest);
  log('CACHE', `Cached ${videoId} (${(sizeBytes / 1024 / 1024).toFixed(1)} MB)`);
  enforceCacheLimit();
}

function enforceCacheLimit(): void {
  const manifest = loadCacheManifest();
  let totalBytes = 0;
  const entries: Array<{ id: string; ts: number; size: number }> = [];

  for (const [id, entry] of Object.entries(manifest)) {
    totalBytes += entry.sizeBytes;
    entries.push({ id, ts: new Date(entry.cachedAt).getTime(), size: entry.sizeBytes });
  }

  const maxBytes = CACHE_MAX_GB * 1024 * 1024 * 1024;
  if (totalBytes <= maxBytes) return;

  // Evict oldest first
  entries.sort((a, b) => a.ts - b.ts);
  for (const entry of entries) {
    if (totalBytes <= maxBytes) break;
    const filePath = join(CACHE_DIR, `${entry.id}.mp4`);
    try { unlinkSync(filePath); } catch {}
    delete manifest[entry.id];
    totalBytes -= entry.size;
    log('CACHE', `Evicted ${entry.id} (limit ${CACHE_MAX_GB}GB)`);
  }
  saveCacheManifest(manifest);
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(tag: string, message: string): void {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] [${tag.padEnd(10)}] ${message}`);
}

// =========================================================================
// RENDER CLIP V2 — Python Pipeline
// =========================================================================

export async function renderClipV2(
  job: Job,
  env: EnvConfig,
  heartbeatFn?: HeartbeatFn,
): Promise<void> {
  const clipParams = job.clipParams;
  if (!clipParams) throw new Error('clip_params missing from job');

  const { videoId, startTime, endTime, renderMode } = clipParams;
  const isVertical = renderMode === 'vertical' || renderMode === 'vertical-split';

  log('CLIP', `[Python Pipeline] Render ${videoId} ${startTime}s-${endTime}s mode=${renderMode || 'landscape'}`);

  // Ensure working directories
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
  if (!existsSync(TEMP_DIR)) mkdirSync(TEMP_DIR, { recursive: true });

  // ── Step 1: Download full video to cache ────────────────────────────
  let videoPath = getCachedVideoPath(videoId);
  if (!videoPath) {
    videoPath = join(CACHE_DIR, `${videoId}.mp4`);
    log('YTDLP', `Downloading ${job.youtubeUrl}`);
    if (heartbeatFn) await heartbeatFn();

    const ffmpegFlag = env.FFMPEG_LOCATION
      ? `--ffmpeg-location "${env.FFMPEG_LOCATION}"`
      : '';
    const formatStr = 'bestvideo[height<=1080][vcodec^=avc1]+bestaudio[ext=m4a]/best[height<=1080]';
    execSync(
      `yt-dlp ${ffmpegFlag} -f "${formatStr}" -o "${videoPath}" "${job.youtubeUrl}" --no-playlist --quiet`,
      EXEC_OPTS,
    );
    addToCache(videoId, videoPath);
  } else {
    log('YTDLP', `Using cached: ${videoPath}`);
  }

  // ── Step 2: Cut the relevant segment ────────────────────────────────
  const segName = `${videoId}_${Math.round(startTime)}s_${Math.round(endTime)}s_source.mp4`;
  const tempClipPath = join(TEMP_DIR, segName);

  if (!existsSync(tempClipPath)) {
    log('FFMPEG', `Cutting ${startTime}s-${endTime}s`);
    if (heartbeatFn) await heartbeatFn();

    const ffmpegBin = resolveFfmpegBin(env.FFMPEG_LOCATION, 'ffmpeg');
    execSync(
      `${ffmpegBin} -y -ss ${startTime} -to ${endTime} -i "${videoPath}" -c copy -movflags +faststart "${tempClipPath}"`,
      { ...EXEC_OPTS, timeout: 120_000 },
    );

    if (!existsSync(tempClipPath)) {
      throw new Error('ffmpeg cut produced no output');
    }
    log('FFMPEG', `Segment ready: ${tempClipPath}`);
  } else {
    log('FFMPEG', `Reusing existing segment: ${tempClipPath}`);
  }

  // ── Step 3: Run Python speaker-hybrid pipeline ──────────────────────
  const outName = `${videoId}_${Math.round(startTime)}s_${Math.round(endTime)}s_${renderMode || 'landscape'}.mp4`;
  const outputPath = join(TEMP_DIR, outName);

  if (!existsSync(outputPath)) {
    log('PYTHON', `Running pipeline on: ${tempClipPath}`);
    if (heartbeatFn) await heartbeatFn();

    const pythonCmd = platform() === 'win32' ? 'python' : 'python3';
    const runPyPath = join(WORKER_DIR, 'run.py');
    const pyWorkDir = join(TEMP_DIR, `py_${videoId}_${Date.now()}`);

    if (!existsSync(runPyPath)) {
      throw new Error(`run.py not found at: ${runPyPath}`);
    }

    mkdirSync(pyWorkDir, { recursive: true });

    const pyArgs = [`"${runPyPath}"`];
    pyArgs.push('--video', `"${tempClipPath}"`);
    pyArgs.push('--output', `"${outputPath}"`);
    pyArgs.push('--work-dir', `"${pyWorkDir}"`);
    if (isVertical) pyArgs.push('--vertical');

    const pyCmd = `${pythonCmd} ${pyArgs.join(' ')}`;
    log('PYTHON', `Command: ${pyCmd}`);

    try {
      execSync(pyCmd, {
        ...EXEC_OPTS,
        stdio: 'inherit',
        timeout: 600_000, // 10 minutes max
        env: {
          ...process.env,
          ...(env.HF_TOKEN ? { HF_TOKEN: env.HF_TOKEN } : {}),
          ...(env.DEEPGRAM_API_KEY ? { DEEPGRAM_API_KEY: env.DEEPGRAM_API_KEY } : {}),
        } as NodeJS.ProcessEnv,
      });
    } catch (pyErr: any) {
      const stderrHint = pyErr.stderr
        ? `\n  stderr: ${pyErr.stderr.toString().slice(0, 500)}`
        : '';
      throw new Error(`Pipeline failed: ${(pyErr.message || '').slice(0, 200)}${stderrHint}`);
    }

    if (!existsSync(outputPath)) {
      throw new Error('Pipeline produced no output file');
    }

    log('PYTHON', `Complete → ${outputPath}`);
  } else {
    log('PYTHON', `Output already exists: ${outputPath}`);
  }

  // ── Step 4: Upload result to web app ────────────────────────────────
  await uploadResult(job, env, outputPath, outName, startTime, endTime, heartbeatFn);

  // ── Step 5: Cleanup temp files ──────────────────────────────────────
  try { unlinkSync(tempClipPath); } catch {}
  try { unlinkSync(outputPath); } catch {}
  log('CLIP', `✅ renderClipV2 complete for job ${job.id} — ${outName}`);
}

// =========================================================================
// Upload Logic (multipart POST to web app)
// =========================================================================

async function uploadResult(
  job: Job,
  env: EnvConfig,
  filePath: string,
  filename: string,
  startTime: number,
  endTime: number,
  heartbeatFn?: HeartbeatFn,
): Promise<void> {
  log('UPLOAD', `Uploading ${filename}...`);
  if (heartbeatFn) await heartbeatFn();

  const uploadUrl = `${env.GANYIQ_API_URL}/api/workers/jobs/${job.id}/upload`;
  const fileBuffer = readFileSync(filePath);
  const durationSec = endTime - startTime;

  // Build multipart form manually
  const boundary = `----FormBoundary${Date.now()}`;
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
  body += `Content-Disposition: form-data; name="has_subtitles"${crlf}${crlf}0${crlf}`;
  body += `--${boundary}${crlf}`;
  body += `Content-Disposition: form-data; name="file"; filename="${filename}"${crlf}`;
  body += `Content-Type: video/mp4${crlf}${crlf}`;

  const bodyPrefix = encoder.encode(body);
  const bodySuffix = encoder.encode(`${crlf}--${boundary}--${crlf}`);
  const totalLength = bodyPrefix.length + fileBuffer.length + bodySuffix.length;

  log('UPLOAD', `POST ${uploadUrl} (${(totalLength / 1024 / 1024).toFixed(1)} MB)`);

  let uploadResponse: Response | null = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 120_000);
      uploadResponse = await fetch(uploadUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.WORKER_API_KEY}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': String(totalLength),
        },
        signal: controller.signal,
        body: (() => {
          const chunks = [bodyPrefix, fileBuffer, bodySuffix];
          return new Blob(chunks);
        })(),
      });
      clearTimeout(timeout);
      break;
    } catch (e: any) {
      const msg = (e.message || '').slice(0, 100);
      log('WARN', `Upload attempt ${attempt}/2 failed: ${msg}`);
      if (attempt === 2) {
        throw new Error(`Upload failed after 2 attempts: ${msg}`);
      }
      await new Promise(r => setTimeout(r, 3000));
    }
  }

  if (!uploadResponse || !uploadResponse.ok) {
    const errBody = uploadResponse ? await uploadResponse.text() : 'no response';
    throw new Error(`Upload failed (${uploadResponse?.status || 'no status'}): ${errBody.slice(0, 200)}`);
  }

  const uploadData = await uploadResponse.json();
  log('CLIP', `✅ Upload OK: ${uploadData.url || uploadData.clipUrl || 'done'}`);
}
