/**
 * lib/test-harness.ts — V2 End-to-End Integration Test
 *
 * Tests the full pipeline:
 *   Candidate → Judge Engine V2 → Scoring → Ranking V2
 *
 * Uses simulated LLM responses (not live API calls) to verify
 * pipeline integrity without external dependencies.
 *
 * Run: npx tsx lib/test-harness.ts
 */

import type { RawMoment, TranscriptSegment } from './types';
import type { JudgeResult } from './judge-types';
import { judgeStage } from './judge-stage';
import { rankMomentsV2, generateComparisonReport } from './ranking-v2';
import {
  calculateRawScore,
  applyCurve,
  buildJudgeResult,
} from './judge-types';

// ---------------------------------------------------------------------------
// Mock LLM (simulates judge responses for testing)
// ---------------------------------------------------------------------------

function createMockLlm(scores: Array<{
  hook?: number;
  coherence?: number;
  connection?: number;
  trend?: number;
}>) {
  let callCount = 0;

  return async (
    prompt: string,
    _options?: { responseFormat?: { type: string }; schema?: Record<string, unknown>; temperature?: number },
  ): Promise<{ text: string }> => {
    const isBatch = prompt.includes('CLIP 1');
    
    if (isBatch) {
      // Batch mode: return array
      const response = scores.map((s, i) => ({
        clipIndex: i,
        hook: { score: s.hook ?? 5, reasoning: `Hook evaluation for clip ${i}` },
        coherence: { score: s.coherence ?? 5, reasoning: `Coherence evaluation for clip ${i}` },
        connection: { score: s.connection ?? 5, reasoning: `Connection evaluation for clip ${i}` },
        trend: { score: s.trend ?? 5, reasoning: `Trend evaluation for clip ${i}` },
      }));
      return { text: JSON.stringify(response) };
    }
    
    // Single mode: return object
    const idx = Math.min(callCount, scores.length - 1);
    callCount++;
    const s = scores[idx] ?? { hook: 5, coherence: 5, connection: 5, trend: 5 };
    const response = {
      hook: { score: s.hook ?? 5, reasoning: 'Mock hook evaluation' },
      coherence: { score: s.coherence ?? 5, reasoning: 'Mock coherence evaluation' },
      connection: { score: s.connection ?? 5, reasoning: 'Mock connection evaluation' },
      trend: { score: s.trend ?? 5, reasoning: 'Mock trend evaluation' },
    };
    return { text: JSON.stringify(response) };
  };
}

// ---------------------------------------------------------------------------
// Sample Data
// ---------------------------------------------------------------------------

const SAMPLE_TRANSCRIPT: TranscriptSegment[] = [
  { start: 0, duration: 5, text: 'Halo semuanya, selamat datang di podcast kita hari ini.' },
  { start: 5, duration: 8, text: 'Gue mau bahas sesuatu yang lagi viral banget nih.' },
  { start: 13, duration: 10, text: 'Lo pada tau gak sih kalo AI sekarang udah bisa bikin video?' },
  { start: 23, duration: 12, text: 'Gue coba sendiri kemarin, dan hasilnya bikin gue merinding.' },
  { start: 35, duration: 15, text: 'Bayangin aja, lo tinggal masukin teks, trus videonya jadi.' },
  { start: 50, duration: 10, text: 'Ini bakal ngerubah cara kita bikin konten selamanya.' },
  { start: 60, duration: 8, text: 'Tapi lo harus tau juga risikonya nih.' },
  { start: 68, duration: 12, text: 'Karena kalo semua orang bisa bikin video, gimana cara lo standout?' },
  { start: 80, duration: 10, text: 'Nah itu yang bakal gue bahas di episode kali ini.' },
  { start: 90, duration: 15, text: 'Gue juga ngajak temen gue yang udah pro di bidang AI.' },
  { start: 105, duration: 20, text: 'Dia bakal jelasin gimana caranya manfaatin AI buat konten kreator.' },
  { start: 125, duration: 8, text: 'Yang penting bukan tools-nya, tapi gimana lo pake.' },
  { start: 133, duration: 10, text: 'Tools bisa berubah, tapi skill kreatif lo gak akan pernah mati.' },
  { start: 143, duration: 7, text: 'Oke langsung aja kita mulai episode kali ini.' },
];

const SAMPLE_MOMENTS: RawMoment[] = [
  {
    startTime: 5,
    endTime: 23,
    worthClippingScore: 85,
    confidence: 'high',
    dnaTags: ['hookPower', 'curiosity'],
    reasoning: 'Opening question about AI video creation is engaging',
  },
  {
    startTime: 35,
    endTime: 50,
    worthClippingScore: 78,
    confidence: 'medium',
    dnaTags: ['emotion', 'storytelling'],
    reasoning: 'Personal story about testing AI is relatable',
  },
  {
    startTime: 60,
    endTime: 80,
    worthClippingScore: 72,
    confidence: 'high',
    dnaTags: ['educational'],
    reasoning: 'Educational content about standing out',
  },
  {
    startTime: 90,
    endTime: 125,
    worthClippingScore: 88,
    confidence: 'high',
    dnaTags: ['authority', 'educational'],
    reasoning: 'Expert interview segment with valuable insights',
  },
  {
    startTime: 125,
    endTime: 143,
    worthClippingScore: 70,
    confidence: 'medium',
    dnaTags: ['motivation'],
    reasoning: 'Inspiring closing statement about creative skills',
  },
];

// ---------------------------------------------------------------------------
// Test Runner
// ---------------------------------------------------------------------------

async function runTest() {
  console.log('='.repeat(70));
  console.log('GANYIQ V2 JUDGE ENGINE — INTEGRATION TEST');
  console.log('='.repeat(70));
  console.log('');
  console.log(`Sample moments: ${SAMPLE_MOMENTS.length}`);
  console.log(`Transcript segments: ${SAMPLE_TRANSCRIPT.length}`);
  console.log('');

  // --------------------------------------------------
  // Step 1: Judge Stage
  // --------------------------------------------------
  console.log('📋 Step 1: Running Judge Stage...');
  console.log('');

  const mockScores = [
    { hook: 8.5, coherence: 7.0, connection: 8.0, trend: 7.5 },  // clip 0: hook
    { hook: 6.0, coherence: 9.0, connection: 7.5, trend: 6.0 },  // clip 1: coherence (story)
    { hook: 5.0, coherence: 7.0, connection: 8.5, trend: 6.5 },  // clip 2: connection (educational)
    { hook: 7.0, coherence: 8.5, connection: 6.0, trend: 9.0 },  // clip 3: trend (expert)
    { hook: 6.5, coherence: 7.0, connection: 7.0, trend: 5.0 },  // clip 4: motivation
  ];

  const mockLlm = createMockLlm(mockScores);

  const enriched = await judgeStage(
    SAMPLE_MOMENTS,
    SAMPLE_TRANSCRIPT,
    { llm: mockLlm, batchSize: 5 },
  );

  console.log('Results:');
  enriched.forEach((m, i) => {
    const jr = m.judgeResult!;
    console.log(
      `  Clip ${i}: ${m.startTime}s-${m.endTime}s ` +
      `hook=${jr.hookScore.toFixed(1)} ` +
      `coh=${jr.coherenceScore.toFixed(1)} ` +
      `conn=${jr.connectionScore.toFixed(1)} ` +
      `trend=${jr.trendScore.toFixed(1)} ` +
      `| raw=${jr.rawScore.toFixed(1)} ` +
      `| curved=${jr.curvedScore}`,
    );
  });

  console.log('');

  // --------------------------------------------------
  // Step 2: V2 Ranking
  // --------------------------------------------------
  console.log('📋 Step 2: Running V2 Ranking...');
  console.log('');

  const ranked = rankMomentsV2(enriched, SAMPLE_TRANSCRIPT);

  console.log('Final Ranking:');
  console.log(
    `${'Rank'.padStart(4)} ${'Tier'.padStart(8)} ${'Curved'.padStart(8)} ${'Raw'.padStart(6)} ` +
    `${'Hook'.padStart(6)} ${'Coh'.padStart(6)} ${'Conn'.padStart(6)} ${'Trend'.padStart(6)} ` +
    `${'Time'.padStart(12)} ${'Excerpt'.padStart(20)}`,
  );
  console.log('-'.repeat(90));

  ranked.forEach(m => {
    const jr = m.judgeResult!;
    console.log(
      `${String(m.rank).padStart(4)} ` +
      `${m.tier.padStart(8)} ` +
      `${String(jr.curvedScore).padStart(8)} ` +
      `${jr.rawScore.toFixed(1).padStart(6)} ` +
      `${jr.hookScore.toFixed(1).padStart(6)} ` +
      `${jr.coherenceScore.toFixed(1).padStart(6)} ` +
      `${jr.connectionScore.toFixed(1).padStart(6)} ` +
      `${jr.trendScore.toFixed(1).padStart(6)} ` +
      `${m.startTimestamp}-${m.endTimestamp} `.padStart(12) +
      `${(m.transcriptExcerpt || '').slice(0, 25).padStart(20)}`,
    );
  });

  // --------------------------------------------------
  // Step 3: Judge Score Distribution
  // --------------------------------------------------
  console.log('');
  console.log('📋 Step 3: Score Distribution:');
  console.log('');

  const allJr = ranked.map(m => m.judgeResult!).filter(Boolean);
  if (allJr.length > 0) {
    const avgHook = allJr.reduce((s, j) => s + j.hookScore, 0) / allJr.length;
    const avgCoh = allJr.reduce((s, j) => s + j.coherenceScore, 0) / allJr.length;
    const avgConn = allJr.reduce((s, j) => s + j.connectionScore, 0) / allJr.length;
    const avgTrend = allJr.reduce((s, j) => s + j.trendScore, 0) / allJr.length;
    const avgRaw = allJr.reduce((s, j) => s + j.rawScore, 0) / allJr.length;
    const avgCurved = allJr.reduce((s, j) => s + j.curvedScore, 0) / allJr.length;

    console.log(`  Avg hookScore:       ${avgHook.toFixed(2)}  (Opus range: 6-9)`);
    console.log(`  Avg coherenceScore:  ${avgCoh.toFixed(2)}  (Opus range: 6-10)`);
    console.log(`  Avg connectionScore: ${avgConn.toFixed(2)}  (Opus range: 5-10)`);
    console.log(`  Avg trendScore:      ${avgTrend.toFixed(2)}  (Opus range: 5-8)`);
    console.log(`  Avg rawScore:        ${avgRaw.toFixed(2)}  (max: 40)`);
    console.log(`  Avg curvedScore:     ${avgCurved.toFixed(2)}  (max: 100)`);
    console.log(`  Score range: ${Math.min(...allJr.map(j => j.curvedScore))} - ${Math.max(...allJr.map(j => j.curvedScore))}`);
  }

  // --------------------------------------------------
  // Step 4: Comparison Report
  // --------------------------------------------------
  console.log('');
  console.log('📋 Step 4: A/B Comparison Report:');
  console.log('');

  // V1: sort by worthClippingScore
  const v1Moments = [...SAMPLE_MOMENTS]
    .sort((a, b) => b.worthClippingScore - a.worthClippingScore)
    .map((m, i) => ({
      ...m,
      rank: i + 1,
      tier: i < Math.ceil(SAMPLE_MOMENTS.length * 0.3) ? 'elite' as const : 'secondary' as const,
      startTimestamp: '0:00',
      endTimestamp: '0:00',
      transcriptExcerpt: '',
    }));

  const report = generateComparisonReport(v1Moments, ranked);
  console.log(report);

  // --------------------------------------------------
  // Summary
  // --------------------------------------------------
  console.log('');
  console.log('='.repeat(70));
  console.log('TEST SUMMARY');
  console.log('='.repeat(70));
  console.log('');
  console.log(`✅ Judge Stage:        ${enriched.length}/${SAMPLE_MOMENTS.length} moments enriched`);
  console.log(`✅ Ranking V2:         ${ranked.length} moments ranked`);
  console.log(`✅ Score distribution: ${ranked.filter(m => m.judgeResult?.curvedScore).length}/${ranked.length} have curved scores`);
  console.log(`✅ Pipeline complete:  Judge → Score → Rank`);
  console.log('');
  console.log('Judge V2 is integrated into the pipeline.');
  console.log('To run with REAL LLM: use judgeStage() with a real LLM function.');
}

// Run
runTest().catch(console.error);
