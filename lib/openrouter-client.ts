/**
 * lib/openrouter-client.ts
 * Robust OpenRouter caller for fallback use (owl-alpha).
 * Designed for high reliability with strong JSON extraction.
 */

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OWL_ALPHA_MODEL = 'openrouter/owl-alpha';

export interface OpenRouterOptions {
  temperature?: number;
  maxTokens?: number;
  responseFormat?: 'json_object' | 'text';
}

export interface OpenRouterResult {
  text: string;
  model: string;
  usage?: any;
}

/**
 * Strong JSON extractor + cleaner.
 * Handles markdown fences, extra text, etc.
 */
function extractJson(text: string): string {
  let cleaned = text.trim();

  // Remove markdown code fences
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenceMatch) {
    cleaned = fenceMatch[1].trim();
  }

  // Try to find the first JSON object/array
  const jsonMatch = cleaned.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (jsonMatch) {
    cleaned = jsonMatch[1].trim();
  }

  // Remove common leading/trailing garbage
  cleaned = cleaned.replace(/^[^{[]+/, '').replace(/[^}\]]+$/, '');

  return cleaned;
}

/**
 * Call OpenRouter with owl-alpha.
 * Includes retry + robust parsing.
 */
export async function callOwlAlpha(
  system: string,
  user: string,
  options: OpenRouterOptions = {}
): Promise<OpenRouterResult> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY is not set');
  }

  const temperature = options.temperature ?? 0.2;
  const maxTokens = options.maxTokens ?? 4000;
  const maxRetries = 3;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(OPENROUTER_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'HTTP-Referer': 'https://ganyiq.ganys.me',
          'X-Title': 'GANYIQ',
        },
        body: JSON.stringify({
          model: OWL_ALPHA_MODEL,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          temperature,
          max_tokens: maxTokens,
          ...(options.responseFormat === 'json_object' && {
            response_format: { type: 'json_object' },
          }),
        }),
        signal: AbortSignal.timeout(120_000),
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        if (response.status === 429) {
          // Rate limit - backoff
          await new Promise(r => setTimeout(r, 2000 * attempt));
          continue;
        }
        throw new Error(`OpenRouter HTTP ${response.status}: ${errText.slice(0, 300)}`);
      }

      const data = await response.json();
      let text = data?.choices?.[0]?.message?.content || '';

      if (!text) {
        throw new Error('Empty response from OpenRouter');
      }

      // Always try to clean for JSON mode
      if (options.responseFormat === 'json_object') {
        text = extractJson(text);
      }

      return {
        text: text.trim(),
        model: OWL_ALPHA_MODEL,
        usage: data.usage,
      };

    } catch (err: any) {
      console.warn(`[OPENROUTER] Owl Alpha attempt ${attempt} failed: ${err.message}`);
      if (attempt === maxRetries) {
        throw err;
      }
      await new Promise(r => setTimeout(r, 1000 * attempt));
    }
  }

  throw new Error('Owl Alpha failed after all retries');
}
