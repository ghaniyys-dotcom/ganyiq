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

import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';
import { join, resolve } from 'path';
import { execSync } from 'child_process';
import { platform } from 'os';
import { analyzeFaces, type CropSegment } from './face-tracker';

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
    renderMode?: 'landscape' | 'vertical';
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
  renderMode?: 'landscape' | 'vertical';
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
  if (!existsSync(CACHE_DIR)) execSync(`mkdir "${CACHE_DIR}"`, EXEC_OPTS);
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

export type HeartbeatFn = () => Promise<void>;

export async function renderClip(
  job: Job & { jobType?: string; clipParams?: ClipParams },
  env: EnvConfig,
  heartbeatFn?: HeartbeatFn,
): Promise<void> {
  const params = job.clipParams;
  if (!params) throw new Error('clip_params missing from job');

  const { videoId, startTime, endTime } = params;
  const videoUrl = job.youtubeUrl;

  log('CLIP', `Rendering clip ${videoId} ${startTime}s-${endTime}s`);

  // Ensure cache directory
  if (!existsSync(CACHE_DIR)) execSync(`mkdir "${CACHE_DIR}"`, EXEC_OPTS);
  if (!existsSync(TEMP_DIR)) execSync(`mkdir "${TEMP_DIR}"`, EXEC_OPTS);

  // 1. Get video (cached or download)
  let videoPath = getCachedVideoPath(videoId);
  if (!videoPath) {
    videoPath = join(CACHE_DIR, `${videoId}.mp4`);
    log('YTDLP', `Downloading video: ${videoUrl}`);
    const ffmpegFlag = env.FFMPEG_LOCATION ? `--ffmpeg-location "${env.FFMPEG_LOCATION}"` : '';
    if (heartbeatFn) await heartbeatFn();
    execSync(
      `yt-dlp ${ffmpegFlag} -f "best[height<=720]" -o "${videoPath}" "${videoUrl}" --no-playlist --quiet`,
      EXEC_OPTS,
    );
    addToCache(videoId, videoPath);
  }

  // SOURCE QUALITY LOG
  let sourceWidth = 1280;
  let sourceHeight = 720;
  try {
    const ffprobePath = env.FFMPEG_LOCATION
      ? `"${env.FFMPEG_LOCATION}/ffprobe"`
      : 'ffprobe';
    const probeOut = execSync(
      `${ffprobePath} -v quiet -print_format json -show_format -show_streams "${videoPath}"`,
      { ...EXEC_OPTS, timeout: 15_000 },
    );
    const probe = JSON.parse(probeOut);
    const vStream = probe?.streams?.find((s: any) => s.codec_type === 'video') || {};
    const aStream = probe?.streams?.find((s: any) => s.codec_type === 'audio') || {};
    log('SOURCE', `video=${vStream.width}x${vStream.height} codec=${vStream.codec_name} video_bitrate=${vStream.bit_rate || 'N/A'} audio_bitrate=${aStream.bit_rate || 'N/A'} duration=${probe?.format?.duration}s size=${probe?.format?.size} bytes`);
    sourceWidth = vStream.width || 1280;
    sourceHeight = vStream.height || 720;
    if (vStream.width < 1280 || vStream.height < 720) {
      log('WARN', `Source quality below 720p (${vStream.width}x${vStream.height})`);
    }
  } catch (e) {
    log('SOURCE', `ffprobe error: ${(e as Error).message.slice(0, 120)}`);
  }

  // 2. ffmpeg cut
  const renderMode = params.renderMode || 'landscape';
  const outputFilename = `${videoId}_${Math.round(startTime)}s_${Math.round(endTime)}s_${renderMode}.mp4`;
  const outputPath = join(TEMP_DIR, outputFilename);
  log('FFMPEG', `Cutting ${startTime}s-${endTime}s → ${outputFilename}`);

  const durationSec = endTime - startTime;
  const ffmpegPath = env.FFMPEG_LOCATION
    ? `"${env.FFMPEG_LOCATION}/ffmpeg"`
    : 'ffmpeg';

  log('FFMPEG', `renderMode=${renderMode}`);

  let ffmpegCmd: string;
  if (renderMode === 'vertical') {
    // ── Vertical mode: Face-tracking crop with center-crop fallback ──
    if (heartbeatFn) await heartbeatFn();
    const trackResult = analyzeFaces(videoPath, TEMP_DIR, sourceWidth, sourceHeight, startTime, endTime);

    if (trackResult && trackResult.segments.length > 0 && trackResult.faceRatio > 0.3) {
      // Face tracking available — segmented render
      log('FACE', `Face tracking active: ${trackResult.segments.length} segments, ${(trackResult.faceRatio * 100).toFixed(0)}% face coverage`);
      await renderVerticalTracked(
        ffmpegPath, videoPath, outputPath,
        startTime, endTime,
        trackResult.segments,
        sourceWidth, sourceHeight,
        heartbeatFn,
      );
      // Skip the single-command ffmpeg below
      ffmpegCmd = ''; // marker: already rendered
    } else {
      // Fallback: center crop (V1 behavior)
      log('FACE', 'Face tracking unavailable — using center crop');
      ffmpegCmd = `${ffmpegPath} -y -ss ${startTime} -to ${endTime} -i "${videoPath}" -vf "scale=-1:1920,crop=1080:1920" -c:v libx264 -preset medium -crf 18 -c:a aac -b:a 128k -movflags +faststart "${outputPath}"`;
    }
  } else {
    // ── Landscape mode (existing): stream copy ──
    ffmpegCmd = `${ffmpegPath} -y -ss ${startTime} -to ${endTime} -i "${videoPath}" -c copy -movflags +faststart "${outputPath}"`;
  }

  // Skip if already rendered by face-tracking path
  if (ffmpegCmd !== '') {
    // Single-command render (landscape or vertical center-crop fallback)
    log('DEBUG', `[1] CACHE_DIR=${CACHE_DIR}`);
    log('DEBUG', `[2] TEMP_DIR=${TEMP_DIR}`);
    log('DEBUG', `[3] sourceVideoPath=${videoPath}`);
    log('DEBUG', `[4] outputPath=${outputPath}`);
  
    // Source cache file size
    try {
      const srcStats = existsSync(videoPath)
        ? execSync(platform() === 'win32' ? `dir /-c "${videoPath}"` : `stat -c%s "${videoPath}"`, { ...EXEC_OPTS, encoding: 'utf-8' })
        : '0';
      const srcSizeMatch = srcStats.match(/\d+/);
      log('DEBUG', `[5] sourceVideoSizeBytes=${srcSizeMatch ? parseInt(srcSizeMatch[0], 10) : 0}`);
    } catch (e) {
      log('DEBUG', `[5] sourceVideoSizeBytes=ERROR: ${(e as Error).message.slice(0, 80)}`);
    }

    // Exact ffmpeg command
    log('DEBUG', `[6] ffmpegCmd=${ffmpegCmd}`);

    if (heartbeatFn) await heartbeatFn();
    execSync(ffmpegCmd, { ...EXEC_OPTS, timeout: 120_000 });
  }

  // Verify output exists (runs for both single-command and face-tracked paths)
  const fileExists = existsSync(outputPath);
  log('DEBUG', `[7] outputFileExists=${fileExists}`);
  log('DEBUG', `[7b] outputFileAbsPath=${outputPath}`);

  if (!fileExists) {
    throw new Error('ffmpeg cut produced no output file');
  }

  // Actual file size from disk
  let fileSizeBytes = 0;
  try {
    const outputStats = execSync(
      platform() === 'win32' ? `dir /-c "${outputPath}"` : `stat -c%s "${outputPath}"`,
      { ...EXEC_OPTS, encoding: 'utf-8' }
    );
    const sizeMatch = outputStats.match(/\d+/);
    fileSizeBytes = sizeMatch ? parseInt(sizeMatch[0], 10) : 0;
    log('DEBUG', `[8] outputFileSizeBytes=${fileSizeBytes}`);
  } catch (e) {
    log('DEBUG', `[8] outputFileSizeBytes=ERROR: ${(e as Error).message.slice(0, 80)}`);
  }

  log('FFMPEG', `Output: ${outputFilename} (${(fileSizeBytes / 1024 / 1024).toFixed(1)} MB, ${durationSec}s)`);

  // OUTPUT QUALITY LOG
  try {
    const ffprobePath = env.FFMPEG_LOCATION
      ? `"${env.FFMPEG_LOCATION}/ffprobe"`
      : 'ffprobe';
    const probeOut = execSync(
      `${ffprobePath} -v quiet -print_format json -show_format -show_streams "${outputPath}"`,
      { ...EXEC_OPTS, timeout: 15_000 },
    );
    const probe = JSON.parse(probeOut);
    const vStream = probe?.streams?.find((s: any) => s.codec_type === 'video') || {};
    const aStream = probe?.streams?.find((s: any) => s.codec_type === 'audio') || {};
    log('OUTPUT', `resolution=${vStream.width}x${vStream.height} codec=${vStream.codec_name} video_bitrate=${vStream.bit_rate || 'N/A'} audio_bitrate=${aStream.bit_rate || 'N/A'} duration=${probe?.format?.duration}s size=${probe?.format?.size} bytes total_bitrate=${probe?.format?.bit_rate}`);
  } catch (e) {
    log('OUTPUT', `ffprobe error: ${(e as Error).message.slice(0, 120)}`);
  }

  // 3. Upload to VPS
  log('UPLOAD', `Uploading ${outputFilename}...`);

  log('DEBUG', `[10] env.GANYIQ_API_URL=${env.GANYIQ_API_URL}`);
  log('DEBUG', `[10] env.WORKER_ID=${env.WORKER_ID}`);
  log('DEBUG', `[10] job.id=${job.id}`);
  const uploadUrl = `${env.GANYIQ_API_URL}/api/workers/jobs/${job.id}/upload`;
  log('DEBUG', `[10] uploadUrl=${uploadUrl}`);

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
  log('DEBUG', `[11] requestBodySize=${totalLength} bytes (prefix=${bodyPrefix.length}, file=${fileBuffer.length}, suffix=${bodySuffix.length})`);
  log('DEBUG', `[11] requestHeaders=${JSON.stringify({
    Authorization: `Bearer ${env.WORKER_API_KEY?.slice(0, 8)}...`,
    ContentType: `multipart/form-data; boundary=${boundary}`,
    ContentLength: String(totalLength),
  })}`);

  log('DEBUG', `[11] fetch POST ${uploadUrl}`);
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
          const { Readable } = require('stream');
          const { ReadableStream } = require('stream/web');
          const chunks = [bodyPrefix, fileBuffer, bodySuffix];
          return new Blob(chunks);
        })(),
      });
      clearTimeout(timeout);
      break;
    } catch (e: any) {
      log('WARN', `Upload attempt ${attempt}/2 failed: ${e.message?.slice(0, 100)}`);
      if (attempt === 2) throw new Error(`Upload failed after 2 attempts: ${e.message?.slice(0, 100)}`);
      await new Promise(r => setTimeout(r, 3000));
    }
  }

  if (!uploadResponse || !uploadResponse.ok) {
    const errBody = uploadResponse ? await uploadResponse.text() : 'no response';
    throw new Error(`Upload failed (${uploadResponse?.status || 'no status'}): ${errBody.slice(0, 200)}`);
  }

  const uploadData = await uploadResponse.json();
  log('DEBUG', `[12] upload OK: url=${uploadData.url}`);
  log('CLIP', `✅ Clip ready: ${uploadData.url}`);

  // Cleanup temp clip file
  try { execSync(`del /f "${outputPath}"`, EXEC_OPTS); } catch { try { execSync(`rm -f "${outputPath}"`, { ...EXEC_OPTS, shell: '/bin/sh' }); } catch {} }
}

// =========================================================================
// FACE-TRACKED VERTICAL RENDER
// =========================================================================

/**
 * Render a vertical (9:16) clip using face-tracking crop segments.
 *
 * Strategy:
 *  1. For each CropSegment, cut the sub-clip with ffmpeg using the
 *     segment's crop coordinates (cropX, cropY) with scale to 1080x1920.
 *  2. Create a concat demuxer file listing all segments.
 *  3. Concatenate all segments into the final output.
 *
 * Face coordinates are in source video pixel space (e.g., 1280x720).
 * Crop is applied as part of the ffmpeg filter chain.
 */
async function renderVerticalTracked(
  ffmpegPath: string,
  sourceVideo: string,
  outputPath: string,
  jobStartTime: number,
  jobEndTime: number,
  segments: CropSegment[],
  sourceWidth: number,
  sourceHeight: number,
  heartbeatFn?: HeartbeatFn,
): Promise<void> {
  if (segments.length === 0) {
    throw new Error('No crop segments provided for face-tracked render');
  }

  const tempDir = join(resolve(__dirname || '.'), 'temp');
  const concatFile = join(tempDir, `concat_${Date.now()}.txt`);
  const segmentPaths: string[] = [];

  // Crop dimensions for 9:16 from source
  const cropH = sourceHeight;
  const cropW = sourceHeight * (1080 / 1920);  // e.g., 720 * 0.5625 = 405

  log('TRACK', `Rendering ${segments.length} face-tracked segments (crop ${Math.round(cropW)}x${cropH})`);

  try {
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const segStart = Math.max(jobStartTime, seg.startTime);
      const segEnd = Math.min(jobEndTime, seg.endTime);

      if (segEnd <= segStart) continue;

      const segFile = join(tempDir, `seg_${i}_${Date.now()}.mp4`);
      segmentPaths.push(segFile);

      // Crop offset: maintain center on face position
      const cx = Math.max(0, Math.min(sourceWidth - cropW, seg.cropX));
      const cy = Math.max(0, Math.min(sourceHeight - cropH, seg.cropY));

      const cmd = `${ffmpegPath} -y -ss ${segStart} -to ${segEnd} -i "${sourceVideo}" ` +
        `-vf "crop=${Math.round(cropW)}:${cropH}:${Math.round(cx)}:${Math.round(cy)},scale=1080:1920" ` +
        `-c:v libx264 -preset medium -crf 18 ` +
        `-c:a aac -b:a 128k ` +
        `-movflags +faststart ` +
        `"${segFile}"`;

      log('TRACK', `Segment ${i}: crop=${Math.round(cx)},${Math.round(cy)} time=${segStart}-${segEnd}s`);

      if (heartbeatFn && i % 10 === 0) await heartbeatFn();
      execSync(cmd, { ...EXEC_OPTS, timeout: 120_000 });

      if (!existsSync(segFile)) {
        throw new Error(`Segment ${i} produced no output`);
      }
    }

    if (segmentPaths.length === 0) {
      throw new Error('No valid segments produced');
    }

    if (segmentPaths.length === 1) {
      // Single segment — just rename
      execSync(
        platform() === 'win32'
          ? `move /y "${segmentPaths[0]}" "${outputPath}"`
          : `mv "${segmentPaths[0]}" "${outputPath}"`,
        EXEC_OPTS,
      );
      log('TRACK', 'Single segment — direct output');
      return;
    }

    // Build concat demuxer file
    const concatLines = segmentPaths.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join('\n');
    writeFileSync(concatFile, concatLines, 'utf-8');

    log('TRACK', `Concatenating ${segmentPaths.length} segments`);

    const concatCmd = `${ffmpegPath} -y -f concat -safe 0 -i "${concatFile}" -c copy "${outputPath}"`;
    execSync(concatCmd, { ...EXEC_OPTS, timeout: 120_000 });

    if (!existsSync(outputPath)) {
      throw new Error('Concat produced no output file');
    }

    log('TRACK', `Concatenated ${segmentPaths.length} segments → ${outputPath}`);
  } finally {
    // Cleanup segment files
    for (const p of segmentPaths) {
      try { unlinkSync(p); } catch { /* ignore */ }
    }
    try { unlinkSync(concatFile); } catch { /* ignore */ }
  }
}
