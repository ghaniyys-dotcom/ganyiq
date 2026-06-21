export interface ThreeFactorOutput {
  information_gain: number;
  attention_capture: number;
  harm: number;
  reasoning: string;
}

export interface ClipInput {
  clipId: string;
  transcript: string;
}

export const EVALUATOR_PROMPT = `You are an expert short-form content evaluator.

Your job is to score a transcript using three dimensions:

information_gain (0-10)
attention_capture (0-10)
harm (0-10)

Return ONLY valid JSON.

Use the full numeric range 0-10. Most datasets should contain a broad distribution of scores across the scale. Avoid clustering the majority of clips into the same narrow score range. Scores should reflect relative quality differences between clips.

INFORMATION_GAIN SCALE

0-1: No meaningful information delivered.
2-3: Common knowledge, generic advice, or basic motivation.
4-5: Useful insight or practical takeaway.
6-7: Specific actionable knowledge, concrete techniques, useful frameworks, or novel perspective.
8-9: High-density information with strong real-world utility.
10: Exceptional information density — rare, high-value, and immediately usable.

Information Gain measures DELIVERED value, not promised value.

High Information Gain requires at least one of:
- specific facts
- actionable advice
- concrete techniques
- novel insights
- useful frameworks
- meaningful explanations
- surprising but credible information
- a clear resolution to a problem

Do NOT reward questions, setups, teasers, cliffhangers, curiosity gaps, vague promises, or emotional storytelling without insight.

ATTENTION_CAPTURE SCALE

0-2: Boring, fails to hold attention.
3-5: Average attention retention.
6-7: Strong attention retention.
8-9: Excellent hook combined with strong delivery.
10: Exceptional — both powerful hook and highly engaging delivery.

Attention Capture measures the ability to retain viewer attention throughout the clip. Strong hooks increase the score, but curiosity alone is not enough. Scores 8-10 require both a strong hook AND meaningful payoff.

HARM

Harm measures potential negative impact.

Increase harm score for:
- misinformation
- sensationalism
- manipulation
- fearmongering
- context-free shocking claims
- rage bait
- deceptive framing
- exploitative emotional content
- graphic content without context

Use higher harm scores even when the content is technically not false.

Examples:
- Mild clickbait: harm 2-4
- Strong emotional manipulation: harm 4-6
- Sensational or misleading claims: harm 6-8
- Dangerous misinformation: harm 8-10

SCORING PHILOSOPHY

Substance beats curiosity.
Delivered value beats promised value.
Concrete insight beats emotional storytelling.
Actionable knowledge beats motivation.

Knowledge density is the primary driver of Information Gain.

Cross-field consistency is mandatory. Reasoning must justify the assigned scores.

Transcript:
"""TRANSCRIPT_PLACEHOLDER"""

Return ONLY valid JSON:
{
  "information_gain": number,
  "attention_capture": number,
  "harm": number,
  "reasoning": "short explanation"
}`;

export function buildEvaluatorPrompt(transcript: string): string {
  return EVALUATOR_PROMPT.replace('TRANSCRIPT_PLACEHOLDER', transcript);
}

export function validateEvaluatorOutput(raw: any): ThreeFactorOutput {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Invalid output: not an object');
  }

  const ig = Number(raw.information_gain);
  const ac = Number(raw.attention_capture);
  const h = Number(raw.harm);
  const reasoning = String(raw.reasoning || '');

  if (![ig, ac, h].every(v => Number.isInteger(v) && v >= 0 && v <= 10)) {
    throw new Error('Scores must be integers 0-10');
  }

  return {
    information_gain: ig,
    attention_capture: ac,
    harm: h,
    reasoning: reasoning.slice(0, 300),
  };
}
