#!/usr/bin/env npx tsx
/**
 * phase3c-validation.ts — Speaker Diarization A/B Validation.
 *
 * Run A: Uses the production API (YouTube transcript, no speaker)
 * Run B: Downloads audio with cookies → Deepgram diarization → analysis
 */

import { execSync } from 'child_process';
import { readFileSync, unlinkSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { TranscriptSegment, VideoMetadata } from '@/lib/types';

const LLM_API_URL = 'https://opencode.ai/zen/go/v1/chat/completions';
const DEEPGRAM_BASE = 'https://api.deepgram.com/v1/listen';
const OUTPUT_DIR = '/root/.hermes/audit-v41';

if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });

// ── Test Dataset ──

const TEST_VIDEOS = [
  { id: 'podkesmas', url: 'https://youtu.be/hN-V0YYDSak', type: 'Podcast (2-3 speakers)', desc: 'SHOWKESMAS Diskusi Pendidikan' },
  { id: 'titik-kumpul', url: 'https://youtu.be/FN283CT4rgg', type: 'Debate/Discussion', desc: 'TITIK KUMPUL Fajar vs Oki & Abdur' },
  { id: 'bola-tirta', url: 'https://youtu.be/fq1-l0thkm8', type: 'Interview/Podcast', desc: 'BOLA TIRTA ngobrol bareng Coach Justin' },
  { id: 'seandainya', url: 'https://youtu.be/spgzk9jvQyc', type: 'Educational', desc: 'Seandainya Saya Tau Ini Lebih Awal' },
  { id: 'duo-bahlul', url: 'https://youtu.be/dtdPS0oBkCU', type: 'Comedy/Long-form', desc: 'Tahun Ini Milik Duo Bahlul' },
];

// ── Helpers ──

function resolveApiKey(): string {
  const envKey = process.env.DEEPGRAM_API_KEY;
  if (envKey && envKey.length > 10) return envKey;
  try {
    const envContent = readFileSync(join(process.cwd(), '.env.local'), 'utf-8');
    const m = envContent.match(/^DEEPGRAM_API_KEY=(.+)$/m);
    if (m && m[1].trim().length > 10) return m[1].trim();
  } catch {}
  throw new Error('No Deepgram API key');
}

function getOpenCodeKey(): string {
  const k = process.env.OPENCODE_GO_API_KEY;
  if (k) return k;
  try {
    const envContent = readFileSync(join(process.cwd(), '.env.local'), 'utf-8');
    const m = envContent.match(/^OPENCODE_GO_API_KEY=(.+)$/m);
    if (m) return m[1].trim();
  } catch {}
  throw new Error('No OpenCode API key');
}

async function fetchDeepgramTranscript(youtubeUrl: string): Promise<{
  segments: TranscriptSegment[];
  confidence: number;
  fullTranscript: string;
  speakerData: boolean;
  speakerCount: number;
  exchangeCount: number;
}> {
  const apiKey = resolveApiKey();
  const tmpFile = `/tmp/ganyiq-dg-${Date.now()}.mp4`;

  try {
    // Download audio with cookies
    execSync(
      `yt-dlp --cookies /root/GANYIQ/cookies.txt -f "bestaudio/best" -o "${tmpFile}" "${youtubeUrl}" 2>&1`,
      { timeout: 300_000, encoding: 'utf-8' },
    );

    if (!existsSync(tmpFile)) throw new Error('Audio download failed — output file not found');
    const audioBuf = readFileSync(tmpFile);

    // Call Deepgram with diarization
    const params = new URLSearchParams({
      model: 'nova-2',
      language: 'id',
      smart_format: 'true',
      punctuate: 'true',
      utterances: 'true',
      utt_split: '1.2',
      diarize: 'true',
      diarize_version: '2',
    });

    const resp = await fetch(`${DEEPGRAM_BASE}?${params.toString()}`, {
      method: 'POST',
      headers: { Authorization: `Token ${apiKey}`, 'Content-Type': 'audio/mp4' },
      body: new Uint8Array(audioBuf),
      signal: AbortSignal.timeout(600_000),
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`Deepgram HTTP ${resp.status}: ${body.substring(0, 200)}`);
    }

    const data: any = await resp.json();
    const alt = data?.results?.channels?.[0]?.alternatives?.[0];
    if (!alt) throw new Error('No transcription alternatives');

    const rawWords: { word: string; start: number; end: number; speaker?: number }[] =
      (alt.words ?? []).map((w: any) => ({
        word: w.punctuated_word ?? w.word ?? '',
        start: w.start ?? 0,
        end: w.end ?? 0,
        speaker: w.speaker,
      }));

    if (rawWords.length === 0) throw new Error('Zero words');

    // Convert to segments with speaker tracking
    const segments: TranscriptSegment[] = [];
    const SEGMENT_TARGET = 5.0;
    const MAX_WORD_GAP = 1.0;

    let segStart = rawWords[0].start;
    let segWords: string[] = [];
    let segSpeaker: string | undefined;
    const speakersSeen = new Set<number>();

    function speakerLabel(id?: number): string | undefined {
      if (id === undefined || id === null) return undefined;
      speakersSeen.add(id);
      return String.fromCharCode(65 + id);
    }

    for (let i = 0; i < rawWords.length; i++) {
      const w = rawWords[i];
      const prevTime = i > 0 ? rawWords[i - 1].start : segStart;
      const wordSpeaker = speakerLabel(w.speaker);

      if (w.start - segStart > SEGMENT_TARGET || w.start - prevTime > MAX_WORD_GAP * 2) {
        if (segWords.length > 0) {
          segments.push({ start: segStart, duration: prevTime - segStart + 0.5, text: segWords.join(' ').trim(), speaker: segSpeaker });
        }
        segStart = w.start;
        segWords = [w.word];
        segSpeaker = wordSpeaker;
      } else {
        segWords.push(w.word);
        if (wordSpeaker && segSpeaker && wordSpeaker !== segSpeaker) segSpeaker = 'mixed';
        else if (wordSpeaker && !segSpeaker) segSpeaker = wordSpeaker;
      }
    }
    if (segWords.length > 0) {
      const lastTime = rawWords[rawWords.length - 1].end;
      segments.push({ start: segStart, duration: Math.max(1, lastTime - segStart), text: segWords.join(' ').trim(), speaker: segSpeaker });
    }

    // Count speaker changes
    let changes = 0;
    for (let i = 1; i < segments.length; i++) {
      const p = segments[i - 1].speaker;
      const c = segments[i].speaker;
      if (p && c && p !== 'mixed' && c !== 'mixed' && p !== c) changes++;
    }

    return {
      segments,
      confidence: alt.confidence ?? 0,
      fullTranscript: alt.transcript ?? '',
      speakerData: segments.some(s => s.speaker !== undefined && s.speaker !== 'mixed'),
      speakerCount: speakersSeen.size,
      exchangeCount: changes,
    };
  } finally {
    try { unlinkSync(tmpFile); } catch {}
  }
}

// ── Call DeepSeek V4 Flash via OpenCode ──

const MODEL = 'deepseek-v4-flash';

interface CandidateInfo {
  index: number;
  start: number;
  end: number;
  duration: number;
  text: string;
  signals: string[];
}

function buildCandidatePrompt(candidates: CandidateInfo[], title: string, channel: string): { system: string; user: string } {
  const candidateTexts = candidates.map((c, i) => {
    const spInfo = (c as any).speakers ? ` speakers:${(c as any).speakers.join(',')} exchanges:${(c as any).speakerChangeCount ?? 0}` : '';
    return `CANDIDATE ${i + 1}: "${c.text}"${spInfo} startTime:${c.start} endTime:${c.end}`;
  }).join('\n---\n');

  return {
    system: 'You are a professional short-form content clipper in Indonesia. Your income depends entirely on views. You have 3+ years of experience. Your job: score podcast clips for viral potential.',
    user: `TASK: Score each of the following ${candidates.length} candidate clips. Score each independently.\n\nVIDEO: ${title} by ${channel}\n\nCANDIDATES:\n${candidateTexts}\n\nSCORING: 85-100 ELITE | 70-84 STRONG | 50-69 MODERATE | 0-49 LOW\nCONFIDENCE: high=clear hook | medium=ambiguous | low=fragmented\nDNA TAGS: hookPower, curiosity, controversy, emotion, humor, storytelling, authority, money, shock, educational, motivation, relatability, vulnerability, inspiration\nRULES: Base score ONLY on transcript text. Hook-first: first 3s must grab. Echo back EXACT startTime/endTime.\nOUTPUT: Valid JSON array only. [{"candidateIndex":number,"startTime":number,"endTime":number,"worthClippingScore":number,"confidence":"high"|"medium"|"low","dnaTags":["tag1","tag2"],"reasoning":"1 sentence"}]`,
  };
}

async function analyzeWithPrompt(segments: TranscriptSegment[], title: string, channel: string): Promise<any[]> {
  // Extract candidates (simple approach — merge high-signal segments)
  const SIGNAL_KEYWORDS: Record<string, string[]> = {
    emotion: ['gila', 'sangat', 'banget', 'astaga', 'wow', 'luar biasa', 'marah', 'sedih', 'senang', 'cinta', 'benci', 'sakit', 'sengsara', 'krisis', 'amazing', 'incredible', 'terrible'],
    controversy: ['salah', 'tidak setuju', 'sebenarnya', 'kontroversi', 'debat', 'argumen', 'tapi kan', 'bukan begitu', 'nggak setuju'],
    humor: ['lucu', 'kocak', 'ngakak', 'haha', 'wkwk', 'jorok', 'konyol', 'funny', 'jokes'],
    shock: ['kaget', 'terkejut', 'shock', 'surprise', 'gak nyangka', 'masa sih', 'astagfirullah', 'subhanallah', 'tidak percaya'],
    money: ['uang', 'duit', 'bisnis', 'gaji', 'jutaan', 'miliar', 'kaya', 'bisnis', 'usaha', 'harga', 'mahal'],
    storytelling: ['cerita', 'pengalaman', 'waktu itu', 'dulu', 'pernah', 'kejadian', 'awalnya'],
    educational: ['cara', 'tips', 'tutorial', 'belajar', 'penting', 'harus tahu', 'rahasia', 'kunci', 'how to'],
    curiosity: ['kenapa', 'bagaimana', 'apa', 'tahukah', 'rahasia', 'ternyata', 'penasaran', 'mau tahu'],
    motivation: ['semangat', 'jangan menyerah', 'bangkit', 'inspirasi', 'motivasi', 'percaya', 'berani'],
    authority: ['profesor', 'dokter', 'ahli', 'ceo', 'founder', 'berpengalaman'],
    vulnerability: ['malu', 'gagal', 'jatuh', 'trauma', 'jujur', 'maaf', 'kelemahan', 'salah'],
    inspiration: ['inspirasi', 'impian', 'mimpi', 'bangkit', 'juara', 'inspiring', 'motivational'],
  };

  // Score each segment
  interface SegScore { idx: number; rawScore: number; signals: string[]; text: string; start: number; end: number; speaker?: string }
  const scored: SegScore[] = segments.map((s, i) => {
    const lower = s.text.toLowerCase();
    const sigs: string[] = [];
    let score = 0;
    for (const [name, kws] of Object.entries(SIGNAL_KEYWORDS)) {
      for (const kw of kws) {
        if (lower.includes(kw.toLowerCase())) { score += 3; sigs.push(name); break; }
      }
    }
    return { idx: i, rawScore: score, signals: [...new Set(sigs)], text: s.text, start: s.start, end: s.start + s.duration, speaker: s.speaker };
  });

  // Merge adjacent high-scored segments into windows
  const ACTIVE_THRESHOLD = 3;
  const windows: any[] = [];
  let i = 0;
  while (i < scored.length) {
    if (scored[i].rawScore < ACTIVE_THRESHOLD) { i++; continue; }
    let j = i;
    while (j < scored.length && scored[j].rawScore >= ACTIVE_THRESHOLD) j++;
    let extStart = Math.max(0, i - 2);
    let extEnd = Math.min(scored.length - 1, j);
    const st = scored[extStart].start;
    const et = scored[extEnd].end;
    const dur = et - st;
    if (dur >= 8 && dur <= 120) {
      const segs = scored.slice(extStart, extEnd + 1);
      const sigs = [...new Set(segs.flatMap(s => s.signals))];
      const sps = new Set(segs.map(s => s.speaker).filter(Boolean));
      const changes = segs.filter((s, idx) => idx > 0 && s.speaker && segs[idx-1].speaker && s.speaker !== 'mixed' && segs[idx-1].speaker !== 'mixed' && s.speaker !== segs[idx-1].speaker).length;
      windows.push({
        start: st, end: et, duration: dur,
        text: segs.map(s => s.text).join(' '),
        signals: sigs, score: segs.reduce((sum, s) => sum + s.rawScore, 0),
        speakers: [...sps], speakerChangeCount: changes,
      });
    }
    i = j + 1;
  }

  // Sort by score desc, take top 60
  windows.sort((a, b) => b.score - a.score);
  const topCandidates = windows.slice(0, 60);

  // Build batch prompt
  const { system, user } = buildCandidatePrompt(
    topCandidates.map(c => ({ index: 0, start: c.start, end: c.end, duration: c.duration, text: c.text, signals: c.signals, ...c })),
    title, channel
  );

  // Call LLM
  const apiKey = getOpenCodeKey();
  const response = await fetch(LLM_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.3,
      max_tokens: 16384,
    }),
    signal: AbortSignal.timeout(500_000),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`LLM HTTP ${response.status}: ${body.substring(0, 200)}`);
  }

  const data: any = await response.json();
  const text: string = data?.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('Empty response');

  // Parse JSON
  const clean = text.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```$/, '').trim();
  const parsed = JSON.parse(clean);
  if (!Array.isArray(parsed)) throw new Error('Not an array: ' + typeof parsed);

  // Validate
  return parsed.filter((item: any) => {
    if (!item || typeof item !== 'object') return false;
    const st = Number(item.startTime);
    const et = Number(item.endTime);
    const sc = Number(item.worthClippingScore);
    return (
      Number.isFinite(st) && st >= 0 &&
      Number.isFinite(et) && et > st &&
      Number.isFinite(sc) && sc >= 0 && sc <= 100 &&
      ['high', 'medium', 'low'].includes(String(item.confidence).toLowerCase()) &&
      Array.isArray(item.dnaTags) && item.dnaTags.length >= 1
    );
  });
}

// ── Rank (same logic as production) ──

function rankMoments(moments: any[]): any[] {
  const sorted = [...moments].sort((a, b) => b.worthClippingScore - a.worthClippingScore);
  const deduped: any[] = [];
  for (const m of sorted) {
    if (!deduped.some(k => Math.abs(m.startTime - k.startTime) < 30)) {
      deduped.push(m);
    }
  }
  const elite = deduped.filter(m => m.worthClippingScore >= 80).slice(0, 5);
  const secondary = deduped.filter(m => m.worthClippingScore >= 50 && m.worthClippingScore < 80).slice(0, 10);
  return [...elite, ...secondary].map((m, i) => ({ ...m, rank: i + 1, tier: i < elite.length ? 'elite' : 'secondary' }));
}

// ── Run API fetch for Run A ──

async function fetchYouTubeAnalysis(url: string): Promise<any> {
  const resp = await fetch(`http://127.0.0.1:3003/api/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
    signal: AbortSignal.timeout(600_000),
  });
  const data = await resp.json();
  if (data.error) throw new Error(`${data.error}: ${data.message}`);
  return data;
}

// ── MAIN ──

async function main() {
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║  Phase 3C — Speaker Diarization A/B Validation  ║');
  console.log('╚══════════════════════════════════════════════════╝\n');

  const allResults: any[] = [];

  async function getYoutubeId(url: string): Promise<string> {
    const m = url.match(/youtu\.be\/([a-zA-Z0-9_-]+)/) || url.match(/[?&]v=([a-zA-Z0-9_-]+)/);
    return m ? m[1] : '';
  }

  async function getMetadata(url: string): Promise<{ title: string; channel: string; duration: number }> {
    try {
      const info = JSON.parse(execSync(
        `yt-dlp --cookies /root/GANYIQ/cookies.txt --print-json --skip-download "${url}" 2>/dev/null`,
        { encoding: 'utf-8', timeout: 30_000 }
      ));
      return { title: info.title || 'Unknown', channel: info.channel || info.uploader || 'Unknown', duration: info.duration || 0 };
    } catch {
      return { title: 'Unknown', channel: 'Unknown', duration: 0 };
    }
  }

  for (const video of TEST_VIDEOS) {
    console.log(`\n${'━'.repeat(60)}`);
    console.log(`[${video.type}] ${video.desc}`);
    console.log(`${'━'.repeat(60)}`);

    const meta = await getMetadata(video.url);
    console.log(`  Metadata: "${meta.title}" by ${meta.channel}, ${Math.round(meta.duration / 60)}min`);

    // ── RUN A: YouTube API ──
    console.log(`\n  ● RUN A: YouTube Transcript (no speaker)`);
    let resultA: any = null;
    let errorA = '';
    try {
      const apiResult = await fetchYouTubeAnalysis(video.url);
      resultA = apiResult;
      const ec = apiResult.moments.filter((m: any) => m.tier === 'elite').length;
      console.log(`  → ${apiResult.moments.length} clips, ${ec} elite`);
      console.log(`  → Top: ${apiResult.moments[0]?.worthClippingScore ?? '-'}`);
    } catch (e: any) {
      errorA = (e.message || String(e)).slice(0, 200);
      console.log(`  ✗ ${errorA}`);
    }

    // ── RUN B: Deepgram + Diarization ──
    console.log(`\n  ● RUN B: Deepgram + Diarization (with speaker)`);
    let resultB: any = null;
    let errorB = '';
    let speakerInfo = { hasSpeakerData: false, speakerCount: 0, exchangeCount: 0 };
    try {
      const dg = await fetchDeepgramTranscript(video.url);
      console.log(`  Deepgram: ${dg.segments.length} segments, confidence=${dg.confidence.toFixed(3)}`);
      console.log(`  Speaker data: ${dg.speakerData ? '✓ PRESENT' : '✗ ABSENT'}`);
      if (dg.speakerData) {
        console.log(`    ${dg.speakerCount} speakers, ${dg.exchangeCount} exchanges`);
      }
      speakerInfo = { hasSpeakerData: dg.speakerData, speakerCount: dg.speakerCount, exchangeCount: dg.exchangeCount };

      // Count multi-speaker candidates
      const sps = dg.segments.map(s => s.speaker).filter(Boolean) as string[];
      const uniqueSpk = new Set(sps.filter(s => s !== 'mixed'));
      const multiSpkSegments = dg.segments.filter(s => s.speaker && s.speaker !== 'mixed').length;

      // Run analysis
      const momentsRaw = await analyzeWithPrompt(dg.segments, meta.title, meta.channel);
      const ranked = rankMoments(momentsRaw);
      const ec = ranked.filter((m: any) => m.tier === 'elite').length;
      console.log(`  → ${ranked.length} clips, ${ec} elite`);

      resultB = {
        moments: ranked,
        totalMomentsFound: ranked.length,
        eliteCount: ec,
        speakerInfo,
        multiSpeakerSegments: multiSpkSegments,
        totalSegments: dg.segments.length,
      };
    } catch (e: any) {
      errorB = (e.message || String(e)).slice(0, 200);
      console.log(`  ✗ ${errorB}`);
    }

    // ── Attribution ──
    let newClipsB: any[] = [];
    let improvedB = 0;
    if (resultA?.moments && resultB?.moments) {
      const mA = resultA.moments;
      const mB = resultB.moments;
      for (const b of mB) {
        const match = mA.find((a: any) => Math.abs(a.startTime - b.startTime) < 15);
        if (!match) {
          newClipsB.push({ score: b.worthClippingScore, tags: b.dnaTags, start: b.startTime });
        } else if (b.worthClippingScore - match.worthClippingScore >= 5) {
          improvedB++;
        }
      }
    }

    allResults.push({
      video: video.id,
      type: video.type,
      desc: video.desc,
      runA: resultA ? {
        clips: resultA.moments.length,
        elite: resultA.moments.filter((m: any) => m.tier === 'elite').length,
        maxScore: resultA.moments[0]?.worthClippingScore ?? 0,
        topClips: resultA.moments.slice(0, 3).map((m: any) => ({ score: m.worthClippingScore, tier: m.tier, tags: m.dnaTags })),
      } : null,
      runB: resultB ? {
        clips: resultB.totalMomentsFound,
        elite: resultB.eliteCount,
        speakerInfo,
        topClips: (resultB.moments || []).slice(0, 3).map((m: any) => ({ score: m.worthClippingScore, tier: m.tier, tags: m.dnaTags })),
      } : null,
      attribution: {
        newClipsFromSpeaker: newClipsB,
        clipsImprovedBySpeaker: improvedB,
      },
      errorA, errorB,
    });

    console.log(`\n  ✔ ${video.id} done`);
    if (newClipsB.length > 0) {
      console.log(`  ★ ${newClipsB.length} clips NEW from speaker data`);
    }
  }

  // ── Summary ──
  console.log(`\n\n${'═'.repeat(60)}`);
  console.log('AGGREGATE RESULTS');
  console.log(`${'═'.repeat(60)}\n`);

  const hasA = allResults.filter(r => r.runA);
  const hasB = allResults.filter(r => r.runB);
  const totalA = hasA.reduce((s, r) => s + r.runA.clips, 0);
  const totalB = hasB.reduce((s, r) => s + r.runB.clips, 0);
  const eliteA = hasA.reduce((s, r) => s + r.runA.elite, 0);
  const eliteB = hasB.reduce((s, r) => s + r.runB.elite, 0);

  for (const r of allResults) {
    const a = r.runA ? `${r.runA.clips}/${r.runA.elite}e` : 'ERR';
    const b = r.runB ? `${r.runB.clips}/${r.runB.elite}e` : 'ERR';
    const spk = r.runB?.speakerInfo?.hasSpeakerData ? 'SPK' : '---';
    const newC = r.attribution?.newClipsFromSpeaker?.length ?? 0;
    console.log(`${r.video.padEnd(16)} | A: ${a.padEnd(10)} | B: ${b.padEnd(10)} | ${spk} | +${newC} new`);
  }
  console.log(`\n  TOTAL: A=${totalA} (${eliteA}e) | B=${totalB} (${eliteB}e)`);

  writeFileSync(join(OUTPUT_DIR, 'PHASE3C_RESULTS.json'), JSON.stringify(allResults, null, 2));
  console.log(`\n  Full results: ${OUTPUT_DIR}/PHASE3C_RESULTS.json`);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
