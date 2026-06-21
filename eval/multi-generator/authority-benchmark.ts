// ============================================================================
// eval/multi-generator/authority-benchmark.ts — Phase 2.5 Authority Benchmark
// ============================================================================
//
// Runs all 4 generators on 3 projects. Cross-reference analysis.
//
// Run: npx tsx eval/multi-generator/authority-benchmark.ts
// ============================================================================

import { readFileSync, existsSync, writeFileSync } from 'fs';
import { HookGenerator } from '../../lib/multi-generator/hook-generator';
import { InsightGenerator } from '../../lib/multi-generator/insight-generator';
import { EmotionGenerator } from '../../lib/multi-generator/emotion-generator';
import { AuthorityGenerator } from '../../lib/multi-generator/authority-generator';
import type { TranscriptSegment, GeneratorCandidate } from '../../lib/types';
import { DEFAULT_GENERATOR_CONFIGS } from '../../lib/multi-generator/types';
import type { GeneratorConfig, GeneratorResult } from '../../lib/multi-generator/types';

const BASE_CONFIG = { maxRawCandidates: 15, localTopK: 5, minDuration: 15, maxDuration: 60, allowOverlap: false };

const PROJECTS = [
  { name: 'Raditya Dika', videoId: 'lqeDF5JwYvM', path: '/tmp/raditya_dika_transcript.json' },
  { name: 'Tom Lembong', videoId: 'lpQrUTWXHZU', path: '/tmp/tom_lembong_transcript.json' },
  { name: 'Fajar Sadboy', videoId: 'FN283CT4rgg', path: '/tmp/fajar_sadboy_transcript.json' },
];

function loadTranscript(path: string): TranscriptSegment[] {
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, 'utf-8')).map((s: any) => ({ start: s.start ?? 0, duration: s.duration ?? 1, text: s.text ?? '' }));
}

function fmtSec(sec: number): string { const m = Math.floor(sec / 60); const s = Math.floor(sec % 60); return `${m}:${String(s).padStart(2, '0')}`; }

function overlap(a: number, ae: number, b: number, be: number): number {
  const i = Math.max(0, Math.min(ae, be) - Math.max(a, b));
  const md = Math.min(ae - a, be - b);
  return md > 0 ? i / md : 0;
}

async function run(): Promise<void> {
  const gens = [new HookGenerator(), new InsightGenerator(), new EmotionGenerator(), new AuthorityGenerator()];
  const genLabels = ['Hook (A)', 'Insight (B)', 'Emotion (C)', 'Authority (D)'];

  const md: string[] = [];
  md.push('# Phase 2.5 — Authority Generator Benchmark');
  md.push('**Date:** 2026-06-16');
  md.push('**Comparison:** Authority (D) vs Hook (A), Insight (B), Emotion (C)');
  md.push('');
  md.push('---\n');

  for (const proj of PROJECTS) {
    const transcript = loadTranscript(proj.path);
    md.push(`## ${proj.name} (\`${proj.videoId}\`)`);
    if (!transcript.length) { md.push('⚠ No transcript.\n---\n'); continue; }

    const results = await Promise.all(gens.map(g => g.generate(transcript, proj.videoId, { ...BASE_CONFIG, strategy: g.strategy, } as GeneratorConfig)));

    // Output summary
    md.push('\n### Output Summary\n');
    md.push('| Metric | ' + genLabels.join(' | ') + ' |');
    md.push('|--------|' + genLabels.map(() => '---|').join(''));
    for (let i = 0; i < genLabels.length; i++) {
      if (i === 0) md.push(`| Raw candidates | ${results.map(r => r.rawCount).join(' | ')} |`);
    }
    md.push(`| Capped | ${results.map(r => r.allCandidates.length).join(' | ')} |`);
    md.push(`| Top K | ${results.map(r => r.topCandidates.length).join(' | ')} |`);
    md.push(`| Time | ${results.map(r => r.durationMs + 'ms').join(' | ')} |`);
    md.push('');

    // Authority Top 5
    const authResult = results[3];
    md.push('### Authority Generator (D) — Top 5\n');
    md.push('| # | ID | Time | Score | Authority Signals |');
    md.push('|---|----|------|-------|------------------|');
    for (let i = 0; i < authResult.topCandidates.length; i++) {
      const c = authResult.topCandidates[i];
      md.push(`| ${i+1} | \`${c.candidateId}\` | ${fmtSec(c.startTime)}-${fmtSec(c.endTime)} | ${c.metadata.internalScore} | ${c.metadata.triggerSignals.slice(0,4).join(', ')} |`);
    }
    md.push('');

    // Overlap: Authority vs each other generator
    md.push('### Cross-Generator Overlap (Authority Top 5)\n');
    md.push('| Vs Generator | Overlap | Candidates affected |');
    md.push('|--------------|---------|---------------------|');

    const overlapData: { label: string; hits: number; pct: string; details: string[] }[] = [];

    for (let gIdx = 0; gIdx < 3; gIdx++) {
      let hits = 0;
      const details: string[] = [];
      for (const ac of authResult.topCandidates) {
        for (const oc of results[gIdx].topCandidates) {
          if (overlap(ac.startTime, ac.endTime, oc.startTime, oc.endTime) > 0.3) {
            hits++;
            details.push(`\`${ac.candidateId}\` ↔ \`${oc.candidateId}\``);
            break;
          }
        }
      }
      const pct = authResult.topCandidates.length > 0 ? ((hits / authResult.topCandidates.length) * 100).toFixed(0) : 'N/A';
      md.push(`| ${genLabels[gIdx]} | ${pct}% | ${details.join(', ') || 'none'} |`);
      overlapData.push({ label: genLabels[gIdx], hits, pct, details });
    }
    md.push('');

    // New discoveries vs all 3 combined
    md.push('### New Discoveries (vs A+B+C Combined)\n');
    const combined = [...results[0].allCandidates, ...results[1].allCandidates, ...results[2].allCandidates];
    let newD = 0;
    const newDetails: string[] = [];
    for (const ac of authResult.topCandidates) {
      let maxOv = 0;
      for (const oc of combined) {
        maxOv = Math.max(maxOv, overlap(ac.startTime, ac.endTime, oc.startTime, oc.endTime));
      }
      if (maxOv < 0.3) {
        newD++;
        newDetails.push(`\`${ac.candidateId}\` @ ${fmtSec(ac.startTime)} sig=${ac.metadata.triggerSignals.slice(0,3).join('/')}`);
      }
    }
    const newPct = authResult.topCandidates.length > 0 ? ((newD / authResult.topCandidates.length) * 100).toFixed(0) : 'N/A';
    md.push(`**New discoveries:** ${newD}/${authResult.topCandidates.length} (${newPct}%)`);
    for (const d of newDetails) md.push(`- ${d}`);
    md.push('');

    // Combined pool (all 4)
    md.push('### Combined Pool (A+B+C+D)\n');
    const all = results.flatMap(r => r.topCandidates);
    const deduped: GeneratorCandidate[] = [];
    for (const c of all) {
      if (!deduped.some(d => overlap(c.startTime, c.endTime, d.startTime, d.endTime) > 0.5)) deduped.push(c);
    }
    md.push('| Generator | Top K | In Pool | % |');
    md.push('|-----------|-------|---------|---|');
    for (let i = 0; i < 4; i++) {
      const count = deduped.filter(d => d.candidateId.startsWith(results[i].topCandidates[0]?.candidateId?.split('_')[0] || '')).length;
      // Better: count by checking if any of the generator's candidates are in the pool
      const inPool = deduped.filter(d => results[i].topCandidates.some(tc => tc.candidateId === d.candidateId)).length;
      md.push(`| ${genLabels[i]} | ${results[i].topCandidates.length} | ${inPool} | ${((inPool/deduped.length)*100).toFixed(0)}% |`);
    }
    md.push(`| **Total** | **${all.length}** | **${deduped.length}** | **100%** |\n`);

    // Authority signal breakdown
    md.push('### Authority Signal Breakdown (All Candidates)\n');
    const sigCounts: Record<string, number> = {};
    for (const c of authResult.allCandidates) {
      for (const s of c.metadata.triggerSignals) sigCounts[s] = (sigCounts[s] || 0) + 1;
    }
    md.push('| Signal | Count |');
    md.push('|--------|-------|');
    for (const [k, v] of Object.entries(sigCounts).sort((a, b) => b[1] - a[1])) md.push(`| ${k} | ${v} |`);
    md.push('');

    // Verdict
    md.push('### Project Verdict\n');
    const oHook = parseInt(overlapData[0].pct);
    const oInsight = parseInt(overlapData[1].pct);
    const oEmotion = parseInt(overlapData[2].pct);
    const nPct = parseInt(newPct);

    const passHook = oHook < 30;
    const passEmotion = oEmotion < 20;
    const passInsight = oInsight < 50;
    const passNew = nPct >= 50;
    const passAll = passHook && passEmotion && passInsight && passNew && authResult.rawCount > 0;

    md.push('| Criterion | Threshold | Result | |');
    md.push('|-----------|-----------|--------|---|');
    md.push(`| Hook overlap | <30% | ${oHook}% | ${passHook ? '✅' : '❌'} |`);
    md.push(`| Emotion overlap | <20% | ${oEmotion}% | ${passEmotion ? '✅' : '❌'} |`);
    md.push(`| Insight overlap | <50% | ${oInsight}% | ${passInsight ? '✅' : '❌'} |`);
    md.push(`| New discoveries | ≥50% | ${nPct}% | ${passNew ? '✅' : '❌'} |`);
    md.push(`| Zero candidates? | — | ${authResult.rawCount === 0 ? '⚠' : '✅'} | — |`);
    md.push(`| **Overall** | | | **${passAll ? '✅ PASS' : '❌ FAIL'}** |\n`);
    md.push('---\n');
  }

  md.push('## Global Summary\n');
  md.push(`*Generated by authority-benchmark.ts at ${new Date().toISOString()}*`);

  writeFileSync('/root/GANYIQ/documents/phase2-5-authority-benchmark.md', md.join('\n'), 'utf-8');
  console.log('Report written.');

  // Console summary
  console.log('\n=== PHASE 2.5 BENCHMARK ===\n');
  for (const proj of PROJECTS) {
    const t = loadTranscript(proj.path);
    if (!t.length) continue;
    const r = await Promise.all(gens.map(g => g.generate(t, proj.videoId, { ...BASE_CONFIG, strategy: g.strategy } as GeneratorConfig)));
    const auth = r[3];
    const combined = [...r[0].allCandidates, ...r[1].allCandidates, ...r[2].allCandidates];
    
    let oH = 0, oI = 0, oE = 0;
    for (const ac of auth.topCandidates) {
      if (r[0].topCandidates.some(oc => overlap(ac.startTime, ac.endTime, oc.startTime, oc.endTime) > 0.3)) oH++;
      if (r[1].topCandidates.some(oc => overlap(ac.startTime, ac.endTime, oc.startTime, oc.endTime) > 0.3)) oI++;
      if (r[2].topCandidates.some(oc => overlap(ac.startTime, ac.endTime, oc.startTime, oc.endTime) > 0.3)) oE++;
    }
    let nD = 0;
    for (const ac of auth.topCandidates) {
      if (!combined.some(oc => overlap(ac.startTime, ac.endTime, oc.startTime, oc.endTime) > 0.3)) nD++;
    }

    const t5 = auth.topCandidates.length;
    console.log(`--- ${proj.name} ---`);
    console.log(`  Authority raw: ${auth.rawCount}`);
    console.log(`  Top-5 scores: ${auth.topCandidates.map(c => c.metadata.internalScore).join(', ')}`);
    console.log(`  Vs Hook: ${t5 > 0 ? ((oH/t5)*100).toFixed(0) : 'N/A'}% (target <30%)`);
    console.log(`  Vs Emotion: ${t5 > 0 ? ((oE/t5)*100).toFixed(0) : 'N/A'}% (target <20%)`);
    console.log(`  Vs Insight: ${t5 > 0 ? ((oI/t5)*100).toFixed(0) : 'N/A'}% (target <50%)`);
    console.log(`  New discoveries: ${t5 > 0 ? ((nD/t5)*100).toFixed(0) : 'N/A'}% (target ≥50%)`);
    if (auth.topCandidates[0]) {
      const c = auth.topCandidates[0];
      console.log(`  Top: ${c.candidateId} @ ${fmtSec(c.startTime)} sig=${c.metadata.triggerSignals.slice(0,3).join('/')}`);
    }
    console.log('');
  }
}

run().catch(err => { console.error('FAILED:', err); process.exit(1); });
