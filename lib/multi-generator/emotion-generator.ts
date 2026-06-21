// ============================================================================
// lib/multi-generator/emotion-generator.ts — Emotion First Generator (Phase 2.4)
// ============================================================================
//
// Finds moments with strongest emotional resonance — vulnerability, personal
// struggle, transformation, regret, fear, gratitude, failure, redemption,
// and human connection.
//
// DIFFERENT FROM HOOK: Hook evaluates opening strength (first 3-10s).
// Emotion evaluates the emotional arc across the ENTIRE clip.
//
// DIFFERENT FROM INSIGHT: Insight evaluates value transfer.
// Emotion evaluates emotional impact.
//
// Uses structural language markers (not keywords) that signal emotional
// content. Designed for Indonesian auto-captions with fragmented segments.
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
// Emotional Signal Markers
// ============================================================================
//
// Categories:
//   VULNERABILITY (5):  personal weakness, shame, fear, embarrassment
//   STRUGGLE (5):       difficulty, hardship, perseverance
//   FAILURE (5):        defeat, loss, regret
//   GRATITUDE (4):      thankfulness, appreciation
//   TRANSFORMATION (4): change, growth, before/after
//   FEAR (4):           anxiety, worry, concern
//   SADNESS (4):        grief, disappointment, heartbreak
//   JOY (3):            happiness, pride, relief
//   CONNECTION (3):     relationships, family, community
//   HOPE (3):           optimism, aspiration, faith
// ============================================================================

type EmotionCategory =
  | 'vulnerability' | 'struggle' | 'failure' | 'gratitude'
  | 'transformation' | 'fear' | 'sadness' | 'joy' | 'connection' | 'hope';

interface EmotionMarker {
  category: EmotionCategory;
  weight: number;
  markers: string[];
}

const EMOTION_MARKERS: EmotionMarker[] = [
  // ── 1. VULNERABILITY (weight 5) ───────────────────────────────────
  // Admitting weakness, shame, embarrassment, insecurity
  {
    category: 'vulnerability',
    weight: 5,
    markers: [
      'saya malu', 'gue malu', 'aku malu',
      'saya takut', 'gue takut', 'aku takut', 'takut banget',
      'saya insecure', 'gue insecure',
      'saya nangis', 'gue nangis', 'aku nangis', 'nangis banget',
      'saya sadar', 'gue sadar', 'aku sadar',
      'saya mengaku', 'gue mengaku', 'aku mengaku',
      'jujur aja', 'jujur saja', 'honestly',
      'saya akui', 'gue akui',
      'saya lemah', 'gue lemah',
      'saya tidak sempurna', 'gue gak sempurna',
      'saya khawatir', 'gue khawatir', 'aku khawatir',
      'cemas', 'kecemasan', 'anxiety',
      'saya bersalah', 'gue bersalah', 'berdosa',
      'saya tidak tahu harus', 'gue bingung',
      'terus terang', 'blak-blakan',
      'saya buka', 'gue buka', 'curhat',
      'saya cerita', 'gue cerita', 'cerita hidup',
      'personal banget', 'terlalu personal',
    ],
  },

  // ── 2. STRUGGLE (weight 5) ────────────────────────────────────────
  // Difficulty, hardship, persevering through challenges
  {
    category: 'struggle',
    weight: 5,
    markers: [
      'perjuangan', 'berjuang', 'berjuang keras',
      'sulit banget', 'susah banget', 'berat banget',
      'paling sulit', 'paling berat', 'paling susah',
      'saya bertahan', 'gue bertahan', 'bertahan hidup',
      'saya melalui', 'gue melalui', 'melalui masa',
      'masa sulit', 'masa berat', 'masa susah',
      'perjalanan panjang', 'perjalanan hidup',
      'jatuh bangun', 'bangkit lagi',
      'bertahan', 'survive',
      'saya berusaha', 'gue berusaha', 'berusaha keras',
      'penderitaan', 'menderita',
      'saya jalani', 'gue jalani', 'menjalani',
      'cobaan', 'ujian hidup', 'tantangan hidup',
      'kerasnya hidup', 'kerasnya kehidupan',
      'saya berjuang', 'gue berjuang',
    ],
  },

  // ── 3. FAILURE (weight 5) ──────────────────────────────────────────
  // Defeat, loss, regret, mistakes
  {
    category: 'failure',
    weight: 5,
    markers: [
      'saya gagal', 'gue gagal', 'aku gagal', 'kegagalan',
      'saya jatuh', 'gue jatuh', 'kejatuhan',
      'bangkrut', 'collapsed', 'hancur',
      'saya kehilangan', 'gue kehilangan', 'kehilangan',
      'saya menyesal', 'gue menyesal', 'penyesalan', 'nyesel',
      'kesalahan terbesar', 'kesalahan fatal',
      'saya hancur', 'gue hancur', 'hancur hati',
      'saya rugi', 'gue rugi', 'kerugian',
      'saya kalah', 'gue kalah', 'kekalahan',
      'saya salah', 'kesalahan',
      'saya jatuh', 'bangkrut',
      'mistake', 'my biggest regret',
      'saya pernah gagal', 'gue pernah gagal',
    ],
  },

  // ── 4. GRATITUDE (weight 4) ────────────────────────────────────────
  // Thankfulness, appreciation, humility
  {
    category: 'gratitude',
    weight: 4,
    markers: [
      'bersyukur', 'syukur banget', 'syukur',
      'saya bersyukur', 'gue bersyukur',
      'terima kasih', 'makasih banyak',
      'alhamdulillah', 'hamdalah',
      'saya berterima kasih',
      'saya sangat berterima kasih',
      'saya tidak akan bisa', 'tanpa bantuan',
      'berkah', 'anugerah', 'karunia',
      'saya diingatkan', 'teringat',
      'saya hargai', 'saya apresiasi',
      'bersyukur banget',
    ],
  },

  // ── 5. TRANSFORMATION (weight 4) ───────────────────────────────────
  // Change, growth, before/after arc, redemption
  {
    category: 'transformation',
    weight: 4,
    markers: [
      'saya berubah', 'gue berubah', 'perubahan',
      'dulu saya', 'dulu gue',
      'sekarang saya', 'sekarang gue',
      'saya menjadi', 'gue menjadi',
      'saya belajar dari', 'belajar dari pengalaman',
      'mengubah hidup', 'mengubah saya',
      'transformasi', 'bertransformasi',
      'babak baru', 'lembaran baru', 'hidup baru',
      'titik balik', 'turning point',
      'saya bangkit', 'gue bangkit', 'bangkit dari',
      'mulai dari nol', 'mulai lagi dari awal',
      'berubah jadi', 'berubah menjadi',
      'yang dulu', 'yang sekarang',
      'saya berbeda', 'gue berbeda',
    ],
  },

  // ── 6. FEAR (weight 4) ──────────────────────────────────────────────
  // Anxiety, worry, concern, being scared
  {
    category: 'fear',
    weight: 4,
    markers: [
      'saya takut', 'gue takut', 'aku takut',
      'takut banget', 'takut sekali',
      'saya khawatir', 'khawatir',
      'saya cemas', 'cemas',
      'menakutkan', 'mengerikan', 'horor',
      'saya tidak berani', 'gue ga berani',
      'tidak berani', 'tak berani',
      'saya was-was', 'waswas',
      'paranoid', 'ketakutan',
      'saya phobia', 'fobia',
      'gelisah', 'resah',
      'ancaman', 'terancam',
    ],
  },

  // ── 7. SADNESS (weight 4) ──────────────────────────────────────────
  // Grief, disappointment, heartbreak
  {
    category: 'sadness',
    weight: 4,
    markers: [
      'saya sedih', 'gue sedih', 'sedih banget',
      'saya kecewa', 'gue kecewa', 'kecewa banget',
      'saya menangis', 'menangis',
      'air mata', 'berlinang',
      'saya kesepian', 'kesepian', 'sepi banget',
      'saya sendiri', 'sendirian',
      'sakit hati', 'patah hati',
      'saya terpuruk', 'terpuruk',
      'patah semangat', 'putus asa', 'berputus asa',
      'depresi', 'depresi banget',
      'broken heart', 'heartbroken',
      'saya sedih sekali',
      'mengharukan', 'touch', 'touching',
      'memilukan', 'menyedihkan',
    ],
  },

  // ── 8. JOY / PRIDE (weight 3) ──────────────────────────────────────
  // Happiness, pride, relief, accomplishment
  {
    category: 'joy',
    weight: 3,
    markers: [
      'saya bangga', 'gue bangga', 'bangga banget',
      'saya senang', 'senang banget', 'saya bahagia',
      'saya puas', 'puas banget',
      'saya gembira', 'gembira',
      'saya lega', 'lega banget',
      'bahagia', 'kebahagiaan',
      'saya menang', 'kemenangan',
      'prestasi', 'pencapaian', 'tercapai',
      'saya berhasil', 'berhasil',
      'luar biasa', 'luarbiasa',
      'saya bersyukur', 'bersyukur banget',
      'indah', 'keindahan',
    ],
  },

  // ── 9. HUMAN CONNECTION (weight 3) ─────────────────────────────────
  // Relationships, family, community, belonging
  {
    category: 'connection',
    weight: 3,
    markers: [
      'keluarga saya', 'keluarga gue', 'orang tua saya',
      'ibu saya', 'ayah saya', 'mama saya', 'papa saya',
      'anak saya', 'istri saya', 'suami saya',
      'teman saya', 'sahabat saya', 'sahabat',
      'orang tua', 'keluarga',
      'hubungan', 'relationship',
      'saya bersama', 'bersama',
      'perhatian', 'peduli', 'kepedulian',
      'saling', 'satu sama lain',
      'pertemanan', 'persahabatan',
      'cinta', 'kasih sayang', 'sayang',
      'rindu', 'kangen',
      'dukungan', 'mendukung', 'support',
    ],
  },

  // ── 10. HOPE (weight 3) ────────────────────────────────────────────
  // Optimism, aspiration, faith, looking forward
  {
    category: 'hope',
    weight: 3,
    markers: [
      'saya berharap', 'gue berharap', 'berharap',
      'saya yakin', 'gue yakin', 'yakin',
      'saya optimis', 'optimis',
      'saya percaya', 'gue percaya', 'percaya',
      'saya bermimpi', 'gue bermimpi', 'mimpi',
      'cita-cita', 'impian',
      'masa depan', 'kedepan',
      'saya ingin', 'gue ingin',
      'semoga', 'insyaallah', 'aamiin',
      'harapan', 'pengharapan',
      'saya tidak menyerah', 'gue ga menyerah',
      'pasti bisa', 'pasti berhasil',
      'kejar mimpi', 'kejar impian',
      'better future', 'better life',
    ],
  },
];

// ── Penalty Markers ─────────────────────────────────────────────────
// Penalize content that lacks emotional depth (pure info, stats, etc.)

const PENALTY_MARKERS: { label: string; penalty: number; markers: string[] }[] = [
  {
    label: 'pure_information',
    penalty: 4,
    markers: [
      'menurut data', 'berdasarkan data', 'data menunjukkan',
      'statistik', 'statistic', 'persentase', 'prosentase',
      'survei', 'survey', 'riset', 'penelitian',
      'faktanya', 'fakta',
      'definisi', 'pengertian',
    ],
  },
  {
    label: 'educational',
    penalty: 3,
    markers: [
      'pertama', 'kedua', 'ketiga', 'keempat',
      'step', 'steps', 'langkah',
      'cara', 'tips', 'trik',
      'tutorial', 'panduan', 'guide',
      'pertama-tama', 'selanjutnya', 'berikutnya',
    ],
  },
  {
    label: 'framework_only',
    penalty: 3,
    markers: [
      'framework', 'frameworknya',
      'model bisnis', 'business model',
      'strategi', 'strategy',
      'analisa', 'analisis', 'analysis',
    ],
  },
  {
    label: 'expert_analysis',
    penalty: 2,
    markers: [
      'menurut saya sebagai', 'sebagai seorang',
      'saya ahli', 'saya expert',
      'saya sudah puluhan tahun',
      'dari segi', 'dari sisi',
    ],
  },
  {
    label: 'greeting_intro',
    penalty: 2,
    markers: [
      'assalamualaikum', 'selamat pagi', 'selamat siang',
      'selamat sore', 'selamat malam',
      'perkenalkan', 'tamu kita',
    ],
  },
  {
    label: 'sponsor',
    penalty: 5,
    markers: [
      'sponsor', 'brought to you by',
      'promo code', 'discount code',
    ],
  },
];

// ── Flatten for efficient matching ───────────────────────────────────

interface FlatEmotionMarker {
  category: EmotionCategory;
  weight: number;
  marker: string;
}

const FLAT_MARKERS: FlatEmotionMarker[] = [];
for (const group of EMOTION_MARKERS) {
  for (const marker of group.markers) {
    FLAT_MARKERS.push({ category: group.category, weight: group.weight, marker });
  }
}

// ============================================================================
// Segment Scoring
// ============================================================================

interface EmotionSegmentScore {
  index: number;
  categories: EmotionCategory[];
  rawScore: number;
  penaltyScore: number;
  netScore: number;
  categoryCount: number;
}

function scoreSegmentForEmotion(
  segment: TranscriptSegment,
  index: number,
  contextWindow: string[],
): EmotionSegmentScore {
  const combined = [...contextWindow, segment.text].join(' ').toLowerCase();
  const categories = new Set<EmotionCategory>();
  let rawScore = 0;

  // Check emotion markers
  for (const fm of FLAT_MARKERS) {
    if (combined.includes(fm.marker)) {
      rawScore += fm.weight;
      categories.add(fm.category);
    }
  }

  // Depth bonus: +2 per category beyond the first
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
    categoryCount: categories.size,
  };
}

// ============================================================================
// Window Formation
// ============================================================================

interface EmotionCandidate {
  startSegment: number;
  endSegment: number;
  startTime: number;
  endTime: number;
  duration: number;
  emotionScore: number;
  penaltyScore: number;
  netScore: number;
  categories: EmotionCategory[];
  penalties: string[];
  emotionalDensity: number;  // avg emotion signals per segment
  categoryRichness: number;  // how many different emotion types
  transcriptExcerpt: string;
}

function formEmotionWindows(
  segments: TranscriptSegment[],
  config: GeneratorConfig,
): EmotionCandidate[] {
  const windows: EmotionCandidate[] = [];
  const n = segments.length;
  const CONTEXT = 5; // segments of context
  const MIN_SIGNALS = 2;
  const MAX_GAP = 3;

  // Score all segments with context
  const scores: EmotionSegmentScore[] = [];
  for (let i = 0; i < n; i++) {
    const ctx = segments
      .slice(Math.max(0, i - CONTEXT), i)
      .map(s => s.text);
    scores.push(scoreSegmentForEmotion(segments[i], i, ctx));
  }

  // Find emotion-dense regions
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

    // Expand window
    const extStart = Math.max(0, i - 2);
    const extEnd = Math.min(n - 1, j + 2);

    const startSec = segments[extStart].start;
    const endSec = segments[extEnd].start + segments[extEnd].duration;
    const duration = endSec - startSec;

    if (duration < config.minDuration || duration > config.maxDuration) {
      i = j + 1;
      continue;
    }

    // Aggregate
    let totalEmotion = 0;
    let totalPenalty = 0;
    let signalSegCount = 0;
    const allCategories = new Set<EmotionCategory>();
    const penalties = new Set<string>();

    for (let k = extStart; k <= extEnd; k++) {
      totalEmotion += scores[k].rawScore;
      totalPenalty += scores[k].penaltyScore;
      if (scores[k].netScore > 0) signalSegCount++;
      for (const cat of scores[k].categories) allCategories.add(cat);
    }

    const windowLen = extEnd - extStart + 1;
    const density = windowLen > 0 ? totalEmotion / windowLen : 0;

    if (signalSegCount < MIN_SIGNALS && density < 1.5) {
      i = j + 1;
      continue;
    }

    const netScore = totalEmotion - totalPenalty;

    windows.push({
      startSegment: extStart,
      endSegment: extEnd,
      startTime: startSec,
      endTime: endSec,
      duration,
      emotionScore: totalEmotion,
      penaltyScore: totalPenalty,
      netScore,
      categories: [...allCategories],
      penalties: [...penalties],
      emotionalDensity: density,
      categoryRichness: allCategories.size,
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

const CATEGORY_LABELS: Record<EmotionCategory, string> = {
  vulnerability: 'Vulnerability',
  struggle: 'Struggle/hardship',
  failure: 'Failure/regret',
  gratitude: 'Gratitude',
  transformation: 'Transformation',
  fear: 'Fear/anxiety',
  sadness: 'Sadness/grief',
  joy: 'Joy/pride',
  connection: 'Human connection',
  hope: 'Hope/optimism',
};

function generateRationale(candidate: EmotionCandidate): string {
  const labels = candidate.categories
    .map(c => CATEGORY_LABELS[c])
    .filter(Boolean)
    .slice(0, 3);

  if (labels.length === 0) return 'Low emotional resonance';

  const richness = candidate.categoryRichness >= 3
    ? ' (rich emotional arc)'
    : candidate.categoryRichness >= 2
      ? ' (mixed emotions)'
      : '';

  let rationale = labels.join(' + ') + '.' + richness;
  if (candidate.penalties.length > 0) {
    rationale += ` Penalties: ${candidate.penalties.join(', ')}`;
  }
  return rationale;
}

// ============================================================================
// Emotion Generator
// ============================================================================

export class EmotionGenerator implements IGenerator {
  readonly strategy: GeneratorStrategy = 'emotion';

  describe(): string {
    return 'Emotion First Generator — finds moments with strongest emotional resonance. ' +
      'Evaluates the full emotional arc (not just the opening). Uses structural markers for ' +
      'vulnerability, struggle, failure, gratitude, transformation, fear, sadness, joy, ' +
      'human connection, and hope. Penalizes pure information, educational content, ' +
      'framework-only explanations, and emotionless expert analysis.';
  }

  async generate(
    transcript: TranscriptSegment[],
    videoId: string,
    config: GeneratorConfig,
  ): Promise<GeneratorResult> {
    const startTime = Date.now();

    if (transcript.length === 0) {
      return {
        strategy: 'emotion',
        allCandidates: [],
        topCandidates: [],
        k: config.localTopK,
        rawCount: 0,
        durationMs: 0,
      };
    }

    const rawCandidates = formEmotionWindows(transcript, config);

    if (rawCandidates.length === 0) {
      return {
        strategy: 'emotion',
        allCandidates: [],
        topCandidates: [],
        k: config.localTopK,
        rawCount: 0,
        durationMs: Date.now() - startTime,
      };
    }

    // Sort and dedup overlapping windows (>50% overlap)
    rawCandidates.sort((a, b) => b.netScore - a.netScore);
    const deduped: EmotionCandidate[] = [];
    for (const raw of rawCandidates) {
      let dup = false;
      for (const existing of deduped) {
        const iStart = Math.max(raw.startTime, existing.startTime);
        const iEnd = Math.min(raw.endTime, existing.endTime);
        const intersection = Math.max(0, iEnd - iStart);
        const minDur = Math.min(raw.endTime - raw.startTime, existing.endTime - existing.startTime);
        if (minDur > 0 && intersection / minDur > 0.5) {
          dup = true;
          break;
        }
      }
      if (!dup) deduped.push(raw);
    }

    const maxNet = Math.max(...deduped.map(c => c.netScore));
    const allCandidates: GeneratorCandidate[] = deduped.map((raw, idx) => {
      const internalScore = maxNet > 0 ? Math.round((raw.netScore / maxNet) * 100) : 0;
      return {
        candidateId: `emotion_${idx}`,
        generator: 'emotion',
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
          confidence: raw.categoryRichness >= 3 && raw.emotionalDensity > 2
            ? 'high'
            : raw.categoryRichness >= 2
              ? 'medium'
              : 'low',
        },
      };
    });

    allCandidates.sort((a, b) => b.metadata.internalScore - a.metadata.internalScore);

    const capped = allCandidates.slice(0, config.maxRawCandidates);
    const topCandidates = capped.slice(0, config.localTopK);

    return {
      strategy: 'emotion',
      allCandidates: capped,
      topCandidates,
      k: config.localTopK,
      rawCount: allCandidates.length,
      durationMs: Date.now() - startTime,
    };
  }
}

export function getEmotionSignals() {
  return EMOTION_MARKERS.map(g => ({ category: g.category, weight: g.weight, count: g.markers.length }));
}
