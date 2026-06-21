// ============================================================================
// eval/multi-generator/emotion-benchmark.ts — Phase 2.4 Emotion First Benchmark
// ============================================================================
//
// Runs all 3 generators (Hook, Insight, Emotion) on 3 projects.
// Reports per-project comparison and cross-generator overlap.
//
// Run: npx tsx eval/multi-generator/emotion-benchmark.ts
// ============================================================================

import { readFileSync, existsSync, writeFileSync } from 'fs';
import { HookGenerator } from '../../lib/multi-generator/hook-generator';
import { InsightGenerator } from '../../lib/multi-generator/insight-generator';
import { EmotionGenerator } from '../../lib/multi-generator/emotion-generator';
import type { TranscriptSegment, GeneratorCandidate } from '../../lib/types';
import { DEFAULT_GENERATOR_CONFIGS } from '../../lib/multi-generator/types';
import type { GeneratorConfig, GeneratorResult } from '../../lib/multi-generator/types';

const HOOK_CONFIG: GeneratorConfig = { ...DEFAULT_GENERATOR_CONFIGS.hook, maxRawCandidates: 15, localTopK: 5 };
const INSIGHT_CONFIG: GeneratorConfig = { ...DEFAULT_GENERATOR_CONFIGS.insight, maxRawCandidates: 15, localTopK: 5 };
const EMOTION_CONFIG: GeneratorConfig = { ...DEFAULT_GENERATOR_CONFIGS.emotion, maxRawCandidates: 15, localTopK: 5 };

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

function loadTranscript(path: string): TranscriptSegment[] {
  if (!existsSync(path)) return [];
  const raw = JSON.parse(readFileSync(path, 'utf-8'));
  return raw.map((s: any) => ({ start: s.start ?? s.startTime ?? 0, duration: s.duration ?? 1, text: s.text ?? '' }));
}

function fmtSec(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function computeTimeOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  const intersection = Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
  const aDur = aEnd - aStart;
  const bDur = bEnd - bStart;
  const minDur = Math.min(aDur, bDur);
  return minDur > 0 ? intersection / minDur : 0;
}

async function runBenchmark(): Promise<void> {
  const hookGen = new HookGenerator();
  const insightGen = new InsightGenerator();
  const emotionGen = new EmotionGenerator();

  const md: string[] = [];
  md.push('# Phase 2.4 — Emotion Generator Benchmark');
  md.push(`**Date:** ${new Date().toISOString().slice(0, 10)}`);
  md.push('**Comparison:** Emotion (C) vs Hook (A) vs Insight (B)');
  md.push('');
  md.push('---');
  md.push('');

  for (const project of PROJECTS) {
    md.push(`## ${project.name} (\`${project.videoId}\`)`);
    md.push('');

    const transcript = loadTranscript(project.transcriptPath);
    if (transcript.length === 0) {
      md.push('⚠ No transcript — skipped.');
      md.push('');
      continue;
    }

    const hookResult = await hookGen.generate(transcript, project.videoId, HOOK_CONFIG);
    const insightResult = await insightGen.generate(transcript, project.videoId, INSIGHT_CONFIG);
    const emotionResult = await emotionGen.generate(transcript, project.videoId, EMOTION_CONFIG);

    // ── Output Summary ──────────────────────────────────────────────

    md.push('### Generator Output Summary');
    md.push('');
    md.push('| Metric | Hook (A) | Insight (B) | Emotion (C) |');
    md.push('|--------|----------|-------------|-------------|');
    md.push(`| Raw candidates | ${hookResult.rawCount} | ${insightResult.rawCount} | ${emotionResult.rawCount} |`);
    md.push(`| Capped | ${hookResult.allCandidates.length} | ${insightResult.allCandidates.length} | ${emotionResult.allCandidates.length} |`);
    md.push(`| Top K | ${hookResult.topCandidates.length} | ${insightResult.topCandidates.length} | ${emotionResult.topCandidates.length} |`);
    md.push(`| Time | ${hookResult.durationMs}ms | ${insightResult.durationMs}ms | ${emotionResult.durationMs}ms |`);
    md.push('');

    // ── Emotion Top 5 ───────────────────────────────────────────────

    md.push('### Emotion Generator (C) — Top 5');
    md.push('');
    md.push('| # | ID | Time | Score | Emotional Signals |');
    md.push('|---|----|------|-------|-------------------|');
    for (let i = 0; i < emotionResult.topCandidates.length; i++) {
      const c = emotionResult.topCandidates[i];
      md.push(`| ${i+1} | \`${c.candidateId}\` | ${fmtSec(c.startTime)}-${fmtSec(c.endTime)} | ${c.metadata.internalScore} | ${c.metadata.triggerSignals.slice(0,4).join(', ')} |`);
    }
    md.push('');

    // ── Overlap Analysis ────────────────────────────────────────────

    md.push('### Overlap Analysis');
    md.push('');

    // For each cross-generator pair
    const pairs: Array<{ label: string; a: GeneratorResult; b: GeneratorResult }> = [
      { label: 'Emotion vs Hook', a: emotionResult, b: hookResult },
      { label: 'Emotion vs Insight', a: emotionResult, b: insightResult },
    ];

    for (const pair of pairs) {
      let hits = 0;
      md.push(`**${pair.label} (Top 5):**`);
      md.push('');
      md.push('| Emotion Candidate | Best Match | Time Overlap | Overlap? |');
      md.push('|------------------|------------|-------------|----------|');
      for (const ec of pair.a.topCandidates) {
        let bestOv = 0;
        let bestMatch = '';
        for (const bc of pair.b.topCandidates) {
          const ov = computeTimeOverlap(ec.startTime, ec.endTime, bc.startTime, bc.endTime);
          if (ov > bestOv) { bestOv = ov; bestMatch = `${bc.candidateId} @ ${fmtSec(bc.startTime)}`; }
        }
        const overlapped = bestOv > 0.3;
        if (overlapped) hits++;
        md.push(`| \`${ec.candidateId}\` @ ${fmtSec(ec.startTime)} | ${bestMatch || '—'} | ${bestOv.toFixed(3)} | ${overlapped ? '⚠ YES' : '✅ no'} |`);
      }
      const pct = pair.a.topCandidates.length > 0 ? ((hits / pair.a.topCandidates.length) * 100).toFixed(0) : 'N/A';
      md.push(`| **Total** | | **${hits}/${pair.a.topCandidates.length}** | **${pct}%** |`);
      md.push('');
    }

    // ── New Discoveries ─────────────────────────────────────────────

    md.push('### New Discoveries (Emotion vs Hook + Insight Combined)');
    md.push('');
    md.push('Emotion clips that neither Hook nor Insight find (>30% overlap):');
    md.push('');

    let newD = 0;
    const allHookInsight = [...hookResult.allCandidates, ...insightResult.allCandidates];
    for (const ec of emotionResult.topCandidates) {
      let maxOv = 0;
      for (const hi of allHookInsight) {
        maxOv = Math.max(maxOv, computeTimeOverlap(ec.startTime, ec.endTime, hi.startTime, hi.endTime));
      }
      if (maxOv < 0.3) newD++;
    }
    const newPct = emotionResult.topCandidates.length > 0 ? ((newD / emotionResult.topCandidates.length) * 100).toFixed(0) : 'N/A';
    md.push(`**New discoveries:** ${newD}/${emotionResult.topCandidates.length} (${newPct}%)`);
    md.push('');

    // ── Combined Pool ───────────────────────────────────────────────

    md.push('### Combined Pool (3 Generators)');
    md.push('');

    const all = [...hookResult.topCandidates, ...insightResult.topCandidates, ...emotionResult.topCandidates];
    const deduped: GeneratorCandidate[] = [];
    const dropped: string[] = [];
    for (const c of all) {
      let dup = false;
      for (const d of deduped) {
        if (computeTimeOverlap(c.startTime, c.endTime, d.startTime, d.endTime) > 0.5) {
          dup = true;
          dropped.push(c.candidateId);
          break;
        }
      }
      if (!dup) deduped.push(c);
    }

    const hInPool = deduped.filter(c => c.generator === 'hook').length;
    const iInPool = deduped.filter(c => c.generator === 'insight').length;
    const eInPool = deduped.filter(c => c.generator === 'emotion').length;

    md.push('| Generator | Top K | Surviving Dedup | % of Pool |');
    md.push('|-----------|-------|-----------------|-----------|');
    md.push(`| Hook (A) | ${hookResult.topCandidates.length} | ${hInPool} | ${((hInPool/deduped.length)*100).toFixed(0)}% |`);
    md.push(`| Insight (B) | ${insightResult.topCandidates.length} | ${iInPool} | ${((iInPool/deduped.length)*100).toFixed(0)}% |`);
    md.push(`| Emotion (C) | ${emotionResult.topCandidates.length} | ${eInPool} | ${((eInPool/deduped.length)*100).toFixed(0)}% |`);
    md.push(`| **Total** | **${all.length}** | **${deduped.length}** | **100%** |`);
    md.push('');
    md.push(`Dropped: ${dropped.join(', ') || 'none'}`);
    md.push('');

    // ── Emotional Signal Breakdown ──────────────────────────────────

    md.push('### Emotional Signal Breakdown (All Candidates)');
    md.push('');
    const signalCounts: Record<string, number> = {};
    for (const c of emotionResult.allCandidates) {
      for (const sig of c.metadata.triggerSignals) {
        signalCounts[sig] = (signalCounts[sig] || 0) + 1;
      }
    }
    const sorted = Object.entries(signalCounts).sort((a, b) => b[1] - a[1]);
    md.push('| Signal | Count |');
    md.push('|--------|-------|');
    for (const [sig, count] of sorted) {
      md.push(`| ${sig} | ${count} |`);
    }
    md.push('');

    // ── Verdict ─────────────────────────────────────────────────────

    md.push('### Project Verdict');
    md.push('');

    const eScores = emotionResult.allCandidates.map(c => c.metadata.internalScore);
    const eMean = eScores.length > 0 ? (eScores.reduce((a, b) => a + b, 0) / eScores.length) : 0;
    const eZero = eScores.filter(s => s === 0).length;

    md.push('| Check | Threshold | Result | Status |');
    md.push('|-------|-----------|--------|--------|');

    // Overlap stats
    let eVsHook = 0;
    for (const ec of emotionResult.topCandidates) {
      for (const hc of hookResult.topCandidates) {
        if (computeTimeOverlap(ec.startTime, ec.endTime, hc.startTime, hc.endTime) > 0.3) {
          eVsHook++;
          break;
        }
      }
    }
    let eVsInsight = 0;
    for (const ec of emotionResult.topCandidates) {
      for (const ic of insightResult.topCandidates) {
        if (computeTimeOverlap(ec.startTime, ec.endTime, ic.startTime, ic.endTime) > 0.3) {
          eVsInsight++;
          break;
        }
      }
    }

    const overlapHookPct = emotionResult.topCandidates.length > 0
      ? ((eVsHook / emotionResult.topCandidates.length) * 100).toFixed(0) : 'N/A';
    const overlapInsightPct = emotionResult.topCandidates.length > 0
      ? ((eVsInsight / emotionResult.topCandidates.length) * 100).toFixed(0) : 'N/A';

    md.push(`| Hook overlap <50% | <50% | ${overlapHookPct}% | ${eVsHook / emotionResult.topCandidates.length < 0.5 ? '✅' : '❌'} |`);
    md.push(`| Insight overlap <50% | <50% | ${overlapInsightPct}% | ${eVsInsight / emotionResult.topCandidates.length < 0.5 ? '✅' : '❌'} |`);
    md.push(`| New discoveries ≥60% | ≥60% | ${newPct}% | ${newD / emotionResult.topCandidates.length >= 0.6 ? '✅' : '❌'} |`);
    md.push(`| Zero-candidate? | — | ${emotionResult.rawCount === 0 ? '⚠ YES' : '✅ no'} | — |`);
    md.push(`| Mean score | — | ${eMean.toFixed(1)} | — |`);
    md.push('');

    const passHook = eVsHook / emotionResult.topCandidates.length < 0.5;
    const passInsight = eVsInsight / emotionResult.topCandidates.length < 0.5;
    const passNovelty = newD / emotionResult.topCandidates.length >= 0.6;
    const passAll = passHook && passInsight && passNovelty && emotionResult.rawCount > 0;

    md.push(`**Overall: ${passAll ? '✅ PASS' : '❌ FAIL' }**`);
    md.push('');
    md.push('---');
    md.push('');
  }

  // ── Global Summary ─────────────────────────────────────────────────

  md.push('## Global Summary');
  md.push('');
  md.push('| Metric | Hook (A) | Insight (B) | Emotion (C) | Combined |');
  md.push('|--------|----------|-------------|-------------|----------|');
  md.push('| Top K total | 15 | 15 | 15 | 45 |');
  md.push('');
  md.push('**Phase 2.4 Gate:**');
  md.push('- [ ] Hook overlap < 50%');
  md.push('- [ ] Insight overlap < 50%');
  md.push('- [ ] New discoveries (vs A+B) ≥ 60%');
  md.push('');
  md.push(`*Generated by emotion-benchmark.ts at ${new Date().toISOString()}*`);

  const reportPath = '/root/GANYIQ/documents/phase2-4-emotion-benchmark.md';
  writeFileSync(reportPath, md.join('\n'), 'utf-8');
  console.log(`Report written to ${reportPath}`);

  // ── Console Summary ───────────────────────────────────────────────

  console.log('\n=== PHASE 2.4 BENCHMARK ===\n');
  for (const project of PROJECTS) {
    const transcript = loadTranscript(project.transcriptPath);
    if (!transcript.length) continue;

    const hr = await hookGen.generate(transcript, project.videoId, HOOK_CONFIG);
    const ir = await insightGen.generate(transcript, project.videoId, INSIGHT_CONFIG);
    const er = await emotionGen.generate(transcript, project.videoId, EMOTION_CONFIG);

    let eVH = 0, eVI = 0;
    for (const ec of er.topCandidates) {
      if (hr.topCandidates.some(hc => computeTimeOverlap(ec.startTime, ec.endTime, hc.startTime, hc.endTime) > 0.3)) eVH++;
      if (ir.topCandidates.some(ic => computeTimeOverlap(ec.startTime, ec.endTime, ic.startTime, ic.endTime) > 0.3)) eVI++;
    }

    const combined = [...hr.allCandidates, ...ir.allCandidates];
    let newD = 0;
    for (const ec of er.topCandidates) {
      if (!combined.some(hi => computeTimeOverlap(ec.startTime, ec.endTime, hi.startTime, hi.endTime) > 0.3)) newD++;
    }

    console.log(`--- ${project.name} ---`);
    console.log(`  Emotion raw: ${er.rawCount}`);
    console.log(`  Emotion top-5 scores: ${er.topCandidates.map(c => c.metadata.internalScore).join(', ')}`);
    console.log(`  Vs Hook overlap: ${((eVH/er.topCandidates.length)*100).toFixed(0)}% (target <50%)`);
    console.log(`  Vs Insight overlap: ${((eVI/er.topCandidates.length)*100).toFixed(0)}% (target <50%)`);
    console.log(`  New discoveries: ${((newD/er.topCandidates.length)*100).toFixed(0)}% (target ≥60%)`);
    console.log(`  Top emotion: ${er.topCandidates[0]?.candidateId} @ ${fmtSec(er.topCandidates[0]?.startTime || 0)} sig=${er.topCandidates[0]?.metadata.triggerSignals.slice(0,3).join('/') || 'none'}`);
    console.log('');
  }
}

runBenchmark().catch(err => { console.error('Benchmark failed:', err); process.exit(1); });
