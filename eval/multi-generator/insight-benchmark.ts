// ============================================================================
// eval/multi-generator/insight-benchmark.ts — Phase 2.3 Insight Generator Benchmark
// ============================================================================
//
// Runs InsightGenerator + HookGenerator on 3 real transcripts.
// Reports per-project and cross-generator overlap analysis.
//
// Run: npx tsx eval/multi-generator/insight-benchmark.ts
// ============================================================================

import { readFileSync, existsSync, writeFileSync } from 'fs';
import { HookGenerator } from '../../lib/multi-generator/hook-generator';
import { InsightGenerator } from '../../lib/multi-generator/insight-generator';
import { computePairOverlap } from '../../lib/multi-generator/diversity';
import type { TranscriptSegment, GeneratorCandidate } from '../../lib/types';
import { DEFAULT_GENERATOR_CONFIGS } from '../../lib/multi-generator/types';
import type { GeneratorConfig, GeneratorResult } from '../../lib/multi-generator/types';

// ─── Config ──────────────────────────────────────────────────────────────

const HOOK_CONFIG: GeneratorConfig = { ...DEFAULT_GENERATOR_CONFIGS.hook, maxRawCandidates: 15, localTopK: 5 };
const INSIGHT_CONFIG: GeneratorConfig = { ...DEFAULT_GENERATOR_CONFIGS.insight, maxRawCandidates: 15, localTopK: 5 };

interface ProjectData {
  name: string;
  videoId: string;
  transcriptPath: string;
}

const PROJECTS: ProjectData[] = [
  { name: 'Raditya Dika', videoId: 'lqeDF5JwYvM', transcriptPath: '/tmp/raditya_dika_transcript.json' },
  { name: 'Tom Lembong', videoId: 'lpQrUTWXHZU', transcriptPath: '/tmp/tom_lembong_transcript.json' },
  { name: 'Fajar Sadboy', videoId: 'FN283CT4rgg', transcriptPath: '/tmp/fajar_sadboy_transcript.json' },
];

// ─── Helpers ─────────────────────────────────────────────────────────────

function loadTranscript(path: string): TranscriptSegment[] {
  if (!existsSync(path)) return [];
  const raw = JSON.parse(readFileSync(path, 'utf-8'));
  return raw.map((s: any) => ({ start: s.start ?? s.startTime ?? 0, duration: s.duration ?? 1, text: s.text ?? '' }));
}

function fmtSec(sec: number): string { const m = Math.floor(sec / 60); const s = Math.floor(sec % 60); return `${m}:${String(s).padStart(2, '0')}`; }

function computeOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  const intersection = Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
  const union = (aEnd - aStart) + (bEnd - bStart) - intersection;
  return union > 0 ? intersection / union : 0;
}

// ─── Benchmark ───────────────────────────────────────────────────────────

async function runBenchmark(): Promise<void> {
  const hookGen = new HookGenerator();
  const insightGen = new InsightGenerator();

  const md: string[] = [];
  md.push('# Phase 2.3 — Insight Generator Benchmark');
  md.push(`**Date:** ${new Date().toISOString().slice(0, 10)}`);
  md.push('**Comparison:** Insight First (B) vs Hook First (A)');
  md.push('');
  md.push('---');
  md.push('');

  let totalHookCandidates = 0;
  let totalInsightCandidates = 0;
  let totalHookTop5 = 0;
  let totalInsightTop5 = 0;

  for (const project of PROJECTS) {
    md.push(`## ${project.name} (\`${project.videoId}\`)`);
    md.push('');

    const transcript = loadTranscript(project.transcriptPath);
    if (transcript.length === 0) {
      md.push('⚠ No transcript — skipped.');
      md.push('');
      continue;
    }

    // Run both generators
    const hookResult = await hookGen.generate(transcript, project.videoId, HOOK_CONFIG);
    const insightResult = await insightGen.generate(transcript, project.videoId, INSIGHT_CONFIG);

    totalHookCandidates += hookResult.rawCount;
    totalInsightCandidates += insightResult.rawCount;
    totalHookTop5 += hookResult.topCandidates.length;
    totalInsightTop5 += insightResult.topCandidates.length;

    // ── Output Summary ──────────────────────────────────────────────

    md.push('### Generator Output Summary');
    md.push('');
    md.push('| Metric | Hook (A) | Insight (B) |');
    md.push('|--------|----------|-------------|');
    md.push(`| Raw candidates | ${hookResult.rawCount} | ${insightResult.rawCount} |`);
    md.push(`| Capped (maxRaw) | ${hookResult.allCandidates.length} | ${insightResult.allCandidates.length} |`);
    md.push(`| Top K (local) | ${hookResult.topCandidates.length} | ${insightResult.topCandidates.length} |`);
    md.push(`| Generation time | ${hookResult.durationMs}ms | ${insightResult.durationMs}ms |`);
    md.push('');

    // ── Hook Top 5 ──────────────────────────────────────────────────

    md.push('### Hook Generator (A) — Top 5');
    md.push('');
    md.push('| # | ID | Time | Score | Signals |');
    md.push('|---|----|------|-------|---------|');
    for (let i = 0; i < hookResult.topCandidates.length; i++) {
      const c = hookResult.topCandidates[i];
      const excerpt = c.transcriptExcerpt.slice(0, 80).replace(/\|/g, '-');
      md.push(`| ${i+1} | \`${c.candidateId}\` | ${fmtSec(c.startTime)}-${fmtSec(c.endTime)} | ${c.metadata.internalScore} | ${c.metadata.triggerSignals.slice(0,3).join(', ')} |`);
    }
    md.push('');

    // ── Insight Top 5 ───────────────────────────────────────────────

    md.push('### Insight Generator (B) — Top 5');
    md.push('');
    md.push('| # | ID | Time | Score | Signals |');
    md.push('|---|----|------|-------|---------|');
    for (let i = 0; i < insightResult.topCandidates.length; i++) {
      const c = insightResult.topCandidates[i];
      md.push(`| ${i+1} | \`${c.candidateId}\` | ${fmtSec(c.startTime)}-${fmtSec(c.endTime)} | ${c.metadata.internalScore} | ${c.metadata.triggerSignals.slice(0,3).join(', ')} |`);
    }
    md.push('');

    // ── Overlap Analysis ────────────────────────────────────────────

    md.push('### Hook vs Insight Overlap');
    md.push('');
    md.push('**Per-candidate overlap (Insight Top 5 vs Hook Top 5):**');
    md.push('');
    md.push('| Insight Candidate | Hook Best Match | Time Ovl | Tx Ovl | Composite | Overlap? |');
    md.push('|-------------------|-----------------|----------|--------|-----------|----------|');

    let insightHits = 0;  // overlap >30%
    for (const ic of insightResult.topCandidates) {
      let bestOverlap = 0;
      let bestHook: GeneratorCandidate | null = null;
      for (const hc of hookResult.topCandidates) {
        const ov = computeOverlap(ic.startTime, ic.endTime, hc.startTime, hc.endTime);
        if (ov > bestOverlap) {
          bestOverlap = ov;
          bestHook = hc;
        }
      }
      const overlapped = bestOverlap > 0.3;
      if (overlapped) insightHits++;
      md.push(`| \`${ic.candidateId}\` @ ${fmtSec(ic.startTime)} | \`${bestHook?.candidateId || '—'}\` @ ${bestHook ? fmtSec(bestHook.startTime) : '—'} | ${(bestOverlap).toFixed(3)} | ${bestHook ? bestOverlap.toFixed(3) : '—'} | ${bestOverlap.toFixed(3)} | ${overlapped ? '⚠ YES' : '✅ no'} |`);
    }
    md.push('');

    const hookOverlapPct = insightResult.topCandidates.length > 0
      ? ((insightHits / insightResult.topCandidates.length) * 100).toFixed(0)
      : 'N/A';
    md.push(`**Overlap rate:** ${insightHits}/${insightResult.topCandidates.length} Insight clips overlap with Hook Top 5 (${hookOverlapPct}%)`);
    md.push('');

    // ── New Discoveries ─────────────────────────────────────────────

    md.push('### New Discoveries (vs Hook All Candidates)');
    md.push('');
    md.push('Insight clips that Hook completely misses (no overlap with ANY Hook candidate):');
    md.push('');

    let newDiscoveries = 0;
    md.push('| # | ID | Time | Score | Signals |');
    md.push('|---|----|------|-------|---------|');
    for (const ic of insightResult.topCandidates) {
      let maxHookOverlap = 0;
      for (const hc of hookResult.allCandidates) {
        const ov = computeOverlap(ic.startTime, ic.endTime, hc.startTime, hc.endTime);
        if (ov > maxHookOverlap) maxHookOverlap = ov;
      }
      if (maxHookOverlap < 0.3) {
        newDiscoveries++;
        md.push(`| ${newDiscoveries} | \`${ic.candidateId}\` | ${fmtSec(ic.startTime)}-${fmtSec(ic.endTime)} | ${ic.metadata.internalScore} | ${ic.metadata.triggerSignals.slice(0,3).join(', ')} |`);
      }
    }
    if (newDiscoveries === 0) {
      md.push('| — | No new discoveries — all Insight clips overlap with Hook candidates |');
    }
    md.push('');
    md.push(`**New discoveries:** ${newDiscoveries}/${insightResult.topCandidates.length} (${((newDiscoveries / insightResult.topCandidates.length) * 100).toFixed(0)}%)`);
    md.push('');

    // ── Candidate Pool Contribution ─────────────────────────────────

    md.push('### Combined Pool Analysis');
    md.push('');

    // Build combined pool
    const combined = [...hookResult.topCandidates, ...insightResult.topCandidates];
    // Dedup by time overlap > 50%
    const deduped: GeneratorCandidate[] = [];
    const dropped: string[] = [];
    for (const c of combined) {
      let duplicate = false;
      for (const d of deduped) {
        const ov = computeOverlap(c.startTime, c.endTime, d.startTime, d.endTime);
        if (ov > 0.5) {
          duplicate = true;
          dropped.push(c.candidateId);
          break;
        }
      }
      if (!duplicate) deduped.push(c);
    }

    md.push('| Generator | Raw Top K | Surviving Dedup | % of Pool |');
    md.push('|-----------|-----------|-----------------|-----------|');
    const hookInPool = deduped.filter(c => c.generator === 'hook').length;
    const insightInPool = deduped.filter(c => c.generator === 'insight').length;
    md.push(`| Hook (A) | ${hookResult.topCandidates.length} | ${hookInPool} | ${((hookInPool / deduped.length) * 100).toFixed(0)}% |`);
    md.push(`| Insight (B) | ${insightResult.topCandidates.length} | ${insightInPool} | ${((insightInPool / deduped.length) * 100).toFixed(0)}% |`);
    md.push(`| **Total** | **${combined.length}** | **${deduped.length}** | **100%** |`);
    md.push('');
    md.push(`Dropped by dedup: ${dropped.join(', ') || 'none'}`);
    md.push('');

    // ── Failure Analysis ────────────────────────────────────────────

    md.push('### Failure Analysis');
    md.push('');

    // Score distribution
    const iScores = insightResult.allCandidates.map(c => c.metadata.internalScore);
    const iMean = iScores.length > 0 ? (iScores.reduce((a, b) => a + b, 0) / iScores.length) : 0;
    const iZeroCount = iScores.filter(s => s === 0).length;
    const iMax = Math.max(...iScores);
    const iMin = Math.min(...iScores);

    md.push('| Metric | Insight | Hook (ref) |');
    md.push('|--------|---------|------------|');
    const hScores = hookResult.allCandidates.map(c => c.metadata.internalScore);
    const hMean = hScores.length > 0 ? (hScores.reduce((a, b) => a + b, 0) / hScores.length) : 0;
    const hZeroCount = hScores.filter(s => s === 0).length;
    md.push(`| Score range | ${iMin}-${iMax} | ${Math.min(...hScores)}-${Math.max(...hScores)} |`);
    md.push(`| Mean score | ${iMean.toFixed(1)} | ${hMean.toFixed(1)} |`);
    md.push(`| Score=0 count | ${iZeroCount} | ${hZeroCount} |`);
    md.push(`| Zero-candidate windows? | ${insightResult.rawCount === 0 ? '⚠ YES' : '✅ no'} | ${hookResult.rawCount === 0 ? '⚠ YES' : '✅ no'} |`);
    md.push('');

    // Top-5 excerpt sampling
    md.push('**Top Insight excerpt (opening 100 chars):**');
    md.push('');
    for (let i = 0; i < Math.min(3, insightResult.topCandidates.length); i++) {
      const c = insightResult.topCandidates[i];
      const ex = c.transcriptExcerpt.slice(0, 120).replace(/\n/g, ' ');
      md.push(`- #${i+1} (score=${c.metadata.internalScore}, ${c.metadata.triggerSignals.slice(0,3).join('+')}): "${ex}..."`);
    }
    md.push('');

    // ── Verdict ─────────────────────────────────────────────────────

    md.push('### Project Verdict');
    md.push('');

    const passOverlap = insightHits / insightResult.topCandidates.length < 0.4;
    const passNovelty = newDiscoveries / insightResult.topCandidates.length >= 0.6;

    md.push('| Criterion | Threshold | Result | Status |');
    md.push('|-----------|-----------|--------|--------|');
    md.push(`| Hook overlap | <40% | ${hookOverlapPct}% | ${passOverlap ? '✅ PASS' : '❌ FAIL'} |`);
    md.push(`| New discoveries | ≥60% | ${((newDiscoveries / insightResult.topCandidates.length) * 100).toFixed(0)}% | ${passNovelty ? '✅ PASS' : '❌ FAIL'} |`);

    if (passOverlap && passNovelty) {
      md.push('| **Overall** | | | **✅ PASS** |');
    } else {
      md.push('| **Overall** | | | **❌ FAIL** — review before Phase 2.4 |');
    }
    md.push('');
    md.push('---');
    md.push('');
  }

  // ── Global Summary ─────────────────────────────────────────────────

  md.push('## Global Summary');
  md.push('');
  md.push('| Metric | Hook (A) | Insight (B) | Combined Pool |');
  md.push('|--------|----------|-------------|---------------|');
  md.push(`| Total raw candidates | ${totalHookCandidates} | ${totalInsightCandidates} | ${totalHookCandidates + totalInsightCandidates} |`);
  md.push(`| Top K total | ${totalHookTop5} | ${totalInsightTop5} | ${totalHookTop5 + totalInsightTop5} |`);
  md.push('');
  md.push('**Phase 2.3 Gate Decision:**');
  md.push('');
  md.push('See per-project results above. Insight Generator must demonstrate:');
  md.push('- [ ] Hook overlap < 40%');
  md.push('- [ ] ≥ 60% new discoveries (vs Hook)');
  md.push('- [ ] Distinct candidate profile from Hook Generator');
  md.push('');
  md.push(`*Generated by insight-benchmark.ts at ${new Date().toISOString()}*`);

  // ── Write Report ──────────────────────────────────────────────────

  const reportPath = '/root/GANYIQ/documents/phase2-3-insight-benchmark.md';
  writeFileSync(reportPath, md.join('\n'), 'utf-8');
  console.log(`Benchmark report written to ${reportPath}`);

  // ── Print Summary to Console ──────────────────────────────────────

  console.log('\n=== PHASE 2.3 BENCHMARK SUMMARY ===\n');
  for (const project of PROJECTS) {
    const transcript = loadTranscript(project.transcriptPath);
    if (transcript.length === 0) continue;

    const hookResult = await hookGen.generate(transcript, project.videoId, HOOK_CONFIG);
    const insightResult = await insightGen.generate(transcript, project.videoId, INSIGHT_CONFIG);

    // Compute overlap
    let insightHits = 0;
    for (const ic of insightResult.topCandidates) {
      for (const hc of hookResult.topCandidates) {
        const ov = computeOverlap(ic.startTime, ic.endTime, hc.startTime, hc.endTime);
        if (ov > 0.3) { insightHits++; break; }
      }
    }

    let newDiscoveries = 0;
    for (const ic of insightResult.topCandidates) {
      let maxOv = 0;
      for (const hc of hookResult.allCandidates) {
        maxOv = Math.max(maxOv, computeOverlap(ic.startTime, ic.endTime, hc.startTime, hc.endTime));
      }
      if (maxOv < 0.3) newDiscoveries++;
    }

    const overlapPct = insightResult.topCandidates.length > 0
      ? (insightHits / insightResult.topCandidates.length * 100).toFixed(0)
      : 'N/A';
    const noveltyPct = insightResult.topCandidates.length > 0
      ? (newDiscoveries / insightResult.topCandidates.length * 100).toFixed(0)
      : 'N/A';

    console.log(`--- ${project.name} ---`);
    console.log(`  Hook raw: ${hookResult.rawCount}, Insight raw: ${insightResult.rawCount}`);
    console.log(`  Hook overlap: ${overlapPct}% (target <40%)`);
    console.log(`  New discoveries: ${noveltyPct}% (target ≥60%)`);

    if (insightResult.topCandidates.length > 0) {
      console.log(`  Insight top-5 scores: ${insightResult.topCandidates.map(c => c.metadata.internalScore).join(', ')}`);
      console.log(`  Insight signals: ${insightResult.topCandidates.map(c => c.metadata.triggerSignals.slice(0,2).join('/')).join(', ')}`);
    }

    // Show top insight candidate
    const topI = insightResult.topCandidates[0];
    if (topI) {
      console.log(`  Top insight: @${fmtSec(topI.startTime)}-${fmtSec(topI.endTime)} score=${topI.metadata.internalScore}`);
      console.log(`    "${topI.transcriptExcerpt.slice(0, 100)}..."`);
    }
    console.log('');
  }

  console.log('=== SUCCESS CRITERIA CHECK ===');
  // Read the report for final verdict
  console.log('See full report for per-project verdicts.');
}

runBenchmark().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
