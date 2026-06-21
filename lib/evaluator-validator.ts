export interface EvaluatorResult {
  information_gain: number;
  attention_capture: number;
  harm: number;
  reasoning: string;
}

export function enforceEvaluatorRules(
  result: EvaluatorResult
): EvaluatorResult {
  const r = result.reasoning.toLowerCase();

  // HARD PENALTIES ONLY for these
  const hardLowValueTriggers = [
    "only poses a question",
    "no concrete information",
    "teaser without payoff",
    "setup without resolution",
    "curiosity gap without answer"
  ];

  if (hardLowValueTriggers.some(x => r.includes(x))) {
    result.information_gain = Math.min(result.information_gain, 2);
    result.attention_capture = Math.min(result.attention_capture, 6);
  }

  // Keep harm penalty
  if (result.harm >= 7) {
    result.attention_capture = Math.max(0, result.attention_capture - 1);
  }

  return result;
}
