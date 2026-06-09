/**
 * lib/genre-detector.ts — Content type / genre auto-detection for GANYIQ.
 *
 * Phase 5A: Genre now returns calibration profiles that influence
 * prompt selection, pass weighting, and scoring bonuses.
 *
 * Uses metadata (title, channel) and transcript patterns to classify content.
 */

import type { TranscriptSegment } from '@/lib/types';
import type { CandidateWindow } from '@/lib/candidate-extraction';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ContentGenre =
  | 'podcast'
  | 'interview'
  | 'educational'
  | 'entertainment'
  | 'debate'
  | 'technical'
  | 'news'
  | 'unknown';

/**
 * Phase 5A: Genre calibration profile returned alongside the genre string.
 * Each field can be applied by the caller (analyzer, multi-pass, prompt).
 */
export interface GenreProfile {
  genre: ContentGenre;
  /** Confidence 0-1 in the classification */
  confidence: number;

  /** Base pass bonus adjustments (applied on top of Phase 4B defaults) */
  passBoosts: Record<string, number>;
  /** Which DNA tags to promote for this genre (scoring bonus) */
  dnaPriorities: string[];
  /** System prompt modifier — a short phrase to add to the system prompt */
  systemPromptModifier: string;

  /** Candidate extraction signal weights multiplier for this genre */
  signalEmphasis: string[];

  /** Suggested dedup threshold adjustment (seconds) */
  dedupWindow: number;
}

// ---------------------------------------------------------------------------
// Genre detection signals
// ---------------------------------------------------------------------------

interface TitleSignals {
  podcast: number;
  interview: number;
  educational: number;
  entertainment: number;
  debate: number;
  technical: number;
  news: number;
}

const TITLE_PATTERNS: Record<string, RegExp[]> = {
  podcast: [
    /podcast|podkesmas|showkesmas|ngobrol|bincang|bincang-bincang/i,
    /(?:deddy|desta|vincent|sule|andre|parto|nunung)/i,
    /(?:vindes|tuah|agak laen)/i,
  ],
  interview: [
    /interview|wawancara|sesi tanya|tanya jawab|obrolan/i,
    /q&a|qna/i,
    /(?:ngobrol|curhat|cerita) (?:bareng|bersama|sama)/i,
    /(?:special|feature|featured) (?:interview|guest)/i,
  ],
  educational: [
    /tutorial|belajar|edukasi|pelajaran|course|kelas|training/i,
    /tips|trik|how to|caranya|panduan|guide/i,
    /(?:kuliah|seminar|workshop|webinar)/i,
    /(?:bahas|membahas) (?:topik|tema|materi)/i,
  ],
  entertainment: [
    /comedy|komedi|lucu|sketsa|stand.?up/i,
    /(?:main|game|challenge|prank|vlog)/i,
    /(?:haha|wkwk|lucu-lucuan)/i,
  ],
  debate: [
    /debat|adu argumen|pro kontra|bedah|diskusi/i,
    /(?:debat|polemik|kontroversi)/i,
  ],
  technical: [
    /teknologi|tech|coding|programming|software|hardware/i,
    /(?:review|review) (?:gadget|hp|smartphone|laptop)/i,
    /(?:linux|windows|mac|ios|android|web|ai|machine learning)/i,
    /(?:tutorial|how.?to) (?:code|program|build|deploy)/i,
  ],
  news: [
    /berita|kabar|update|breaking news|headline/i,
    /(?:politik|politik|ekonomi) (?:hari ini|terkini)/i,
  ],
};

const GENRE_THRESHOLD = 2;

// ---------------------------------------------------------------------------
// Phase 5A: Genre Calibration Profiles
// ---------------------------------------------------------------------------

const GENRE_CALIBRATIONS: Record<string, GenreProfile> = {
  podcast: {
    genre: 'podcast',
    confidence: 0.8,
    passBoosts: {
      emotion: 2,
      storytelling: 3,
      controversy: 1,
    },
    dnaPriorities: ['emotion', 'storytelling', 'relatability', 'humor', 'vulnerability'],
    systemPromptModifier:
      'This is a podcast. Prioritize emotional moments, personal stories, and natural conversation dynamics. Speaker chemistry and genuine reactions are high value.',
    signalEmphasis: ['emotion', 'story_transitions', 'personal', 'reaction_moment', 'vulnerability'],
    dedupWindow: 30,
  },
  interview: {
    genre: 'interview',
    confidence: 0.8,
    passBoosts: {
      vulnerability: 3,
      storytelling: 2,
      emotion: 2,
    },
    dnaPriorities: ['vulnerability', 'storytelling', 'emotion', 'authority', 'relatability'],
    systemPromptModifier:
      'This is an interview. Prioritize vulnerable moments, personal revelations, and insightful answers. Guest background and unique perspectives are high value.',
    signalEmphasis: ['personal', 'vulnerability', 'emotion', 'quotations', 'authority'],
    dedupWindow: 30,
  },
  educational: {
    genre: 'educational',
    confidence: 0.8,
    passBoosts: {
      educational: 4,
      authority: 2,
    },
    dnaPriorities: ['educational', 'authority', 'money', 'motivation', 'curiosity'],
    systemPromptModifier:
      'This is educational content. Prioritize clear explanations, actionable insights, and authoritative knowledge. "Aha moments" and teaching value are high priority.',
    signalEmphasis: ['educational_structure', 'numbers', 'actionable_advice', 'authority', 'strong_claims'],
    dedupWindow: 25,
  },
  entertainment: {
    genre: 'entertainment',
    confidence: 0.7,
    passBoosts: {
      hook: 3,
      emotion: 2,
    },
    dnaPriorities: ['humor', 'curiosity', 'shock', 'emotion', 'hookPower'],
    systemPromptModifier:
      'This is entertainment content. Prioritize humor, surprising reveals, and audience engagement moments. Energy and entertainment value are high priority.',
    signalEmphasis: ['surprise', 'humor', 'emotion', 'cliffhanger', 'reaction_moment'],
    dedupWindow: 20,
  },
  debate: {
    genre: 'debate',
    confidence: 0.7,
    passBoosts: {
      controversy: 4,
      emotion: 2,
    },
    dnaPriorities: ['controversy', 'emotion', 'shock', 'authority', 'hookPower'],
    systemPromptModifier:
      'This is a debate. Prioritize strong disagreements, contrarian opinions, and heated exchanges. Argumentative tension and clash of ideas are high value.',
    signalEmphasis: ['controversy', 'debate_arc', 'hot_take', 'speaker_disagreement', 'strong_claims'],
    dedupWindow: 20,
  },
  technical: {
    genre: 'technical',
    confidence: 0.7,
    passBoosts: {
      educational: 3,
      authority: 2,
    },
    dnaPriorities: ['educational', 'authority', 'money', 'curiosity', 'motivation'],
    systemPromptModifier:
      'This is technical content. Prioritize deep insights, practical how-to knowledge, and expert analysis. Technical depth and unique perspectives are high value.',
    signalEmphasis: ['educational_structure', 'numbers', 'actionable_advice', 'authority', 'strong_claims'],
    dedupWindow: 25,
  },
  news: {
    genre: 'news',
    confidence: 0.6,
    passBoosts: {
      controversy: 2,
      authority: 2,
    },
    dnaPriorities: ['authority', 'controversy', 'shock', 'money', 'curiosity'],
    systemPromptModifier:
      'This is news content. Prioritize breaking information, expert commentary, and impactful revelations. Timeliness and informational value are high priority.',
    signalEmphasis: ['strong_claims', 'controversy', 'numbers', 'authority', 'surprise'],
    dedupWindow: 20,
  },
  unknown: {
    genre: 'unknown',
    confidence: 0.3,
    passBoosts: {},
    dnaPriorities: ['emotion', 'curiosity', 'hookPower', 'storytelling', 'humor'],
    systemPromptModifier:
      'Rate each candidate independently for viral potential.',
    signalEmphasis: [],
    dedupWindow: 30,
  },
};

// ---------------------------------------------------------------------------
// Transcript signal analysis
// ---------------------------------------------------------------------------

interface TranscriptSignals {
  questionDensity: number;
  speakerChangeHints: number;
  storyMarkers: number;
  educationalMarkers: number;
}

function analyzeTranscriptSignals(transcript: TranscriptSegment[]): TranscriptSignals {
  const allText = transcript.map(s => s.text).join(' ').toLowerCase();
  const wordCount = allText.split(/\s+/).length;

  const questionWords = (allText.match(/\?/g) || []).length;
  const questionDensity = wordCount > 0 ? (questionWords / wordCount) * 100 : 0;

  const eduPattern = /(?:cara|langkah|tips|tutorial|how to|step|pertama|kedua|ketiga|kesimpulan)/gi;
  const eduMatches = (allText.match(eduPattern) || []).length;
  const educationalMarkers = eduMatches;

  const storyPattern = /(?:dulu|pernah|cerita|waktu itu|pengalaman|kejadian|awalnya|ternyata)/gi;
  const storyMatches = (allText.match(storyPattern) || []).length;
  const storyMarkers = storyMatches;

  const shortSegments = transcript.filter(s => s.text.split(/\s+/).length <= 5).length;
  const speakerChangeHints = wordCount > 0 ? (shortSegments / transcript.length) * 100 : 0;

  return { questionDensity, speakerChangeHints, educationalMarkers, storyMarkers };
}

// ---------------------------------------------------------------------------
// Main Export
// ---------------------------------------------------------------------------

/**
 * Detect the content genre of a video based on metadata and transcript.
 *
 * Phase 5A: Returns a GenreProfile with calibration data that influences
 * prompt selection, pass weighting, and scoring bonuses throughout the pipeline.
 *
 * @param title - Video title
 * @param channelName - Channel name
 * @param transcript - Transcript segments (optional, improves accuracy)
 * @returns GenreProfile with genre, confidence, pass boosts, and calibration data
 */
export function detectGenre(
  title: string,
  channelName: string,
  transcript?: TranscriptSegment[],
): GenreProfile {
  const combinedMeta = `${title} ${channelName}`;

  // Stage 1: Score title + channel against known patterns
  const scores: TitleSignals = {
    podcast: 0,
    interview: 0,
    educational: 0,
    entertainment: 0,
    debate: 0,
    technical: 0,
    news: 0,
  };

  for (const [genre, patterns] of Object.entries(TITLE_PATTERNS)) {
    for (const pattern of patterns) {
      if (pattern.test(combinedMeta)) {
        scores[genre as keyof TitleSignals] += 1;
      }
    }
  }

  // Stage 2: Transcript signals (if available)
  if (transcript && transcript.length > 20) {
    const tx = analyzeTranscriptSignals(transcript);

    if (tx.questionDensity > 5) {
      scores.interview += 2;
      scores.educational += 1;
    }
    if (tx.educationalMarkers > 20) {
      scores.educational += 3;
    }
    if (tx.storyMarkers > 30) {
      scores.podcast += 2;
    }
    if (tx.speakerChangeHints > 40 && tx.questionDensity > 3) {
      scores.interview += 2;
    }
  }

  // Stage 3: Find best match above threshold
  let bestGenre: ContentGenre = 'unknown';
  let bestScore = 0;

  for (const [genre, score] of Object.entries(scores)) {
    if (score > bestScore && score >= GENRE_THRESHOLD) {
      bestScore = score;
      bestGenre = genre as ContentGenre;
    }
  }

  // Stage 4: Resolve ambiguous cases
  if (bestGenre === 'unknown') {
    if (transcript && transcript.length > 200) {
      bestGenre = 'podcast';
    }
  }

  // Phase 5A: Return the calibration profile
  const profile = GENRE_CALIBRATIONS[bestGenre];
  // Adjust confidence based on score strength
  const normalizedConfidence = Math.min(1, bestScore / 10);
  return {
    ...profile,
    genre: bestGenre,
    confidence: normalizedConfidence || 0.3,
  };
}
