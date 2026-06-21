import { getCachedResult, saveCachedResult } from './evaluator-cache';
import { enforceEvaluatorRules } from './evaluator-validator';
import { buildEvaluatorPrompt, validateEvaluatorOutput, type ThreeFactorOutput, type ClipInput } from './three-factor-evaluator';
import { callOwlAlpha } from './openrouter-client';

export interface LlmFunction {
  (prompt: string, options?: { responseFormat?: { type: string }; temperature?: number }): Promise<{ text: string }>;
}

const MAX_RETRIES = 3;

export class EvaluatorRunner {
  private llm?: LlmFunction;

  constructor(llm?: LlmFunction) {
    this.llm = llm;
  }

  async evaluateClip(clip: ClipInput): Promise<ThreeFactorOutput> {
    const cached = getCachedResult(clip.transcript);
    if (cached) {
      return cached;
    }

    const prompt = buildEvaluatorPrompt(clip.transcript);

    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        let text: string;

        if (this.llm) {
          const response = await this.llm(prompt, {
            responseFormat: { type: 'json_object' },
            temperature: 0,
          });
          text = response.text;
        } else {
          // Fallback to direct OpenRouter owl-alpha
          const result = await callOwlAlpha(
            "You are a strict evaluator. Return only valid JSON, no extra text.",
            prompt,
            { temperature: 0.1, responseFormat: 'json_object' }
          );
          text = result.text;
        }

        // Try direct parse
        try {
          const parsed = JSON.parse(text);
          const validated = validateEvaluatorOutput(parsed);
      const corrected = enforceEvaluatorRules(validated);
      saveCachedResult(clip.transcript, corrected);
      return corrected;
        } catch {}

        // Try regex extraction
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          const validated = validateEvaluatorOutput(parsed);
      const corrected = enforceEvaluatorRules(validated);
      saveCachedResult(clip.transcript, corrected);
      return corrected;
        }

        throw new Error('No valid JSON found in response');
      } catch (err: any) {
        lastError = err;
        console.warn(`[EVALUATOR] Attempt ${attempt} failed for ${clip.clipId}: ${err.message}`);
        if (attempt < MAX_RETRIES) {
          await new Promise(r => setTimeout(r, 1500 * attempt));
        }
      }
    }

    // Safe fallback when evaluator fails completely
    console.error(`[EVALUATOR] All retries failed for ${clip.clipId}. Using safe fallback.`);
    const fallback: ThreeFactorOutput = {
      information_gain: 3,
      attention_capture: 3,
      harm: 1,
      reasoning: "Evaluator call failed after retries. Using conservative default scores.",
    };
    saveCachedResult(clip.transcript, fallback);
    return fallback;
  }
}

export const defaultEvaluator = new EvaluatorRunner();
