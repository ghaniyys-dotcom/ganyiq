import { ClipEvaluation } from '../scripts/benchmark-metrics';

export function calculateHybridScore(e: ClipEvaluation): number {
  const { information_gain, attention_capture, harm } = e.scores;
  return (information_gain * 5.0) + (attention_capture * 2.0) - (harm * 4.0);
}

export function rankClips(evaluations: ClipEvaluation[]): ClipEvaluation[] {
  return [...evaluations].sort((a, b) => calculateHybridScore(b) - calculateHybridScore(a));
}
