// ============================================================================
// lib/multi-generator/hook-generator.ts — Hook First Generator (Phase 2.2)
// ============================================================================
//
// Goal: Generate clips optimized for the strongest opening hook within the
// first 3–10 seconds. Entirely signal-based — NO LLM calls.
//
// Strategy:
//   1. Score each transcript segment against hook signals (curiosity gap,
//      controversy, surprise, strong opinion, emotional opening, question)
//   2. Penalize segments that look like greetings, intros, sponsor reads,
//      housekeeping, or transitions
//   3. Form candidate windows around high-hook segments
//   4. Score each candidate by its opening 3–10 seconds
//   5. Local rank by hookScore → keep top `localTopK`
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
// Hook Signal Library
// ============================================================================

interface HookSignalDef {
  weight: number;
  keywords: string[];
}

/** Signals that indicate a strong hook opening. */
const HOOK_SIGNALS: Record<string, HookSignalDef> = {
  // ── 1. CURIOSITY GAP (weight 5) ──────────────────────────────────────
  curiosity_gap: {
    weight: 5,
    keywords: [
      'you won\'t believe', 'guess what', 'wait till you', 'plot twist',
      'the real reason', 'what happened next', 'what comes next',
      'but then', 'little did i', 'little did they',
      'the truth is', 'here\'s the thing', 'the problem is',
      'what most people', 'what nobody tells you',
      'the secret to', 'the hidden', 'underrated',
      'tapi ternyata', 'eh ternyata', 'tau gak', 'mau tau',
      'penasaran', 'tunggu dulu', 'belum selesai',
      'masih ada lagi', 'yang lebih parah', 'tebak apa',
      'coba tebak', 'yang gak disangka', 'tak disangka',
      'nggak nyangka', 'dan ternyata', 'tiba-tiba', 'tau-tau',
      'puncaknya', 'klimaksnya', 'yang paling gila',
      'rahasia', 'terungkap', 'misteri',
      'you won\'t guess', 'the crazy thing is',
      'what\'s wild is', 'what\'s interesting is',
      'the best part?', 'the worst part?',
      'here\'s the kicker', 'get this',
    ],
  },

  // ── 2. CONTROVERSIAL / HOT TAKE (weight 5) ──────────────────────────
  controversial: {
    weight: 5,
    keywords: [
      'hot take', 'unpopular opinion', 'controversial opinion',
      'i disagree', 'actually', 'the truth is',
      'no one wants to admit', 'nobody talks about',
      'people are wrong about', 'wrong', 'misguided',
      'salah', 'keliru', 'tidak benar', 'bukan begitu',
      'sebenarnya', 'justru', 'malah', 'sebaliknya',
      'kontroversi', 'menolak', 'membantah',
      'tidak setuju', 'beda pendapat',
      'menurut gue', 'menurut gua', 'menurut saya',
      'gue berani bilang', 'saya berani bilang',
      'orang gak mau denger', 'jarang ada yang',
      'sejujurnya', 'jujur aja', 'honestly',
      'people don\'t realize', 'the reality is',
      'let\'s be honest', 'let\'s be real',
      'i\'ll say it', 'somebody needs to say it',
      'here\'s what nobody tells you about',
      'everyone thinks but', 'popular belief is wrong',
    ],
  },

  // ── 3. SURPRISING CLAIM (weight 4) ──────────────────────────────────
  surprising_claim: {
    weight: 4,
    keywords: [
      'shocking', 'unbelievable', 'incredible', 'insane',
      'this is crazy', 'mind blowing', 'life changing',
      'game changer', 'breakthrough', 'revolutionary',
      'tergila', 'termengerikan', 'teraneh', 'terunik',
      'tidak pernah ada', 'belum pernah', 'pertama kali',
      'pasti', 'yakin', 'jamin', 'garansi', 'serius',
      'sungguh', 'betul', 'memang', 'tentu',
      'bukti', 'fakta', 'kebenaran',
      'tidak bisa', 'mustahil', 'tidak mungkin',
      'satu-satunya', 'terbesar', 'terpenting', 'nomor satu',
      'wajib', 'harus', 'jangan pernah',
      'definitely', 'absolutely', 'guarantee',
      'never', 'always', 'only', 'must',
      'serius?', 'beneran?', 'masa sih',
      'percaya nggak', 'gak percaya',
      'this changes everything', 'i promise you',
    ],
  },

  // ── 4. STRONG OPINION (weight 4) ────────────────────────────────────
  strong_opinion: {
    weight: 4,
    keywords: [
      'i think', 'i believe', 'in my opinion', 'i feel',
      'i\'m convinced', 'i know for a fact',
      'the problem with', 'the issue is',
      'what bothers me', 'what frustrates me',
      'what i love about', 'what i hate about',
      'the worst thing', 'the best thing',
      'i guarantee you', 'i promise you',
      'mark my words', 'take it from me',
      'menurut gue', 'menurut saya', 'gue rasa',
      'saya rasa', 'sejujurnya', 'jujur',
      'that\'s why', 'that\'s because',
      'the reason is', 'here\'s why',
      'i\'ll tell you what', 'you know what',
      'what i\'m saying is', 'what i mean is',
    ],
  },

  // ── 5. EMOTIONAL OPENING (weight 3) ─────────────────────────────────
  emotional_opening: {
    weight: 3,
    keywords: [
      'i remember', 'i still remember', 'when i was',
      'the moment i', 'the day i',
      'it was the', 'it changed my life',
      'i never thought', 'i never expected',
      'i was scared', 'i was terrified', 'i was excited',
      'it was heartbreaking', 'it was amazing',
      'waktu itu', 'dulu', 'pernah', 'pengalaman',
      'kejadian', 'peristiwa',
      'luar biasa', 'gila', 'sangat', 'banget',
      'menakjubkan', 'hebat', 'keren',
      'sedih', 'marah', 'kesal', 'kecewa',
      'malu', 'menangis', 'nangis',
      'gagal', 'jatuh', 'bangkrut',
      'trauma', 'sakit', 'menderita',
      'senang', 'bahagia', 'bangga',
      'excited', 'passion', 'cinta',
      'i was wrong', 'i made a mistake',
      'the hardest', 'the most difficult',
      'the best decision', 'the worst decision',
      'i\'ll never forget', 'i can still remember',
    ],
  },

  // ── 6. QUESTION-DRIVEN (weight 3) ───────────────────────────────────
  question_driven: {
    weight: 3,
    keywords: [
      'have you ever', 'what if', 'did you know',
      'do you know', 'do you realize',
      'what would you do', 'how would you feel',
      'what happens when', 'what happens if',
      'have you noticed', 'ever wonder',
      'are you ready', 'can you imagine',
      'what\'s the one thing', 'who here has',
      'apa', 'siapa', 'kenapa', 'bagaimana',
      'kapan', 'dimana', 'mengapa', 'gimana',
      'tahukah', 'pernahkah', 'bayangkan',
      'apakah', 'siapa yang', 'apa yang',
      'what', 'who', 'why', 'how', 'when',
      'imagine', 'picture this', 'think about this',
      'what\'s the first thing', 'how many of you',
      'what do you think', 'do you ever',
      'could you', 'would you', 'should you',
      'how often do you', 'how long have you',
      'are you the kind of person',
    ],
  },
};

// ── Penalty Signals (reduce score) ─────────────────────────────────────

interface PenaltySignalDef {
  penalty: number;
  keywords: string[];
}

const PENALTY_SIGNALS: Record<string, PenaltySignalDef> = {
  greeting: {
    penalty: 4,
    keywords: [
      'hello', 'hi', 'hey', 'welcome', 'good morning', 'good evening',
      'good afternoon', 'assalamualaikum', 'selamat pagi',
      'selamat siang', 'selamat sore', 'selamat malam',
      'halo', 'hai', 'hai hai', 'helo', 'hallo',
      'what\'s up', 'whats up', 'how\'s it going',
      'how are you', 'how you doing', 'welcome back',
      'selamat datang', 'kembali lagi', 'balik lagi',
      'senang bertemu', 'senang bisa', 'terima kasih sudah',
    ],
  },

  guest_intro: {
    penalty: 5,
    keywords: [
      'introducing', 'our guest', 'please welcome', 'joining us',
      'our speaker', 'our panelist', 'special guest',
      'today\'s guest', 'this week\'s guest',
      'let me introduce', 'i\'d like to introduce',
      'we have with us', 'we are joined by',
      'tamu kita', 'tamu kita hari ini', 'bintang tamu',
      'bersama kita', 'bersama kami',
      'perkenalkan', 'mengundang', 'menghadirkan',
      'guest today', 'our special guest',
    ],
  },

  sponsor: {
    penalty: 5,
    keywords: [
      'sponsor', 'brought to you by', 'supported by',
      'today\'s video is sponsored', 'this episode is brought',
      'thanks to our sponsor', 'in partnership with',
      'sponsored by', 'our sponsor',
      'disponsori', 'didukung oleh', 'sponsor kita',
      'berkerja sama dengan', 'bersama',
      'promo code', 'discount code', 'use code',
      'link in description', 'check out',
      'go check out', 'head over to',
      'this video is brought to you',
    ],
  },

  housekeeping: {
    penalty: 3,
    keywords: [
      'before we begin', 'before we start', 'before we dive in',
      'just a quick note', 'quick reminder',
      'don\'t forget to subscribe', 'like this video',
      'subscribe', 'smash that like', 'hit that like',
      'click the bell', 'turn on notifications',
      'comment below', 'let me know in the comments',
      'jangan lupa subscribe', 'jangan lupa like',
      'subscribe dulu', 'like dulu',
      'sebelum kita mulai', 'sebelum kita lanjut',
      'cek link', 'link di deskripsi',
      'support us on', 'follow me on',
      'connect with me', 'reach me at',
    ],
  },

  transition: {
    penalty: 2,
    keywords: [
      'anyway', 'moving on', 'next thing', 'so yeah',
      'so anyway', 'but anyway', 'anyways',
      'back to', 'so back to', 'anyway back',
      'okay so', 'alright so', 'right so',
      'lanjut', 'next', 'selanjutnya', 'berikutnya',
      'oh iya', 'oya', 'ngomong-ngomong', 'by the way',
      'btw', 'anywho', 'where was i',
      'as i was saying', 'like i said',
    ],
  },
};

// ============================================================================
// Hook Score Computation
// ============================================================================

interface SegmentHookScore {
  index: number;
  hookScore: number;
  penaltyScore: number;
  netScore: number;
  signals: string[];
  penalties: string[];
}

/**
 * Score a single transcript segment for hook potential.
 * Positive = hook-rich, Negative = penalized content.
 */
function scoreSegmentForHook(segment: TranscriptSegment, index: number): SegmentHookScore {
  const lower = segment.text.toLowerCase();
  const signals: string[] = [];
  const penalties: string[] = [];
  let hookScore = 0;
  let penaltyScore = 0;

  // Hook signals
  for (const [name, def] of Object.entries(HOOK_SIGNALS)) {
    for (const kw of def.keywords) {
      if (lower.includes(kw)) {
        hookScore += def.weight;
        if (!signals.includes(name)) signals.push(name);
        break; // one keyword hit per signal type is enough
      }
    }
  }

  // Penalty signals
  for (const [name, def] of Object.entries(PENALTY_SIGNALS)) {
    for (const kw of def.keywords) {
      if (lower.includes(kw)) {
        penaltyScore += def.penalty;
        if (!penalties.includes(name)) penalties.push(name);
        break;
      }
    }
  }

  return {
    index,
    hookScore,
    penaltyScore,
    netScore: hookScore - penaltyScore,
    signals,
    penalties,
  };
}

// ============================================================================
// Hook Candidate Window
// ============================================================================

interface HookCandidate {
  startSegment: number;
  endSegment: number;
  startTime: number;
  endTime: number;
  duration: number;
  hookScore: number;        // Total hook score for the opening
  penaltyScore: number;     // Total penalty for the opening
  openingHookScore: number; // Hook score of first 10s only
  netScore: number;         // openingHookScore - penaltyScore
  signals: string[];        // Which hook types fired
  penalties: string[];      // Which penalties applied
  transcriptExcerpt: string;
}

// ============================================================================
// Utility: build timeline JSON stub for hook candidates
// ============================================================================

function buildTimelineJSON(
  videoId: string,
  startTime: number,
  endTime: number,
  transcriptExcerpt: string,
  hookScore: number,
): TimelineJSON {
  const durationSec = endTime - startTime;
  return {
    version: 1,
    schema: 'ganyiq-timeline-v1',
    duration: durationSec,
    metadata: {
      projectId: videoId,
      sourceVideo: videoId,
      sourceDuration: durationSec,
      createdAt: new Date().toISOString(),
    },
    tracks: [],
  };
}

// ============================================================================
// Window Formation
// ============================================================================

/**
 * Form candidate windows from hook-rich segments.
 *
 * Algorithm:
 *   1. Mark segments with netScore > 0 as "active"
 *   2. Group consecutive active segments into windows
 *   3. Extend windows by 1 segment before (for context)
 *   4. Filter by duration (min/max from config)
 *   5. If window has zero signals in its opening, drop it
 */
function formHookWindows(
  segments: TranscriptSegment[],
  scores: SegmentHookScore[],
  config: GeneratorConfig,
  allSignalsList: string[],
): HookCandidate[] {
  const windows: HookCandidate[] = [];
  const n = segments.length;

  // Identify hook-rich segments (netScore > 0)
  const active = scores.map((s) => s.netScore > 0);
  const activeWithHook = scores.map((s) => s.hookScore > 0);

  let i = 0;
  while (i < n) {
    // Skip segments that aren't hook-rich
    if (!activeWithHook[i]) {
      i++;
      continue;
    }

    // Found a hook segment — extend cluster
    let j = i + 1;
    // Allow up to 2 inactive segments inside a cluster (porous)
    let skipped = 0;
    while (j < n && skipped <= 2) {
      if (activeWithHook[j] || active[j]) {
        skipped = 0; // reset on active
        j++;
      } else if (scores[j].netScore >= 0) {
        // Neutral segment — include but count as skipped
        skipped++;
        j++;
      } else {
        // Strongly penalized — break
        break;
      }
    }

    // Extend start by 1 for context (if possible)
    const extStart = Math.max(0, i - 1);

    // If we went past the end
    j = Math.min(j, n - 1);

    // Calculate window
    const startSec = segments[extStart].start;
    const endSeg = segments[j];
    const endSec = endSeg.start + endSeg.duration;
    const duration = endSec - startSec;

    if (duration < config.minDuration || duration > config.maxDuration) {
      i = j + 1;
      continue;
    }

    // Opening analysis: score only the FIRST 10 seconds
    let openingEndSec = startSec + 10;
    let openingIdx = extStart;
    while (openingIdx <= j && segments[openingIdx].start < openingEndSec) {
      openingIdx++;
    }

    const openingEnd = Math.min(openingIdx, j);

    // Sum hook/penalty for full window
    let windowHook = 0;
    let windowPenalty = 0;
    const windowSignals = new Set<string>();
    const windowPenalties = new Set<string>();

    for (let k = extStart; k <= j; k++) {
      windowHook += scores[k].hookScore;
      windowPenalty += scores[k].penaltyScore;
      for (const sig of scores[k].signals) windowSignals.add(sig);
      for (const pen of scores[k].penalties) windowPenalties.add(pen);
    }

    // Opening hook score (first ~10s only) — more weight
    let openingHook = 0;
    for (let k = extStart; k <= openingEnd; k++) {
      openingHook += scores[k].hookScore;
    }

    const netScore = openingHook - windowPenalty;

    // Require at least 1 hook signal type in opening
    const openingSignals = new Set<string>();
    for (let k = extStart; k <= openingEnd; k++) {
      for (const sig of scores[k].signals) openingSignals.add(sig);
    }

    if (openingSignals.size === 0) {
      i = j + 1;
      continue;
    }

    const windowText = segments
      .slice(extStart, j + 1)
      .map((s) => s.text)
      .join(' ');

    windows.push({
      startSegment: extStart,
      endSegment: j,
      startTime: startSec,
      endTime: endSec,
      duration,
      hookScore: windowHook,
      penaltyScore: windowPenalty,
      openingHookScore: openingHook,
      netScore,
      signals: [...openingSignals],
      penalties: [...windowPenalties],
      transcriptExcerpt: windowText,
    });

    i = j + 1;
  }

  return windows;
}

// ============================================================================
// Hook Generator (implements IGenerator)
// ============================================================================

export class HookGenerator implements IGenerator {
  readonly strategy: GeneratorStrategy = 'hook';

  describe(): string {
    return 'Hook First Generator — optimizes for strongest opening hook within first 3–10 seconds. ' +
      'Signal-based: curiosity gaps, controversy, surprising claims, strong opinions, ' +
      'emotional openings, and questions. Penalizes: greetings, guest intros, sponsor segments, ' +
      'housekeeping, and transitions.';
  }

  async generate(
    transcript: TranscriptSegment[],
    videoId: string,
    config: GeneratorConfig,
  ): Promise<GeneratorResult> {
    const startTime = Date.now();

    if (transcript.length === 0) {
      return {
        strategy: 'hook',
        allCandidates: [],
        topCandidates: [],
        k: config.localTopK,
        rawCount: 0,
        durationMs: 0,
      };
    }

    // Phase 1: Score every segment for hook potential
    const scores = transcript.map((seg, i) => scoreSegmentForHook(seg, i));

    // Collect all possible hook signal names for validation
    const allHookSignals = Object.keys(HOOK_SIGNALS);

    // Phase 2: Form candidate windows
    const rawCandidates = formHookWindows(transcript, scores, config, allHookSignals);

    if (rawCandidates.length === 0) {
      return {
        strategy: 'hook',
        allCandidates: [],
        topCandidates: [],
        k: config.localTopK,
        rawCount: 0,
        durationMs: Date.now() - startTime,
      };
    }

    // Phase 3: Score & rank candidates
    // Normalize netScore to 0-100 based on max across all candidates
    const maxNetScore = Math.max(...rawCandidates.map((c) => c.netScore));
    const allCandidates: GeneratorCandidate[] = rawCandidates.map((raw, idx) => {
      const internalScore = maxNetScore > 0
        ? Math.round((raw.netScore / maxNetScore) * 100)
        : 0;

      const timeline = buildTimelineJSON(
        videoId,
        raw.startTime,
        raw.endTime,
        raw.transcriptExcerpt,
        raw.netScore,
      );

      return {
        candidateId: `hook_${idx}`,
        generator: 'hook',
        videoId,
        startTime: raw.startTime,
        endTime: raw.endTime,
        durationSeconds: raw.duration,
        transcriptExcerpt: raw.transcriptExcerpt,
        timeline,
        metadata: {
          selectionRationale: generateRationale(raw),
          triggerSignals: raw.signals,
          internalScore: Math.max(0, Math.min(100, internalScore)),
          confidence: raw.openingHookScore >= 12 ? 'high'
            : raw.openingHookScore >= 6 ? 'medium'
            : 'low',
        },
      };
    });

    // Sort by internalScore DESC
    allCandidates.sort((a, b) => b.metadata.internalScore - a.metadata.internalScore);

    // Local ranking: cap to maxRawCandidates, then keep top localTopK
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

// ============================================================================
// Rationale generation
// ============================================================================

function generateRationale(candidate: HookCandidate): string {
  const signalLabels: Record<string, string> = {
    curiosity_gap: 'Curiosity gap opening',
    controversial: 'Controversial / hot take',
    surprising_claim: 'Surprising claim',
    strong_opinion: 'Strong opinion statement',
    emotional_opening: 'Emotional resonance',
    question_driven: 'Question-driven opening',
  };

  const topSignals = candidate.signals
    .filter((s) => signalLabels[s])
    .slice(0, 3)
    .map((s) => signalLabels[s]);

  if (topSignals.length === 0) {
    return 'Low hook score — may need manual review';
  }

  let rationale = topSignals.join('. ') + '.';
  if (candidate.penalties.length > 0) {
    rationale += ` (Penalties: ${candidate.penalties.join(', ')})`;
  }
  return rationale;
}

// ============================================================================
// Exported utility: raw segment scoring (for benchmark/debug)
// ============================================================================

export function getHookSignalLibrary(): Record<string, HookSignalDef> {
  return { ...HOOK_SIGNALS };
}

export function getPenaltyLibrary(): Record<string, PenaltySignalDef> {
  return { ...PENALTY_SIGNALS };
}
