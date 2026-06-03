#!/usr/bin/env npx tsx
/**
 * deepgram-analysis-test.ts — End-to-end Deepgram → DeepSeek pipeline validation.
 *
 * Tests whether Deepgram-generated Indonesian transcripts produce valid
 * analysis results when fed through the existing DeepSeek analysis pipeline.
 *
 * Flow:
 *   YouTube URL → yt-dlp audio → Deepgram STT → TranscriptSegment[]
 *   → analyzeTranscript() (DeepSeek V4 Flash via OpenCode Go)
 *   → rankMoments() (deterministic scoring)
 *   → results
 *
 * Usage:
 *   npx tsx scripts/deepgram-analysis-test.ts --all
 *   npx tsx scripts/deepgram-analysis-test.ts <youtube-url>
 */

import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { analyzeTranscript } from '../lib/analyzer';
import { rankMoments } from '../lib/ranking';
import type { VideoMetadata, TranscriptSegment, RawMoment, RankedMoment } from '../lib/types';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const COOKIES_PATH = join(process.cwd(), 'cookies.txt');

/** Target segment duration in seconds (matches lib/youtube.ts). */
const SEGMENT_TARGET = 5.0;

/** Max gap between words in seconds. */
const MAX_WORD_GAP = 1.0;

const TEST_VIDEOS = [
  {
    label: 'Raditya Dika — Diskusi Tentang Pendidikan Indonesia',
    url: 'https://www.youtube.com/watch?v=hN-V0YYDSak',
  },
  {
    label: 'Deddy Corbuzier — Podcast (ROCM31HEB6M)',
    url: 'https://www.youtube.com/watch?v=ROCM31HEB6M',
  },
  {
    label: 'Suara Berkelas — Cara Menemukan Bahagia',
    url: 'https://www.youtube.com/watch?v=FIXQQ7X7tZE',
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getApiKey(): string {
  // Try env var first
  let key = process.env.DEEPGRAM_API_KEY;
  if (key && key.length > 10 && key !== '***') return key;

  // Fallback to .env.local
  try {
    const envContent = readFileSync(join(process.cwd(), '.env.local'), 'utf-8');
    const match = envContent.match(/^DEEPGRAM_API_KEY=(.+)$/m);
    if (match) {
      key = match[1].trim();
      if (key.length > 10) return key;
    }
  } catch { /* ignore */ }

  throw new Error('DEEPGRAM_API_KEY not found. Set it in .env.local or export it.');
}

function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

function secondsToTimestamp(sec: number): string {
  const mins = Math.floor(sec / 60);
  const secs = Math.floor(sec % 60);
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Step 1: Get metadata via yt-dlp --dump-json
// ---------------------------------------------------------------------------

interface YtMetadata {
  title: string;
  channel: string;
  duration: number;
  id: string;
}

function getMetadata(youtubeUrl: string): YtMetadata {
  const cookieFlag = existsSync(COOKIES_PATH) ? `--cookies "${COOKIES_PATH}"` : '';
  const cmd = `yt-dlp ${cookieFlag} --dump-json "${youtubeUrl}" 2>&1`;
  const stdout = execSync(cmd, { timeout: 30_000, encoding: 'utf-8' }).trim();
  const data = JSON.parse(stdout.split('\n')[0]);
  return {
    title: data.title ?? 'Unknown',
    channel: data.channel ?? data.uploader ?? 'Unknown',
    duration: data.duration ?? 0,
    id: data.id ?? '',
  };
}

function getVideoId(youtubeUrl: string): string {
  const m = youtubeUrl.match(/(?:v=|\/)([\w-]{11})(?:[?&/]|$)/);
  return m ? m[1] : 'unknown';
}

// ---------------------------------------------------------------------------
// Step 2: Download audio + transcribe via Deepgram
// ---------------------------------------------------------------------------

interface DgWord {
  word: string;
  start: number;
  end: number;
}

interface DgResult {
  words: DgWord[];
  fullTranscript: string;
  confidence: number;
}

async function transcribeWithDeepgram(youtubeUrl: string): Promise<DgResult> {
  const apiKey = getApiKey();
  const tmpFile = `/tmp/ganyiq-dg-${Date.now()}.webm`;

  // Download audio
  console.log(`  [audio] Downloading...`);
  const dlStart = Date.now();
  const cookieFlag = existsSync(COOKIES_PATH) ? `--cookies "${COOKIES_PATH}"` : '';
  execSync(`yt-dlp ${cookieFlag} -f bestaudio -o "${tmpFile}" "${youtubeUrl}" 2>&1`, {
    timeout: 300_000,
    encoding: 'utf-8',
  });
  const dlTime = Date.now() - dlStart;

  // Get file size
  const sizeBytes = parseInt(
    execSync(`stat --format=%s "${tmpFile}"`, { encoding: 'utf-8' }).trim(),
    10,
  );
  console.log(`  [audio] ${(sizeBytes / 1024 / 1024).toFixed(1)}MB downloaded (${fmtDuration(dlTime)})`);

  // Upload to Deepgram
  console.log(`  [dg] Transcribing...`);
  const audioBuf = readFileSync(tmpFile);
  unlinkSync(tmpFile);

  const params = new URLSearchParams({
    model: 'nova-2',
    language: 'id',
    smart_format: 'true',
    punctuate: 'true',
    utterances: 'true',
    utt_split: '1.2',
  });

  const dgStart = Date.now();
  const resp = await fetch(`https://api.deepgram.com/v1/listen?${params.toString()}`, {
    method: 'POST',
    headers: {
      Authorization: `Token ${apiKey}`,
      'Content-Type': 'audio/webm',
    },
    body: audioBuf,
    signal: AbortSignal.timeout(600_000),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Deepgram HTTP ${resp.status}: ${body.substring(0, 200)}`);
  }

  const data = await resp.json();
  const dgTime = Date.now() - dgStart;

  // Parse response
  const alt = data?.results?.channels?.[0]?.alternatives?.[0];
  if (!alt) throw new Error('No transcription alternatives in Deepgram response');

  const rawWords: { word: string; start: number; end: number }[] = (alt.words ?? []).map(
    (w: any) => ({
      word: w.punctuated_word ?? w.word ?? '',
      start: w.start ?? 0,
      end: w.end ?? 0,
    }),
  );

  const fullTranscript = alt.transcript ?? '';
  const confidence = alt.confidence ?? 0;

  console.log(`  [dg] request_id=${data.metadata?.request_id}`);
  console.log(`  [dg] ${fullTranscript.length} chars, ${(confidence * 100).toFixed(1)}% conf (${fmtDuration(dgTime)})`);

  return { words: rawWords, fullTranscript, confidence };
}

// ---------------------------------------------------------------------------
// Step 3: Convert Deepgram words → TranscriptSegment[] (same algo as youtube.ts)
// ---------------------------------------------------------------------------

function wordsToSegments(words: { word: string; start: number; end: number }[]): TranscriptSegment[] {
  if (words.length === 0) return [];

  const segments: TranscriptSegment[] = [];
  let segStart = words[0].start;
  let segWords: string[] = [];

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const prevTime = i > 0 ? words[i - 1].start : segStart;

    // Start new segment if accumulated >5s or large gap
    if (w.start - segStart > SEGMENT_TARGET || w.start - prevTime > MAX_WORD_GAP * 2) {
      if (segWords.length > 0) {
        segments.push({
          start: segStart,
          duration: prevTime - segStart + 0.5,
          text: segWords.join(' ').trim(),
        });
      }
      segStart = w.start;
      segWords = [w.word];
    } else {
      segWords.push(w.word);
    }
  }

  // Final segment
  if (segWords.length > 0) {
    const lastTime = words[words.length - 1].end;
    segments.push({
      start: segStart,
      duration: Math.max(1, lastTime - segStart),
      text: segWords.join(' ').trim(),
    });
  }

  return segments;
}

// ---------------------------------------------------------------------------
// Step 4: Run analysis + ranking (existing pipeline)
// ---------------------------------------------------------------------------

async function analyzeAndRank(
  metadata: VideoMetadata,
  segments: TranscriptSegment[],
): Promise<{ rawMoments: RawMoment[]; rankedMoments: RankedMoment[] }> {
  console.log(`  [llm] Analyzing ${segments.length} segments with DeepSeek V4 Flash...`);
  const llmStart = Date.now();
  const rawMoments = await analyzeTranscript(metadata, segments);
  const llmTime = Date.now() - llmStart;
  console.log(`  [llm] ${rawMoments.length} raw moments found (${fmtDuration(llmTime)})`);

  console.log(`  [rank] Ranking...`);
  const rankStart = Date.now();
  const rankedMoments = rankMoments(rawMoments, segments);
  const rankTime = Date.now() - rankStart;
  console.log(`  [rank] ${rankedMoments.length} ranked moments (${fmtDuration(rankTime)})`);

  return { rawMoments, rankedMoments };
}

// ---------------------------------------------------------------------------
// Step 5: Print results
// ---------------------------------------------------------------------------

interface TestResult {
  label: string;
  url: string;
  videoId: string;
  success: boolean;
  title: string;
  channel: string;
  audioDurationSec: number;
  transcriptChars: number;
  transcriptConfidence: number;
  segments: number;
  rawMomentCount: number;
  eliteCount: number;
  secondaryCount: number;
  rankedMoments: RankedMoment[];
  totalTimeMs: number;
  error?: string;
}

function printResult(r: TestResult): void {
  const sep = '─'.repeat(60);
  console.log(`\n${sep}`);
  console.log(`📊  ${r.label}`);
  console.log(`    Title: ${r.title}`);
  console.log(`    Channel: ${r.channel}`);
  console.log(`    Duration: ${(r.audioDurationSec / 60).toFixed(1)} min`);
  console.log(sep);

  if (!r.success) {
    console.log(`❌  FAILED: ${r.error}`);
    return;
  }

  console.log(`   Transcript:     ${r.transcriptChars.toLocaleString()} chars (${r.segments} segments)`);
  console.log(`   Confidence:     ${(r.transcriptConfidence * 100).toFixed(1)}%`);
  console.log(`   Raw moments:    ${r.rawMomentCount}`);
  console.log(`   Elite moments:  ${r.eliteCount}`);
  console.log(`   Secondary:      ${r.secondaryCount}`);
  console.log(`   Total time:     ${fmtDuration(r.totalTimeMs)}`);
  console.log(sep);

  // Top 5 moments
  console.log(`\n🏆  TOP 5 MOMENTS:`);
  const top5 = r.rankedMoments.slice(0, 5);
  top5.forEach((m, i) => {
    const tierIcon = m.tier === 'elite' ? '🔥' : '✅';
    const tags = m.dnaTags.join(', ');
    console.log(`\n   ${tierIcon} #${i + 1}  Score: ${m.worthClippingScore}  [${m.confidence}]`);
    console.log(`       ${m.startTimestamp} → ${m.endTimestamp}  (${(m.endTime - m.startTime).toFixed(0)}s)`);
    console.log(`       DNA: ${tags}`);
    console.log(`       "${m.transcriptExcerpt.substring(0, 200)}..."`);
    console.log(`       ${m.reasoning}`);
  });
}

// ---------------------------------------------------------------------------
// Generate report
// ---------------------------------------------------------------------------

function generateReport(results: TestResult[], totalElapsed: number): string {
  const successes = results.filter((r) => r.success);
  const failures = results.filter((r) => !r.success);

  let md = `# Deepgram Pipeline Validation Report\n\n`;
  md += `> **Date:** ${new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '')}\n`;
  md += `> **Purpose:** End-to-end test: Deepgram STT → DeepSeek analysis → Ranking\n`;
  md += `> **Pipeline:** \`yt-dlp → Deepgram nova-2 → analyzeTranscript() → rankMoments()\`\n`;
  md += `> **Total time:** ${fmtDuration(totalElapsed)}\n`;
  md += `> **Success rate:** ${successes.length}/${results.length}\n\n`;

  md += `## Summary Table\n\n`;
  md += `| # | Video | Transcript | Confidence | Segments | Raw | Elite | Secondary | Time |\n`;
  md += `|---|---|---|---|---|---|---|---|---|\n`;

  results.forEach((r, i) => {
    if (r.success) {
      md += `| ${i + 1} | ${r.label.substring(0, 35)} | ${r.transcriptChars} chars | ${(r.transcriptConfidence * 100).toFixed(1)}% | ${r.segments} | ${r.rawMomentCount} | ${r.eliteCount} | ${r.secondaryCount} | ${fmtDuration(r.totalTimeMs)} |\n`;
    } else {
      md += `| ${i + 1} | ${r.label.substring(0, 35)} | ❌ FAILED | - | - | - | - | - | ${fmtDuration(r.totalTimeMs)} |\n`;
    }
  });

  md += `\n---\n\n`;

  for (const r of results) {
    md += `## ${r.label}\n\n`;
    md += `| Metric | Value |\n|---|---|\n`;
    md += `| **Video URL** | ${r.url} |\n`;
    md += `| **Title** | ${r.title} |\n`;
    md += `| **Channel** | ${r.channel} |\n`;
    md += `| **Duration** | ${(r.audioDurationSec / 60).toFixed(1)} min |\n`;
    md += `| **Transcript chars** | ${r.transcriptChars.toLocaleString()} |\n`;
    md += `| **Transcript segments** | ${r.segments} |\n`;
    md += `| **Deepgram confidence** | ${(r.transcriptConfidence * 100).toFixed(1)}% |\n`;
    md += `| **Raw moments** | ${r.rawMomentCount} |\n`;
    md += `| **Elite moments** | ${r.eliteCount} |\n`;
    md += `| **Secondary moments** | ${r.secondaryCount} |\n`;
    md += `| **Total processing** | ${fmtDuration(r.totalTimeMs)} |\n`;

    if (!r.success) {
      md += `| **Error** | ${r.error ?? 'Unknown'} |\n\n`;
    } else {
      md += `\n### Top 5 Moments\n\n`;
      r.rankedMoments.slice(0, 5).forEach((m, i) => {
        const tierIcon = m.tier === 'elite' ? '🔥' : '✅';
        const ts = `${m.startTimestamp} → ${m.endTimestamp} (${(m.endTime - m.startTime).toFixed(0)}s)`;
        md += `**#${i + 1}** ${tierIcon} Score: **${m.worthClippingScore}** | ${ts} | ${m.confidence}\n\n`;
        md += `- **DNA:** ${m.dnaTags.join(', ')}\n`;
        md += `- **Transcript:** ${m.transcriptExcerpt.substring(0, 300)}...\n`;
        md += `- **Why:** ${m.reasoning}\n\n`;
      });
    }

    md += `---\n\n`;
  }

  return md;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`
╔═══════════════════════════════════════════════╗
║   GANYIQ — Deepgram Pipeline Validation      ║
╚═══════════════════════════════════════════════╝
`);

  // Check API keys
  try {
    getApiKey();
  } catch (e) {
    console.error(`❌ ${e instanceof Error ? e.message : 'No Deepgram API key'}`);
    process.exit(1);
  }
  if (!process.env.OPENCODE_GO_API_KEY) {
    console.error('❌ OPENCODE_GO_API_KEY not found in environment');
    process.exit(1);
  }

  // Determine videos
  const allFlag = process.argv.includes('--all');
  const urlArg = process.argv.find((a) => a.startsWith('http'));

  const videos = allFlag
    ? TEST_VIDEOS
    : urlArg
      ? [{ label: `Custom video (${getVideoId(urlArg)})`, url: urlArg }]
      : TEST_VIDEOS;

  console.log(`Testing ${videos.length} video(s)...\n`);

  const results: TestResult[] = [];
  const overallStart = Date.now();

  for (const video of videos) {
    const start = Date.now();
    const videoId = getVideoId(video.url);
    const result: TestResult = {
      label: video.label,
      url: video.url,
      videoId,
      success: false,
      title: '',
      channel: '',
      audioDurationSec: 0,
      transcriptChars: 0,
      transcriptConfidence: 0,
      segments: 0,
      rawMomentCount: 0,
      eliteCount: 0,
      secondaryCount: 0,
      rankedMoments: [],
      totalTimeMs: 0,
    };

    try {
      // Step 1: Get metadata
      console.log(`\n[${videoId}] 🎬 ${video.label}`);
      const ytMeta = getMetadata(video.url);
      result.title = ytMeta.title;
      result.channel = ytMeta.channel;
      result.audioDurationSec = ytMeta.duration;
      console.log(`  [meta] "${ytMeta.title}" by ${ytMeta.channel} (${(ytMeta.duration / 60).toFixed(1)}min)`);

      const metadata: VideoMetadata = {
        youtubeId: ytMeta.id,
        title: ytMeta.title,
        channelName: ytMeta.channel,
        durationSeconds: ytMeta.duration,
      };

      // Step 2: Deepgram transcription
      const dgResult = await transcribeWithDeepgram(video.url);
      result.transcriptChars = dgResult.fullTranscript.length;
      result.transcriptConfidence = dgResult.confidence;

      // Step 3: Convert to segments
      const segments = wordsToSegments(dgResult.words);
      result.segments = segments.length;
      console.log(`  [seg] ${segments.length} segments from ${dgResult.words.length} words`);

      // Step 4: Analyze + rank
      const { rawMoments, rankedMoments } = await analyzeAndRank(metadata, segments);
      result.rawMomentCount = rawMoments.length;
      result.eliteCount = rankedMoments.filter((m) => m.tier === 'elite').length;
      result.secondaryCount = rankedMoments.filter((m) => m.tier === 'secondary').length;
      result.rankedMoments = rankedMoments;
      result.success = true;
    } catch (err) {
      result.error = err instanceof Error ? err.message.substring(0, 300) : 'Unknown error';
      console.error(`  ❌ ${result.error}`);
    }

    result.totalTimeMs = Date.now() - start;
    printResult(result);
    results.push(result);
  }

  const totalElapsed = Date.now() - overallStart;

  // Generate and save report
  const report = generateReport(results, totalElapsed);
  const docsDir = join(process.cwd(), 'docs');
  if (!existsSync(docsDir)) execSync(`mkdir -p "${docsDir}"`, { encoding: 'utf-8' });
  const reportPath = join(docsDir, 'DEEPGRAM_PIPELINE_VALIDATION.md');
  writeFileSync(reportPath, report, 'utf-8');
  console.log(`\n📄  Report saved: ${reportPath}`);
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`🏁  DONE — ${results.filter((r) => r.success).length}/${results.length} passed in ${fmtDuration(totalElapsed)}`);
}

// eslint-disable-next-line @typescript-eslint/no-floating-promises
main().catch((err) => {
  console.error(`\n❌ Fatal: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
