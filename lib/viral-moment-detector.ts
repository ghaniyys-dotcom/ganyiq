/**
 * lib/viral-moment-detector.ts — Server-side viral moment detection
 *
 * Ports the worker's viral detection logic for server-side use.
 */

export interface ViralComponents {
  hookStrength: number;
  surpriseLevel: number;
  noveltyScore: number;
  emotionalIntensity: number;
  audienceRelevance: number;
}

export interface ViralResult {
  viral_score: number;
  components: ViralComponents;
}

// Keyword lists (same as worker version)
const SURPRISE_SIGNALS = [
  /surprising(ly)?/i, /unexpected(ly)?/i, /shocking(ly)?/i,
  /never thought/i, /against all odds/i, /contrary to/i,
  /actually (works|doesn'?t)/i, /it turns out/i,
];

const NOVELTY_SIGNALS = [
  /new (study|research|discovery|framework)/i,
  /groundbreaking/i, /breakthrough/i, /first.?ever/i,
  /unprecedented/i, /revolutionary/i,
  /latest (science|findings|research)/i,
];

const EMOTIONAL_HIGH = ['devastated', 'incredible', 'unbelievable', 'horrifying', 'miraculous'];
const EMOTIONAL_MED = ['fascinating', 'worried', 'excited', 'frustrated', 'amazed'];
const EMOTIONAL_LOW = ['interesting', 'surprising', 'good', 'bad', 'great', 'weird'];

export function computeViralScore(transcript: string): ViralResult {
  const lower = transcript.toLowerCase();
  const words = lower.split(/\s+/);

  // Hook strength: check common hook patterns
  let hookStrength = 0;
  if (/here's why|the real reason|what nobody tells|this is why|the one thing/i.test(transcript)) hookStrength = 8;
  else if (/you need to|after years of|stop doing|start doing/i.test(transcript)) hookStrength = 6;
  else if (/let me tell|so here's the thing|today i'll/i.test(transcript)) hookStrength = 3;

  // Surprise level
  const surpriseCount = SURPRISE_SIGNALS.filter(p => p.test(transcript)).length;
  const surpriseLevel = Math.min(10, surpriseCount * 2.5);

  // Novelty
  const noveltyCount = NOVELTY_SIGNALS.filter(p => p.test(transcript)).length;
  const noveltyScore = Math.min(10, noveltyCount * 2);

  // Emotional intensity
  let emotionalIntensity = 0;
  for (const w of words) {
    if (EMOTIONAL_HIGH.includes(w)) emotionalIntensity += 3;
    else if (EMOTIONAL_MED.includes(w)) emotionalIntensity += 2;
    else if (EMOTIONAL_LOW.includes(w)) emotionalIntensity += 1;
  }
  emotionalIntensity = Math.min(10, emotionalIntensity);

  // Audience relevance
  let audienceRelevance = 5; // default
  if (/everyone|anyone|most people|we all|common (mistake|problem)/i.test(transcript)) audienceRelevance = 8;
  if (/(algorithm|protocol|recursion|polymorphism)/i.test(transcript)) audienceRelevance = Math.max(1, audienceRelevance - 3);

  const components: ViralComponents = { hookStrength, surpriseLevel, noveltyScore, emotionalIntensity, audienceRelevance };

  const viral_score = Math.round(
    (hookStrength * 0.25 + surpriseLevel * 0.20 + noveltyScore * 0.20 + emotionalIntensity * 0.20 + audienceRelevance * 0.15) * 10
  ) / 10;

  return { viral_score: Math.min(10, Math.max(0, viral_score)), components };
}
