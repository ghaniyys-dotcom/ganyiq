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

import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';
import { execSync } from 'child_process';
import { platform } from 'os';
import { analyzeFaces, type CropSegment, type MultiCropSegment, type MultiFaceSample } from './face-tracker';
import type { DecisionSegment } from './decision-engine';
import { renderSubtitles, type SubtitleRenderResult, buildSubtitleFilter } from './subtitle-renderer';
import type { SubtitleTemplateId } from './subtitle-templates';

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
  HF_TOKEN?: string;
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
    renderMode?: 'landscape' | 'vertical' | 'vertical-split';
    subtitleStyle?: SubtitleTemplateId;
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
  renderMode?: 'landscape' | 'vertical' | 'vertical-split';
  subtitleStyle?: SubtitleTemplateId;
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

  const { videoId, startTime, endTime, subtitleStyle } = params;
  const effectiveSubtitleStyle: SubtitleTemplateId = subtitleStyle || 'opus';
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
    // P0.5: Download up to 1080p source for better quality
    const formatStr = 'bestvideo[height<=1080][vcodec^=avc1]+bestaudio[ext=m4a]/best[height<=1080]';
    execSync(
      `yt-dlp ${ffmpegFlag} -f "${formatStr}" -o "${videoPath}" "${videoUrl}" --no-playlist --quiet`,
      EXEC_OPTS,
    );
    addToCache(videoId, videoPath);
  }

  // SOURCE QUALITY LOG
  let sourceWidth = 1280;
  let sourceHeight = 720;
  let sourceFps = 30;
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

    const rFrameRate = vStream.r_frame_rate || '30/1';
    if (rFrameRate && rFrameRate.includes('/')) {
      const [num, den] = rFrameRate.split('/').map(Number);
      if (num && den) {
        sourceFps = num / den;
      }
    } else {
      const parsed = Number(rFrameRate);
      if (parsed) {
        sourceFps = parsed;
      }
    }
    log('SOURCE', `Parsed FPS: ${sourceFps}`);

    if (vStream.width >= 1920 && vStream.height >= 1080) {
      log('SOURCE', 'Full HD source — excellent quality');
    } else if (vStream.width < 1280 || vStream.height < 720) {
      log('WARN', `Source quality below 720p (${vStream.width}x${vStream.height}) — will need upscaling`);
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

  // Run analysis pipeline (V2 with V1 fallback)
  // HF Token for PyAnnote speaker diarization (optional — set HF_TOKEN in .env.local)
  const hfToken = env.HF_TOKEN || process.env.HF_TOKEN || '';
  const deepgramKey = env.DEEPGRAM_API_KEY || process.env.DEEPGRAM_API_KEY || '';
  // Make FFMPEG_LOCATION available to Python subprocesses (diarize.py, transcribe.py, reaction-detector.py)
  if (env.FFMPEG_LOCATION && !process.env.FFMPEG_LOCATION) {
    process.env.FFMPEG_LOCATION = env.FFMPEG_LOCATION;
  }
  if (heartbeatFn) await heartbeatFn();
  const trackResult = await analyzeFaces(videoPath, TEMP_DIR, sourceWidth, sourceHeight, startTime, endTime, hfToken, deepgramKey);

  // Generate subtitles if we have word timestamps
  let subtitleFilter = '';
  let subtitleResult: SubtitleRenderResult | null = null;
  if (trackResult?.speakerData?.wordTimestamps && trackResult.speakerData.wordTimestamps.length > 0) {
    log('SUBTITLE', 'Generating ASS subtitles...');
    const tempSubtitlesDir = join(TEMP_DIR, 'subs');
    if (!existsSync(tempSubtitlesDir)) mkdirSync(tempSubtitlesDir, { recursive: true });

    subtitleResult = renderSubtitles(
      trackResult.speakerData.wordTimestamps,
      trackResult.speakerData.speakerSegments,
      startTime,
      endTime,
      tempSubtitlesDir,
      `${videoId}_${Math.round(startTime)}s`,
      effectiveSubtitleStyle,
      trackResult.decisionSegments || undefined,
    );
    log('SUBTITLE', `Using subtitle style: ${effectiveSubtitleStyle}`);
    subtitleFilter = `,${buildSubtitleFilter(subtitleResult.assFilePath)}`;
    log('SUBTITLE', `✅ Subtitles generated: ${subtitleResult.lineCount} lines, ${subtitleResult.wordCount} words`);
  } else {
    log('SUBTITLE', 'No word-level timestamps available — skipping subtitles');
  }

  const hasSubtitles = subtitleResult !== null ? '1' : '0';

  let ffmpegCmd: string;
  if (renderMode === 'vertical' || renderMode === 'vertical-split') {
    // ── Unified Shorts mode: dynamic split screen for any face count ──
    if (heartbeatFn) await heartbeatFn();

    let splitSegments: MultiCropSegment[];

    if (trackResult && trackResult.decisionSegments && trackResult.decisionSegments.length > 0) {
      // P1.1: Use Decision Engine output (reaction cuts, EMA smoothing, smart layout)
      splitSegments = trackResult.decisionSegments.map(ds => ({
        startTime: ds.startTime,
        endTime: ds.endTime,
        crops: ds.crops.map(c => ({
          cropX: c.cropX,
          cropY: c.cropY,
          faceId: c.faceId,
          confidence: c.confidence,
          isReaction: c.isReaction ?? false,
        })),
        transitionIn: ds.transitionOut
          ? { type: ds.transitionOut.type as 'crossfade' | 'none', duration: ds.transitionOut.duration }
          : undefined,
        mode: ds.mode,
      }));
      if (splitSegments.length > 0 && trackResult.totalReactionCuts && trackResult.totalReactionCuts > 0) {
        log('SHORTS', `P1.1 Decision Engine: ${trackResult.totalReactionCuts} reaction cuts, ${trackResult.totalLayoutSwitches} layout switches`);
      }
    } else if (trackResult && trackResult.multiFaces && trackResult.multiFaces.length > 0) {
      // Legacy: Build split segments from face data (V2.5 fallback)
      const baseSegments = (trackResult?.segments && trackResult.segments.length > 0) ? trackResult.segments : [];
      splitSegments = buildSplitSegments(trackResult.multiFaces, baseSegments, sourceWidth, sourceHeight);
    } else {
      // No face data — create single center-crop segment (still goes through renderVerticalSplit)
      const cropH = sourceHeight;
      const cropW = sourceHeight * (1080 / 1920);
      const centerCropX = Math.round((sourceWidth - cropW) / 2);
      splitSegments = [{
        startTime,
        endTime,
        crops: [{ cropX: centerCropX, cropY: 0, faceId: -1, confidence: 0 }],
      }];
    }

    if (splitSegments.length > 0) {
      log('SHORTS', `Split screen render: ${splitSegments.length} segments${subtitleResult ? ` + subtitles (${subtitleResult.lineCount} lines)` : ''}`);
      await renderVerticalSplit(
        ffmpegPath, videoPath, outputPath,
        startTime, endTime,
        splitSegments,
        sourceWidth, sourceHeight,
        subtitleFilter,
        heartbeatFn,
        videoId,
        sourceFps,
      );
      ffmpegCmd = ''; // marker: already rendered
    } else {
      // Extreme fallback — should never happen
      log('SHORTS', 'No split segments — center crop fallback');
      ffmpegCmd = `${ffmpegPath} -y -ss ${startTime} -to ${endTime} -i "${videoPath}" -vf "scale=-1:1920,crop=1080:1920${subtitleFilter}" -c:v libx264 -preset medium -crf 18 -c:a aac -b:a 128k -movflags +faststart "${outputPath}"`;
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
  body += `Content-Disposition: form-data; name="has_subtitles"${crlf}${crlf}${hasSubtitles}${crlf}`;
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

// =============================================================================
// DYNAMIC SPLIT SCREEN (V2.5)
// =============================================================================
//
// Uses ALL face data from face-tracker.ts (MultiFaceSample[]) to generate
// multi-crop segments where 2-3 faces are visible simultaneously.
//
// Split rules:
//   1 active face  → full screen single crop (current V2.4A)
//   2 active faces → 50/50 vertical stack
//   3 active faces → 33/33/33 vertical stack
//   MIN_HOLD_SPLIT=3s before switching back to single
//   MIN_HOLD_SINGLE=3s before activating split
//
// =============================================================================

const SPLIT_MIN_HOLD_SINGLE = 1.5;   // seconds before split can activate
const SPLIT_MIN_HOLD_SPLIT = 1.5;    // seconds before split can deactivate
const SPLIT_MAX_FACES = 3;           // max faces shown in split
const SPLIT_CONFIDENCE_FLOOR = 0.01; // min confidence to be "active" (was 0.1 — too high for 720p)

/**
 * Build multi-crop segments for split-screen rendering.
 * Frame-by-face analysis → split decision with hold timers → segment grouping.
 */
function buildSplitSegments(
  multiFaces: MultiFaceSample[],
  baseSegments: CropSegment[],
  sourceWidth: number,
  sourceHeight: number,
): MultiCropSegment[] {
  const cropH = sourceHeight;
  const cropW = sourceHeight * (1080 / 1920);
  const totalFrames = multiFaces.length;

  // Step 1: Per-frame — extract all faces, compute crop coordinates
  interface FrameState {
    time: number;
    activeFaces: Array<{ faceId: number; cx: number; cy: number; confidence: number }>;
    activeCount: number;
  }

  const frameStates: FrameState[] = multiFaces.map((sample) => {
    const activeFaces = sample.faces.map((f) => {
      // Convert face center (f.cx/f.cy) to crop coordinates
      const cropX = Math.max(0, Math.min(sourceWidth - cropW, f.cx - cropW / 2));
      const cropY = Math.max(0, Math.min(sourceHeight - cropH, f.cy - cropH * 0.35));
      const confidence = (f.w * f.h) / (sourceWidth * sourceHeight);
      return { faceId: f.id, cx: cropX, cy: cropY, confidence };
    }).filter((f) => f.confidence >= SPLIT_CONFIDENCE_FLOOR);

    return {
      time: sample.time,
      activeFaces,
      activeCount: Math.min(activeFaces.length, SPLIT_MAX_FACES),
    };
  });

  // Step 2: Determine split mode per-frame with hold timers
  enum SplitMode { SINGLE = 1, SPLIT_2 = 2, SPLIT_3 = 3 }

  interface ModeFrame {
    time: number;
    mode: SplitMode;
    topFaces: typeof frameStates[0]['activeFaces'];
  }

  let currentMode = SplitMode.SINGLE;
  let modeSwitchTime = 0;
  const modeFrames: ModeFrame[] = [];

  for (let i = 0; i < totalFrames; i++) {
    const fs = frameStates[i];
    const timeSinceSwitch = fs.time - modeSwitchTime;

    // Desired mode based on face count
    let desiredMode = SplitMode.SINGLE;
    if (fs.activeCount >= 3) desiredMode = SplitMode.SPLIT_3;
    else if (fs.activeCount >= 2) desiredMode = SplitMode.SPLIT_2;

    // Hold timer: prevent flicker
    if (desiredMode !== currentMode) {
      if (timeSinceSwitch >= (currentMode === SplitMode.SINGLE ? SPLIT_MIN_HOLD_SINGLE : SPLIT_MIN_HOLD_SPLIT)) {
        currentMode = desiredMode;
        modeSwitchTime = fs.time;
      }
    }

    // Select top N faces sorted by confidence
    const topFaces = fs.activeFaces
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, currentMode);

    modeFrames.push({ time: fs.time, mode: currentMode, topFaces });
  }

  // Step 3: Group into segments with stable split mode
  const result: MultiCropSegment[] = [];

  for (let i = 0; i < modeFrames.length; ) {
    const mode = modeFrames[i].mode;
    const segFrames: ModeFrame[] = [];

    while (i < modeFrames.length && modeFrames[i].mode === mode) {
      segFrames.push(modeFrames[i]);
      i++;
    }

    if (segFrames.length === 0) continue;

    // Average crop coordinates per face across the segment
    const cropMap = new Map<number, { sumCx: number; sumCy: number; sumConfidence: number; count: number }>();

    for (const sf of segFrames) {
      for (const face of sf.topFaces) {
        const entry = cropMap.get(face.faceId) || { sumCx: 0, sumCy: 0, sumConfidence: 0, count: 0 };
        entry.sumCx += face.cx;
        entry.sumCy += face.cy;
        entry.sumConfidence += face.confidence;
        entry.count++;
        cropMap.set(face.faceId, entry);
      }
    }

    const crops = Array.from(cropMap.entries())
      .sort((a, b) => (b[1].sumConfidence / b[1].count) - (a[1].sumConfidence / a[1].count))
      .slice(0, mode)
      .map(([faceId, data]) => ({
        cropX: Math.round(data.sumCx / data.count),
        cropY: Math.round(data.sumCy / data.count),
        faceId,
        confidence: data.sumConfidence / data.count,
      }));

    result.push({
      startTime: segFrames[0].time,
      endTime: segFrames[segFrames.length - 1].time,
      crops,
    });
  }

  // Step 4: Merge tiny segments (< 1s) into next segment
  const cleaned: MultiCropSegment[] = [];
  for (let i = 0; i < result.length; i++) {
    const seg = result[i];
    const dur = seg.endTime - seg.startTime;

    if (dur < 1.0 && i < result.length - 1) {
      const next = result[i + 1];
      cleaned.push({ startTime: seg.startTime, endTime: next.endTime, crops: next.crops });
      i++;
    } else {
      cleaned.push(seg);
    }
  }

  log('SPLIT', `Split segments: ${cleaned.length} (1-face=${cleaned.filter(s => s.crops.length === 1).length}, 2-way=${cleaned.filter(s => s.crops.length === 2).length}, 3-way=${cleaned.filter(s => s.crops.length === 3).length})`);
  return cleaned;
}

// =============================================================================
// SPLIT SCREEN RENDERER
// =============================================================================

/**
 * Render vertical clip with dynamic split using FFmpeg complex filter.
 *
 * For each segment:
 *   crops=1 → standard single-crop (full 1080x1920)
 *   crops=2 → each crop to 1080x960, vstack
 *   crops=3 → each crop to 1080x640, vstack
 *
 * P1.1 enhancements:
 *   - Reaction cuts (crops=1 segments inserted at audio events)
 *   - Crossfade transitions between segments for smooth layout switches
 *   - REACTION_CUT treated as single-face segment
 *
 * Concat all segments at the end.
 */
async function renderVerticalSplit(
  ffmpegPath: string,
  sourceVideo: string,
  outputPath: string,
  jobStartTime: number,
  jobEndTime: number,
  segments: MultiCropSegment[],
  sourceWidth: number,
  sourceHeight: number,
  subtitleFilter: string = '',
  heartbeatFn?: HeartbeatFn,
  /** Unique identifier for temp file naming (e.g. videoId). */
  renderId?: string,
  sourceFps: number = 30,
): Promise<void> {
  if (segments.length === 0) {
    throw new Error('No split segments provided');
  }

  const FULL_H = sourceHeight;
  const OLD_CROP_W = FULL_H * (1080 / 1920);
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

  const filterParts: string[] = [];
  // Track per-valid-segment metadata for xfade chain
  const segDurations: number[] = [];
  const segTransitions: Array<{ type: 'crossfade' | 'none'; duration: number } | undefined> = [];

  // V2: Use NVENC GPU encoding when available, fall back to libx264
  const hasNvenc = hasNvidiaEncoder();
  const ENC = hasNvenc
    ? '-c:v h264_nvenc -preset p7 -cq 22 -b:v 0 -c:a aac -b:a 128k -movflags +faststart'
    : '-c:v libx264 -preset fast -crf 20 -c:a aac -b:a 128k -movflags +faststart';

  log('SPLIT', `Using ${hasNvenc ? 'NVENC GPU' : 'libx264 CPU'} encoder`);

  let segIdx = 0;

  try {
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const segStart = Math.max(jobStartTime, seg.startTime);
      const segEnd = Math.min(jobEndTime, seg.endTime);
      if (segEnd <= segStart) continue;
      const thisDuration = segEnd - segStart;
      segDurations.push(thisDuration);
      segTransitions.push(seg.transitionIn);

      const numFaces = seg.crops.length;
      const vLabel = `sv${segIdx}`;
      const aLabel = `sa${segIdx}`;

      // P1.1: Handle crossfade transitions between segments
      const hasTransition = seg.transitionIn && seg.transitionIn.type === 'crossfade';

      // Detect PiP mode: 2 crops with mode === 'listener_pip'
      const isPiP = numFaces >= 2 && seg.mode === 'listener_pip';
      const isHeroReaction = seg.mode === 'hero_reaction';

      if (isPiP) {
        // ── Picture-in-Picture: speaker full-frame + listener inset ──
        const mainFace = seg.crops[0];
        const pipFace = seg.crops[1];

        const mainCx = mainFace.cropX + OLD_CROP_W / 2;
        const mainCw = OLD_CROP_W;
        const mainCropX = clamp(Math.round(mainCx - mainCw / 2), 0, sourceWidth - mainCw);

        const PIP_OUT_W = 270;
        const PIP_OUT_H = 480;
        const pipCx = pipFace.cropX !== undefined
          ? pipFace.cropX + OLD_CROP_W / 2
          : sourceWidth / 2;
        const pipScaleFactor = (FULL_H / PIP_OUT_H) * 0.85;
        const pipCropW = Math.min(Math.round(PIP_OUT_W * pipScaleFactor), sourceWidth);
        const pipCropH = FULL_H;
        const pipCropX = clamp(Math.round(pipCx - pipCropW / 2), 0, sourceWidth - pipCropW);

        filterParts.push(
          `[0:v]trim=start=${segStart}:end=${segEnd},setpts=PTS-STARTPTS,`
          + `crop=${mainCw}:${FULL_H}:${mainCropX}:0,`
          + `scale=1080:1920:flags=lanczos,`
          + `unsharp=5:5:0.8:3:3:0.4,`
          + `setsar=1[main${segIdx}]`
        );
        filterParts.push(
          `[0:v]trim=start=${segStart}:end=${segEnd},setpts=PTS-STARTPTS,`
          + `crop=${pipCropW}:${pipCropH}:${pipCropX}:0,`
          + `scale=${PIP_OUT_W - 4}:${PIP_OUT_H - 4}:flags=lanczos,`
          + `setsar=1,`
          + `pad=${PIP_OUT_W}:${PIP_OUT_H}:2:2:color=0xE2C266,`
          + `split[pip_img${segIdx}][pip_shadow${segIdx}]`
        );
        filterParts.push(
          `[pip_shadow${segIdx}]format=rgba,drawbox=x=0:y=0:w=iw:h=ih:color=black@0.35:t=fill,`
          + `boxblur=6:3[shadow${segIdx}]`
        );
        filterParts.push(
          `[main${segIdx}][shadow${segIdx}]overlay=W-w-20:H-h-20[main_shadowed${segIdx}]`
        );
        filterParts.push(
          `[main_shadowed${segIdx}][pip_img${segIdx}]overlay=W-w-24:H-h-24,`
          + `setsar=1,fps=30000/1001,settb=AVTB,setpts=PTS-STARTPTS[${vLabel}]`
        );
        filterParts.push(
          `[0:a]atrim=start=${segStart}:end=${segEnd},asetpts=PTS-STARTPTS[${aLabel}]`
        );
        log('SPLIT', `Seg ${segIdx}: PiP [${segStart}s-${segEnd}s]`);

      } else if (isHeroReaction) {
        // ── HERO_REACTION: 60/40 top/bottom split ──
        // crops[0] = primary speaker (top 60%, full width)
        // crops[1..2] = reaction panel(s) (bottom 40%, 1 or 2 faces side by side)
        const heroFace = seg.crops[0];
        const heroCx = heroFace.cropX + OLD_CROP_W / 2;
        const heroCw = OLD_CROP_W;
        const heroCropX = clamp(Math.round(heroCx - heroCw / 2), 0, sourceWidth - heroCw);

        const reactionCount = Math.min(seg.crops.length - 1, 2); // 1 or 2 reaction panels
        const HERO_H = Math.floor(1920 * 0.6); // 1152px
        const REACT_H = 1920 - HERO_H;         // 768px

        // Hero panel (top 60%)
        filterParts.push(
          `[0:v]trim=start=${segStart}:end=${segEnd},setpts=PTS-STARTPTS,`
          + `crop=${heroCw}:${FULL_H}:${heroCropX}:0,`
          + `scale=1080:${HERO_H}:flags=lanczos,`
          + `unsharp=5:5:0.8:3:3:0.4,`
          + `setsar=1[hero${segIdx}]`
        );

        // Reaction panel(s) (bottom 40%)
        if (reactionCount === 1) {
          const rFace = seg.crops[1];
          const rCx = rFace.cropX !== undefined ? rFace.cropX + OLD_CROP_W / 2 : sourceWidth / 2;
          const rCropW = OLD_CROP_W;
          const rCropX = clamp(Math.round(rCx - rCropW / 2), 0, sourceWidth - rCropW);
          filterParts.push(
            `[0:v]trim=start=${segStart}:end=${segEnd},setpts=PTS-STARTPTS,`
            + `crop=${rCropW}:${FULL_H}:${rCropX}:0,`
            + `scale=1080:${REACT_H}:flags=lanczos,`
            + `setsar=1[react${segIdx}]`
          );
          filterParts.push(
            `[hero${segIdx}][react${segIdx}]vstack=inputs=2,`
            + `setsar=1,fps=30000/1001,settb=AVTB,setpts=PTS-STARTPTS[${vLabel}]`
          );
        } else {
          // 2 reaction panels side by side
          const r1Face = seg.crops[1];
          const r2Face = seg.crops[2];
          const r1Cx = r1Face.cropX !== undefined ? r1Face.cropX + OLD_CROP_W / 2 : sourceWidth / 2;
          const r2Cx = r2Face.cropX !== undefined ? r2Face.cropX + OLD_CROP_W / 2 : sourceWidth / 2;
          const rCropW = Math.round(OLD_CROP_W * 0.9); // wider crop for reaction panels
          const r1CropX = clamp(Math.round(r1Cx - rCropW / 2), 0, sourceWidth - rCropW);
          const r2CropX = clamp(Math.round(r2Cx - rCropW / 2), 0, sourceWidth - rCropW);
          filterParts.push(
            `[0:v]trim=start=${segStart}:end=${segEnd},setpts=PTS-STARTPTS,`
            + `crop=${rCropW}:${FULL_H}:${r1CropX}:0,`
            + `scale=540:${REACT_H}:flags=lanczos,`
            + `setsar=1[r1${segIdx}]`
          );
          filterParts.push(
            `[0:v]trim=start=${segStart}:end=${segEnd},setpts=PTS-STARTPTS,`
            + `crop=${rCropW}:${FULL_H}:${r2CropX}:0,`
            + `scale=540:${REACT_H}:flags=lanczos,`
            + `setsar=1[r2${segIdx}]`
          );
          filterParts.push(
            `[r1${segIdx}][r2${segIdx}]hstack=inputs=2[react_row${segIdx}]`
          );
          filterParts.push(
            `[hero${segIdx}][react_row${segIdx}]vstack=inputs=2,`
            + `setsar=1,fps=30000/1001,settb=AVTB,setpts=PTS-STARTPTS[${vLabel}]`
          );
        }

        filterParts.push(
          `[0:a]atrim=start=${segStart}:end=${segEnd},asetpts=PTS-STARTPTS[${aLabel}]`
        );
        log('SPLIT', `Seg ${segIdx}: Hero+Reaction [${segStart}s-${segEnd}s]`);

      } else if (numFaces <= 1) {
        // ── Single-face (SINGLE, REACTION_CUT, WIDE_CONTEXT): trim → crop → scale → sharpen → subtitle ──
        const faceCx = seg.crops[0]?.cropX !== undefined
          ? seg.crops[0].cropX + OLD_CROP_W / 2
          : sourceWidth / 2;

        // WIDE_CONTEXT: 90% of normal crop width (less zoomed in)
        const isWide = seg.mode === 'wide_context';
        const cw = isWide ? OLD_CROP_W * 1.1 : OLD_CROP_W;
        const effectiveCw = Math.min(Math.round(cw), sourceWidth);
        const cx = clamp(Math.round(faceCx - effectiveCw / 2), 0, sourceWidth - effectiveCw);
        const cy = 0;

        const reactionLabel = seg.crops[0]?.isReaction ? 'reaction' : isWide ? 'wide' : 'single';

        const segDuration = Math.max(1, segEnd - segStart);
        const kbZoom = 0.04; // 4% zoom over the segment
        const cropFilter = `crop=w='${effectiveCw}*(1-${kbZoom}*t/${segDuration})':h='${FULL_H}*(1-${kbZoom}*t/${segDuration})':x='${cx}+${effectiveCw}*${kbZoom}*t/(2*${segDuration})':y='${FULL_H}*${kbZoom}*t/(2*${segDuration})'`;

        if (seg.crops[0]?.isReaction) {
          const reactionZoom = 1.05;
          filterParts.push(
            `[0:v]trim=start=${segStart}:end=${segEnd},setpts=PTS-STARTPTS,`
            + `crop=${Math.round(effectiveCw / reactionZoom)}:${FULL_H}:${Math.round(cx + effectiveCw * (1 - 1/reactionZoom) / 2)}:${cy},`
            + `scale=1080:1920:flags=lanczos,`
            + `unsharp=5:5:0.8:3:3:0.4,`
            + `setsar=1,fps=30000/1001,settb=AVTB,setpts=PTS-STARTPTS[${vLabel}]`
          );
        } else {
          const durationStr = segDuration.toFixed(4);
          filterParts.push(
            `[0:v]trim=start=${segStart}:end=${segEnd},setpts=PTS-STARTPTS,`
            + `crop=${effectiveCw}:${FULL_H}:${cx}:${cy},`
            + `scale=1080:1920:flags=lanczos,`
            + `zoompan=z='1.0+0.04*time/${durationStr}':x='iw/2-(iw/zoom)/2':y='ih/2-(ih/zoom)/2':d=1:s=1080x1920:fps=30000/1001,`
            + `unsharp=5:5:0.8:3:3:0.4,`
            + `setsar=1,fps=30000/1001,settb=AVTB,setpts=PTS-STARTPTS[${vLabel}]`
          );
        }

        filterParts.push(
          `[0:a]atrim=start=${segStart}:end=${segEnd},asetpts=PTS-STARTPTS[${aLabel}]`
        );
        log('SPLIT', `Seg ${segIdx}: ${reactionLabel} crop=${cx},${cy} [${segStart}s-${segEnd}s]${hasTransition ? ' +xfade' : ''}`);

      } else if (seg.mode === 'split_4') {
        // ── SPLIT_4: 2x2 grid ──
        const faceCount = 4;
        const cellW = 540;   // 1080/2
        const cellH = 960;   // 1920/2

        // Compute crop width for each face
        let panelCropW = Math.round(FULL_H * (cellW / cellH));
        panelCropW = Math.min(panelCropW, sourceWidth);

        const splitLabel = `sp${segIdx}`;
        filterParts.push(
          `[0:v]trim=start=${segStart}:end=${segEnd},setpts=PTS-STARTPTS,`
          + `split=4[${splitLabel}_0][${splitLabel}_1][${splitLabel}_2][${splitLabel}_3]`
        );

        // Top row: faces 0,1 side by side
        for (let fi = 0; fi < 2; fi++) {
          const face = seg.crops[fi];
          const faceCx = face.cropX !== undefined ? face.cropX + OLD_CROP_W / 2 : sourceWidth / 2;
          const cx = clamp(Math.round(faceCx - panelCropW / 2), 0, sourceWidth - panelCropW);
          filterParts.push(
            `[${splitLabel}_${fi}]crop=${panelCropW}:${FULL_H}:${cx}:0,`
            + `scale=${cellW}:${cellH}:flags=lanczos,setsar=1,setpts=PTS-STARTPTS[row0c${fi}${segIdx}]`
          );
        }
        filterParts.push(
          `[row0c0${segIdx}][row0c1${segIdx}]hstack=inputs=2[top_row${segIdx}]`
        );

        // Bottom row: faces 2,3 side by side
        for (let fi = 2; fi < 4; fi++) {
          const face = seg.crops[fi];
          const faceCx = face.cropX !== undefined ? face.cropX + OLD_CROP_W / 2 : sourceWidth / 2;
          const cx = clamp(Math.round(faceCx - panelCropW / 2), 0, sourceWidth - panelCropW);
          filterParts.push(
            `[${splitLabel}_${fi}]crop=${panelCropW}:${FULL_H}:${cx}:0,`
            + `scale=${cellW}:${cellH}:flags=lanczos,setsar=1,setpts=PTS-STARTPTS[row1c${fi - 2}${segIdx}]`
          );
        }
        filterParts.push(
          `[row1c0${segIdx}][row1c1${segIdx}]hstack=inputs=2[btm_row${segIdx}]`
        );

        // Stack rows
        filterParts.push(
          `[top_row${segIdx}][btm_row${segIdx}]vstack=inputs=2,setsar=1,`
          + `unsharp=5:5:0.8:3:3:0.4,fps=30000/1001,settb=AVTB,setpts=PTS-STARTPTS[${vLabel}]`
        );
        filterParts.push(
          `[0:a]atrim=start=${segStart}:end=${segEnd},asetpts=PTS-STARTPTS[${aLabel}]`
        );
        log('SPLIT', `Seg ${segIdx}: 4-way grid [${segStart}s-${segEnd}s]${hasTransition ? ' +xfade' : ''}`);

      } else {
        // ── Multi-face vstack (SPLIT_2, SPLIT_3): trim → split → crop → sharpen → pad divider → vstack → subtitle ──
        // P2.1: Professional divider lines between panels (3px white)
        // P3.1: Per-panel sharpening (unsharp BEFORE vstack, not after)
        const faceCount = Math.min(numFaces, SPLIT_MAX_FACES);
        const DIVIDER_PX = 3;
        const totalDividers = faceCount - 1;
        const usableHeight = 1920 - (totalDividers * DIVIDER_PX);
        const segHeight = Math.floor(usableHeight / faceCount);
        let panelCropW = Math.round(FULL_H * (1080 / segHeight));
        panelCropW = Math.min(panelCropW, sourceWidth);

        const splitLabel = `sp${segIdx}`;
        filterParts.push(
          `[0:v]trim=start=${segStart}:end=${segEnd},setpts=PTS-STARTPTS,split=${faceCount}[${splitLabel}_0`
          + `${Array.from({length: faceCount - 1}, (_, j) => `][${splitLabel}_${j + 1}`).join('')}]`
        );

        const vstackInputs: string[] = [];
        for (let fi = 0; fi < faceCount; fi++) {
          const face = seg.crops[fi];
          const faceCx = face.cropX !== undefined
            ? face.cropX + OLD_CROP_W / 2
            : sourceWidth / 2;
          const cx = clamp(Math.round(faceCx - panelCropW / 2), 0, sourceWidth - panelCropW);
          const subLabel = `sf${segIdx}_${fi}`;

          // P3.1: Sharpen each panel INDIVIDUALLY before compositing
          // P2.1: Add bottom divider pad (white 3px) except for last panel
          const needsDivider = fi < faceCount - 1;
          const dividerFilter = needsDivider
            ? `,pad=1080:${segHeight + DIVIDER_PX}:0:0:color=white`
            : '';

          // P2.4: Pad top panel to 1920 to act as a background canvas for slide-in overlays
          const padFilter = fi === 0
            ? `,pad=1080:1920:0:0:color=black`
            : '';

          filterParts.push(
            `[${splitLabel}_${fi}]crop=${panelCropW}:${FULL_H}:${cx}:0,`
            + `scale=1080:${segHeight}:flags=lanczos,`
            + `unsharp=5:5:0.8:3:3:0.4,`
            + `setsar=1,setpts=PTS-STARTPTS${dividerFilter}${padFilter}[${subLabel}]`
          );
          vstackInputs.push(`[${subLabel}]`);
        }

        // P2.4: Overlay panels with a 0.4s slide-in transition animation
        if (faceCount === 2) {
          filterParts.push(
            `[sf${segIdx}_0][sf${segIdx}_1]overlay=x=0:y='if(lt(t,0.4),1920-(1920-${segHeight + DIVIDER_PX})*(t/0.4),${segHeight + DIVIDER_PX})':shortest=1,`
            + `setsar=1,fps=30000/1001,settb=AVTB,setpts=PTS-STARTPTS[${vLabel}]`
          );
        } else if (faceCount === 3) {
          const y1 = segHeight + DIVIDER_PX;
          const y2 = 2 * (segHeight + DIVIDER_PX);
          filterParts.push(
            `[sf${segIdx}_0][sf${segIdx}_1]overlay=x=0:y='if(lt(t,0.4),1920-(1920-${y1})*(t/0.4),${y1})'[tmp_v${segIdx}]`
          );
          filterParts.push(
            `[tmp_v${segIdx}][sf${segIdx}_2]overlay=x=0:y='if(lt(t,0.4),1920-(1920-${y2})*(t/0.4),${y2})':shortest=1,`
            + `setsar=1,fps=30000/1001,settb=AVTB,setpts=PTS-STARTPTS[${vLabel}]`
          );
        } else {
          // Fallback just in case
          filterParts.push(
            `${vstackInputs.join('')}vstack=inputs=${faceCount},`
            + `setsar=1,fps=30000/1001,settb=AVTB,setpts=PTS-STARTPTS[${vLabel}]`
          );
        }
        filterParts.push(
          `[0:a]atrim=start=${segStart}:end=${segEnd},asetpts=PTS-STARTPTS[${aLabel}]`
        );
        log('SPLIT', `Seg ${segIdx}: ${faceCount}-way vstack cw=${panelCropW} divider=${DIVIDER_PX}px [${segStart}s-${segEnd}s]${hasTransition ? ' +xfade' : ''}`);
      }

      segIdx++;
    }

    if (segIdx === 0) {
      throw new Error('No valid split segments produced');
    }

    // ── Build output chain: xfade or concat ──
    const anyXFade = segIdx > 1 && segTransitions.some(t => t?.type === 'crossfade');

    if (anyXFade) {
      // P1.1: xfade/acrossfade chain for smooth transitions between segments
      // Each xfade blends the last fadeDuration seconds of the previous segment
      // with the first fadeDuration seconds of the next segment.
      let currentVLabel = 'sv0';
      let currentALabel = 'sa0';
      let accumDuration = segDurations[0];

      for (let i = 1; i < segIdx; i++) {
        const transition = segTransitions[i];
        const fadeDuration = transition?.type === 'crossfade'
          ? Math.max(0.001, Math.min(transition.duration, segDurations[i] * 0.5, segDurations[i - 1] * 0.5))
          : 0.001;
        const offset = Math.max(0, accumDuration - fadeDuration);
        const isLast = i === segIdx - 1;
        const vOut = isLast ? 'outv' : `xf${i - 1}`;
        const aOut = isLast ? 'outa' : `axf${i - 1}`;

        filterParts.push(
          `[${currentVLabel}][sv${i}]xfade=transition=fade:duration=${fadeDuration.toFixed(3)}:offset=${offset.toFixed(3)}[${vOut}]`
        );
        filterParts.push(
          `[${currentALabel}][sa${i}]acrossfade=d=${fadeDuration.toFixed(3)}[${aOut}]`
        );

        currentVLabel = vOut;
        currentALabel = aOut;
        accumDuration += segDurations[i] - fadeDuration;
      }

      const totalOverlap = segDurations.reduce((s, d) => s + d, 0) - accumDuration;
      log('XFADE', `${segIdx} segments chained via xfade, total=${accumDuration.toFixed(2)}s, overlap=${totalOverlap.toFixed(2)}s`);
    } else {
      // Standard concat (no transitions)
      let concatInputStr = '';
      for (let i = 0; i < segIdx; i++) {
        concatInputStr += `[sv${i}][sa${i}]`;
      }
      filterParts.push(
        `${concatInputStr}concat=n=${segIdx}:v=1:a=1[outv][outa]`
      );
    }

    // P0: Move ASS rendering to post-xfade (single ASS instance instead of N)
    // This eliminates the per-segment ass filter frame buffering that caused OOM
    const finalVideoLabel = subtitleFilter ? 'outv_final' : 'outv';
    if (subtitleFilter) {
      const assFilter = subtitleFilter.startsWith(',') ? subtitleFilter.substring(1) : subtitleFilter;
      filterParts.push(`[outv]${assFilter}[${finalVideoLabel}]`);
    }

    const filterComplex = filterParts.join(';');

    // Memory diagnostics: filter graph complexity
    const totalNodes = filterParts.length;
    const assCount = filterComplex.split('ass=').length - 1;
    log('FILTER', `Graph: ${totalNodes} filter nodes, ${assCount} ass instances (was ${segIdx} before post-xfade optimization)`);
    let cmd: string;

    // Use filter_complex_script when the filter is long (Windows cmd.exe 8191 char limit)
    // On Windows, always use filter_script to avoid cmd.exe quoting/escaping issues
    const useFilterScript = platform() === 'win32' || filterComplex.length > 4000;
    if (useFilterScript) {
      const effectiveRenderId = renderId || `render_${Math.round(jobStartTime)}s`;
      const filterScriptPath = join(TEMP_DIR, `filter_${effectiveRenderId}.txt`);
      writeFileSync(filterScriptPath, filterComplex, 'utf-8');
      log('SPLIT', `Using filter_script (${filterComplex.length} chars → ${filterScriptPath})`);
      cmd = `${ffmpegPath} -y -i "${sourceVideo}"`
        + ` -filter_complex_script "${filterScriptPath}"`
        + ` -map "[${finalVideoLabel}]" -map "[outa]" ${ENC} "${outputPath}"`;
    } else {
      cmd = `${ffmpegPath} -y -i "${sourceVideo}"`
        + ` -filter_complex "${filterComplex}"`
        + ` -map "[${finalVideoLabel}]" -map "[outa]" ${ENC} "${outputPath}"`;
    }

    log('SPLIT', `Single-pass render: ${segIdx} segments${anyXFade ? ' (xfade)' : ''} (${segments.filter(s => s.crops.some(c => c.isReaction)).length} reaction cuts), ${hasNvenc ? 'NVENC' : 'libx264'}, filter=${filterComplex.length} chars`);
    try {
      execSync(cmd, { ...EXEC_OPTS, timeout: 300_000 });
    } catch (renderErr: any) {
      // Save full stderr to a file for post-mortem
      const errorLogPath = join(TEMP_DIR, `${renderId || 'render'}_ffmpeg_stderr.log`);
      const stderrContent = renderErr.stderr || renderErr.message || 'No stderr captured';
      try {
        writeFileSync(errorLogPath, stderrContent, 'utf-8');
        log('SPLIT', `Full stderr saved to: ${errorLogPath}`);
      } catch {}
      // Print last 100 lines of stderr to console
      const stderrLines = (stderrContent as string).split('\n');
      const tailLines = stderrLines.slice(Math.max(0, stderrLines.length - 100));
      log('SPLIT', `--- ffmpeg stderr (last ${tailLines.length} lines) ---`);
      for (const line of tailLines) {
        if (line.trim()) log('SPLIT', `  ${line}`);
      }
      log('SPLIT', `--- end ffmpeg stderr ---`);
      throw renderErr;
    }

    if (!existsSync(outputPath)) {
      throw new Error('Split render produced no output file');
    }
    log('SPLIT', `✅ Single-pass complete: ${outputPath}`);
  } finally {
    // Cleanup temp files
  }
}

// =============================================================================
// NVENC Detection
// =============================================================================

let _hasNvenc: boolean | null = null;

function hasNvidiaEncoder(): boolean {
  if (_hasNvenc !== null) return _hasNvenc;

  try {
    const out = execSync('ffmpeg -encoders 2>/dev/null | grep -i nvenc', {
      ...EXEC_OPTS, timeout: 5000, shell: '/bin/sh'
    });
    _hasNvenc = (out as string).includes('nvenc');
    if (_hasNvenc) log('ENCODER', 'NVIDIA NVENC detected — using GPU encoding');
    return _hasNvenc;
  } catch {
    try {
      // Windows fallback
      const out = execSync('ffmpeg -encoders 2>&1 | findstr nvenc', {
        ...EXEC_OPTS, timeout: 5000, shell: process.env.COMSPEC || 'cmd.exe'
      });
      _hasNvenc = (out as string).includes('nvenc');
      if (_hasNvenc) log('ENCODER', 'NVIDIA NVENC detected — using GPU encoding');
      return _hasNvenc;
    } catch {
      _hasNvenc = false;
      log('ENCODER', 'NVENC not available — using libx264 CPU encoding');
      return false;
    }
  }
}
