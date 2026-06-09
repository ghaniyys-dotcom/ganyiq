/**
 * Hook pass diagnostic — captures raw LLM response
 * Run: cd /root/GANYIQ && npx tsx scripts/hook-diag.ts
 */
import { buildHookPrompt, buildStorytellingPrompt } from '../lib/prompt';
import type { CandidateWindow } from '../lib/candidate-extraction';
import { config } from 'dotenv';

config({ path: '.env' });
config({ path: '.env.local' });

const LLM_API_URL = 'https://opencode.ai/zen/go/v1/chat/completions';
const API_KEY = process.env.OPENCODE_GO_API_KEY || '';

const mockCandidates: CandidateWindow[] = [
  {
    startSeconds: 3481.28,
    endSeconds: 3516.94,
    durationSeconds: 35.66,
    text: 'kalau gua mati gua bisa bilang kemarin udah sama anak gue benar. Iya yang pasti mund kayak bro.',
    signals: ['storytelling', 'relatability'],
    speakers: ['Speaker1', 'Speaker2'],
    speakerChangeCount: 2,
  },
  {
    startSeconds: 9.96,
    endSeconds: 75.299,
    durationSeconds: 65.339,
    text: 'udah jarang bertiga terakhir kapan? Kapan terakhir? Udah lama lu udah sibuk sama pedel.',
    signals: ['questions', 'storytelling'],
    speakers: ['Speaker1', 'Speaker2'],
    speakerChangeCount: 3,
  },
];

async function callLLM(model: string, system: string, user: string): Promise<{ raw: string; parsed: unknown; parseError: string | null }> {
  const response = await fetch(LLM_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.3,
      max_tokens: 8192,
    }),
    signal: AbortSignal.timeout(120_000),
  });

  const data = await response.json();
  const rawText = (data?.choices?.[0]?.message?.content || '').trim();

  let parsed: unknown = null;
  let parseError: string | null = null;
  try {
    const cleaned = rawText.replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/s, '$1').trim();
    parsed = JSON.parse(cleaned);
  } catch (e: unknown) {
    parseError = e instanceof Error ? e.message : String(e);
  }

  return { raw: rawText, parsed, parseError };
}

async function main() {
  const title = 'Andre Taulany Marah-Marah! Mau Bubarin PREDIKSI!! Pada Susah Diatur!!';

  console.log('=== HOOK PASS DIAGNOSTIC ===');
  console.log('Candidates:', mockCandidates.length);
  
  const { system: hookSys, user: hookUser } = buildHookPrompt(mockCandidates, title);
  const { system: storySys, user: storyUser } = buildStorytellingPrompt(mockCandidates, title);

  // Test storytelling first (known working pass)
  console.log('\n=== STORYTELLING (control) ===');
  const storyResult = await callLLM('deepseek-v4-flash', storySys, storyUser);
  console.log('PARSED TYPE:', typeof storyResult.parsed);
  console.log('IsArray:', Array.isArray(storyResult.parsed));
  console.log('Parsed entries:', Array.isArray(storyResult.parsed) ? (storyResult.parsed as unknown[]).length : 'N/A');
  if (storyResult.parseError) console.log('PARSE ERROR:', storyResult.parseError);
  else console.log('First entry:', JSON.stringify(Array.isArray(storyResult.parsed) ? (storyResult.parsed as unknown[])[0] : null));

  // Test hook prompt with deepseek-v4-flash
  console.log('\n=== HOOK: deepseek-v4-flash ===');
  const dsResult = await callLLM('deepseek-v4-flash', hookSys, hookUser);
  console.log('RAW OUTPUT:');
  console.log(dsResult.raw);
  console.log('');
  console.log('PARSED TYPE:', typeof dsResult.parsed);
  console.log('IsArray:', Array.isArray(dsResult.parsed));
  if (!Array.isArray(dsResult.parsed) && dsResult.parsed && typeof dsResult.parsed === 'object' && dsResult.parsed !== null) {
    const obj = dsResult.parsed as Record<string, unknown>;
    console.log('Object keys:', Object.keys(obj));
    console.log('Has startTime:', 'startTime' in obj);
    console.log('Has error:', 'error' in obj);
    console.log('Full parsed:', JSON.stringify(obj, null, 2));
  }
  if (dsResult.parseError) console.log('PARSE ERROR:', dsResult.parseError);

  // Test mimo-v2.5
  console.log('\n=== HOOK: mimo-v2.5 ===');
  const mimoResult = await callLLM('mimo-v2.5', hookSys, hookUser);
  console.log('RAW OUTPUT:');
  console.log(mimoResult.raw);
  console.log('');
  console.log('PARSED TYPE:', typeof mimoResult.parsed);
  console.log('IsArray:', Array.isArray(mimoResult.parsed));
  if (mimoResult.parseError) console.log('PARSE ERROR:', mimoResult.parseError);
  else if (mimoResult.parsed && typeof mimoResult.parsed === 'object') {
    console.log('Parsed:', JSON.stringify(mimoResult.parsed, null, 2));
  }

  // Test qwen3.7-plus
  console.log('\n=== HOOK: qwen3.7-plus ===');
  const qwenResult = await callLLM('qwen3.7-plus', hookSys, hookUser);
  console.log('RAW OUTPUT:');
  console.log(qwenResult.raw);
  console.log('');
  console.log('PARSED TYPE:', typeof qwenResult.parsed);
  console.log('IsArray:', Array.isArray(qwenResult.parsed));
  if (qwenResult.parseError) console.log('PARSE ERROR:', qwenResult.parseError);
  else if (qwenResult.parsed && typeof qwenResult.parsed === 'object') {
    console.log('Parsed:', JSON.stringify(qwenResult.parsed, null, 2));
  }

  process.exit(0);
}

main().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
