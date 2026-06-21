// ============================================================================
// lib/multi-generator/insight-generator.ts — Insight First Generator (Phase 2.3)
// ============================================================================
//
// NOT a keyword detector. Uses STRUCTURAL linguistic markers that signal
// explanatory content. These are single-word/dual-phrase markers that
// indicate the speaker is delivering: causal reasoning, counterintuitive
// claims, first-principles explanations, frameworks, or lessons.
//
// "bukan modal tapi distribusi" → counterintuitive structural marker "bukan X tapi Y"
// "makanya saya bilang" → causal conclusion marker
// "padahal selama ini" → contradiction/reversal marker
// "intinya sederhana" → distillation marker
//
// Why single-word markers? Indonesian YouTube auto-captions are highly
// fragmented (2-6 words per segment). Multi-word patterns like
// "kenapa X terjadi karena Y" rarely appear in one segment.
//
// Instead we detect individual insight-signaling words, then use a
// sliding window to aggregate context around them.
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
// Insight Signal Markers
// ============================================================================
//
// Each marker is a single word or short phrase that signals the speaker
// is about to deliver (or is currently delivering) explanatory content.
// These are STRUCTURAL markers, not topic keywords.
//
// Categories:
//   STRONG (5):  unmistakable insight markers
//   HIGH (4):    strong explanatory signals
//   MEDIUM (3):  moderate signals of explanatory content
//   MILD (2):    weak signals, need surrounding context
// ============================================================================

// Maps category → weight
type InsightMarker = {
  category: 'counterintuitive' | 'causal' | 'framework' | 'principle' | 'lesson' | 'explanation' | 'problem';
  weight: number;
  markers: string[];
};

const INSIGHT_MARKERS: InsightMarker[] = [
  // ── COUNTERINTUITIVE (weight 5) ───────────────────────────────────
  // Signals the speaker is challenging a common belief or expectation.
  {
    category: 'counterintuitive',
    weight: 5,
    markers: [
      'justru',          // "actually, it's the opposite"
      'padahal',         // "whereas/despite" — contradiction marker
      'sebenarnya',      // "actually" — truth reveal
      'sebetulnya',      // "actually" (informal)
      'kebanyakan orang', // "most people" — common belief setup
      'jarang ada yang',  // "rarely does anyone" — contrarian
      'berbanding terbalik', // "inversely related"
      'mitos',           // "myth" — debunking
      'salah kaprah',    // "common misconception"
      'berkebalikan',    // "the opposite"
    ],
  },

  // ── CAUSAL (weight 5) ─────────────────────────────────────────────
  // Signals cause-effect reasoning or explanatory follow-through.
  {
    category: 'causal',
    weight: 5,
    markers: [
      'makanya',          // "that's why" — causal conclusion
      'karenanya',        // "therefore"
      'alasannya',        // "the reason is"
      'sebabnya',         // "the cause is"
      'disebabkan',       // "caused by"
      'berakibat',        // "results in"
      'menyebabkan',      // "causes"
      'dampaknya',        // "the impact is"
      'dengan begitu',    // "with that" — conclusion
      'dengan demikian',  // "therefore" (formal)
      'berujung',         // "ends up"
      'bermuara',         // "leads to"
    ],
  },

  // ── FRAMEWORK (weight 4) ──────────────────────────────────────────
  // Signals comparative, trade-off, or structured thinking.
  {
    category: 'framework',
    weight: 4,
    markers: [
      'perbedaan',        // "difference" — comparative
      'bedanya',          // "the difference" (casual)
      'membedakan',       // "distinguishes"
      'perbandingan',     // "comparison"
      'dibanding',        // "compared to"
      'lebih baik',       // "better than" — trade-off
      'trade off',        // explicit trade-off
      'sisi lain',        // "the other side" — balanced view
      'kelebihan',        // "advantages"
      'kekurangan',       // "disadvantages"
      'semakin',          // "the more...the more" — correlation
      'antara',           // "between" — distinction
    ],
  },

  // ── PRINCIPLE (weight 4) ──────────────────────────────────────────
  // Signals first-principles reasoning or fundamental truth.
  {
    category: 'principle',
    weight: 4,
    markers: [
      'pada dasarnya',    // "fundamentally" — first principles
      'pada prinsipnya',  // "in principle"
      'intinya',          // "the point is" — distillation
      'kuncinya',         // "the key is"
      'fundamental',      // "fundamental"
      'esensi',           // "essence"
      'hakikat',          // "true nature"
      'sederhananya',     // "simply put"
      'paling penting',   // "most important"
      'yang terpenting',  // "what matters most"
      'yang paling dasar', // "the most basic"
      'akar masalah',     // "root cause"
      'source of',        // "source of"
    ],
  },

  // ── LESSON (weight 4) ─────────────────────────────────────────────
  // Signals experiential learning or reflective takeaway.
  {
    category: 'lesson',
    weight: 4,
    markers: [
      'saya belajar',     // "I learned"
      'saya menyadari',   // "I realized"
      'saya sadar',       // "I realize"
      'saya paham',       // "I understand now"
      'pengalaman saya',  // "my experience"
      'pelajaran',        // "lesson"
      'dulu saya',        // "back then I" — before/after framing
      'dulu gue',         // same, informal
      'sekarang saya tahu', // "now I know" — learning arc
      'ternyata',         // "it turns out" — revelation
      'takeaway',         // explicit takeaway
      'lessons learned',  // explicit lesson
      'kalau saya',       // "if I" — personal conditional
    ],
  },

  // ── EXPLANATION (weight 3) ────────────────────────────────────────
  // Signals that the speaker is explaining or illustrating a concept.
  {
    category: 'explanation',
    weight: 3,
    markers: [
      'contohnya',        // "for example"
      'misalnya',         // "for instance"
      'ibaratnya',        // "it's like" — analogy
      'artinya',          // "that means" — interpretation
      'maksudnya',        // "the meaning is"
      'dengan kata lain', // "in other words"
      'analogi',          // "analogy"
      'begini cara',      // "this is how"
      'cara kerjanya',    // "how it works"
      'prosesnya',        // "the process"
      'mekanismenya',     // "the mechanism"
      'gambaran',         // "the picture/overview"
      'ilustrasi',        // "illustration"
      'seperti ini',      // "like this"
      'seperti itu',      // "like that"
    ],
  },

  // ── PROBLEM (weight 3) ────────────────────────────────────────────
  // Signals problem identification and solution framing.
  {
    category: 'problem',
    weight: 3,
    markers: [
      'masalahnya',       // "the problem is"
      'masalah utama',    // "main problem"
      'akar masalah',     // "root cause" (duplicate with principle)
      'tantangan',        // "challenge"
      'hambatan',         // "obstacle"
      'solusinya',        // "the solution"
      'solusi',           // "solution"
      'jawabannya',       // "the answer"
      'cara mengatasi',   // "how to overcome"
      'strategi',         // "strategy"
      'pendekatan',       // "approach"
    ],
  },
];

// ── Flatten for efficient matching ───────────────────────────────────
interface FlatMarker {
  category: string;
  weight: number;
  marker: string;
}

const FLAT_MARKERS: FlatMarker[] = [];
for (const group of INSIGHT_MARKERS) {
  for (const marker of group.markers) {
    FLAT_MARKERS.push({ category: group.category, weight: group.weight, marker });
  }
}

// ── Penalty Markers ─────────────────────────────────────────────────
// These identify content that lacks explanatory depth.

const PENALTY_MARKERS: { label: string; penalty: number; markers: string[] }[] = [
  {
    label: 'pure_reaction',
    penalty: 4,
    markers: [
      'wkwk', 'haha', 'hihi', 'hehe', 'wkwkwk',
      'gila sih', 'gila banget', 'anjir', 'anjay',
      'masa sih', 'masa gitu', 'serius?',
      'no way', 'really?', 'omg',
      '(laughs)', '(laughter)',
    ],
  },
  {
    label: 'banter',
    penalty: 3,
    markers: [
      'iya dong', 'iya lah', 'gitu dong',
      'elo', 'lu gua', 'lo gue',
    ],
  },
  {
    label: 'guest_intro',
    penalty: 4,
    markers: [
      'perkenalkan', 'tamu kita', 'bersama kita',
      'mengundang', 'narasumber',
      'please welcome', 'joining us', 'our guest',
    ],
  },
  {
    label: 'emotional_only',
    penalty: 2,
    markers: [
      'nangis', 'menangis',
      'sedih banget', 'marah banget',
    ],
  },
  {
    label: 'greeting',
    penalty: 2,
    markers: [
      'assalamualaikum', 'selamat pagi', 'selamat siang',
      'selamat sore', 'selamat malam',
      'halo', 'hai', 'hi', 'hello',
      'apa kabar', 'how are you',
    ],
  },
  {
    label: 'sponsor',
    penalty: 5,
    markers: [
      'sponsor', 'brought to you by',
      'promo code', 'discount code',
      'link di deskripsi',
    ],
  },
];

// ============================================================================
// Segment Scoring
// ============================================================================

interface InsightSegmentScore {
  index: number;
  signalCategories: string[];    // which categories fired
  rawScore: number;              // sum of all signal weights
  penaltyScore: number;          // sum of all penalty weights
  netScore: number;              // raw - penalty
  densityBonus: number;          // extra for multiple signal types
}

function scoreSegmentForInsight(segment: TranscriptSegment, index: number, window: string[]): InsightSegmentScore {
  const combinedText = [...window, segment.text].join(' ').toLowerCase();
  const categories = new Set<string>();
  let rawScore = 0;
  let penaltyScore = 0;

  // Check markers against wider context
  for (const fm of FLAT_MARKERS) {
    if (combinedText.includes(fm.marker)) {
      rawScore += fm.weight;
      categories.add(fm.category);
    }
  }

  // Penalties (check original segment)
  const lower = segment.text.toLowerCase();
  for (const pg of PENALTY_MARKERS) {
    for (const marker of pg.markers) {
      if (lower.includes(marker)) {
        penaltyScore += pg.penalty;
        break; // one match per group
      }
    }
  }

  // Density bonus: +3 for each signal category beyond the first
  const uniqueCategories = categories.size;
  const densityBonus = Math.max(0, (uniqueCategories - 1) * 3);

  return {
    index,
    signalCategories: [...categories],
    rawScore: rawScore + densityBonus,
    penaltyScore,
    netScore: rawScore + densityBonus - penaltyScore,
    densityBonus,
  };
}

// ============================================================================
// Window Formation — Sliding Window with Context Prepend
// ============================================================================

interface InsightCandidate {
  startSegment: number;
  endSegment: number;
  startTime: number;
  endTime: number;
  duration: number;
  insightScore: number;
  penaltyScore: number;
  netScore: number;
  signalCategories: string[];
  penalties: string[];
  peakDensity: number;       // max signal density in window
  transcriptExcerpt: string;
}

function shouldExcludeByText(text: string): boolean {
  const lower = text.toLowerCase();
  // Exclude segments that are pure reaction/noise
  const noisePatterns = [
    /^[a-z]+\s+[a-z]+$/i,      // very short 2-word fragments
    /^\d+\s*s$/,                // timestamp-only
    /^\[.*\]$/,                 // bracket tags
  ];
  return noisePatterns.some(p => p.test(text.trim()));
}

function formInsightWindows(
  segments: TranscriptSegment[],
  config: GeneratorConfig,
): InsightCandidate[] {
  const windows: InsightCandidate[] = [];
  const n = segments.length;
  const MIN_SIGNAL_SEGMENTS = 2;   // need at least 2 signal-carrying segments in window
  const CONTEXT_WINDOW = 5;        // segments of context before for scoring

  // Phase 1: Score all segments with sliding context
  const scores: InsightSegmentScore[] = [];
  for (let i = 0; i < n; i++) {
    const windowText = segments
      .slice(Math.max(0, i - CONTEXT_WINDOW), i + 1)
      .map(s => s.text)
      .join(' ');
    scores.push(scoreSegmentForInsight(segments[i], i, [windowText]));
  }

  // Phase 2: Find insight-dense regions
  // Use a sliding window of segments to find clusters of insight signals
  const WINDOW_SIZE = 5; // merge within 5 segments

  for (let i = 0; i < n; i++) {
    // Look ahead for clusters of insight-rich segments
    if (scores[i].netScore <= 0) continue;

    let j = i;
    let lastSignal = i;
    let gapCount = 0;
    const MAX_GAP = 3;

    while (j < n && gapCount <= MAX_GAP) {
      if (scores[j].netScore > 0) {
        lastSignal = j;
        gapCount = 0;
      } else {
        gapCount++;
      }
      j++;
    }

    // End at last signal segment
    j = lastSignal;

    // Expand: start 1 earlier (context), end 1 later (follow-through)
    const extStart = Math.max(0, i - 2);
    const extEnd = Math.min(n - 1, j + 2);

    const startSec = segments[extStart].start;
    const endSeg = segments[extEnd];
    const endSec = endSeg.start + endSeg.duration;
    const duration = endSec - startSec;

    if (duration < config.minDuration || duration > config.maxDuration) {
      i = j + 1;
      continue;
    }

    // Aggregate window scores
    let totalInsight = 0;
    let totalPenalty = 0;
    let signalSegmentCount = 0;
    const categories = new Set<string>();
    const penalties = new Set<string>();
    let maxDensity = 0;

    for (let k = extStart; k <= extEnd; k++) {
      totalInsight += scores[k].rawScore;
      totalPenalty += scores[k].penaltyScore;
      if (scores[k].netScore > 0) signalSegmentCount++;
      for (const cat of scores[k].signalCategories) categories.add(cat);
    }

    // Density: average signal score per segment
    const windowSize = extEnd - extStart + 1;
    const density = windowSize > 0 ? totalInsight / windowSize : 0;

    // Require minimum signal density
    if (signalSegmentCount < MIN_SIGNAL_SEGMENTS && density < 1.5) {
      i = j + 1;
      continue;
    }

    const netScore = totalInsight - totalPenalty;

    const windowText = segments
      .slice(extStart, extEnd + 1)
      .map((s) => s.text)
      .join(' ');

    windows.push({
      startSegment: extStart,
      endSegment: extEnd,
      startTime: startSec,
      endTime: endSec,
      duration,
      insightScore: totalInsight,
      penaltyScore: totalPenalty,
      netScore,
      signalCategories: [...categories],
      penalties: [...penalties],
      peakDensity: density,
      transcriptExcerpt: windowText,
    });

    i = j + 1;
  }

  return windows;
}

// ============================================================================
// Timeline Builder
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

// ============================================================================
// Rationale Generation
// ============================================================================

const CATEGORY_LABELS: Record<string, string> = {
  counterintuitive: 'Counterintuitive claim',
  causal: 'Causal reasoning',
  framework: 'Comparative framework',
  principle: 'First-principles reasoning',
  lesson: 'Lesson/reflection',
  explanation: 'Conceptual explanation',
  problem: 'Problem/solution framing',
};

function generateRationale(candidate: InsightCandidate): string {
  const topLabels = candidate.signalCategories
    .map((c) => CATEGORY_LABELS[c])
    .filter(Boolean)
    .slice(0, 3);

  if (topLabels.length === 0) return 'Low insight density';

  const labels = topLabels.join(' + ');
  const densityNote = candidate.peakDensity > 2
    ? ` (density: ${candidate.peakDensity.toFixed(1)})`
    : '';

  let rationale = `${labels}.${densityNote}`;
  if (candidate.penalties.length > 0) {
    rationale += ` Penalties: ${candidate.penalties.join(', ')}`;
  }
  return rationale;
}

// ============================================================================
// Insight Generator
// ============================================================================

export class InsightGenerator implements IGenerator {
  readonly strategy: GeneratorStrategy = 'insight';

  describe(): string {
    return 'Insight First Generator — identifies clips with explanatory depth using ' +
      'structural language markers (not keywords). Detects: causal reasoning, ' +
      'counterintuitive claims, comparative frameworks, first-principles explanations, ' +
      'lessons learned, and problem/solution framing. Designed for Indonesian auto-captions ' +
      'with fragmented segments.';
  }

  async generate(
    transcript: TranscriptSegment[],
    videoId: string,
    config: GeneratorConfig,
  ): Promise<GeneratorResult> {
    const startTime = Date.now();

    if (transcript.length === 0) {
      return {
        strategy: 'insight',
        allCandidates: [],
        topCandidates: [],
        k: config.localTopK,
        rawCount: 0,
        durationMs: 0,
      };
    }

    // Form candidate windows
    const rawCandidates = formInsightWindows(transcript, config);

    if (rawCandidates.length === 0) {
      return {
        strategy: 'insight',
        allCandidates: [],
        topCandidates: [],
        k: config.localTopK,
        rawCount: 0,
        durationMs: Date.now() - startTime,
      };
    }

    // Sort by netScore DESC, then dedup overlapping windows
    rawCandidates.sort((a, b) => b.netScore - a.netScore);

    // Dedup: if two windows overlap > 50%, keep the higher-scoring one
    const deduped: InsightCandidate[] = [];
    for (const raw of rawCandidates) {
      let dup = false;
      for (const existing of deduped) {
        const iStart = Math.max(raw.startTime, existing.startTime);
        const iEnd = Math.min(raw.endTime, existing.endTime);
        const intersection = Math.max(0, iEnd - iStart);
        const rawDur = raw.endTime - raw.startTime;
        const existingDur = existing.endTime - existing.startTime;
        const minDur = Math.min(rawDur, existingDur);
        if (minDur > 0 && intersection / minDur > 0.5) {
          dup = true;
          break;
        }
      }
      if (!dup) deduped.push(raw);
    }

    const maxNetScore = Math.max(...deduped.map((c) => c.netScore));
    const allCandidates: GeneratorCandidate[] = deduped.map((raw, idx) => {
      const internalScore = maxNetScore > 0
        ? Math.round((raw.netScore / maxNetScore) * 100)
        : 0;

      return {
        candidateId: `insight_${idx}`,
        generator: 'insight',
        videoId,
        startTime: raw.startTime,
        endTime: raw.endTime,
        durationSeconds: raw.duration,
        transcriptExcerpt: raw.transcriptExcerpt,
        timeline: buildTimelineJSON(videoId, raw.startTime, raw.endTime),
        metadata: {
          selectionRationale: generateRationale(raw),
          triggerSignals: raw.signalCategories,
          internalScore: Math.max(0, Math.min(100, internalScore)),
          confidence: raw.signalCategories.length >= 3 && raw.peakDensity > 2
            ? 'high'
            : raw.signalCategories.length >= 2
              ? 'medium'
              : 'low',
        },
      };
    });

    // Sort by internalScore DESC
    allCandidates.sort((a, b) => b.metadata.internalScore - a.metadata.internalScore);

    // Cap and top K
    const capped = allCandidates.slice(0, config.maxRawCandidates);
    const topCandidates = capped.slice(0, config.localTopK);

    return {
      strategy: 'insight',
      allCandidates: capped,
      topCandidates,
      k: config.localTopK,
      rawCount: allCandidates.length,
      durationMs: Date.now() - startTime,
    };
  }
}

// ============================================================================
// Exported utilities
// ============================================================================

export function getInsightMarkers() {
  return INSIGHT_MARKERS.map((g) => ({ category: g.category, weight: g.weight, count: g.markers.length }));
}
