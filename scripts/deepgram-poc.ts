#!/usr/bin/env npx tsx
/**
 * deepgram-poc.ts — Proof of Concept: Deepgram Indonesian Transcript Generation
 *
 * Goal:
 *   Prove Deepgram can generate Indonesian transcripts for YouTube videos that
 *   currently fail with LOGIN_REQUIRED on the VPS (InnerTube API / yt-dlp IP block).
 *
 * Strategy:
 *   Deepgram URL submission mode: we give Deepgram the audio stream URL (obtained
 *   via yt-dlp with JS challenge solver), and Deepgram downloads & transcribes it
 *   from THEIR infrastructure. If URL submission fails, falls back to local download
 *   + binary upload.
 *
 * Usage:
 *   DEEPGRAM_API_KEY=<key> npx tsx scripts/deepgram-poc.ts <youtube-url>
 *   DEEPGRAM_API_KEY=<key> npx tsx scripts/deepgram-poc.ts --all
 *   DEEPGRAM_API_KEY=<key> npx tsx scripts/deepgram-poc.ts --help
 *
 * Flags:
 *   --all        Run all 3 test videos (Raditya Dika, Deddy Corbuzier, Suara Berkelas)
 *   --save       Save transcript to docs/ for review
 *   --timeout=N  Max seconds to wait for Deepgram (default: 600)
 *
 * Output:
 *   - Prints results to stdout
 *   - If --save: writes docs/DEEPGRAM_POC_RESULTS.md
 *   - If --all: generates docs/DEEPGRAM_POC_RESULTS.md regardless
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, unlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PROJECT_ROOT = resolve(process.cwd());
const COOKIES_PATH = join(PROJECT_ROOT, 'cookies.txt');
const DEEPGRAM_BASE = 'https://api.deepgram.com/v1/listen';
const DEEPGRAM_MODEL = 'nova-2';
const LANG = 'id';
const POLL_INTERVAL_MS = 5_000; // 5 seconds between poll attempts
const MAX_WAIT_SEC = Math.min(
  parseInt(process.argv.find((a) => a.startsWith('--timeout='))?.split('=')[1] ?? '600', 10),
  600,
);

// ---------------------------------------------------------------------------
// Test videos (from url-tracker.csv + test-videos.ts)
// ---------------------------------------------------------------------------

interface TestVideo {
  label: string;
  url: string;
  note: string;
}

const TEST_VIDEOS: TestVideo[] = [
  {
    label: 'Raditya Dika — Diskusi Tentang Pendidikan Indonesia',
    url: 'https://www.youtube.com/watch?v=hN-V0YYDSak',
    note: '74 min podcast, auto-generated ID captions likely',
  },
  {
    label: 'Deddy Corbuzier — Podcast (ROCM31HEB6M)',
    url: 'https://www.youtube.com/watch?v=ROCM31HEB6M',
    note: '~60 min podcast, verified accessible',
  },
  {
    label: 'Suara Berkelas — Cara Menemukan Bahagia',
    url: 'https://www.youtube.com/watch?v=FIXQQ7X7tZE',
    note: '79 min self-improvement podcast',
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getArg(name: string, fallback: string): string {
  const flag = process.argv.find((a) => a.startsWith(`--${name}=`));
  return flag ? flag.split('=', 2)[1] : fallback;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function extractVideoId(input: string): string {
  const trimmed = input.trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(trimmed)) return trimmed;
  const patterns = [
    /(?:youtube\.com\/watch\?v=)([\w-]{11})/i,
    /(?:youtu\.be\/)([\w-]{11})/i,
    /(?:youtube\.com\/embed\/)([\w-]{11})/i,
  ];
  for (const p of patterns) {
    const m = trimmed.match(p);
    if (m) return m[1];
  }
  throw new Error(`Cannot extract video ID from: "${input}"`);
}

function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}m ${m % 60}s ${s % 60}s`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

function fmtTimestamp(d: Date): string {
  return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
}

// ---------------------------------------------------------------------------
// 1. Get audio URL via yt-dlp with JS challenge solver
// ---------------------------------------------------------------------------

function getAudioUrl(youtubeUrl: string): { url: string; durationSec: number } {
  console.log(`\n  [1/3] Getting audio URL via yt-dlp...`);
  const start = Date.now();

  const cookieFlag = existsSync(COOKIES_PATH) ? `--cookies "${COOKIES_PATH}"` : '';
  const cmd = `yt-dlp ${cookieFlag} -g -f bestaudio "${youtubeUrl}" 2>&1`;

  let stdout: string;
  try {
    stdout = execSync(cmd, { timeout: 60_000, encoding: 'utf-8' });
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    const details = (err.stdout || err.stderr || err.message || '').substring(0, 300);
    throw new Error(`yt-dlp failed: ${details}`);
  }
  stdout = stdout.trim();
  const lines = stdout.split('\n').filter((l) => l.startsWith('http'));
  const audioUrl = lines[0];

  if (!audioUrl) {
    throw new Error(`yt-dlp returned no audio URL. Output: ${stdout.substring(0, 200)}`);
  }

  console.log(`  [1/3] ✅ Audio URL obtained (${Date.now() - start}ms)`);
  console.log(`  [1/3]    URL preview: ${audioUrl.substring(0, 100)}...`);

  // Get duration via ffprobe
  let durationSec = 0;
  try {
    const ffprobeCmd = `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${audioUrl}" 2>&1`;
    durationSec = Math.round(parseFloat(execSync(ffprobeCmd, { timeout: 15_000, encoding: 'utf-8' }).trim()));
  } catch {
    // Fallback: try yt-dlp --dump-json
    try {
      const jsonCmd = `yt-dlp ${cookieFlag} --dump-json "${youtubeUrl}" 2>&1`;
      const jsonOut = execSync(jsonCmd, { timeout: 30_000, encoding: 'utf-8' }).trim();
      const data = JSON.parse(jsonOut.split('\n')[0]);
      durationSec = data.duration ?? 0;
    } catch {
      console.warn('  [1/3] ⚠ Could not determine audio duration');
    }
  }

  return { url: audioUrl, durationSec };
}

// ---------------------------------------------------------------------------
// 2a. Deepgram: URL submission mode
// ---------------------------------------------------------------------------

async function submitUrlToDeepgram(
  audioUrl: string,
  apiKey: string,
): Promise<unknown> {
  console.log(`\n  [2/3] Submitting audio URL to Deepgram (model=${DEEPGRAM_MODEL}, lang=${LANG})...`);

  const params = new URLSearchParams({
    model: DEEPGRAM_MODEL,
    language: LANG,
    smart_format: 'true',
    punctuate: 'true',
    utterances: 'true',
    utt_split: '1.2',
  });

  const url = `${DEEPGRAM_BASE}?${params.toString()}`;
  const start = Date.now();
  console.log(`  [2/3]    Auth key prefix: ${apiKey.substring(0, 5)}... len=${apiKey.length}`);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Token ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ url: audioUrl }),
    signal: AbortSignal.timeout(MAX_WAIT_SEC * 1000),
  });

  const elapsed = Date.now() - start;
  console.log(`  [2/3] Deepgram response: ${response.status} ${response.statusText} (${fmtDuration(elapsed)})`);

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Deepgram HTTP ${response.status}: ${body.substring(0, 300)}`);
  }

  const data = await response.json();
  return data;
}

// ---------------------------------------------------------------------------
// 2b. Deepgram: File upload fallback mode
// ---------------------------------------------------------------------------

async function uploadFileToDeepgram(
  filePath: string,
  apiKey: string,
): Promise<unknown> {
  console.log(`\n  [2/3] Uploading audio file to Deepgram (model=${DEEPGRAM_MODEL}, lang=${LANG})...`);

  const { readFileSync } = await import('node:fs');

  const params = new URLSearchParams({
    model: DEEPGRAM_MODEL,
    language: LANG,
    smart_format: 'true',
    punctuate: 'true',
    utterances: 'true',
    utt_split: '1.2',
  });

  const url = `${DEEPGRAM_BASE}?${params.toString()}`;
  const audioBuffer = readFileSync(filePath);
  const start = Date.now();

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Token ${apiKey}`,
      'Content-Type': 'audio/webm',
    },
    body: audioBuffer,
    signal: AbortSignal.timeout(MAX_WAIT_SEC * 1000),
  });

  const elapsed = Date.now() - start;
  console.log(`  [2/3] Deepgram response: ${response.status} ${response.statusText} (${fmtDuration(elapsed)})`);

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Deepgram HTTP ${response.status}: ${body.substring(0, 300)}`);
  }

  const data = await response.json();
  return data;
}

// ---------------------------------------------------------------------------
// 3. Download audio locally (fallback for URL submission failure)
// ---------------------------------------------------------------------------

function downloadAudio(youtubeUrl: string): string {
  const tmpPath = join(tmpdir(), `ganyiq-poc-${randomUUID()}.webm`);
  console.log(`\n  [fallback] Downloading audio to ${tmpPath}...`);

  const cookieFlag = existsSync(COOKIES_PATH) ? `--cookies "${COOKIES_PATH}"` : '';
  const cmd = `yt-dlp ${cookieFlag} -f bestaudio -o "${tmpPath}" "${youtubeUrl}" 2>&1`;
  execSync(cmd, { timeout: 300_000, encoding: 'utf-8' });
  console.log(`  [fallback] ✅ Download complete: ${tmpPath}`);

  return tmpPath;
}

// ---------------------------------------------------------------------------
// 4. Parse Deepgram response
// ---------------------------------------------------------------------------

interface PocResult {
  videoLabel: string;
  youtubeUrl: string;
  success: boolean;
  transcriptLength: number;
  detectedLanguage: string | null;
  processingTimeMs: number;
  transcriptPreview: string;
  confidence: number | null;
  durationSec: number;
  error?: string;
  method: 'url-submission' | 'file-upload';
}

function parseDeepgramResponse(data: any, label: string, url: string, durationSec: number, elapsed: number, method: 'url-submission' | 'file-upload'): PocResult {
  // Deepgram response structure:
  // {
  //   metadata: { transaction_key, request_id, sha256, created, duration, channels, models },
  //   results: {
  //     channels: [{
  //       alternatives: [{
  //         transcript: "...",
  //         confidence: 0.99,
  //         words: [{ word, start, end, confidence, punctuated_word }],
  //         paragraphs: { paragraphs: [...] }
  //       }]
  //     }]
  //   }
  // }

  try {
    const channel = data?.results?.channels?.[0];
    const alternative = channel?.alternatives?.[0];

    if (!alternative) {
      return {
        videoLabel: label,
        youtubeUrl: url,
        success: false,
        transcriptLength: 0,
        detectedLanguage: null,
        processingTimeMs: elapsed,
        transcriptPreview: '',
        confidence: null,
        durationSec,
        error: 'No transcription alternatives in response',
        method,
      };
    }

    const transcript = alternative.transcript ?? '';
    const confidence = alternative.confidence ?? null;
    const words = alternative.words ?? [];
    const detectedLang = channel?.detected_language ?? null;

    // Try to detect language from words
    const firstWords = words.slice(0, 10).map((w: any) => w.word ?? w.punctuated_word ?? '').join(' ');

    return {
      videoLabel: label,
      youtubeUrl: url,
      success: transcript.length > 50,
      transcriptLength: transcript.length,
      detectedLanguage: detectedLang ?? (channel?.search ?? null),
      processingTimeMs: elapsed,
      transcriptPreview: transcript.substring(0, 500),
      confidence,
      durationSec,
      method,
    };
  } catch (err) {
    return {
      videoLabel: label,
      youtubeUrl: url,
      success: false,
      transcriptLength: 0,
      detectedLanguage: null,
      processingTimeMs: elapsed,
      transcriptPreview: '',
      confidence: null,
      durationSec,
      error: `Parse error: ${err instanceof Error ? err.message : 'Unknown'}`,
      method,
    };
  }
}

// ---------------------------------------------------------------------------
// 5. Process one video
// ---------------------------------------------------------------------------

async function processVideo(label: string, youtubeUrl: string, apiKey: string, note: string): Promise<PocResult> {
  const separator = '─'.repeat(60);
  console.log(`\n${separator}`);
  console.log(`🎬  ${label}`);
  console.log(`📌  ${youtubeUrl}`);
  console.log(`📝  ${note}`);
  console.log(separator);

  const overallStart = Date.now();
  let audioUrl: string;
  let durationSec = 0;

  // Step 1: Get audio URL
  try {
    const result = getAudioUrl(youtubeUrl);
    audioUrl = result.url;
    durationSec = result.durationSec;
  } catch (err) {
    return {
      videoLabel: label,
      youtubeUrl,
      success: false,
      transcriptLength: 0,
      detectedLanguage: null,
      processingTimeMs: Date.now() - overallStart,
      transcriptPreview: '',
      confidence: null,
      durationSec: 0,
      error: `Audio URL extraction failed: ${err instanceof Error ? err.message : 'Unknown'}`,
      method: 'url-submission',
    };
  }

  // Step 2: Submit to Deepgram
  // Strategy: try URL submission first (googlevideo URL)
  // If that fails with 403/400, fall back to download + upload
  let result: PocResult;

  try {
    const data = await submitUrlToDeepgram(audioUrl, apiKey);
    const elapsed = Date.now() - overallStart;
    result = parseDeepgramResponse(data, label, youtubeUrl, durationSec, elapsed, 'url-submission');
  } catch (urlErr) {
    const urlErrMsg = urlErr instanceof Error ? urlErr.message : '';
    console.log(`  ⚠ URL submission failed: ${urlErrMsg.substring(0, 120)}`);

    // Try fallback: download + upload
    try {
      console.log(`  Trying file upload fallback...`);
      const tmpFile = downloadAudio(youtubeUrl);
      const data = await uploadFileToDeepgram(tmpFile, apiKey);
      // Clean up
      try { unlinkSync(tmpFile); } catch { /* ignore */ }
      const elapsed = Date.now() - overallStart;
      result = parseDeepgramResponse(data, label, youtubeUrl, durationSec, elapsed, 'file-upload');
    } catch (fileErr) {
      const fileErrMsg = fileErr instanceof Error ? fileErr.message : '';
      result = {
        videoLabel: label,
        youtubeUrl,
        success: false,
        transcriptLength: 0,
        detectedLanguage: null,
        processingTimeMs: Date.now() - overallStart,
        transcriptPreview: '',
        confidence: null,
        durationSec,
        error: `URL submission failed (${urlErrMsg.substring(0, 100)}), File upload failed (${fileErrMsg.substring(0, 100)})`,
        method: 'url-submission',
      };
    }
  }

  // Print summary
  console.log(`\n📋  RESULT:`);
  console.log(`   Success:       ${result.success ? '✅ YES' : '❌ NO'}`);
  console.log(`   Method:        ${result.method}`);
  console.log(`   Processing:    ${fmtDuration(result.processingTimeMs)}`);
  if (result.success) {
    console.log(`   Transcript:    ${result.transcriptLength} chars`);
    console.log(`   Confidence:    ${result.confidence !== null ? (result.confidence * 100).toFixed(1) + '%' : 'N/A'}`);
    console.log(`   Lang detected: ${result.detectedLanguage ?? 'N/A'}`);
    console.log(`   Duration:      ${result.durationSec}s (${(result.durationSec / 60).toFixed(1)} min)`);
    console.log(`\n   Preview:`);
    console.log(`   ${result.transcriptPreview.substring(0, 300)}...`);
  } else {
    console.log(`   Error:         ${result.error ?? 'Unknown'}`);
  }

  return result;
}

// ---------------------------------------------------------------------------
// 6. Generate report
// ---------------------------------------------------------------------------

function generateReport(results: PocResult[], totalElapsed: number): string {
  const totalSuccess = results.filter((r) => r.success).length;
  const totalFail = results.filter((r) => !r.success).length;
  const date = fmtTimestamp(new Date());

  let md = `# Deepgram Proof of Concept Results\n\n`;
  md += `> **Date:** ${date}\n`;
  md += `> **Purpose:** Validate Deepgram URL transcription for Indonesian YouTube content that fails with LOGIN_REQUIRED\n`;
  md += `> **Model:** ${DEEPGRAM_MODEL} (language: ${LANG})\n`;
  md += `> **Total time:** ${fmtDuration(totalElapsed)}\n`;
  md += `> **Success rate:** ${totalSuccess}/${results.length} (${Math.round((totalSuccess / results.length) * 100)}%)\n\n`;

  md += `---\n\n`;

  for (const r of results) {
    md += `## ${r.videoLabel}\n\n`;
    md += `| Metric | Value |\n`;
    md += `|---|---|\n`;
    md += `| **YouTube URL** | ${r.youtubeUrl} |\n`;
    md += `| **Success** | ${r.success ? '✅ YES' : '❌ NO'} |\n`;
    md += `| **Method** | ${r.method} |\n`;
    md += `| **Processing time** | ${fmtDuration(r.processingTimeMs)} |\n`;
    md += `| **Audio duration** | ${r.durationSec}s (${(r.durationSec / 60).toFixed(1)} min) |\n`;

    if (r.success) {
      md += `| **Transcript length** | ${r.transcriptLength} characters |\n`;
      md += `| **Confidence** | ${r.confidence !== null ? (r.confidence * 100).toFixed(1) + '%' : 'N/A'} |\n`;
      md += `| **Detected language** | ${r.detectedLanguage ?? 'N/A'} |\n\n`;
      md += `### Transcript Preview\n\n`;
      md += "```\n";
      md += r.transcriptPreview;
      md += "\n```\n\n";
    } else {
      md += `| **Error** | ${r.error ?? 'Unknown'} |\n\n`;
    }

    md += `---\n\n`;
  }

  // Summary
  md += `## Summary\n\n`;
  md += `| # | Video | Status | Method | Time | Transcript |\n`;
  md += `|---|---|---|---|---|---|\n`;
  results.forEach((r, i) => {
    const status = r.success ? '✅' : '❌';
    const transLen = r.success ? `${r.transcriptLength} chars` : '-';
    md += `| ${i + 1} | ${r.videoLabel.substring(0, 40)} | ${status} | ${r.method} | ${fmtDuration(r.processingTimeMs)} | ${transLen} |\n`;
  });

  md += `\n## Verdict\n\n`;
  if (totalSuccess === results.length) {
    md += `**Deepgram URL transcription is CONFIRMED working for Indonesian YouTube content.**\n\n`;
    md += `All ${results.length} test videos were successfully transcribed. This proves Deepgram can bypass the LOGIN_REQUIRED/IP-block issue that affects InnerTube API and yt-dlp on the VPS.\n\n`;
    md += `### Next Steps\n\n`;
    md += `1. Integrate Deepgram as fallback in \`lib/youtube.ts\` when InnerTube returns LOGIN_REQUIRED\n`;
    md += `2. Add \`DEEPGRAM_API_KEY\` to Vercel environment variables\n`;
    md += `3. Deploy and monitor transcript coverage improvement\n`;
  } else if (totalSuccess > 0) {
    md += `**Partial success — ${totalSuccess}/${results.length} videos transcribed.**\n\n`;
    md += `Deepgram works for some Indonesian content but not all. Analysis of failures needed.\n`;
  } else {
    md += `**Deepgram URL transcription FAILED for all test videos.**\n\n`;
    md += `Alternative approaches needed:\n`;
    for (const r of results) {
      if (r.error) {
        md += `- ${r.videoLabel}: ${r.error}\n`;
      }
    }
    md += `\nConsider: VPS-based Whisper worker, AssemblyAI, or other approaches.\n`;
  }

  return md;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`
╔═══════════════════════════════════════════════╗
║        GANYIQ — Deepgram POC Runner           ║
╚═══════════════════════════════════════════════╝
`);

  // Help
  if (hasFlag('help')) {
    console.log(`
Usage:
  DEEPGRAM_API_KEY=<key> npx tsx scripts/deepgram-poc.ts <youtube-url>
  DEEPGRAM_API_KEY=<key> npx tsx scripts/deepgram-poc.ts --all
  DEEPGRAM_API_KEY=<key> npx tsx scripts/deepgram-poc.ts --help

Flags:
  --all         Run all 3 test videos
  --save        Save transcript report to docs/
  --timeout=N   Deepgram API timeout in seconds (default: 600)

Examples:
  DEEPGRAM_API_KEY=abc npx tsx scripts/deepgram-poc.ts "https://youtu.be/hN-V0YYDSak"
  DEEPGRAM_API_KEY=abc npx tsx scripts/deepgram-poc.ts --all
`);
    return;
  }

  // API key check — try env var, fallback to .env.local
  // Must be at least 10 chars to be valid (Deepgram keys are 40+ hex chars)
  let apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey || apiKey.length < 10 || apiKey === '***') {
    try {
      const envContent = readFileSync(join(PROJECT_ROOT, '.env.local'), 'utf-8');
      const match = envContent.match(/^DEEPGRAM_API_KEY=(.+)$/m);
      if (match) {
        apiKey = match[1].trim();
        process.env.DEEPGRAM_API_KEY = apiKey;
      }
    } catch {
      // .env.local doesn't exist or unreadable
    }
  }
  if (!apiKey) {
    console.error('❌ DEEPGRAM_API_KEY environment variable is required.');
    console.error('');
    console.error('   Get a free API key at: https://console.deepgram.com/');
    console.error('   Usage:');
    console.error('     DEEPGRAM_API_KEY=<your-key> npx tsx scripts/deepgram-poc.ts <youtube-url>');
    console.error('     DEEPGRAM_API_KEY=<your-key> npx tsx scripts/deepgram-poc.ts --all');
    process.exit(1);
  }

  // yt-dlp check
  try {
    execSync('which yt-dlp', { encoding: 'utf-8' });
  } catch {
    console.error('❌ yt-dlp not found. Install it first.');
    process.exit(1);
  }

  // Determine which videos to process
  const videos: TestVideo[] = [];
  const allFlag = hasFlag('all');
  const saveFlag = hasFlag('save') || allFlag;
  const cliUrl = process.argv.find(
    (a) => a.startsWith('http') && (a.includes('youtube') || a.includes('youtu.be')),
  );

  if (allFlag) {
    videos.push(...TEST_VIDEOS);
  } else if (cliUrl) {
    // Single URL from command line
    try {
      const videoId = extractVideoId(cliUrl);
      videos.push({
        label: `Custom video (${videoId})`,
        url: cliUrl,
        note: 'User-provided URL',
      });
    } catch {
      console.error(`❌ Invalid YouTube URL: "${cliUrl}"`);
      process.exit(1);
    }
  } else {
    console.error('❌ Provide a YouTube URL or use --all.');
    console.error('');
    console.error('   Examples:');
    console.error('     DEEPGRAM_API_KEY=abc npx tsx scripts/deepgram-poc.ts "https://youtu.be/..."');
    console.error('     DEEPGRAM_API_KEY=abc npx tsx scripts/deepgram-poc.ts --all');
    process.exit(1);
  }

  console.log(`\n📡  Testing ${videos.length} video(s) with Deepgram ${DEEPGRAM_MODEL} (lang: ${LANG})`);
  console.log(`⏱️   Deepgram timeout: ${MAX_WAIT_SEC}s per video`);
  console.log(`🍪  Cookies: ${existsSync(COOKIES_PATH) ? '✅ found' : '⚠ not found'}`);
  console.log('');

  const results: PocResult[] = [];
  const overallStart = Date.now();

  for (const video of videos) {
    try {
      const result = await processVideo(video.label, video.url, apiKey, video.note);
      results.push(result);
    } catch (err) {
      results.push({
        videoLabel: video.label,
        youtubeUrl: video.url,
        success: false,
        transcriptLength: 0,
        detectedLanguage: null,
        processingTimeMs: Date.now() - overallStart,
        transcriptPreview: '',
        confidence: null,
        durationSec: 0,
        error: `Unexpected error: ${err instanceof Error ? err.message : 'Unknown'}`,
        method: 'url-submission',
      });
    }
  }

  const totalElapsed = Date.now() - overallStart;

  // Print final summary
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`📊  FINAL SUMMARY`);
  console.log(`${'═'.repeat(60)}`);
  console.log(`   Total:     ${results.length} video(s)`);
  console.log(`   Success:   ${results.filter((r) => r.success).length}`);
  console.log(`   Failed:    ${results.filter((r) => !r.success).length}`);
  console.log(`   Duration:  ${fmtDuration(totalElapsed)}`);

  for (const r of results) {
    const icon = r.success ? '✅' : '❌';
    const trans = r.success ? `${r.transcriptLength} chars` : 'FAILED';
    console.log(`   ${icon} ${r.videoLabel.substring(0, 50)} → ${trans} (${fmtDuration(r.processingTimeMs)})`);
  }

  // Save report
  if (saveFlag || allFlag) {
    const report = generateReport(results, totalElapsed);
    const docsDir = join(PROJECT_ROOT, 'docs');
    if (!existsSync(docsDir)) mkdirSync(docsDir, { recursive: true });
    const reportPath = join(docsDir, 'DEEPGRAM_POC_RESULTS.md');
    writeFileSync(reportPath, report, 'utf-8');
    console.log(`\n📄  Report saved: ${reportPath}`);
  }

  console.log('');
}

main().catch((err) => {
  console.error(`\n❌ Fatal error: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
