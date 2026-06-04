/**
 * V2 Pipeline End-to-End Test
 *
 * Tests the full pipeline on a cached video:
 *   1. Load transcript from DB
 *   2. Extract candidates
 *   3. Build batch scoring prompt
 *   4. Call LLM (if API key available)
 *   5. Validate output
 *
 * Usage: npx tsx scripts/test-v2-pipeline.ts
 */

import dotenv from 'dotenv';
dotenv.config({ path: '/root/GANYIQ/.env.local' });
import { query } from '@/db/client';
import { extractCandidates } from '@/lib/candidate-extraction';
import { buildBatchCandidateScoringPrompt, TARGET_MODEL, PROMPT_VERSION } from '@/lib/prompt';
import type { VideoMetadata, TranscriptSegment, RawMoment, DnaTag, ConfidenceLevel } from '@/lib/types';

async function main() {
  console.log('═'.repeat(70));
  console.log('V2 Pipeline End-to-End Test');
  console.log('═'.repeat(70));

  // Step 1: Load a cached video (largest transcript — 836 segments)
  console.log('\n[1/5] Loading cached video...');
  const videoResult = await query<{
    youtube_id: string;
    title: string;
    channel_name: string;
    duration_seconds: number;
    transcript: unknown;
  }>(
    `SELECT youtube_id, title, channel_name, duration_seconds, transcript
     FROM videos WHERE youtube_id = 'hN-V0YYDSak'`,
  );

  if (videoResult.rows.length === 0) {
    console.error('Video not found in DB');
    process.exit(1);
  }

  const row = videoResult.rows[0];
  const transcript: TranscriptSegment[] = JSON.parse(JSON.stringify(row.transcript));
  // Compute duration from transcript (DB may have 0)
  const lastSeg = transcript[transcript.length - 1];
  const computedDuration = lastSeg ? Math.ceil(lastSeg.start + lastSeg.duration) : 0;
  const metadata: VideoMetadata = {
    youtubeId: row.youtube_id,
    title: row.title || 'Unknown',
    channelName: row.channel_name || 'Unknown',
    durationSeconds: row.duration_seconds || computedDuration,
  };

  console.log(`  Video: ${metadata.title} (${metadata.youtubeId})`);
  console.log(`  Channel: ${metadata.channelName}`);
  console.log(`  Duration: ${Math.round(metadata.durationSeconds / 60)} min`);
  console.log(`  Transcript: ${transcript.length} segments`);

  // Step 2: Extract candidates
  console.log('\n[2/5] Extracting candidates (V2 signal library)...');
  const startExtract = Date.now();
  const candidates = extractCandidates(transcript, 15);
  const extractMs = Date.now() - startExtract;

  console.log(`  Found: ${candidates.length} candidates in ${extractMs}ms`);

  if (candidates.length === 0) {
    console.log('\n  ⚠️ No candidates found. This may indicate a signal matching issue.');
    console.log('  Check that the transcript text is in Indonesian.');
    console.log(`  First segment text: "${transcript[0]?.text?.slice(0, 100)}"`);
    process.exit(0);
  }

  // Show top 5 candidates
  console.log('\n  Top 5 candidates:');
  for (let i = 0; i < Math.min(5, candidates.length); i++) {
    const c = candidates[i];
    const startMin = Math.floor(c.startSeconds / 60);
    const startSec = Math.floor(c.startSeconds % 60);
    const endMin = Math.floor(c.endSeconds / 60);
    const endSec = Math.floor(c.endSeconds % 60);
    console.log(
      `  #${i + 1} [${startMin}:${String(startSec).padStart(2, '0')} - ${endMin}:${String(endSec).padStart(2, '0')}] ` +
      `score=${c.score.toFixed(1)} sigs=${c.signals.join(',')} div=${c.diversity} ` +
      `dur=${Math.round(c.durationSeconds)}s`
    );
    console.log(`       "${c.text.slice(0, 120)}"`);
  }

  // Step 3: Build batch scoring prompt
  console.log('\n[3/5] Building batch scoring prompt...');
  const { system, user } = buildBatchCandidateScoringPrompt(metadata, candidates);
  console.log(`  System prompt: ${system.length} chars`);
  console.log(`  User prompt: ${user.length} chars`);
  console.log(`  Candidates in prompt: ${candidates.length}`);

  // Estimate tokens (rough: 1 token ≈ 4 chars for English, 3 for Indonesian)
  const estimatedTokens = Math.round(user.length / 3.5);
  console.log(`  Estimated prompt tokens: ~${estimatedTokens}`);
  console.log(`  Model: ${TARGET_MODEL}`);
  console.log(`  Prompt version: ${PROMPT_VERSION}`);

  // Step 4: Call LLM
  console.log('\n[4/5] Calling LLM for batch scoring...');

  const apiKey = process.env.OPENCODE_GO_API_KEY;
  if (!apiKey || apiKey === '***' || apiKey.length < 10) {
    console.log('  ⚠️ No valid API key. Skipping LLM call.');
    console.log('  To test end-to-end, set OPENCODE_GO_API_KEY in .env.local');
    console.log('\n✅ V2 pipeline setup complete (candidates + prompt ready)');
    console.log('   Set API key and re-run to test full pipeline.');
    process.exit(0);
  }

  const LLM_API_URL = 'https://opencode.ai/zen/go/v1/chat/completions';
  const startLLM = Date.now();

  let rawText: string;
  try {
    const response = await fetch(LLM_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: TARGET_MODEL,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: 0.3,
        max_tokens: 8192,
      }),
      signal: AbortSignal.timeout(300_000),
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => 'unknown');
      console.error(`  ❌ LLM API returned HTTP ${response.status}: ${errBody.slice(0, 200)}`);
      process.exit(1);
    }

    const data = await response.json();
    rawText = data?.choices?.[0]?.message?.content;

    if (!rawText || rawText.trim().length === 0) {
      console.error(`  ❌ LLM returned empty response`);
      console.error(`  Usage: ${JSON.stringify(data?.usage ?? {})}`);
      console.error(`  Finish reason: ${data?.choices?.[0]?.finish_reason ?? 'N/A'}`);
      process.exit(1);
    }

    const llmMs = Date.now() - startLLM;
    console.log(`  LLM responded in ${(llmMs / 1000).toFixed(1)}s`);
    console.log(`  Response length: ${rawText.length} chars`);
    console.log(`  Usage: ${JSON.stringify(data?.usage ?? {})}`);
  } catch (err) {
    console.error(`  ❌ LLM call failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    process.exit(1);
  }

  // Step 5: Parse and validate
  console.log('\n[5/5] Parsing and validating LLM response...');

  const cleaned = rawText.trim().replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/, '$1').trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    console.error(`  ❌ JSON parse failed`);
    console.error(`  Raw response (first 500 chars): ${rawText.slice(0, 500)}`);
    process.exit(1);
  }

  if (!Array.isArray(parsed)) {
    console.error(`  ❌ Expected JSON array, got ${typeof parsed}`);
    process.exit(1);
  }

  // Validate
  const validMoments: RawMoment[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const m = item as Record<string, unknown>;

    const startTime = typeof m.startTime === 'number' && Number.isFinite(m.startTime) ? m.startTime : null;
    const endTime = typeof m.endTime === 'number' && Number.isFinite(m.endTime) ? m.endTime : null;
    const score = typeof m.worthClippingScore === 'number' && Number.isFinite(m.worthClippingScore) ? m.worthClippingScore : null;
    const confidence = String(m.confidence ?? '').toLowerCase();
    const reasoning = String(m.reasoning ?? '').trim();

    if (startTime === null || startTime < 0 || startTime >= metadata.durationSeconds) continue;
    if (endTime === null || endTime <= startTime || endTime > metadata.durationSeconds) continue;
    const dur = endTime - startTime;
    if (dur < 15 || dur > 90) continue;
    if (score === null || score < 0 || score > 100) continue;
    if (!['high', 'medium', 'low'].includes(confidence)) continue;

    const validTags = new Set(['hookPower','curiosity','controversy','emotion','humor','storytelling','authority','money','shock','educational','motivation','relatability']);
    const tags = Array.isArray(m.dnaTags) ? m.dnaTags.filter((t: unknown) => validTags.has(String(t))).slice(0, 3) : [];
    if (tags.length === 0) continue;
    if (reasoning.length === 0) continue;

    validMoments.push({
      startTime, endTime, worthClippingScore: score,
      confidence: confidence as ConfidenceLevel,
      dnaTags: tags as DnaTag[],
      reasoning,
    });
  }

  validMoments.sort((a, b) => b.worthClippingScore - a.worthClippingScore);

  console.log(`  Valid moments: ${validMoments.length}/${parsed.length}`);

  if (validMoments.length === 0 && parsed.length > 0) {
    console.log('\n  ⚠️ All moments failed validation. Raw parsed data:');
    for (let i = 0; i < Math.min(3, parsed.length); i++) {
      console.log(`  [${i}]: ${JSON.stringify(parsed[i], null, 2).slice(0, 300)}`);
    }
  }

  if (validMoments.length > 0) {
    console.log('\n  📊 Results:');
    for (let i = 0; i < Math.min(10, validMoments.length); i++) {
      const m = validMoments[i];
      const startMin = Math.floor(m.startTime / 60);
      const startSec = Math.floor(m.startTime % 60);
      const endMin = Math.floor(m.endTime / 60);
      const endSec = Math.floor(m.endTime % 60);
      console.log(
        `  #${i + 1} [${startMin}:${String(startSec).padStart(2, '0')} - ${endMin}:${String(endSec).padStart(2, '0')}] ` +
        `score=${m.worthClippingScore} conf=${m.confidence} tags=[${m.dnaTags.join(',')}]`
      );
      console.log(`       ${m.reasoning}`);
    }
  }

  console.log('\n' + '═'.repeat(70));
  console.log('✅ V2 Pipeline test complete');
  console.log(`   Candidates: ${candidates.length}`);
  console.log(`   Valid moments: ${validMoments.length}`);
  console.log(`   Total time: ${((Date.now() - startExtract) / 1000).toFixed(1)}s`);
  console.log('═'.repeat(70));
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
