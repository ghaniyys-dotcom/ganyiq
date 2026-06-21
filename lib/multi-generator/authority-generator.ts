// ============================================================================
// lib/multi-generator/authority-generator.ts — Authority First (Phase 2.5)
// ============================================================================
//
// Identifies credibility, expertise, evidence, and trust-building moments.
//
// Rewards:
//   - Expert explanations with data/evidence backing
//   - Statistics, research references, firsthand professional experience
//   - Historical context, domain expertise, case studies
//   - Evidence-backed comparisons
//
// Penalizes:
//   - Emotional-only moments without evidence
//   - Motivational speeches without substance
//   - Personal venting, weak opinions, controversy without support
//
// DIFFERENT FROM HOOK: Authority is rational, not attention-driven.
// DIFFERENT FROM INSIGHT: Authority requires evidence/source, not just explanation.
// DIFFERENT FROM EMOTION: Authority is objective/cited, not emotional.
// ============================================================================

import type { TranscriptSegment } from '../types';
import type {
  IGenerator,
  GeneratorCandidate,
  GeneratorResult,
  GeneratorConfig,
  GeneratorStrategy,
} from './types';
import type { TimelineJSON } from '../timeline-types';

// ============================================================================
// Authority Signal Markers
// ============================================================================

type AuthorityCategory =
  | 'data_evidence' | 'professional_authority' | 'research_reference'
  | 'historical_context' | 'case_study' | 'domain_expertise'
  | 'expert_comparison' | 'firsthand_experience' | 'source_attribution';

interface AuthorityMarker {
  category: AuthorityCategory;
  weight: number;
  markers: (string | RegExp)[];
}

const AUTHORITY_MARKERS: AuthorityMarker[] = [
  // ── 1. DATA & EVIDENCE (weight 5) ─────────────────────────────────
  // Statistics, numbers, percentages, data-backed claims
  {
    category: 'data_evidence',
    weight: 5,
    markers: [
      'data menunjukkan', 'data menunjukan', 'data mengatakan',
      'menurut data', 'berdasarkan data',
      'statistik', 'statistic', 'statistics',
      'angka', 'persen', 'persentase', 'prosentase',
      'rasio', 'rata-rata', 'rata rata',
      'sebanyak', 'sejumlah', 'total',
      'survey', 'survei', 'riset', 'research',
      'penelitian', 'studi', 'study',
      'fakta', 'faktanya', 'bukti', 'terbukti',
      'evidence', 'data point',
      'dalam 5 tahun', 'dalam 10 tahun', 'dalam 20 tahun',
      'menurut laporan', 'berdasarkan laporan',
      'data terbaru', 'data terkini',
      'hitungan', 'kalkulasi', 'perhitungan',
      'berdasarkan fakta', 'berdasarkan bukti',
      // Number patterns: "3 dari 4", "95%", "Rp 100 miliar"
      /\d+\s*dari\s*\d+/,
      /\d+[.,]\d+\s*(juta|miliar|triliun|ribu)/,
      /rp\s*[\d.,\s]+/i,
      /\$\s*[\d.,]+/i,
      /\d+\s*(orang|perusahaan|negara|tahun|bulan)/i,
    ],
  },

  // ── 2. PROFESSIONAL AUTHORITY (weight 5) ─────────────────────────
  // Expert role, institutional affiliation, credentials
  {
    category: 'professional_authority',
    weight: 5,
    markers: [
      'saya sebagai', 'gue sebagai',
      'saya bekerja', 'gue bekerja',
      'saya menjabat', 'saya menjadi',
      'waktu saya di', 'ketika saya di',
      'saya sudah', 'saya telah', 'saya selama',
      'pengalaman saya', 'pengalaman gue',
      'saya praktek', 'saya praktik',
      'profesi', 'profesi saya',
      'jabatan', 'posisi',
      'saya menangani', 'saya handle',
      'klien saya', 'klien gue',
      'karir saya', 'karier saya',
      'bidang saya', 'spesialisasi',
      'saya berkecimpung',
      'saya puluhan tahun', 'sudah puluhan tahun',
      'berpengalaman', 'berpengalaman di',
      'saya ahli', 'saya expert',
      'kompeten', 'kompetensi',
      'saya di bidang', 'saya di industri',
      'praktisi', 'profesional',
      'saya lulusan', 'saya alumni',
      'sertifikasi', 'certified',
      'izin praktek', 'izin praktik',
    ],
  },

  // ── 3. RESEARCH REFERENCE (weight 4) ─────────────────────────────
  // Citing studies, experts, publications, sources
  {
    category: 'research_reference',
    weight: 4,
    markers: [
      'menurut penelitian', 'menurut studi', 'menurut riset',
      'menurut para ahli', 'menurut pakar',
      'menurut', 'menurut saya',
      'berdasarkan penelitian', 'berdasarkan studi',
      'penelitian menunjukkan', 'studi menunjukkan',
      'jurnal', 'publikasi', 'paper',
      'universitas', 'institut',
      'dosen', 'profesor', 'doktor', 'dokter',
      'peneliti', 'periset',
      'dikutip dari', 'dikutip dari',
      'mengutip', 'merujuk pada',
      'sumber', 'sumber terpercaya',
      'berdasarkan sumber', 'berdasarkan referensi',
      'dalam jurnal', 'dalam penelitian',
      'menurut WHO', 'menurut Bank Dunia', 'menurut PBB',
      'berdasarkan kajian', 'berdasarkan analisis',
      'ilmiah', 'secara ilmiah',
    ],
  },

  // ── 4. HISTORICAL CONTEXT (weight 4) ─────────────────────────────
  // Historical patterns, trends over time, context
  {
    category: 'historical_context',
    weight: 4,
    markers: [
      'sejarah', 'sejarahnya', 'secara historis',
      'pada tahun', 'tahun', 'era',
      'sejak', 'mulai dari', 'dari dulu',
      'dulu', 'dahulu', 'dahulu kala',
      'dari zaman', 'sejak zaman',
      'perkembangan', 'evolusi',
      'tren', 'trend', 'pola',
      'sepanjang sejarah', 'sepanjang masa',
      'orde lama', 'orde baru', 'reformasi',
      'masa lalu', 'masa lampau',
      'berabad-abad', 'puluhan tahun',
      'generasi', 'angkatan',
      'periode', 'fase', 'tahapan',
      'sebelumnya', 'sebelum',
      'konteks sejarah', 'secara historis',
      'dari dulu sampai sekarang',
    ],
  },

  // ── 5. CASE STUDY / EXAMPLE (weight 4) ────────────────────────────
  // Concrete examples, case studies, real-world applications
  {
    category: 'case_study',
    weight: 4,
    markers: [
      'contoh kasus', 'studi kasus', 'case study',
      'contoh nyata', 'contoh konkret', 'contoh real',
      'misalnya', 'contohnya',
      'salah satu contoh', 'contoh paling',
      'kasus', 'kasus nyata',
      'kejadian nyata', 'peristiwa nyata',
      'salah satu kasus', 'dalam kasus',
      'contoh sederhana', 'contoh konkrit',
      'kasus seperti', 'kasus ini',
      'real example', 'real case',
      'prakteknya', 'praktiknya',
      'implementasi', 'penerapan',
      'terjadi pada', 'terjadi di',
    ],
  },

  // ── 6. DOMAIN EXPERTISE (weight 3) ───────────────────────────────
  // Technical terminology, specialized knowledge, deep domain insight
  {
    category: 'domain_expertise',
    weight: 3,
    markers: [
      'secara teknis', 'secara teknis',
      'dari segi', 'dari sisi',
      'mekanisme', 'mekanismenya',
      'sistem', 'proses',
      'infrastruktur', 'struktur',
      'regulasi', 'kebijakan',
      'standar', 'standarisasi',
      'protokol', 'prosedur',
      'spesifikasi', 'spesifikasi',
      'parameter', 'variabel', 'indikator',
      'efisiensi', 'efektivitas', 'optimal',
      'analisis', 'analisa', 'assessment',
      'evaluasi', 'evaluate',
      'metodologi', 'metode',
      'framework', 'kerangka kerja',
      'algoritma', 'algoritme',
      'arsitektur', 'infrastruktur',
      // Technical Indonesian
      'koefisien', 'korelasi', 'kausalitas',
      'diferensiasi', 'segmentasi',
      'benchmark', 'benchmarking',
    ],
  },

  // ── 7. EXPERT COMPARISON (weight 3) ─────────────────────────────
  // Evidence-based comparisons, benchmarks, professional judgment
  {
    category: 'expert_comparison',
    weight: 3,
    markers: [
      'dibandingkan', 'dibanding',
      'perbandingan', 'komparasi',
      'lebih efektif', 'lebih efisien',
      'berbeda dengan', 'berbeda dari',
      'keunggulan', 'kelebihan',
      'kekurangan', 'kelemahan',
      'kelebihan dan kekurangan',
      'lebih baik dari', 'lebih buruk dari',
      'sama halnya dengan', 'serupa dengan',
      'perbedaan mendasar',
      'dari sisi', 'dari segi',
      'benchmark', 'benchmarking',
      'standar industri', 'standar',
    ],
  },

  // ── 8. FIRSTHAND EXPERIENCE (weight 3) ──────────────────────────
  // Direct professional experience, "when I worked in..."
  {
    category: 'firsthand_experience',
    weight: 3,
    markers: [
      'saya alami', 'saya rasakan',
      'saya kerjakan', 'saya lakukan',
      'saya tangani', 'saya handle',
      'saya selesaikan', 'selesaikan',
      'waktu saya bekerja', 'saat saya bekerja',
      'ketika saya bekerja', 'selama saya bekerja',
      'saya pernah', 'saya sempat',
      'saya ikut', 'saya terlibat', 'serta',
      'proyek', 'project', 'tugas',
      'saya memimpin', 'saya pimpin',
      'saya membangun', 'saya bangun',
      'saya mengelola', 'saya kelola',
      'pengalaman langsung', 'pengalaman pribadi',
      'saya hadapi', 'saya menghadapi',
      'saya saksikan', 'saya lihat langsung',
      'saya observasi', 'saya amati',
    ],
  },

  // ── 9. SOURCE ATTRIBUTION (weight 3) ─────────────────────────────
  // Citing specific sources, references, verifiable claims
  {
    category: 'source_attribution',
    weight: 3,
    markers: [
      'menurut', 'menurut sumber',
      'berdasarkan', 'berdasarkan sumber',
      'mengutip', 'dikutip',
      'referensi', 'referensi',
      'sumber', 'sumber terpercaya',
      'menurut laporan', 'menurut data',
      'berdasarkan catatan', 'berdasarkan arsip',
      'dokumen', 'dokumentasi',
      'tercatat', 'terdokumentasi',
      'yang saya baca', 'yang saya pelajari',
      'saya pelajari dari', 'saya baca dari',
      'literatur', 'kepustakaan',
      'acuan', 'rujukan',
    ],
  },
];

// ── Penalty Markers ─────────────────────────────────────────────────
// Penalize content that lacks authority/evidence backing

const PENALTY_MARKERS: { label: string; penalty: number; markers: string[] }[] = [
  {
    label: 'emotional_only',
    penalty: 4,
    markers: [
      'nangis', 'menangis', 'air mata',
      'saya sedih', 'gue sedih', 'sedih banget',
      'saya takut', 'takut banget',
      'saya malu', 'malu banget',
      'saya kecewa', 'kecewa banget',
      'broken heart', 'patah hati',
      'saya nangis', 'gue nangis',
      'saya trauma', 'trauma',
    ],
  },
  {
    label: 'motivational',
    penalty: 4,
    markers: [
      'jangan menyerah', 'jangan pernah menyerah',
      'kejar mimpi', 'kejar impian',
      'pasti bisa', 'kamu pasti bisa',
      'semangat', 'semangat terus',
      'you can do it', 'never give up',
      'percaya pada diri sendiri',
      'kamu mampu', 'kamu hebat',
      'jadilah pribadi', 'jadilah orang',
      'inspirasi', 'inspirational',
      'motivasi', 'motivation',
    ],
  },
  {
    label: 'personal_venting',
    penalty: 3,
    markers: [
      'saya kesal', 'gue kesal', 'kesel banget',
      'saya muak', 'gue muak',
      'saya capek', 'gue capek',
      'saya benci', 'gue benci',
      'goblok', 'bodoh', 'tolol',
      'saya sebel', 'gue sebel',
    ],
  },
  {
    label: 'weak_opinion',
    penalty: 3,
    markers: [
      'saya rasa', 'gue rasa', 'menurut gue', 'menurut gua',
      'saya kira', 'gue kira',
      'saya pikir', 'gue pikir',
      'saya feeling', 'gue feeling',
      'entahlah', 'entah',
    ],
  },
  {
    label: 'controversy_without_support',
    penalty: 3,
    markers: [
      'saya tidak setuju', 'gue ga setuju',
      'itu salah', 'itu keliru',
      'itu tidak benar', 'itu ga bener',
      'hot take', 'unpopular opinion',
    ],
  },
  {
    label: 'greeting_sponsor',
    penalty: 3,
    markers: [
      'assalamualaikum', 'selamat pagi', 'selamat siang',
      'sponsor', 'brought to you by',
      'promo code', 'discount code',
    ],
  },
];

// ── Flatten markers ─────────────────────────────────────────────────

interface FlatAuthorityMarker {
  category: AuthorityCategory;
  weight: number;
  marker: string;
}

const FLAT_MARKERS: FlatAuthorityMarker[] = [];
// Track regex-based markers separately
const REGEX_MARKERS: Array<{ category: AuthorityCategory; weight: number; pattern: RegExp }> = [];

for (const group of AUTHORITY_MARKERS) {
  for (const marker of group.markers) {
    if (marker instanceof RegExp) {
      REGEX_MARKERS.push({ category: group.category, weight: group.weight, pattern: marker });
    } else {
      FLAT_MARKERS.push({ category: group.category, weight: group.weight, marker });
    }
  }
}

// ============================================================================
// Segment Scoring
// ============================================================================

interface AuthoritySegmentScore {
  index: number;
  categories: AuthorityCategory[];
  rawScore: number;
  penaltyScore: number;
  netScore: number;
}

function scoreSegmentForAuthority(
  segment: TranscriptSegment,
  index: number,
  contextWindow: string[],
): AuthoritySegmentScore {
  const combined = [...contextWindow, segment.text].join(' ').toLowerCase();
  const categories = new Set<AuthorityCategory>();
  let rawScore = 0;

  // String markers
  for (const fm of FLAT_MARKERS) {
    if (combined.includes(fm.marker)) {
      rawScore += fm.weight;
      categories.add(fm.category);
    }
  }

  // Regex markers
  for (const rm of REGEX_MARKERS) {
    if (rm.pattern.test(segment.text)) {
      rawScore += rm.weight;
      categories.add(rm.category);
    }
  }

  // Depth bonus: +2 per category beyond first
  const depthBonus = Math.max(0, (categories.size - 1) * 2);

  // Penalties
  const lower = segment.text.toLowerCase();
  let penaltyScore = 0;
  for (const pg of PENALTY_MARKERS) {
    for (const marker of pg.markers) {
      if (lower.includes(marker)) {
        penaltyScore += pg.penalty;
        break;
      }
    }
  }

  return {
    index,
    categories: [...categories],
    rawScore: rawScore + depthBonus,
    penaltyScore,
    netScore: rawScore + depthBonus - penaltyScore,
  };
}

// ============================================================================
// Window Formation
// ============================================================================

interface AuthorityCandidate {
  startSegment: number;
  endSegment: number;
  startTime: number;
  endTime: number;
  duration: number;
  authorityScore: number;
  penaltyScore: number;
  netScore: number;
  categories: AuthorityCategory[];
  penalties: string[];
  signalDensity: number;
  categoryRichness: number;
  transcriptExcerpt: string;
}

function formAuthorityWindows(
  segments: TranscriptSegment[],
  config: GeneratorConfig,
): AuthorityCandidate[] {
  const windows: AuthorityCandidate[] = [];
  const n = segments.length;
  const CONTEXT = 5;
  const MAX_GAP = 3;

  // Score all segments
  const scores: AuthoritySegmentScore[] = [];
  for (let i = 0; i < n; i++) {
    const ctx = segments.slice(Math.max(0, i - CONTEXT), i).map(s => s.text);
    scores.push(scoreSegmentForAuthority(segments[i], i, ctx));
  }

  // Find authority-dense regions
  let i = 0;
  while (i < n) {
    if (scores[i].netScore <= 0) { i++; continue; }

    let j = i;
    let lastSignal = i;
    let gapCount = 0;

    while (j < n && gapCount <= MAX_GAP) {
      if (scores[j].netScore > 0) {
        lastSignal = j;
        gapCount = 0;
      } else {
        gapCount++;
      }
      j++;
    }

    j = lastSignal;

    const extStart = Math.max(0, i - 2);
    const extEnd = Math.min(n - 1, j + 2);
    const startSec = segments[extStart].start;
    const endSec = segments[extEnd].start + segments[extEnd].duration;
    const duration = endSec - startSec;

    if (duration < config.minDuration || duration > config.maxDuration) {
      i = j + 1;
      continue;
    }

    let totalAuth = 0;
    let totalPen = 0;
    let signalSeg = 0;
    const allCat = new Set<AuthorityCategory>();
    const penalties = new Set<string>();

    for (let k = extStart; k <= extEnd; k++) {
      totalAuth += scores[k].rawScore;
      totalPen += scores[k].penaltyScore;
      if (scores[k].netScore > 0) signalSeg++;
      for (const cat of scores[k].categories) allCat.add(cat);
    }

    const winSize = extEnd - extStart + 1;
    const density = winSize > 0 ? totalAuth / winSize : 0;

    // Require at least 2 signal segments OR high density
    if (signalSeg < 2 && density < 2) {
      i = j + 1;
      continue;
    }

    windows.push({
      startSegment: extStart,
      endSegment: extEnd,
      startTime: startSec,
      endTime: endSec,
      duration,
      authorityScore: totalAuth,
      penaltyScore: totalPen,
      netScore: totalAuth - totalPen,
      categories: [...allCat],
      penalties: [...penalties],
      signalDensity: density,
      categoryRichness: allCat.size,
      transcriptExcerpt: segments.slice(extStart, extEnd + 1).map(s => s.text).join(' '),
    });

    i = j + 1;
  }

  return windows;
}

// ============================================================================
// Helpers
// ============================================================================

function buildTimelineJSON(videoId: string, startTime: number, endTime: number): TimelineJSON {
  return {
    version: 1,
    schema: 'ganyiq-timeline-v1',
    duration: endTime - startTime,
    metadata: {
      projectId: videoId,
      sourceVideo: videoId,
      sourceDuration: endTime - startTime,
      createdAt: new Date().toISOString(),
    },
    tracks: [],
  };
}

const CATEGORY_LABELS: Record<AuthorityCategory, string> = {
  data_evidence: 'Data/evidence',
  professional_authority: 'Professional authority',
  research_reference: 'Research reference',
  historical_context: 'Historical context',
  case_study: 'Case study',
  domain_expertise: 'Domain expertise',
  expert_comparison: 'Expert comparison',
  firsthand_experience: 'Firsthand experience',
  source_attribution: 'Source attribution',
};

function generateRationale(candidate: AuthorityCandidate): string {
  const labels = candidate.categories.map(c => CATEGORY_LABELS[c]).filter(Boolean).slice(0, 3);
  if (labels.length === 0) return 'Low authority signal';
  const richness = candidate.categoryRichness >= 3 ? ' (multi-source)' : '';
  let r = labels.join(' + ') + '.' + richness;
  if (candidate.penalties.length > 0) r += ` Penalties: ${candidate.penalties.join(', ')}`;
  return r;
}

// ============================================================================
// Authority Generator
// ============================================================================

export class AuthorityGenerator implements IGenerator {
  readonly strategy: GeneratorStrategy = 'hook';  // placeholder — will use proper type

  constructor() {
    // Override strategy after construction since GeneratorStrategy doesn't include 'authority'
    Object.defineProperty(this, 'strategy', { value: 'hook', writable: false });
  }

  get actualStrategy(): string {
    return 'authority';
  }

  describe(): string {
    return 'Authority First Generator — identifies credibility, expertise, evidence, ' +
      'and trust-building moments. Uses structural markers for data/evidence, professional ' +
      'authority, research references, historical context, case studies, domain expertise, ' +
      'firsthand experience, and source attribution. Penalizes emotional-only, motivational, ' +
      'personal venting, weak opinions, and controversy without support.';
  }

  async generate(
    transcript: TranscriptSegment[],
    videoId: string,
    config: GeneratorConfig,
  ): Promise<GeneratorResult> {
    const startTime = Date.now();
    if (transcript.length === 0) {
      return { strategy: 'hook', allCandidates: [], topCandidates: [], k: config.localTopK, rawCount: 0, durationMs: 0 };
    }

    const rawCandidates = formAuthorityWindows(transcript, config);

    if (rawCandidates.length === 0) {
      return { strategy: 'hook', allCandidates: [], topCandidates: [], k: config.localTopK, rawCount: 0, durationMs: Date.now() - startTime };
    }

    // Sort and dedup
    rawCandidates.sort((a, b) => b.netScore - a.netScore);
    const deduped: AuthorityCandidate[] = [];
    for (const raw of rawCandidates) {
      let dup = false;
      for (const existing of deduped) {
        const iStart = Math.max(raw.startTime, existing.startTime);
        const iEnd = Math.min(raw.endTime, existing.endTime);
        const intersection = Math.max(0, iEnd - iStart);
        const minDur = Math.min(raw.endTime - raw.startTime, existing.endTime - existing.startTime);
        if (minDur > 0 && intersection / minDur > 0.5) { dup = true; break; }
      }
      if (!dup) deduped.push(raw);
    }

    const maxNet = Math.max(...deduped.map(c => c.netScore));
    const allCandidates: GeneratorCandidate[] = deduped.map((raw, idx) => {
      const internalScore = maxNet > 0 ? Math.round((raw.netScore / maxNet) * 100) : 0;
      return {
        candidateId: `auth_${idx}`,
        generator: 'hook',
        videoId,
        startTime: raw.startTime,
        endTime: raw.endTime,
        durationSeconds: raw.duration,
        transcriptExcerpt: raw.transcriptExcerpt,
        timeline: buildTimelineJSON(videoId, raw.startTime, raw.endTime),
        metadata: {
          selectionRationale: generateRationale(raw),
          triggerSignals: raw.categories,
          internalScore: Math.max(0, Math.min(100, internalScore)),
          confidence: raw.categoryRichness >= 3 && raw.signalDensity > 2 ? 'high'
            : raw.categoryRichness >= 2 ? 'medium' : 'low',
        },
      };
    });

    allCandidates.sort((a, b) => b.metadata.internalScore - a.metadata.internalScore);
    const capped = allCandidates.slice(0, config.maxRawCandidates);
    const topCandidates = capped.slice(0, config.localTopK);

    return {
      strategy: 'hook',
      allCandidates: capped,
      topCandidates,
      k: config.localTopK,
      rawCount: allCandidates.length,
      durationMs: Date.now() - startTime,
    };
  }
}

export function getAuthoritySignals() {
  return AUTHORITY_MARKERS.map(g => ({ category: g.category, weight: g.weight, count: g.markers.length }));
}
