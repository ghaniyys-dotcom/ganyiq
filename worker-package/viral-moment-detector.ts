/**
 * worker/viral-moment-detector.ts — Viral moment scoring for GANYIQ
 *
 * Analyzes clip transcripts and metadata to produce a viral_score
 * independent of the frozen evaluator.
 *
 * Components:
 *   - hookStrength: how strong the opening hook is
 *   - surpriseLevel: unexpected statement or revelation
 *   - noveltyScore: unique/novel insight or perspective
 *   - emotionalIntensity: emotional language analysis
 *   - audienceRelevance: how broadly applicable
 *
 * Output: viral_score (0-10) for each clip, plus component breakdown.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ViralScoreComponents {
  hookStrength: number;       // 0-10
  surpriseLevel: number;      // 0-10
  noveltyScore: number;       // 0-10
  emotionalIntensity: number; // 0-10
  audienceRelevance: number;  // 0-10
}

export interface ViralScoreResult {
  clipId: string;
  viral_score: number;          // 0-10 (composite)
  components: ViralScoreComponents;
  topViralFrames?: Array<{
    startTime: number;
    endTime: number;
    viralScore: number;
    reason: string;
  }>;
}

// ---------------------------------------------------------------------------
// Hook detection patterns
// ---------------------------------------------------------------------------

interface HookPattern {
  pattern: RegExp;
  strength: number; // 1-10
  label: string;
}

const HOOK_PATTERNS: HookPattern[] = [
  // Strong hooks (8-10)
  { pattern: /here'?s why (most|every|everything|nobody|everyone)/i, strength: 9, label: 'why_explanation' },
  { pattern: /the (real|actual|surprising|shocking) (reason|truth|secret)/i, strength: 9, label: 'real_reason' },
  { pattern: /what (nobody|no one|they don'?t) (tells|told|wants).*(about)/i, strength: 8, label: 'hidden_truth' },
  { pattern: /this is (why|how|what) (happens|works|changes)/i, strength: 8, label: 'key_insight' },
  { pattern: /the (single|one|only) (thing|way|reason|trick)/i, strength: 8, label: 'single_thing' },
  
  // Medium hooks (5-7)
  { pattern: /you (need to|should|must|can'?t afford to)/i, strength: 6, label: 'direct_advice' },
  { pattern: /after (years|months|weeks) of/i, strength: 6, label: 'journey_story' },
  { pattern: /(i|we) (tried|tested|experimented)/i, strength: 5, label: 'personal_experiment' },
  { pattern: /(stop|start|learn) (doing|using|wasting)/i, strength: 5, label: 'action_directive' },
  
  // Weak hooks (3-4)
  { pattern: /(so|and|but) here'?s the (thing|deal)/i, strength: 4, label: 'filler_hook' },
  { pattern: /let me (tell|show|explain)/i, strength: 3, label: 'let_me' },
  { pattern: /(today|in this video) (i'?ll|we'?ll)/i, strength: 3, label: 'video_intro' },
];

// ---------------------------------------------------------------------------
// Surprise/detection patterns
// ---------------------------------------------------------------------------

const SURPRISE_SIGNALS = [
  /surprising(ly)?/i, /unexpected(ly)?/i, /shocking(ly)?/i,
  /never thought/i, /against all odds/i, /contrary to/i,
  /actually (works|doesn'?t)/i, /it turns out/i,
  /what if (i told|everything)/i, /imagine (if|a world)/i,
];

const NOVELTY_SIGNALS = [
  /new (study|research|discovery|framework)/i,
  /groundbreaking/i, /breakthrough/i, /first.?ever/i,
  /unprecedented/i, /revolutionary/i,
  /introducing (a|the|our)/i, /presenting/i,
  /latest (science|findings|research)/i,
];

const EMOTIONAL_WORDS = {
  high: ['devastated', 'incredible', 'unbelievable', 'horrifying', 'miraculous',
         'heartbreaking', 'life-changing', 'tragic', 'extraordinary', 'epic'],
  medium: ['fascinating', 'worried', 'excited', 'frustrated', 'amazed',
           'terrifying', 'inspiring', 'disturbing', 'remarkable', 'brilliant'],
  low: ['interesting', 'surprising', 'good', 'bad', 'great', 'weird',
        'strange', 'funny', 'nice', 'okay'],
};

const AUDIENCE_RANGE_KEYWORDS = [
  /everyone/i, /anyone/i, /anybody/i, /most people/i,
  /you and (me|your family|everyone)/i,
  /common (mistake|problem|issue)/i,
  /universal/i, /global/i, /worldwide/i,
  /we all/i, /all of us/i,
];

// ---------------------------------------------------------------------------
// Scoring Functions
// ---------------------------------------------------------------------------

/**
 * Score hook strength in transcript text (0-10).
 */
export function scoreHookStrength(transcript: string): number {
  let maxStrength = 0;
  for (const hook of HOOK_PATTERNS) {
    if (hook.pattern.test(transcript)) {
      maxStrength = Math.max(maxStrength, hook.strength);
    }
  }
  return maxStrength;
}

/**
 * Score surprise level in transcript (0-10).
 */
export function scoreSurpriseLevel(transcript: string): number {
  let count = 0;
  for (const pattern of SURPRISE_SIGNALS) {
    if (pattern.test(transcript)) count++;
  }
  return Math.min(10, count * 2.5);
}

/**
 * Score novelty in transcript (0-10).
 */
export function scoreNovelty(transcript: string): number {
  let count = 0;
  for (const pattern of NOVELTY_SIGNALS) {
    if (pattern.test(transcript)) count++;
  }
  return Math.min(10, count * 2);
}

/**
 * Score emotional intensity in transcript (0-10).
 */
export function scoreEmotionalIntensity(transcript: string): number {
  const words = transcript.toLowerCase().split(/\s+/);
  let score = 0;
  
  for (const word of words) {
    if (EMOTIONAL_WORDS.high.includes(word)) score += 3;
    else if (EMOTIONAL_WORDS.medium.includes(word)) score += 2;
    else if (EMOTIONAL_WORDS.low.includes(word)) score += 1;
  }
  
  // Check for exclamation marks (increases intensity)
  const exclaimCount = (transcript.match(/!/g) || []).length;
  score += exclaimCount * 0.5;
  
  return Math.min(10, score);
}

/**
 * Score audience relevance (0-10).
 */
export function scoreAudienceRelevance(transcript: string): number {
  let score = 0;
  for (const pattern of AUDIENCE_RANGE_KEYWORDS) {
    if (pattern.test(transcript)) score += 2;
  }
  
  // Penalize very niche technical language
  const nicheTerms = transcript.match(/\b(algorithm|protocol|specification|implementation|recursion|polymorphism)\b/gi);
  if (nicheTerms && nicheTerms.length > 3) {
    score = Math.max(0, score - 2);
  }
  
  return Math.min(10, score);
}

/**
 * Compute composite viral score for a clip.
 */
export function computeViralScore(clipId: string, transcript: string): ViralScoreResult {
  const components: ViralScoreComponents = {
    hookStrength: scoreHookStrength(transcript),
    surpriseLevel: scoreSurpriseLevel(transcript),
    noveltyScore: scoreNovelty(transcript),
    emotionalIntensity: scoreEmotionalIntensity(transcript),
    audienceRelevance: scoreAudienceRelevance(transcript),
  };
  
  // Composite: weighted average (0-10)
  const weights = {
    hookStrength: 0.25,
    surpriseLevel: 0.20,
    noveltyScore: 0.20,
    emotionalIntensity: 0.20,
    audienceRelevance: 0.15,
  };
  
  const viral_score = Math.round(
    (components.hookStrength * weights.hookStrength +
     components.surpriseLevel * weights.surpriseLevel +
     components.noveltyScore * weights.noveltyScore +
     components.emotionalIntensity * weights.emotionalIntensity +
     components.audienceRelevance * weights.audienceRelevance) * 10
  ) / 10;
  
  return {
    clipId,
    viral_score: Math.min(10, Math.max(0, viral_score)),
    components,
  };
}

/**
 * Find the most viral frames within a clip's transcript (by sentence).
 */
export function findTopViralFrames(
  clipId: string,
  sentences: Array<{ text: string; startTime: number; endTime: number }>
): Array<{ startTime: number; endTime: number; viralScore: number; reason: string }> {
  return sentences
    .map(s => {
      const result = computeViralScore(`${clipId}-sent`, s.text);
      return {
        startTime: s.startTime,
        endTime: s.endTime,
        viralScore: result.viral_score,
        reason: `hook=${result.components.hookStrength}, emotional=${result.components.emotionalIntensity}`,
      };
    })
    .filter(s => s.viralScore >= 6)
    .sort((a, b) => b.viralScore - a.viralScore)
    .slice(0, 10);
}
