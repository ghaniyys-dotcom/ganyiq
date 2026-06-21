export type InfoGainCategory = "VERY_LOW" | "LOW" | "MEDIUM" | "HIGH" | "VERY_HIGH";

export interface CategoricalEvaluatorOutput {
  information_gain_category: InfoGainCategory;
  information_gain: number; // mapped numeric
  attention_capture: number;
  harm: number;
  reasoning: string;
}

const CATEGORY_MAP: Record<InfoGainCategory, number> = {
  VERY_LOW: 1,
  LOW: 3,
  MEDIUM: 5,
  HIGH: 7,
  VERY_HIGH: 9,
};

export const CATEGORICAL_EVALUATOR_PROMPT = `You are an expert short-form content evaluator.

Your job is to classify a transcript into one of five categories for Information Gain, plus numeric scores for Attention Capture and Harm.

Return ONLY valid JSON.

INFORMATION GAIN CATEGORIES (choose exactly one):

VERY_LOW
No meaningful information delivered. The clip contains only questions, teasers, curiosity gaps, or empty motivation.

LOW
Generic advice, common knowledge, or basic motivational content. No specific techniques or novel insights.

MEDIUM
Useful takeaway or practical insight. The viewer learns something concrete they can apply.

HIGH
Specific actionable knowledge, concrete technique, useful framework, or novel perspective that stands out.

VERY_HIGH
Exceptional information density. Rare, high-value, immediately usable knowledge that is difficult to find elsewhere.

ATTENTION_CAPTURE (0-10)
Rate how well the clip holds attention from start to finish.

HARM (0-10)
Rate potential negative impact (misinformation, sensationalism, manipulation, rage bait, etc.).

Transcript:
"""TRANSCRIPT_PLACEHOLDER"""

Return ONLY valid JSON:
{
  "information_gain_category": "VERY_LOW" | "LOW" | "MEDIUM" | "HIGH" | "VERY_HIGH",
  "attention_capture": number,
  "harm": number,
  "reasoning": "short explanation"
}`;
export function buildCategoricalPrompt(transcript: string): string {
  return CATEGORICAL_EVALUATOR_PROMPT.replace('TRANSCRIPT_PLACEHOLDER', transcript);
}

export function mapCategoryToScore(category: InfoGainCategory): number {
  return CATEGORY_MAP[category] ?? 1;
}
