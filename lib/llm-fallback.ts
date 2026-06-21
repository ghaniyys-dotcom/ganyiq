/**
 * lib/llm-fallback.ts
 * Unified LLM caller with fallback to OpenRouter owl-alpha.
 * Use this for future-proofing.
 */

import { callOwlAlpha } from './openrouter-client';

export type LlmCallOptions = {
  temperature?: number;
  maxTokens?: number;
  expectJson?: boolean;
};

export async function callLLMWithFallback(
  model: string,
  system: string,
  user: string,
  options: LlmCallOptions = {}
): Promise<string> {
  if (model === 'openrouter/owl-alpha' || model.includes('owl-alpha')) {
    const result = await callOwlAlpha(system, user, {
      temperature: options.temperature ?? 0.2,
      maxTokens: options.maxTokens ?? 4000,
      responseFormat: options.expectJson ? 'json_object' : 'text',
    });
    return result.text;
  }

  // For other models, fall through to existing callLLM in analyzer
  // (or implement here if needed)
  throw new Error(`Model ${model} not supported in fallback wrapper yet`);
}
