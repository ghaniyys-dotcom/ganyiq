/**
 * worker/index.ts — Residential Worker Agent for GANYIQ
 *
 * Runs on PC-GANY (Windows) or LAPTOP-GANY.
 * Downloads audio via yt-dlp, transcribes via Deepgram, submits to API.
 *
 * Usage:
 *   npx tsx worker/index.ts
 *
 * Environment (.env.local):
 *   GANYIQ_API_URL       = https://ganyiq.ganys.me
 *   DEEPGRAM_API_KEY     = your_deepgram_key
 *   WORKER_NAME          = PC-GANY (default)
 *   POLL_INTERVAL_MS     = 30000 (default)
 *   WORKER_ID            = (set after first registration)
 *   WORKER_API_KEY       = (set after first registration)
 *   HF_TOKEN             = (optional) HuggingFace token for PyAnnote speaker diarization
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, unlinkSync } from 'fs';
import { join, resolve } from 'path';
import { execSync, ExecSyncOptions } from 'child_process';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const APP_VERSION = 'WORKER-v1.1.0';
const ENV_PATH = resolve(__dirname || '.', '.env.local');
const TEMP_DIR = resolve(__dirname || '.', 'temp');

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
  };
}

interface TranscriptSegment {
  start: number;
  duration: number;
  text: string;
}

interface DeepgramResult {
  segments: TranscriptSegment[];
  full_transcript: string;
  confidence: number;
  duration_ms: number;
}

/** Shared exec options for yt-dlp/ffmpeg calls. */
import { platform } from 'os';
import { renderClip } from './clip-renderer';

/** Path to the system shell — cmd.exe on Windows, /bin/sh on Unix. */
const SHELL = platform() === 'win32' ? (process.env.COMSPEC || 'cmd.exe') : '/bin/sh';

const EXEC_OPTS = {
  stdio: 'pipe' as const,
  timeout: 300_000,
  shell: SHELL,
  encoding: 'utf-8' as const,
};

// ---------------------------------------------------------------------------
// Config Management
// ---------------------------------------------------------------------------

function loadEnv(): EnvConfig {
  const config: Record<string, string> = {};

  if (existsSync(ENV_PATH)) {
    const content = readFileSync(ENV_PATH, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      config[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
    }
  }

  // Also read from process.env (higher priority)
  return {
    GANYIQ_API_URL: (process.env.GANYIQ_API_URL || config.GANYIQ_API_URL || 'https://ganyiq.ganys.me').replace(/\/+$/, ''),
    DEEPGRAM_API_KEY: process.env.DEEPGRAM_API_KEY || config.DEEPGRAM_API_KEY || '',
    WORKER_NAME: process.env.WORKER_NAME || config.WORKER_NAME || 'PC-GANY',
    POLL_INTERVAL_MS: parseInt(process.env.POLL_INTERVAL_MS || config.POLL_INTERVAL_MS || '30000', 10),
    FFMPEG_LOCATION: process.env.FFMPEG_LOCATION || config.FFMPEG_LOCATION || undefined,
    WORKER_ID: process.env.WORKER_ID || config.WORKER_ID,
    WORKER_API_KEY: process.env.WORKER_API_KEY || config.WORKER_API_KEY,
    HF_TOKEN: process.env.HF_TOKEN || config.HF_TOKEN || undefined,
  };
}

function saveToEnv(key: string, value: string): void {
  let content = '';
  let found = false;

  if (existsSync(ENV_PATH)) {
    const lines = readFileSync(ENV_PATH, 'utf-8').split('\n');
    for (const line of lines) {
      if (line.trim().startsWith(`${key}=`)) {
        content += `${key}=${value}\n`;
        found = true;
      } else {
        content += line + '\n';
      }
    }
    if (!found) {
      content += `${key}=${value}\n`;
    }
  } else {
    content = `${key}=${value}\n`;
  }

  writeFileSync(ENV_PATH, content.trim() + '\n', 'utf-8');
  // Also set in process.env for this session
  process.env[key] = value;
}

// ---------------------------------------------------------------------------
// API Helpers
// ---------------------------------------------------------------------------

async function apiPost(path: string, body: unknown, token?: string): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const url = `${loadEnv().GANYIQ_API_URL}${path}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 120_000); // 2 min timeout

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function apiGet(path: string, token: string): Promise<Response> {
  const url = `${loadEnv().GANYIQ_API_URL}${path}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 60_000); // 1 min timeout

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` },
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

// ---------------------------------------------------------------------------
// Worker Registration
// ---------------------------------------------------------------------------

async function register(env: EnvConfig): Promise<void> {
  log('REGISTER', `Registering as "${env.WORKER_NAME}"...`);

  const response = await apiPost('/api/workers/register', {
    worker_name: env.WORKER_NAME,
  });

  if (!response.ok) {
    const body = await response.json();
    if (response.status === 409) {
      // Worker already exists — need manual recovery
      log('ERROR', `Worker "${env.WORKER_NAME}" already registered.`);
      log('ERROR', 'Run: curl -X POST https://GANYIQ_API_URL/api/workers/register -H "Content-Type: application/json" -d \'{"worker_name":"PC-GANY-NEW"}\'');
      log('ERROR', 'Or check the workers table in Neon dashboard.');
      process.exit(1);
    }
    throw new Error(`Registration failed (${response.status}): ${JSON.stringify(body)}`);
  }

  const data = await response.json();
  const workerId: string = data.worker_id;
  const apiKey: string = data.api_key;

  saveToEnv('WORKER_ID', workerId);
  saveToEnv('WORKER_API_KEY', apiKey);

  log('REGISTER', `Registered successfully!`);
  log('REGISTER', `  Worker ID:  ${workerId}`);
  log('REGISTER', `  API Key:    ${apiKey.slice(0, 8)}...${apiKey.slice(-8)}`);
  log('REGISTER', `  Saved to:   ${ENV_PATH}`);
}

// ---------------------------------------------------------------------------
// Heartbeat
// ---------------------------------------------------------------------------

async function sendHeartbeat(env: EnvConfig): Promise<void> {
  if (!env.WORKER_ID || !env.WORKER_API_KEY) return;

  try {
    const response = await apiPost(
      `/api/workers/${env.WORKER_ID}/heartbeat`,
      { version: APP_VERSION },
      env.WORKER_API_KEY,
    );

    if (!response.ok) {
      log('HEARTBEAT', `Failed (${response.status})`);
    }
  } catch (err) {
    // Heartbeat failure is non-fatal (network blips)
    debug('Heartbeat failed:', (err as Error).message);
  }
}

// ---------------------------------------------------------------------------
// Deepgram Transcription via yt-dlp
// ---------------------------------------------------------------------------

async function transcribe(youtubeUrl: string, deepgramKey: string, ffmpegLocation?: string): Promise<DeepgramResult> {
  const videoId = extractVideoId(youtubeUrl);
  const audioPath = join(TEMP_DIR, `${videoId}.mp3`);
  const segments: TranscriptSegment[] = [];

  log('YTDLP', `Downloading audio: ${youtubeUrl}`);

  // Ensure temp directory
  if (!existsSync(TEMP_DIR)) {
    execSync(`mkdir "${TEMP_DIR}"`, EXEC_OPTS);
  }

  // Download audio with yt-dlp
  try {
    const ffmpegFlag = ffmpegLocation
      ? `--ffmpeg-location "${ffmpegLocation}"`
      : '';
    execSync(
      `yt-dlp --extractor-args "youtube:player_client=android" ${ffmpegFlag} -x --audio-format mp3 -o "${audioPath}" "${youtubeUrl}" --no-playlist --quiet`,
      EXEC_OPTS,
    );
  } catch (err) {
    throw new Error(`yt-dlp failed: ${(err as Error).message}`);
  }

  log('DEEPGRAM', `Transcribing: ${audioPath}`);

  // Read audio file
  const audioBuffer = readFileSync(audioPath);
  const audioMimeType = 'audio/mp3';

  // Call Deepgram API
  const dgUrl = new URL('https://api.deepgram.com/v1/listen');
  dgUrl.searchParams.set('model', 'nova-2');
  dgUrl.searchParams.set('language', 'id');
  dgUrl.searchParams.set('smart_format', 'true');
  dgUrl.searchParams.set('punctuate', 'true');
  dgUrl.searchParams.set('utterances', 'true');
  dgUrl.searchParams.set('paragraphs', 'true');

  const dgResponse = await fetch(dgUrl.toString(), {
    method: 'POST',
    headers: {
      'Authorization': `Token ${deepgramKey}`,
      'Content-Type': audioMimeType,
    },
    body: audioBuffer,
  });

  if (!dgResponse.ok) {
    const errText = await dgResponse.text();
    throw new Error(`Deepgram API error (${dgResponse.status}): ${errText.slice(0, 200)}`);
  }

  const dgData = await dgResponse.json();

  // Parse response
  const channels = dgData?.results?.channels;
  if (!channels || channels.length === 0) {
    throw new Error('Deepgram returned empty results.');
  }

  const alternatives = channels[0]?.alternatives;
  if (!alternatives || alternatives.length === 0) {
    throw new Error('Deepgram returned no alternatives.');
  }

  const alt = alternatives[0];
  const words = alt.words || [];
  const fullTranscript = alt.paragraphs?.transcript || alt.transcript || '';

  // Build segments from words (group into ~5-second chunks)
  let currentSegment: { start: number; text: string[] } | null = null;
  const SEGMENT_TARGET = 5.0;

  for (const word of words) {
    const wordStart = word.start || 0;
    const wordEnd = word.end || 0;
    const wordText = word.word || '';
    const wordDuration = wordEnd - wordStart;

    if (!currentSegment) {
      currentSegment = { start: wordStart, text: [wordText] };
    } else {
      const segmentDuration = wordStart + wordDuration - currentSegment.start;
      if (segmentDuration > SEGMENT_TARGET) {
        // Finalize current segment
        segments.push({
          start: currentSegment.start,
          duration: wordStart - currentSegment.start,
          text: currentSegment.text.join(' '),
        });
        currentSegment = { start: wordStart, text: [wordText] };
      } else {
        currentSegment.text.push(wordText);
      }
    }
  }

  // Push last segment
  if (currentSegment) {
    const lastWord = words[words.length - 1];
    const endTime = lastWord ? (lastWord.start || 0) + (lastWord.end || 0) - (lastWord.start || 0) : 0;
    segments.push({
      start: currentSegment.start,
      duration: endTime - currentSegment.start,
      text: currentSegment.text.join(' '),
    });
  }

  // Calculate confidence from words
  const wordConfidences = words
    .filter((w: { confidence?: number }) => w.confidence !== undefined)
    .map((w: { confidence: number }) => w.confidence);
  const avgConfidence = wordConfidences.length > 0
    ? wordConfidences.reduce((a: number, b: number) => a + b, 0) / wordConfidences.length
    : 0;

  // Calculate duration from words
  const totalDurationMs = words.length > 0
    ? Math.round(((words[words.length - 1]?.end || 0) - (words[0]?.start || 0)) * 1000)
    : 0;

  // Cleanup temp file on Windows
  try {
    execSync(`del /f "${audioPath}"`, EXEC_OPTS);
  } catch {
    try { writeFileSync(audioPath, ''); } catch { /* ignore */ }
  }

  log('DEEPGRAM', `Done: ${segments.length} segments, confidence: ${avgConfidence.toFixed(3)}`);

  return {
    segments,
    full_transcript: fullTranscript,
    confidence: avgConfidence,
    duration_ms: totalDurationMs,
  };
}

// ---------------------------------------------------------------------------
// Job Processing
// ---------------------------------------------------------------------------

async function pollAndProcessJob(env: EnvConfig): Promise<void> {
  if (!env.WORKER_ID || !env.WORKER_API_KEY) return;

  const response = await apiGet(
    `/api/workers/jobs/poll?worker_id=${env.WORKER_ID}`,
    env.WORKER_API_KEY,
  );

  if (response.status === 204) {
    debug('No jobs available, waiting...');
    return;
  }

  if (!response.ok) {
    const body = await response.json();
    log('POLL', `Poll failed (${response.status}): ${JSON.stringify(body)}`);
    return;
  }

  const data = await response.json();
  const job: Job = data.job;

  log('JOB', `Claimed job ${job.id}`);
  log('JOB', `  Video: ${job.youtubeId}`);
  log('JOB', `  Type:  ${job.jobType || 'transcript'}`);
  log('JOB', `  URL:   ${job.youtubeUrl}`);

  // Branch by job type
  if (job.jobType === 'clip') {
    try {
      await renderClip(job, env, () => sendHeartbeat(env));
    } catch (err) {
      const execErr = err as any;
      const errorMsg = (execErr.message || String(err)).slice(0, 2000);
      const stderrStr = execErr.stderr ? execErr.stderr.toString().slice(0, 3000) : '';
      log('CLIP', `❌ Failed: ${errorMsg}`);
      if (stderrStr) log('CLIP', `ffmpeg stderr:\n${stderrStr}`);

      // Report failure
      await apiPost(
        `/api/workers/jobs/${job.id}/fail`,
        {
          worker_id: env.WORKER_ID,
          error_message: errorMsg,
        },
        env.WORKER_API_KEY,
      ).catch(() => {}); // fail-report failure is non-fatal
    }
    return;
  }

  // ── Scene + Visual job ──
  if (job.jobType === 'scene_video') {
    try {
      await handleSceneVideo(job as Job, env);
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      const errorMsg = e.message.slice(0, 2000);
      log('SCENE', `❌ Failed: ${errorMsg}`);
      await apiPost(
        `/api/workers/jobs/${job.id}/fail`,
        { worker_id: env.WORKER_ID, error_message: errorMsg },
        env.WORKER_API_KEY,
      ).catch(() => {});
    }
    return;
  }

  // ── Transcript job (existing flow) ──
  try {
    // Check if we have a Deepgram API key
    if (!env.DEEPGRAM_API_KEY) {
      throw new Error('DEEPGRAM_API_KEY is not configured. Set it in .env.local');
    }

    const result = await transcribe(job.youtubeUrl, env.DEEPGRAM_API_KEY, env.FFMPEG_LOCATION);

    log('JOB', `Submitting result (${result.segments.length} segments)...`);

    const submitResponse = await apiPost(
      `/api/workers/jobs/${job.id}/complete`,
      {
        worker_id: env.WORKER_ID,
        segments: result.segments,
        full_transcript: result.full_transcript,
        confidence: result.confidence,
        duration_ms: result.duration_ms,
      },
      env.WORKER_API_KEY,
    );

    if (submitResponse.ok) {
      const submitData = await submitResponse.json();
      log('JOB', `✅ Completed! Job: ${job.id}, Segments: ${submitData.segments_count}`);
    } else {
      // Use text() not json() — error body may be HTML (Nginx error page)
      const errBodyText = await submitResponse.text().catch(() => '(no body)');
      log('JOB', `❌ Submit failed (${submitResponse.status}): ${errBodyText.slice(0, 500)}`);
    }
  } catch (err) {
    const error = err as Error & { cause?: unknown };
    const causeStr = error.cause
      ? ` | cause=${error.cause instanceof Error ? error.cause.message : String(error.cause)}`
      : '';
    const errorMsg = error.message.slice(0, 2000);
    log('JOB', `❌ Failed: ${errorMsg}${causeStr}`);

    // Report failure (non-fatal — API may also be unreachable)
    try {
      const failResponse = await apiPost(
        `/api/workers/jobs/${job.id}/fail`,
        {
          worker_id: env.WORKER_ID,
          error_message: errorMsg,
        },
        env.WORKER_API_KEY,
      );

      if (failResponse.ok) {
        const failData = await failResponse.json();
        if (failData.will_retry) {
          log('JOB', `  Will retry (attempt ${failData.retry_count}/${failData.max_retries})`);
        } else {
          log('JOB', `  Max retries reached. Job marked as failed.`);
        }
      } else {
        const failText = await failResponse.text().catch(() => '(no body)');
        log('JOB', `  Fail-report returned ${failResponse.status}: ${failText.slice(0, 200)}`);
      }
    } catch (failErr) {
      const fe = failErr as Error & { cause?: unknown };
      const fc = fe.cause ? ` | cause=${fe.cause instanceof Error ? fe.cause.message : String(fe.cause)}` : '';
      log('JOB', `  Fail-report also failed: ${fe.message}${fc}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function extractVideoId(url: string): string {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
    /^([a-zA-Z0-9_-]{11})$/,
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  throw new Error(`Cannot extract video ID from URL: ${url}`);
}

// ---------------------------------------------------------------------------
// Scene + Visual Detection Handler
// ---------------------------------------------------------------------------

interface SceneVideoJob {
  id: string;
  youtubeId: string;
  youtubeUrl: string;
  createdAt: string;
  jobType?: string;
  clipParams?: any;
}

async function handleSceneVideo(job: SceneVideoJob, env: EnvConfig): Promise<void> {
  const youtubeId = extractVideoId(job.youtubeUrl);
  const clipParams = job.clipParams || { analysisId: '', moments: [] };
  const { analysisId, moments } = clipParams;

  log('SCENE', `Processing scene_video job for ${youtubeId}`);
  log('SCENE', `  Analysis: ${analysisId}`);
  log('SCENE', `  Moments:  ${moments.length}`);

  const tmpDir = join(TEMP_DIR, 'scene-video');
  try { execSync(`mkdir -p "${tmpDir}"`, EXEC_OPTS); } catch {}

  const videoPath = join(tmpDir, `${youtubeId}.mp4`);
  const resultsPath = join(tmpDir, `${youtubeId}-results.json`);

  try {
    // Step 1: Download video (up to 720p, ~200MB max)
    log('SCENE', 'Downloading video...');
    const dlCmd = `yt-dlp -f "bestvideo[height<=720][vcodec^=avc1]+bestaudio[ext=m4a]/best[height<=720]" -o "${videoPath}" "${job.youtubeUrl}" --no-playlist --quiet`;
    execSync(dlCmd, { ...EXEC_OPTS, timeout: 600_000 });
    log('SCENE', `Video downloaded: ${videoPath}`);

    // Step 2: Run ffmpeg scene detection
    log('SCENE', 'Running scene detection...');
    const ffmpegCmd = `ffmpeg -i "${videoPath}" -filter:v "select='gt(scene,0.2)',showinfo" -vsync vfr -f null - 2>&1`;
    const ffmpegOut = execSync(ffmpegCmd, { ...EXEC_OPTS, timeout: 300_000 }).toString();
    const scenes: Array<{
      scene_index: number;
      start_time: number;
      end_time: number;
      duration: number;
      score: number;
      transition_type: string;
    }> = [];

    // Parse ffmpeg showinfo output
    const sceneRegex = /pts_time:([\d.]+)/g;
    const timestamps: number[] = [];
    let match;
    while ((match = sceneRegex.exec(ffmpegOut)) !== null) {
      timestamps.push(parseFloat(match[1]));
    }

    // Get video duration
    let videoDuration = 0;
    try {
      const durCmd = `ffprobe -v error -show_entries format=duration -of csv=p=0 "${videoPath}"`;
      videoDuration = parseFloat(execSync(durCmd, EXEC_OPTS).toString().trim()) || 0;
    } catch {}

    // Build scenes
    let prevTime = 0;
    for (let i = 0; i < timestamps.length; i++) {
      const t = timestamps[i];
      const duration = t - prevTime;
      if (duration >= 0.5) {
        scenes.push({
          scene_index: scenes.length + 1,
          start_time: parseFloat(prevTime.toFixed(3)),
          end_time: parseFloat(t.toFixed(3)),
          duration: parseFloat(duration.toFixed(3)),
          score: 0.3,
          transition_type: 'hard_cut',
        });
      }
      prevTime = t;
    }
    // Last scene
    if (videoDuration > prevTime) {
      scenes.push({
        scene_index: scenes.length + 1,
        start_time: parseFloat(prevTime.toFixed(3)),
        end_time: parseFloat(videoDuration.toFixed(3)),
        duration: parseFloat((videoDuration - prevTime).toFixed(3)),
        score: 0,
        transition_type: 'unknown',
      });
    }

    log('SCENE', `Detected ${scenes.length} scenes`);

    // Step 3: Visual quality scoring per moment
    log('SCENE', 'Running visual quality scoring...');
    const scoredMoments: Array<{
      rank_position: number;
      visual_quality_score: number | null;
      sharpness: number | null;
      brightness: number | null;
      exposure: number | null;
      face_visibility: number | null;
      blur_score: number | null;
    }> = [];

    // Create a Python script for visual scoring (uses OpenCV which is installed)
    const pyScript = `
import sys, json, subprocess, os
import cv2
import numpy as np

video_path = sys.argv[1]
start_time = float(sys.argv[2])
end_time = float(sys.argv[3])

cap = cv2.VideoCapture(video_path)
if not cap.isOpened():
    print(json.dumps({"error": "cannot open video"}))
    sys.exit(0)

cap.set(cv2.CAP_PROP_POS_AVI_RATIO, 0)
fps = cap.get(cv2.CAP_PROP_FPS)
if fps <= 0:
    fps = 30

# Sample 5 frames evenly across the clip
sample_times = []
for i in range(5):
    t = start_time + (end_time - start_time) * (i + 0.5) / 5
    sample_times.append(t)

frames = []
for t in sample_times:
    cap.set(cv2.CAP_PROP_POS_FRAMES, int(t * fps))
    ret, frame = cap.read()
    if ret:
        frames.append(frame)
cap.release()

if len(frames) == 0:
    print(json.dumps({"error": "no frames extracted"}))
    sys.exit(0)

# Calculate metrics per frame
brightness_vals = []
sharpness_vals = []
blur_vals = []
face_count = 0
total_faces = 0

for frame in frames:
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    h, w = gray.shape

    # Brightness (0-255 normalized to 0-10)
    brightness_vals.append(float(np.mean(gray)))

    # Sharpness (Laplacian variance)
    laplacian = cv2.Laplacian(gray, cv2.CV_64F)
    sharpness_vals.append(float(laplacian.var()))

    # Blur score (inverse of sharpness, normalized)
    blur = 1.0 / (1.0 + laplacian.var() / 1000.0)
    blur_vals.append(blur)

    # Face detection using Haar cascade
    try:
        face_cascade = cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_frontalface_default.xml')
        faces = face_cascade.detectMultiScale(gray, 1.1, 4)
        face_count += len(faces)
        total_faces += 1
    except:
        pass

avg_brightness = np.mean(brightness_vals) if brightness_vals else 128
avg_sharpness = np.mean(sharpness_vals) if sharpness_vals else 0
avg_blur = np.mean(blur_vals) if blur_vals else 0.5
face_ratio = face_count / max(total_faces, 1)

# Normalize to DB schema ranges
visual_score = min(10, max(0, 10 - avg_blur * 5))
normalized_brightness = min(1, max(0, avg_brightness / 255))
exposure = min(1, max(0, 1 - abs(0.5 - normalized_brightness) * 2))
brightness_score = min(1, max(0, normalized_brightness))
sharpness_score = min(1, max(0, avg_sharpness / 5000))
blur_score = min(1, max(0, avg_blur))
face_visibility = min(1, max(0, face_ratio))

result = {
    "visual_quality_score": round(visual_score, 1),
    "sharpness": round(sharpness_score, 4),
    "brightness": round(brightness_score, 4),
    "exposure": round(exposure, 4),
    "face_visibility": round(face_visibility, 4),
    "blur_score": round(blur_score, 4),
    "frames_analyzed": len(frames)
}
print(json.dumps(result))
`.trim();

    // Write Python script to a temp file (more reliable cross-platform)
    const pyScriptPath = join(tmpDir, 'visual_scorer.py');
    writeFileSync(pyScriptPath, pyScript, 'utf-8');

    for (const m of moments) {
      try {
        const pyCmd = `python3 "${pyScriptPath}" "${videoPath}" ${m.start_time} ${m.end_time}`;
        const pyOut = execSync(pyCmd, { ...EXEC_OPTS, timeout: 60_000 }).toString().trim();
        const parsed = JSON.parse(pyOut);

        scoredMoments.push({
          rank_position: m.rank_position,
          visual_quality_score: parsed.visual_quality_score ?? null,
          sharpness: parsed.sharpness ?? null,
          brightness: parsed.brightness ?? null,
          exposure: parsed.exposure ?? null,
          face_visibility: parsed.face_visibility ?? null,
          blur_score: parsed.blur_score ?? null,
        });
        log('SCENE', `  Moment #${m.rank_position}: visual=${parsed.visual_quality_score || '?'} sharpness=${parsed.sharpness || '?'}`);
      } catch (pyErr) {
        log('SCENE', `  Moment #${m.rank_position} scoring failed, using defaults`);
        scoredMoments.push({
          rank_position: m.rank_position,
          visual_quality_score: 5.0,
          sharpness: 0.5,
          brightness: 0.5,
          exposure: 0.5,
          face_visibility: 0,
          blur_score: 0.5,
        });
      }
    }

    // Step 4: POST results back to VPS
    log('SCENE', `Submitting ${scenes.length} scenes + ${scoredMoments.length} moment scores...`);

    // Save results to file first (debugging)
    const resultsData = JSON.stringify({
      analysis_id: analysisId,
      youtube_id: youtubeId,
      scenes,
      moments: scoredMoments,
    });
    writeFileSync(resultsPath, resultsData, 'utf-8');

    const resp = await apiPost(
      `/api/workers/jobs/${job.id}/scene-complete`,
      {
        worker_id: env.WORKER_ID,
        analysis_id: analysisId,
        youtube_id: youtubeId,
        scenes,
        moments: scoredMoments,
      },
      env.WORKER_API_KEY,
    );

    if (resp.ok) {
      const data = await resp.json();
      log('SCENE', `✅ Done: ${data.scenes_inserted} scenes, ${data.moments_updated} moments updated`);
    } else {
      const errText = await resp.text().catch(() => '(no body)');
      log('SCENE', `❌ Submit failed (${resp.status}): ${errText.slice(0, 300)}`);
    }
  } finally {
    // Cleanup
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------
function log(tag: string, message: string): void {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] [${tag.padEnd(10)}] ${message}`);
}

function debug(...args: unknown[]): void {
  if (process.env.DEBUG_WORKER === 'true') {
    console.log('[DEBUG]', ...args);
  }
}

// ---------------------------------------------------------------------------
// Main Loop
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║        GANYIQ Residential Worker         ║');
  console.log(`║           ${APP_VERSION.padEnd(31)}║`);
  console.log('╚══════════════════════════════════════════╝');
  console.log('');

  const env = loadEnv();

  log('CONFIG', `API URL:        ${env.GANYIQ_API_URL}`);
  log('CONFIG', `Worker Name:    ${env.WORKER_NAME}`);
  log('CONFIG', `Poll Interval:  ${env.POLL_INTERVAL_MS}ms`);
  log('CONFIG', `FFmpeg Path:    ${env.FFMPEG_LOCATION || 'default (PATH)'}`);
  log('CONFIG', `Deepgram Key:   ${env.DEEPGRAM_API_KEY ? env.DEEPGRAM_API_KEY.slice(0, 8) + '...' : 'NOT SET'}`);
  log('CONFIG', `Worker ID:      ${env.WORKER_ID || 'NOT REGISTERED'}`);

  // Register if needed
  if (!env.WORKER_ID || !env.WORKER_API_KEY) {
    await register(env);
    // Reload env after registration
    Object.assign(env, loadEnv());
  }

  if (!env.DEEPGRAM_API_KEY) {
    log('WARN', 'DEEPGRAM_API_KEY is not set. Transcription will fail.');
    log('WARN', 'Add DEEPGRAM_API_KEY=<your_key> to .env.local and restart.');
  }

  log('MAIN', 'Worker started. Press Ctrl+C to stop.');
  console.log('');

  // Send initial heartbeat
  await sendHeartbeat(env);

  // Start heartbeat interval (60 seconds)
  setInterval(() => sendHeartbeat(env), 60_000);

  // Main poll loop
  while (true) {
    try {
      await pollAndProcessJob(env);
    } catch (err) {
      log('MAIN', `Unexpected error: ${(err as Error).message}`);
    }

    await sleep(env.POLL_INTERVAL_MS);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

main().catch((err) => {
  log('FATAL', (err as Error).message);
  process.exit(1);
});
