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

import { readFileSync, writeFileSync, existsSync } from 'fs';
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
      `yt-dlp --remote-components ejs:github --extractor-args "youtube:player_client=android" ${ffmpegFlag} -x --audio-format mp3 -o "${audioPath}" "${youtubeUrl}" --no-playlist --quiet`,
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
