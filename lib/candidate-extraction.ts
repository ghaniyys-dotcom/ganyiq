/**
 * Candidate Extraction V2 — Deterministic pre-filter before LLM stage.
 *
 * INPUT:  TranscriptSegment[] (e.g., 747 segments)
 * OUTPUT: CandidateWindow[] (20-35 candidates, sorted by score descending)
 *
 * DESIGN LOCKED — Do not modify signal definitions without validation.
 *
 * Architecture:
 *   1. Score each segment against 15 text signals (keyword + regex matching)
 *   2. Merge adjacent high-signal segments into candidate windows
 *   3. Score windows with context boost + diversity bonus
 *   4. Return top-N candidates (default 35)
 *
 * Performance: O(N * S) where N=segments, S=signals. For N=747, S=15: <50ms.
 */

import type { TranscriptSegment } from '@/lib/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CandidateWindow {
  startSegment: number;     // index into transcript array
  endSegment: number;       // inclusive
  startSeconds: number;     // segment.start
  endSeconds: number;       // segment.end
  durationSeconds: number;
  score: number;            // final score (normalized 0-100)
  signals: string[];        // which signal types fired
  signalCount: number;      // total raw signal matches
  diversity: number;        // unique signal types
  text: string;             // joined text of all segments
}

// ---------------------------------------------------------------------------
// V2 Signal Library (LOCKED)
// ---------------------------------------------------------------------------

interface SignalDef {
  weight: number;
  keywords: string[];
  regex?: RegExp[];
}

/**
 * V2 signals — tuned on 200 real segments from hN-V0YYDSak.
 *
 * Changes from v1:
 *   - REMOVED: hooks, cta, topic_shift (84-85% noise)
 *   - REDUCED weight: personal, strong_claims, questions, quotations
 *   - ADDED: vulnerability, inspiration signals
 *   - EXPANDED: emotion with Indonesian keywords (kasihan, mohon maaf, etc.)
 */
const SIGNALS: Record<string, SignalDef> = {
  // ── 1. EMOTION (weight 3) ──────────────────────────────────────────
  emotion: {
    weight: 3,
    keywords: [
      // Positive high-arousal
      'luar biasa', 'gila', 'sangat', 'banget', 'astaga', 'ya ampun',
      'menakjubkan', 'hebat', 'keren', 'mantap', 'sukses', 'berhasil',
      'bahagia', 'senang', 'excited', 'passion', 'cinta', 'sayang',
      'bangga', 'menang', 'juara', 'terbaik', 'paling',
      // Negative high-arousal
      'marah', 'kesal', 'benci', 'jijik', 'mual', 'sakit', 'sengsara',
      'menderita', 'tragis', 'mengerikan', 'horor', 'menyedihkan',
      'kecewa', 'frustrasi', 'stress', 'depresi', 'trauma', 'luka',
      'mati', 'meninggal', 'celaka', 'bencana', 'krisis', 'masalah',
      'konflik', 'perang', 'bentrok', 'ribut', 'hancur',
      // Indonesian-specific emotional
      'kasihan', 'mohon maaf', 'alhamdulillah', 'bersyukur',
      'insyaallah', 'astagfirullah', 'subhanallah', 'masyaallah',
      // English
      'amazing', 'incredible', 'shocking', 'unbelievable', 'insane',
      'love', 'hate', 'angry', 'furious', 'devastated', 'thrilled',
      'terrible', 'horrible', 'wonderful', 'fantastic', 'awful',
    ],
  },

  // ── 2. CONTROVERSY (weight 4) ──────────────────────────────────────
  controversy: {
    weight: 4,
    keywords: [
      'salah', 'keliru', 'tidak benar', 'bukan begitu', 'sebenarnya',
      'justru', 'malah', 'sebaliknya', 'kontroversi', 'protes',
      'menolak', 'membantah', 'kritik', 'mengkritik', 'keberatan',
      'tidak setuju', 'beda pendapat', 'bertengkar', 'debat',
      'polemik', 'skandal', 'tertuduh', 'fitnah', 'hoax', 'bohong',
      'tipu', 'korupsi', 'koruptor', 'penipuan', 'manipulasi',
      'konspirasi', 'teroris', 'radikal', 'sara',
      'wrong', 'disagree', 'controversy', 'scandal', 'accused',
      'deny', 'refute', 'debate', 'argument', 'conflict',
    ],
  },

  // ── 3. NUMBERS / STATISTICS (weight 3) ─────────────────────────────
  numbers: {
    weight: 3,
    keywords: [
      'persen', 'rata-rata', 'total', 'jumlah', 'angka', 'statistik',
      'data', 'survei', 'riset', 'penelitian', 'laporan', 'bukti',
      'fakta', 'nyata', 'hitung', 'hitungan', 'estimasi', 'prediksi',
    ],
    regex: [
      /\d+%/,
      /\d+\s*(juta|miliar|triliun|ribu)/i,
      /Rp\s*[\d,.]+/i,
      /\$\s*[\d,.]+/i,
      /\d+\s*(tahun|bulan|hari|jam|menit|detik)/i,
      /\d+\s*(orang|penonton|subscriber|follower)/i,
      /(pertama|kedua|ketiga|terakhir)/i,
    ],
  },

  // ── 4. QUESTIONS (weight 2 — reduced from v1) ──────────────────────
  questions: {
    weight: 2,
    keywords: [
      'apa', 'siapa', 'kenapa', 'bagaimana', 'kapan', 'dimana',
      'mengapa', 'gimana', 'apaan', 'tahukah', 'pernahkah',
      'bayangkan', 'tebak', 'siapa yang', 'apa yang',
      'what', 'who', 'why', 'how', 'when', 'where',
      'guess', 'imagine', 'did you know', 'ever wonder',
    ],
    regex: [/\?$/],
  },

  // ── 5. STRONG CLAIMS (weight 3 — reduced from 4) ───────────────────
  strong_claims: {
    weight: 3,
    keywords: [
      'pasti', 'yakin', 'jamin', 'garanti', 'serius', 'sumpah',
      'sungguh', 'betul', 'memang', 'tentu', 'jelas',
      'bukti', 'fakta', 'kebenaran', 'realita', 'kenyataan',
      'tidak bisa', 'mustahil', 'tidak mungkin', 'selalu', 'tidak pernah',
      'satu-satunya', 'terbesar', 'terpenting', 'nomor satu',
      'wajib', 'harus', 'jangan pernah', 'jangan sampai',
      'definitely', 'absolutely', 'guarantee', 'promise', 'swear',
      'never', 'always', 'only', 'must', 'have to',
      'truth', 'real', 'proven', 'certain',
    ],
  },

  // ── 6. SUPERLATIVES (weight 3) ─────────────────────────────────────
  superlatives: {
    weight: 3,
    keywords: [
      'terbaik', 'terburuk', 'terbesar', 'terkecil', 'tertinggi',
      'terendah', 'tercepat', 'terlama', 'terbaru',
      'pertama kali', 'sepanjang sejarah', 'tidak pernah ada',
      'paling hebat', 'paling keren', 'paling gila', 'paling mahal',
      'paling murah', 'paling cepat', 'paling lambat',
    ],
  },

  // ── 7. STORY TRANSITIONS (weight 3) ────────────────────────────────
  story_transitions: {
    weight: 3,
    keywords: [
      'dulu', 'dahulu', 'pernah', 'waktu itu', 'ketika', 'saat',
      'ceritanya', 'begini ceritanya', 'ini cerita', 'pengalaman',
      'kejadian', 'peristiwa', 'masa lalu', 'masa kecil',
      'awalnya', 'mulai dari', 'berawal',
      'terus tiba-tiba', 'lalu tiba-tiba', 'eh tiba-tiba',
      'ternyata', 'tahu-tahu', 'tak disangka', 'tidak diduga',
      'di situlah', 'di saat itulah', 'puncaknya', 'klimaks',
      'akhirnya', 'kesimpulannya', 'intinya', 'moralnya',
      'pelajarannya', 'hikmahnya', 'takeaway', 'pesan',
    ],
  },

  // ── 8. PROFANITY / TABOO (weight 4) ────────────────────────────────
  profanity: {
    weight: 4,
    keywords: [
      'anjing', 'babi', 'bangsat', 'brengsek', 'tolol', 'bodoh',
      'goblok', 'sialan', 'sial', 'tai', 'setan', 'iblis',
      'dosa', 'haram',
      'seks', 'sex', 'ciuman', 'pacaran', 'selingkuhan',
      'hamil', 'kandungan', 'aborsi', 'narkoba',
      'judi', 'prostitusi', 'psk',
    ],
  },

  // ── 9. SURPRISE / SHOCK (weight 4) ─────────────────────────────────
  surprise: {
    weight: 4,
    keywords: [
      'tidak menyangka', 'tidak duga', 'kaget', 'terkejut',
      'shock', 'shocked', 'surprised', 'unexpected', 'surprising',
      'gak nyangka', 'nggak nyangka', 'gak sangka',
      'wow', 'wah', 'aduh', 'ya ampun', 'astaga', 'astagfirullah',
      'subhanallah', 'masyaallah', 'yaallah', 'ya tuhan',
      'serius', 'beneran', 'masa', 'masa sih',
      'kamu nggak percaya', 'percaya nggak', 'gak percaya',
      'ini beneran', 'ini nyata', 'ini terjadi',
      'rahasia', 'ungkap', 'terungkap',
      'misteri', 'misterius', 'aneh', 'unik', 'langka',
      'shocking', 'unbelievable', 'can you believe',
      "you won't believe", 'plot twist',
      'secret', 'revealed', 'exposed', 'hidden truth',
    ],
  },

  // ── 10. MONEY / WEALTH (weight 3) ──────────────────────────────────
  money: {
    weight: 3,
    keywords: [
      'uang', 'duit', 'modal', 'investasi', 'saham', 'crypto',
      'bitcoin', 'trading', 'profit', 'untung', 'rugi',
      'penghasilan', 'gaji', 'omzet', 'revenue', 'income',
      'jutawan', 'miliarder', 'kaya', 'sukses', 'bisnis',
      'usaha', 'startup', 'perusahaan', 'brand', 'jualan',
      'jual', 'beli', 'harga', 'mahal', 'murah', 'gratis',
      'diskon', 'promo', 'cashback', 'cicilan', 'kredit',
      'hutang', 'pinjaman', 'bank', 'bunga',
    ],
  },

  // ── 11. AUTHORITY / CREDIBILITY (weight 2) ─────────────────────────
  authority: {
    weight: 2,
    keywords: [
      'profesor', 'dokter', 'ahli', 'pakar', 'expert', 'specialist',
      'ceo', 'founder', 'presiden', 'menteri', 'gubernur',
      'artis', 'selebriti', 'influencer', 'youtuber',
      'pengusaha', 'bos', 'atasan', 'pemimpin',
      'berpengalaman', 'veteran', 'senior',
      'sarjana', 'magister', 'doktor', 'phd', 'prof',
      'penghargaan', 'award', 'rekor',
    ],
  },

  // ── 12. QUOTATIONS (weight 2 — reduced from v1) ────────────────────
  quotations: {
    weight: 2,
    keywords: [
      'kata', 'bilang', 'ucap', 'tegas', 'ungkap',
      'mengatakan', 'menyebutkan', 'menjawab', 'bertanya',
      'meminta', 'memerintah', 'menasihati',
      'pesan', 'saran', 'nasihat', 'peringatan',
    ],
    regex: [/"[^"]*"/, /'[^']*'/],
  },

  // ── 13. PERSONAL REVELATION (weight 3 — reduced from 4) ────────────
  personal: {
    weight: 3,
    keywords: [
      'aku', 'saya', 'gue', 'gw', 'ane',
      'pengalaman', 'cerita', 'curhat', 'rahasia',
      'malu', 'menangis', 'nangis', 'sedih', 'depresi',
      'broken', 'gagal', 'jatuh', 'bangkit', 'move on',
      'mantan', 'ex', 'pacar', 'suami', 'istri', 'anak',
      'keluarga', 'orang tua', 'ibu', 'ayah', 'mama', 'papa',
      'sendirian', 'kesepian', 'sepi',
    ],
  },

  // ── 14. VULNERABILITY (weight 4 — NEW in v2) ───────────────────────
  vulnerability: {
    weight: 4,
    keywords: [
      'mohon maaf', 'maaf', 'salah', 'kesalahan',
      'malu', 'menangis', 'nangis', 'terisak',
      'gagal', 'jatuh', 'hancur', 'patah hati',
      'trauma', 'luka', 'sakit', 'menderita',
      'kesepian', 'sendirian', 'sepi',
      'tidak sempurna', 'imperfect', 'kelemahan',
      'jujur', 'terus terang', 'blak-blakan',
      'vulnerable', 'honest', 'raw',
    ],
  },

  // ── 15. INSPIRATION (weight 3 — NEW in v2) ─────────────────────────
  inspiration: {
    weight: 3,
    keywords: [
      'inspirasi', 'motivasi', 'semangat', 'passion',
      'impian', 'cita-cita', 'mimpi', 'dream',
      'bangkit', 'rise', 'juara', 'champion',
      'jangan menyerah', 'never give up', 'keep going',
      'percaya diri', 'confidence', 'yakin',
      'berani', 'courage', 'brave',
      'inspiring', 'motivational', 'uplifting',
    ],
  },
};

// ---------------------------------------------------------------------------
// Segment Scoring
// ---------------------------------------------------------------------------

interface SegmentScore {
  rawScore: number;
  signalMatches: Record<string, number>;  // signal name → match count
}

/**
 * Score a single transcript segment against all signals.
 */
function scoreSegment(text: string): SegmentScore {
  const lower = text.toLowerCase();
  const signalMatches: Record<string, number> = {};
  let rawScore = 0;

  for (const [name, def] of Object.entries(SIGNALS)) {
    let count = 0;

    // Keyword matching
    for (const kw of def.keywords) {
      const kwLower = kw.toLowerCase();
      let idx = lower.indexOf(kwLower);
      while (idx !== -1) {
        count++;
        idx = lower.indexOf(kwLower, idx + 1);
      }
    }

    // Regex matching
    if (def.regex) {
      for (const re of def.regex) {
        const matches = text.match(new RegExp(re.source, re.flags + (re.flags.includes('g') ? '' : 'g')));
        if (matches) count += matches.length;
      }
    }

    if (count > 0) {
      signalMatches[name] = count;
      rawScore += def.weight * count;
    }
  }

  return { rawScore, signalMatches };
}

// ---------------------------------------------------------------------------
// Window Formation
// ---------------------------------------------------------------------------

/**
 * Merge adjacent high-signal segments into candidate windows.
 *
 * Algorithm:
 *   1. Mark segments with rawScore > 0 as "active"
 *   2. Group consecutive active segments into windows
 *   3. Extend windows by 1 segment on each side for context
 *   4. Filter windows by duration (15-90 seconds)
 */
function formWindows(
  segments: TranscriptSegment[],
  scores: SegmentScore[],
  minDuration: number = 15,
  maxDuration: number = 90,
): CandidateWindow[] {
  const windows: CandidateWindow[] = [];
  const n = segments.length;

  // Find active segments (score > 0)
  const active = scores.map(s => s.rawScore > 0);

  let i = 0;
  while (i < n) {
    if (!active[i]) { i++; continue; }

    // Found start of a cluster — extend as far as possible
    let j = i;
    while (j < n && active[j]) j++;

    // j is now the first inactive segment after the cluster
    // Extend by 1 segment on each side for context (if possible)
    const extStart = Math.max(0, i - 1);
    const extEnd = Math.min(n - 1, j);  // j is already past the last active

    const startSec = segments[extStart].start;
    const endSeg = segments[extEnd];
    const endSec = endSeg.start + endSeg.duration;
    const duration = endSec - startSec;

    if (duration >= minDuration && duration <= maxDuration) {
      // Build window
      const windowSegments = segments.slice(extStart, extEnd + 1);
      const windowScores = scores.slice(extStart, extEnd + 1);

      // Aggregate signal matches
      const allSignals: Record<string, number> = {};
      let totalRawScore = 0;
      for (const ws of windowScores) {
        totalRawScore += ws.rawScore;
        for (const [sig, cnt] of Object.entries(ws.signalMatches)) {
          allSignals[sig] = (allSignals[sig] || 0) + cnt;
        }
      }

      // Context boost: check 3 segments before and after
      let contextScore = 0;
      for (let c = Math.max(0, extStart - 3); c < extStart; c++) {
        contextScore += scores[c].rawScore;
      }
      for (let c = extEnd + 1; c <= Math.min(n - 1, extEnd + 3); c++) {
        contextScore += scores[c].rawScore;
      }
      const contextBoost = 1 + 0.1 * contextScore;

      // Diversity bonus
      const uniqueSignals = Object.keys(allSignals).length;
      const diversityBonus = 1 + 0.15 * uniqueSignals;

      // Duration normalization: divide by √duration to prevent bias toward long windows
      const durationNorm = Math.sqrt(duration);
      const windowScore = (totalRawScore / durationNorm) * contextBoost * diversityBonus;

      windows.push({
        startSegment: extStart,
        endSegment: extEnd,
        startSeconds: startSec,
        endSeconds: endSec,
        durationSeconds: duration,
        score: windowScore,
        signals: Object.keys(allSignals),
        signalCount: Object.values(allSignals).reduce((a, b) => a + b, 0),
        diversity: uniqueSignals,
        text: windowSegments.map(s => s.text).join(' '),
      });
    }

    i = j + 1;
  }

  return windows;
}

// ---------------------------------------------------------------------------
// Main Export
// ---------------------------------------------------------------------------

/**
 * Extract candidate windows from a transcript using V2 signal library.
 *
 * @param transcript - Full transcript segments
 * @param maxCandidates - Maximum candidates to return (default 35)
 * @returns CandidateWindow[] sorted by score descending, length ≤ maxCandidates
 */
export function extractCandidates(
  transcript: TranscriptSegment[],
  maxCandidates: number = 35,
): CandidateWindow[] {
  if (transcript.length === 0) return [];

  // Step 1: Score each segment
  const scores = transcript.map(seg => scoreSegment(seg.text));

  // Step 2: Form candidate windows
  const windows = formWindows(transcript, scores);

  // Step 3: Sort by score descending
  windows.sort((a, b) => b.score - a.score);

  // Step 4: Normalize scores to 0-100
  if (windows.length > 0) {
    const maxScore = windows[0].score;
    if (maxScore > 0) {
      for (const w of windows) {
        w.score = Math.round((w.score / maxScore) * 100 * 10) / 10;
      }
    }
  }

  // Step 5: Return top-N
  return windows.slice(0, maxCandidates);
}
