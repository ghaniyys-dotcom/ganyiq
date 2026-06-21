// ============================================================================
// lib/multi-generator/diversity.test.ts — Validation Suite
// ============================================================================
// Run: npx tsx lib/multi-generator/diversity.test.ts
//
// 4 synthetic test cases verifying:
//   A: Near-identical clips → 1 survivor
//   B: Overlapping clips from same moment → maxPerCluster respected
//   C: Completely different clips → all survive
//   D: Mixed pool (20 candidates) → full dedup run
// ============================================================================

import type { GeneratorCandidate, GeneratorStrategy, PoolConstraints } from './types';
import { DEFAULT_POOL_CONSTRAINTS } from './types';
import {
  computePairOverlap,
  buildClusterMap,
  dedupPool,
  computeDiversityScore,
} from './diversity';

// Helper: build a synthetic candidate
function makeCandidate(
  candidateId: string,
  generator: GeneratorStrategy,
  startTime: number,
  endTime: number,
  transcriptWords: string[],
  triggerSignals: string[],
  internalScore: number,
  confidence: 'high' | 'medium' | 'low' = 'medium',
): GeneratorCandidate {
  return {
    candidateId,
    generator,
    videoId: 'test-video',
    startTime,
    endTime,
    durationSeconds: endTime - startTime,
    transcriptExcerpt: transcriptWords.join(' '),
    timeline: {
      videoInfo: { videoId: 'test-video', title: 'Test', durationMs: (endTime - startTime) * 1000 },
      segments: [],
      metadata: {
        generatedAt: Date.now(),
        version: '2.0.0',
        generator: 'test',
      },
    },
    metadata: {
      selectionRationale: 'test',
      triggerSignals,
      internalScore,
      confidence,
    },
  };
}

// ============================================================================
// CASE A: Near-identical clips
// ============================================================================
// 3 clips with same time range, same transcript, same signals.
// Expected: 1 survivor (identical clips merge into 1 cluster, maxPerCluster=2,
//           but pairwise overlap > maxPairOverlap=0.65 so only 1 survives)
// Actually: identical clips will have composite = 1.0. BuildClusterMap merges
// them (threshold=0.65). Then dedup keeps max 2 per cluster. But pairwise
// overlap check on survivors (step 3) will drop one more since composite 1.0
// exceeds maxPairOverlap 0.65.
// Final: 1 survivor. Let's see what the actual algorithm produces.
// ============================================================================

function testCaseA(): void {
  console.log('\n========== CASE A: Near-identical clips ==========');

  const clips = [
    makeCandidate('hook_0', 'hook', 30, 60, ['hello', 'world', 'this', 'is', 'test'], ['hook', 'question'], 85, 'high'),
    makeCandidate('hook_1', 'hook', 30, 60, ['hello', 'world', 'this', 'is', 'test'], ['hook', 'question'], 82, 'high'),
    makeCandidate('emotion_0', 'emotion', 30, 60, ['hello', 'world', 'this', 'is', 'test'], ['hook', 'question'], 78, 'high'),
  ];

  const result = dedupPool(clips);
  console.log(`  Before: ${result.stats.before}`);
  console.log(`  After:  ${result.stats.after}`);
  console.log(`  Removed: ${result.stats.removedCount}`);
  console.log(`  Clusters: ${result.stats.clusterCount}`);
  console.log(`  Survivors: ${result.survivors.map((c) => c.candidateId).join(', ')}`);

  for (const r of result.removed) {
    console.log(`  ✗ ${r.candidate.candidateId}: ${r.reason}`);
  }

  const pass = result.stats.after === 1;
  console.log(`  → Case A: ${pass ? 'PASS' : 'FAIL'} (expected 1 survivor, got ${result.stats.after})`);
  if (!pass) process.exitCode = 1;
}

// ============================================================================
// CASE B: Overlapping clips from same moment
// ============================================================================
// 3 clips covering the same moment with different boundaries:
//   hook_0: 30-60, story_0: 35-65, emotion_0: 25-55
// Overlapping but not identical. Should form 1 cluster, keep max 2.
// Expected: 2 survivors
// ============================================================================

function testCaseB(): void {
  console.log('\n========== CASE B: Overlapping clips, same moment ==========');

  // Same time range (30-60s), overlapping boundaries (75/90% of each other).
  // Mostly same transcript (4/5 words in common), different signals.
  // Composite should be ~0.75-0.85 → clusters together, max 2 survivors.
  const clips = [
    makeCandidate('hook_0', 'hook', 30, 60, ['hello', 'world', 'this', 'is', 'test'], ['hook', 'question'], 85, 'high'),
    makeCandidate('story_0', 'story', 32, 62, ['hello', 'world', 'this', 'is', 'different'], ['story', 'narrative'], 80, 'high'),
    makeCandidate('emotion_0', 'emotion', 28, 58, ['hello', 'world', 'this', 'is', 'test'], ['emotion', 'vulnerability'], 75, 'high'),
  ];

  // Debug: print pairwise composites
  console.log('  Pairwise composites:');
  for (let i = 0; i < clips.length; i++) {
    for (let j = i + 1; j < clips.length; j++) {
      const p = computePairOverlap(clips[i], clips[j]);
      console.log(`    ${clips[i].candidateId} ↔ ${clips[j].candidateId}: ${p.composite.toFixed(3)} (t=${p.scores.timeOverlap.toFixed(3)} tx=${p.scores.transcriptOverlap.toFixed(3)} s=${p.scores.semanticOverlap.toFixed(3)})`);
    }
  }

  const result = dedupPool(clips);
  console.log(`  Before: ${result.stats.before}`);
  console.log(`  After:  ${result.stats.after}`);
  console.log(`  Survivors: ${result.survivors.map((c) => c.candidateId).join(', ')}`);

  for (const r of result.removed) {
    console.log(`  ✗ ${r.candidate.candidateId}: ${r.reason}`);
  }

  // Expected: maxPerCluster=2, so 1 removed
  const pass = result.stats.after === 2;
  console.log(`  → Case B: ${pass ? 'PASS' : 'FAIL'} (expected 2 survivors, got ${result.stats.after})`);
  if (!pass) process.exitCode = 1;
}

// ============================================================================
// CASE C: Completely different clips
// ============================================================================
// 3 clips from completely different parts of the video, different transcript,
// different signals. No overlap.
// Expected: 3 survivors
// ============================================================================

function testCaseC(): void {
  console.log('\n========== CASE C: Completely different clips ==========');

  const clips = [
    makeCandidate('hook_0', 'hook', 10, 40, ['introduction', 'hello', 'everyone'], ['hook', 'opening'], 85, 'high'),
    makeCandidate('story_0', 'story', 120, 180, ['back', 'in', 'the', 'old', 'days', 'story'], ['story', 'anecdote'], 82, 'high'),
    makeCandidate('insight_0', 'insight', 400, 450, ['key', 'insight', 'here', 'is', 'that'], ['insight', 'analysis'], 78, 'high'),
  ];

  const result = dedupPool(clips);
  console.log(`  Before: ${result.stats.before}`);
  console.log(`  After:  ${result.stats.after}`);
  console.log(`  Survivors: ${result.survivors.map((c) => c.candidateId).join(', ')}`);

  for (const r of result.removed) {
    console.log(`  ✗ ${r.candidate.candidateId}: ${r.reason}`);
  }

  const pass = result.stats.after === 3;
  console.log(`  → Case C: ${pass ? 'PASS' : 'FAIL'} (expected 3 survivors, got ${result.stats.after})`);
  if (!pass) process.exitCode = 1;
}

// ============================================================================
// CASE D: Mixed pool (20 candidates, 4 generators × 5 each)
// ============================================================================
// 4 generators produce 20 clips spread across 5 distinct moments.
// Cluster distribution:
//   Moment A (10-40):    hook_0, story_0, emotion_0, insight_0  [4 clips]
//   Moment B (60-100):   hook_1, story_1, emotion_1             [3 clips]
//   Moment C (150-190):  hook_2, story_2                        [2 clips]
//   Moment D (250-300):  hook_3                                 [1 clip]
//   Moment E (400-450):  hook_4, story_3, emotion_2, insight_1  [4 clips]
//   Moment F (500-540):  story_4, emotion_3, insight_2          [3 clips]
//   Moment G (600-630):  emotion_4, insight_3                   [2 clips]
//   Moment H (700-720):  insight_4                              [1 clip]
//
// 8 clusters total. maxPerCluster=2 → each cluster keeps up to 2.
// Total before: 20. Total after maxPerCluster: 2×8 = 16.
// Then pairwise check and diversity threshold may remove more.
// Expected: ≤ 16 survivors (realistic: 8-14 after all checks)
// ============================================================================

function testCaseD(): void {
  console.log('\n========== CASE D: Mixed pool (20 candidates) ==========');

  const clips: GeneratorCandidate[] = [];

  // Moment A (10-40): intro — 4 clips, same time, same transcript, different signals
  // Composite ≈ 0.75 (time=1.0, tx=1.0, sem=0.0) → clusters
  clips.push(makeCandidate('hook_A0', 'hook', 10, 40, ['introduction', 'hello', 'everyone', 'welcome'], ['hook', 'opening'], 85, 'high'));
  clips.push(makeCandidate('story_A0', 'story', 10, 40, ['introduction', 'hello', 'everyone', 'welcome'], ['story', 'setup'], 80, 'high'));
  clips.push(makeCandidate('emotion_A0', 'emotion', 10, 40, ['introduction', 'hello', 'everyone', 'welcome'], ['emotion', 'warmth'], 75, 'high'));
  clips.push(makeCandidate('insight_A0', 'insight', 10, 40, ['introduction', 'hello', 'everyone', 'welcome'], ['insight', 'context'], 70, 'high'));

  // Moment B (60-100): hook setup — 3 clips, overlapping boundaries (85-95% of each other)
  // hook vs story: time=25/35=0.714, tx=4/6=0.667, sem=0 → composite ≈ 0.519 — NOT enough
  // Need tighter overlap: make all the same time range
  clips.push(makeCandidate('hook_B0', 'hook', 60, 100, ['but', 'what', 'if', 'I', 'told', 'you', 'something'], ['hook', 'curiosity'], 88, 'high'));
  clips.push(makeCandidate('story_B0', 'story', 60, 100, ['but', 'what', 'if', 'I', 'told', 'you', 'story'], ['story', 'personal'], 82, 'high'));
  clips.push(makeCandidate('emotion_B0', 'emotion', 60, 100, ['but', 'what', 'if', 'I', 'told', 'you', 'something'], ['emotion', 'struggle'], 76, 'high'));

  // Moment C (150-190): insight — 2 clips
  clips.push(makeCandidate('hook_C0', 'hook', 150, 190, ['here', 'is', 'the', 'key', 'takeaway', 'folks'], ['hook', 'promise'], 84, 'high'));
  clips.push(makeCandidate('story_C0', 'story', 150, 190, ['here', 'is', 'the', 'key', 'takeaway', 'today'], ['story', 'reflection'], 79, 'high'));

  // Moment D (250-300): stand-alone — 1 clip (singleton)
  clips.push(makeCandidate('hook_D0', 'hook', 250, 300, ['completely', 'different', 'topic', 'now'], ['hook', 'transition'], 81, 'high'));

  // Moment E (400-450): climax — 4 clips
  clips.push(makeCandidate('hook_E0', 'hook', 400, 450, ['this', 'changes', 'everything', 'you', 'know'], ['hook', 'revelation'], 92, 'high'));
  clips.push(makeCandidate('story_E0', 'story', 400, 450, ['this', 'changes', 'everything', 'you', 'believe'], ['story', 'climax'], 87, 'high'));
  clips.push(makeCandidate('emotion_E0', 'emotion', 400, 450, ['this', 'changes', 'everything', 'you', 'know'], ['emotion', 'impact'], 83, 'high'));
  clips.push(makeCandidate('insight_E0', 'insight', 400, 450, ['this', 'changes', 'everything', 'you', 'know'], ['insight', 'revelation'], 78, 'high'));

  // Moment F (500-540): reflection — 3 clips
  clips.push(makeCandidate('story_F0', 'story', 500, 540, ['looking', 'back', 'I', 'realize', 'now'], ['story', 'reflection'], 86, 'high'));
  clips.push(makeCandidate('emotion_F0', 'emotion', 500, 540, ['looking', 'back', 'I', 'realize', 'now'], ['emotion', 'nostalgia'], 80, 'high'));
  clips.push(makeCandidate('insight_F0', 'insight', 500, 540, ['looking', 'back', 'I', 'realize', 'now'], ['insight', 'lesson'], 75, 'high'));

  // Moment G (600-630): outro — 2 clips
  clips.push(makeCandidate('emotion_G0', 'emotion', 600, 630, ['finally', 'I', 'want', 'to', 'say'], ['emotion', 'gratitude'], 79, 'high'));
  clips.push(makeCandidate('insight_G0', 'insight', 600, 630, ['finally', 'I', 'want', 'to', 'say'], ['insight', 'summary'], 74, 'high'));

  // Moment H (700-720): CTA — 1 clip (singleton)
  clips.push(makeCandidate('insight_H0', 'insight', 700, 720, ['go', 'out', 'and', 'apply', 'this'], ['insight', 'action'], 77, 'high'));

  console.log('  Debug — Pairwise composites within each moment:');
  for (let i = 0; i < clips.length; i++) {
    for (let j = i + 1; j < clips.length; j++) {
      const ci = clips[i];
      const cj = clips[j];
      // Only debug pairs from same moment cluster
      if (Math.abs(ci.startTime - cj.startTime) <= 5 && Math.abs(ci.endTime - cj.endTime) <= 5) {
        if (ci.candidateId !== cj.candidateId) {
          const p = computePairOverlap(ci, cj);
          console.log(`    ${ci.candidateId} ↔ ${cj.candidateId}: composite=${p.composite.toFixed(3)} (t=${p.scores.timeOverlap.toFixed(3)} tx=${p.scores.transcriptOverlap.toFixed(3)} s=${p.scores.semanticOverlap.toFixed(3)})`);
        }
      }
    }
  }

  const result = dedupPool(clips);

  console.log(`  Before: ${result.stats.before}`);
  console.log(`  After:  ${result.stats.after}`);
  console.log(`  Removed: ${result.stats.removedCount}`);
  console.log(`  Clusters: ${result.stats.clusterCount}`);
  console.log(`  Singletons: ${result.stats.singletonCount}`);
  console.log(`  Avg diversity score: ${result.stats.avgDiversityScore.toFixed(3)}`);
  console.log(`  Uniqueness ratio: ${(result.stats.singletonCount / result.stats.clusterCount).toFixed(3)}`);

  // Print removed log
  console.log('\n  Removed candidates:');
  for (const r of result.removed) {
    console.log(`    ✗ ${r.candidate.candidateId} (cluster ${r.clusterId || 'N/A'}): ${r.reason}`);
  }

  console.log('\n  Survivors:');
  for (const s of result.survivors) {
    const ds = computeDiversityScore(s, result.survivors);
    console.log(`    ✓ ${s.candidateId} (${s.generator}) @ ${s.startTime}-${s.endTime}s, score=${ds.composite.toFixed(3)}`);
  }

  console.log('\n  Cluster details:');
  for (const c of result.clusters) {
    console.log(`    ${c.id}: ${c.clips.length} clip(s) @ ${c.startSec}-${c.endSec}s [${c.strategies.join(', ')}] "${c.label.slice(0, 50)}..."`);
  }

  // Sanity checks
  let allPass = true;

  // No cluster should have > maxPerCluster survivors
  const clusterSurvivorCounts = new Map<string, number>();
  for (const s of result.survivors) {
    const cluster = result.clusters.find((c) => c.clips.some((cc) => cc.candidateId === s.candidateId));
    if (cluster) {
      clusterSurvivorCounts.set(cluster.id, (clusterSurvivorCounts.get(cluster.id) || 0) + 1);
    }
  }
  for (const [cid, count] of clusterSurvivorCounts) {
    if (count > DEFAULT_POOL_CONSTRAINTS.maxPerCluster) {
      console.log(`  FAIL: Cluster ${cid} has ${count} survivors, max is ${DEFAULT_POOL_CONSTRAINTS.maxPerCluster}`);
      allPass = false;
    }
  }

  // All survivors should have diversity score >= minDiversityScore
  for (const s of result.survivors) {
    const ds = computeDiversityScore(s, result.survivors);
    if (ds.composite < DEFAULT_POOL_CONSTRAINTS.minDiversityScore) {
      console.log(`  FAIL: ${s.candidateId} has diversity score ${ds.composite.toFixed(3)}, below minimum ${DEFAULT_POOL_CONSTRAINTS.minDiversityScore}`);
      allPass = false;
    }
  }

  // Survivors should be ≤ maxDedupedCandidates
  if (result.stats.after > DEFAULT_POOL_CONSTRAINTS.maxDedupedCandidates) {
    console.log(`  FAIL: ${result.stats.after} survivors exceed maxDedupedCandidates ${DEFAULT_POOL_CONSTRAINTS.maxDedupedCandidates}`);
    allPass = false;
  }

  console.log(`  → Case D: ${allPass ? 'PASS' : 'FAIL'}`);
  if (!allPass) process.exitCode = 1;
}

// ============================================================================
// Edge case: Empty pool
// ============================================================================

function testEdgeEmpty(): void {
  console.log('\n========== Edge case: Empty pool ==========');

  const result = dedupPool([]);
  console.log(`  Before: ${result.stats.before}`);
  console.log(`  After:  ${result.stats.after}`);
  console.log(`  Clusters: ${result.stats.clusterCount}`);

  const pass = result.stats.before === 0 && result.stats.after === 0 && result.stats.clusterCount === 0;
  console.log(`  → Edge empty: ${pass ? 'PASS' : 'FAIL'}`);
  if (!pass) process.exitCode = 1;
}

// ============================================================================
// Edge case: Single candidate
// ============================================================================

function testEdgeSingle(): void {
  console.log('\n========== Edge case: Single candidate ==========');

  const clips = [
    makeCandidate('hook_0', 'hook', 30, 60, ['hello', 'world'], ['hook'], 85, 'high'),
  ];

  const result = dedupPool(clips);
  console.log(`  Before: ${result.stats.before}`);
  console.log(`  After:  ${result.stats.after}`);
  console.log(`  Survivor: ${result.survivors[0]?.candidateId}`);

  const pass = result.stats.after === 1;
  console.log(`  → Edge single: ${pass ? 'PASS' : 'FAIL'}`);
  if (!pass) process.exitCode = 1;
}

// ============================================================================
// Metrics report
// ============================================================================

function printMetricsReport(): void {
  console.log('\n\n========== METRICS REPORT ==========');

  // Build a mixed pool and run full dedup
  const clips: GeneratorCandidate[] = [];
  for (let i = 0; i < 5; i++) {
    clips.push(makeCandidate(
      `hook_${i}`, 'hook',
      10 + i * 60, 40 + i * 60,
      [`word${i}a`, `word${i}b`, `word${i}c`],
      ['hook', `signal${i}`],
      80 + i,
    ));
    clips.push(makeCandidate(
      `story_${i}`, 'story',
      15 + i * 60, 45 + i * 60,
      [`word${i}a`, `word${i}b`, `word${i}d`],
      ['story', `signal${i}`],
      75 + i,
    ));
    clips.push(makeCandidate(
      `emotion_${i}`, 'emotion',
      20 + i * 60, 50 + i * 60,
      [`word${i}a`, `word${i}e`],
      ['emotion'],
      70 + i,
    ));
    clips.push(makeCandidate(
      `insight_${i}`, 'insight',
      5 + i * 60, 35 + i * 60,
      [`word${i}f`, `word${i}g`],
      ['insight'],
      65 + i,
    ));
  }

  const result = dedupPool(clips);

  // Overlap histogram
  console.log('\n--- Overlap Histogram ---');
  const overlapBuckets = [0, 0, 0, 0, 0]; // 0-0.2, 0.2-0.4, 0.4-0.6, 0.6-0.8, 0.8-1.0
  let overlapPairs = 0;
  for (let i = 0; i < result.survivors.length; i++) {
    for (let j = i + 1; j < result.survivors.length; j++) {
      const pair = computePairOverlap(result.survivors[i], result.survivors[j]);
      overlapPairs++;
      if (pair.composite < 0.2) overlapBuckets[0]++;
      else if (pair.composite < 0.4) overlapBuckets[1]++;
      else if (pair.composite < 0.6) overlapBuckets[2]++;
      else if (pair.composite < 0.8) overlapBuckets[3]++;
      else overlapBuckets[4]++;
    }
  }
  console.log(`  Total pairs checked: ${overlapPairs}`);
  console.log(`  [0.00-0.20): ${overlapBuckets[0]}`);
  console.log(`  [0.20-0.40): ${overlapBuckets[1]}`);
  console.log(`  [0.40-0.60): ${overlapBuckets[2]}`);
  console.log(`  [0.60-0.80): ${overlapBuckets[3]}`);
  console.log(`  [0.80-1.00]: ${overlapBuckets[4]}`);
  console.log(`  Max pairwise overlap: ${maxPairwiseInSet(result.survivors).toFixed(4)}`);

  // Diversity score histogram
  console.log('\n--- Diversity Score Histogram ---');
  const divBuckets = [0, 0, 0, 0, 0]; // 0-0.2, 0.2-0.4, 0.4-0.6, 0.6-0.8, 0.8-1.0
  let totalScore = 0;
  for (const s of result.survivors) {
    const ds = computeDiversityScore(s, result.survivors);
    totalScore += ds.composite;
    if (ds.composite < 0.2) divBuckets[0]++;
    else if (ds.composite < 0.4) divBuckets[1]++;
    else if (ds.composite < 0.6) divBuckets[2]++;
    else if (ds.composite < 0.8) divBuckets[3]++;
    else divBuckets[4]++;
  }
  console.log(`  [0.00-0.20): ${divBuckets[0]}`);
  console.log(`  [0.20-0.40): ${divBuckets[1]}`);
  console.log(`  [0.40-0.60): ${divBuckets[2]}`);
  console.log(`  [0.60-0.80): ${divBuckets[3]}`);
  console.log(`  [0.80-1.00]: ${divBuckets[4]}`);
  console.log(`  Mean diversity: ${result.survivors.length > 0 ? (totalScore / result.survivors.length).toFixed(3) : 'N/A'}`);

  // Summary
  console.log('\n--- Summary ---');
  console.log(`  Raw candidates:    ${result.stats.before}`);
  console.log(`  Clusters created:  ${result.stats.clusterCount}`);
  console.log(`  Singletons:        ${result.stats.singletonCount}`);
  console.log(`  Candidates removed: ${result.stats.removedCount}`);
  console.log(`  Final survivors:   ${result.stats.after}`);
  console.log(`  Avg diversity:     ${result.stats.avgDiversityScore.toFixed(3)}`);
}

function maxPairwiseInSet(candidates: GeneratorCandidate[]): number {
  let maxVal = 0;
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const pair = computePairOverlap(candidates[i], candidates[j]);
      if (pair.composite > maxVal) maxVal = pair.composite;
    }
  }
  return maxVal;
}

// ============================================================================
// Runner
// ============================================================================

function main(): void {
  console.log('===== DIVERSITY MODULE VALIDATION =====\n');

  testEdgeEmpty();
  testEdgeSingle();
  testCaseA();
  testCaseB();
  testCaseC();
  testCaseD();
  printMetricsReport();

  const code = process.exitCode || 0;
  console.log(`\n===== ${code === 0 ? 'ALL TESTS PASSED' : 'SOME TESTS FAILED'} =====`);
}

main();
