// ============================================================================
// eval/multi-generator/hook-benchmark.ts — Hook Generator Benchmark (Phase 2.2)
// ============================================================================
//
// Runs HookGenerator on 3 real transcripts:
//   1. Raditya Dika (lqeDF5JwYvM) — comedy/sketch
//   2. Tom Lembong (lpQrUTWXHZU) — political/economics talk
//   3. Fajar Sadboy (FN283CT4rgg) — comedy/podcast
//
// Output:
//   - Top 5 candidates per project with full scores
//   - Failure cases and zero-candidate segments
//   - Coverage analysis (time coverage, signal diversity)
//   - Overlap with V1 pipeline clips (where available)
//
// Run: npx tsx eval/multi-generator/hook-benchmark.ts
// ============================================================================

import { readFileSync, existsSync } from 'fs';
import { HookGenerator } from '../../lib/multi-generator/hook-generator';
import type { TranscriptSegment } from '../../lib/types';
import { DEFAULT_GENERATOR_CONFIGS } from '../../lib/multi-generator/types';
import type { GeneratorConfig } from '../../lib/multi-generator/types';

// ============================================================================
// Config
// ============================================================================

const HOOK_CONFIG: GeneratorConfig = {
  ...DEFAULT_GENERATOR_CONFIGS.hook,
  maxRawCandidates: 15,
  localTopK: 5,
};

interface ProjectData {
  name: string;
  videoId: string;
  transcriptPath: string;
  v1Path?: string;
}

const PROJECTS: ProjectData[] = [
  {
    name: 'Raditya Dika',
    videoId: 'lqeDF5JwYvM',
    transcriptPath: '/tmp/raditya_dika_transcript.json',
    v1Path: '/tmp/radit_v1_moments.json',
  },
  {
    name: 'Tom Lembong',
    videoId: 'lpQrUTWXHZU',
    transcriptPath: '/tmp/tom_lembong_transcript.json',
  },
  {
    name: 'Fajar Sadboy',
    videoId: 'FN283CT4rgg',
    transcriptPath: '/tmp/fajar_sadboy_transcript.json',
    v1Path: '/tmp/fajar_v1_moments.json',
  },
];

// ============================================================================
// Helpers
// ============================================================================

interface V1Moment {
  start: number;
  end: number;
  score: number;
  text: string;
}

function loadTranscript(path: string): TranscriptSegment[] {
  if (!existsSync(path)) {
    console.error(`  [ERROR] Transcript not found: ${path}`);
    return [];
  }
  const raw = JSON.parse(readFileSync(path, 'utf-8'));
  return raw.map((s: any, i: number) => ({
    start: s.start ?? s.startTime ?? 0,
    duration: s.duration ?? s.durationSec ?? 1,
    text: s.text ?? '',
  }));
}

function loadV1Moments(path: string): V1Moment[] {
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function fmtSec(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function computeOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  const intersection = Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
  const union = (aEnd - aStart) + (bEnd - bStart) - intersection;
  return union > 0 ? intersection / union : 0;
}

// ============================================================================
// Benchmark Runner
// ============================================================================

async function runBenchmark(): Promise<void> {
  const generator = new HookGenerator();

  console.log('HOOK GENERATOR BENCHMARK — Phase 2.2');
  console.log('=====================================\n');
  console.log(`Generator: ${generator.describe()}\n`);

  let totalRawCandidates = 0;
  let totalTopCandidates = 0;
  let projectsWithZeroCandidates = 0;

  for (const project of PROJECTS) {
    console.log(`\n${'='.repeat(70)}`);
    console.log(`  PROJECT: ${project.name} (${project.videoId})`);
    console.log(`${'='.repeat(70)}\n`);

    // Load transcript
    const transcript = loadTranscript(project.transcriptPath);
    if (transcript.length === 0) {
      console.log('  ⚠  SKIPPED — No transcript available\n');
      projectsWithZeroCandidates++;
      continue;
    }
    console.log(`  Transcript: ${transcript.length} segments, ${fmtSec(transcript[0].start)}-${fmtSec(transcript[transcript.length-1].start + transcript[transcript.length-1].duration)}`);
    console.log(`  Duration: ~${Math.round((transcript[transcript.length-1].start + transcript[transcript.length-1].duration) / 60)} min\n`);

    // Run hook generator
    const startMs = Date.now();
    const result = await generator.generate(transcript, project.videoId, HOOK_CONFIG);
    const elapsed = Date.now() - startMs;

    console.log(`  Generation: ${elapsed}ms`);
    console.log(`  Raw candidates: ${result.rawCount}`);
    console.log(`  Top K (localTopK=${result.k}): ${result.topCandidates.length}`);
    console.log(`  All candidates (capped): ${result.allCandidates.length}`);

    totalRawCandidates += result.rawCount;
    totalTopCandidates += result.topCandidates.length;

    // Failure case analysis
    console.log(`\n  ── Failure Cases ──`);

    if (result.rawCount === 0) {
      console.log(`  ⚠  NO CANDIDATES GENERATED`);
      // Show hook signal scan across transcript
      let totalHookSegments = 0;
      for (const seg of transcript) {
        const lower = seg.text.toLowerCase();
        const hasHook = ['curiosity gap', 'controversial', 'surprising', 'strong opinion', 'emotional', 'question'].some(() => {
          return Object.values({
            curiosity_gap: ['you won\'t believe', 'guess what', 'wait till', 'plot twist', 'tapi ternyata', 'tau gak', 'mau tau', 'penasaran'],
            controversial: ['hot take', 'unpopular opinion', 'controversial', 'i disagree', 'sebenarnya', 'justru', 'menurut gue', 'honestly'],
            surprising_claim: ['shocking', 'incredible', 'insane', 'game changer', 'tidak pernah', 'pertama kali', 'serius', 'mustahil'],
            strong_opinion: ['i think', 'i believe', 'in my opinion', 'menurut gue', 'gue rasa', 'sejujurnya'],
            emotional_opening: ['i remember', 'when i was', 'it changed my life', 'waktu itu', 'dulu', 'pernah', 'pengalaman', 'sedih'],
            question_driven: ['have you ever', 'what if', 'did you know', 'apa', 'siapa', 'kenapa', 'bagaimana', 'bayangkan'],
          }).some(signals => signals.some(s => lower.includes(s)));
        });
        if (hasHook) totalHookSegments++;
      }
      console.log(`  Hook signal coverage: ${totalHookSegments}/${transcript.length} segments (${(totalHookSegments/transcript.length*100).toFixed(1)}%)`);
      projectsWithZeroCandidates++;
      continue;
    }

    // Score distribution
    const scores = result.allCandidates.map(c => c.metadata.internalScore);
    const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;
    const maxScore = Math.max(...scores);
    const minScore = Math.min(...scores);
    console.log(`  Score range: ${minScore}-${maxScore} (avg: ${avgScore.toFixed(1)})`);

    // Zero/high failure cases
    const zeroScoreCandidates = result.allCandidates.filter(c => c.metadata.internalScore === 0);
    if (zeroScoreCandidates.length > 0) {
      console.log(`  ⚠  ${zeroScoreCandidates.length} candidate(s) scored 0 (all hooks penalized)`);
      for (const z of zeroScoreCandidates) {
        console.log(`      ${z.candidateId} @ ${fmtSec(z.startTime)}-${fmtSec(z.endTime)}: "${z.transcriptExcerpt.slice(0, 80)}..."`);
      }
    }

    const lowScore = result.allCandidates.filter(c => c.metadata.internalScore < 20 && c.metadata.internalScore > 0);
    if (lowScore.length > 0) {
      console.log(`  ⚠  ${lowScore.length} candidate(s) scored < 20 (weak hook)`);
    }

    // ── Top 5 Candidates ──────────────────────────────────────────────
    console.log(`\n  ── Top ${result.topCandidates.length} Candidates ──`);
    for (let i = 0; i < result.topCandidates.length; i++) {
      const c = result.topCandidates[i];
      console.log(`\n  #${i + 1}: ${c.candidateId}`);
      console.log(`     Time:     ${fmtSec(c.startTime)} - ${fmtSec(c.endTime)} (${c.durationSeconds.toFixed(1)}s)`);
      console.log(`     Score:    ${c.metadata.internalScore}/100 (${c.metadata.confidence})`);
      console.log(`     Signals:  ${c.metadata.triggerSignals.join(', ')}`);
      console.log(`     Rationale: ${c.metadata.selectionRationale}`);
      const excerpt = c.transcriptExcerpt.length > 120
        ? c.transcriptExcerpt.slice(0, 120) + '...'
        : c.transcriptExcerpt;
      console.log(`     Excerpt:  "${excerpt}"`);
    }

    // ── Coverage Analysis ─────────────────────────────────────────────
    console.log(`\n  ── Coverage Analysis ──`);

    // Time coverage
    if (result.allCandidates.length > 0) {
      const totalDuration = transcript[transcript.length - 1].start + transcript[transcript.length - 1].duration;
      const covered = new Set<number>();
      for (const c of result.allCandidates) {
        for (let t = Math.floor(c.startTime); t < Math.ceil(c.endTime); t++) {
          covered.add(t);
        }
      }
      const coveragePct = (covered.size / totalDuration) * 100;
      console.log(`  Time coverage: ${covered.size}s / ${Math.round(totalDuration)}s (${coveragePct.toFixed(1)}%)`);

      // Signal distribution
      const signalCounts: Record<string, number> = {};
      for (const c of result.allCandidates) {
        for (const sig of c.metadata.triggerSignals) {
          signalCounts[sig] = (signalCounts[sig] || 0) + 1;
        }
      }
      console.log(`  Signal distribution (${Object.keys(signalCounts).length} types):`);
      for (const [sig, count] of Object.entries(signalCounts).sort((a, b) => b[1] - a[1])) {
        console.log(`    ${sig}: ${count}`);
      }

      // Confidence distribution
      const confCounts: Record<string, number> = { high: 0, medium: 0, low: 0 };
      for (const c of result.allCandidates) {
        confCounts[c.metadata.confidence]++;
      }
      console.log(`  Confidence distribution: high=${confCounts.high} medium=${confCounts.medium} low=${confCounts.low}`);

      // Avg candidate duration
      const avgDur = result.allCandidates.reduce((s, c) => s + c.durationSeconds, 0) / result.allCandidates.length;
      console.log(`  Avg clip duration: ${avgDur.toFixed(1)}s`);
      console.log(`  Min duration: ${Math.min(...result.allCandidates.map(c => c.durationSeconds)).toFixed(1)}s`);
      console.log(`  Max duration: ${Math.max(...result.allCandidates.map(c => c.durationSeconds)).toFixed(1)}s`);
    }

    // ── V1 Overlap Analysis ───────────────────────────────────────────
    const v1Moments = project.v1Path ? loadV1Moments(project.v1Path) : [];
    if (v1Moments.length > 0) {
      console.log(`\n  ── V1 Overlap Analysis (${v1Moments.length} V1 moments) ──`);

      let hookNewDiscoveries = 0;
      let hookOverlapCount = 0;
      let totalOverlap = 0;

      for (const hookC of result.topCandidates) {
        let maxOverlap = 0;
        let bestV1: V1Moment | null = null;
        for (const v1 of v1Moments) {
          const ov = computeOverlap(hookC.startTime, hookC.endTime, v1.start, v1.end);
          if (ov > maxOverlap) {
            maxOverlap = ov;
            bestV1 = v1;
          }
        }
        totalOverlap += maxOverlap;

        if (maxOverlap > 0.3) {
          hookOverlapCount++;
          console.log(`  🔄 ${hookC.candidateId}: ${(maxOverlap * 100).toFixed(0)}% overlap with V1 clip @ ${fmtSec(bestV1!.start)}-${fmtSec(bestV1!.end)} (V1=${bestV1!.score})`);
        } else {
          hookNewDiscoveries++;
          console.log(`  ✨ ${hookC.candidateId}: NEW discovery (${(maxOverlap * 100).toFixed(0)}% overlap with nearest V1)`);
        }
      }

      const avgV1Overlap = result.topCandidates.length > 0
        ? (totalOverlap / result.topCandidates.length * 100).toFixed(1)
        : 'N/A';
      console.log(`\n  Summary:`);
      console.log(`    Hook-V1 overlap rate: ${hookOverlapCount}/${result.topCandidates.length} clips overlap >30%`);
      console.log(`    New discoveries: ${hookNewDiscoveries}/${result.topCandidates.length}`);
      console.log(`    Avg overlap with V1: ${avgV1Overlap}%`);

      // Coverage: how many V1 moments does Hook find?
      let v1FoundByHook = 0;
      for (const v1 of v1Moments) {
        for (const hookC of result.allCandidates) {
          const ov = computeOverlap(hookC.startTime, hookC.endTime, v1.start, v1.end);
          if (ov > 0.3) {
            v1FoundByHook++;
            break;
          }
        }
      }
      console.log(`    V1 moments found by Hook: ${v1FoundByHook}/${v1Moments.length} (${(v1FoundByHook/v1Moments.length*100).toFixed(0)}%)`);
    }

    console.log('');  // blank line between projects
  }

  // ==========================================================================
  // Overall Summary
  // ==========================================================================

  console.log(`\n${'='.repeat(70)}`);
  console.log('  OVERALL SUMMARY');
  console.log(`${'='.repeat(70)}\n`);
  console.log(`  Total raw candidates: ${totalRawCandidates}`);
  console.log(`  Total top candidates: ${totalTopCandidates}`);
  console.log(`  Projects with zero candidates: ${projectsWithZeroCandidates}/${PROJECTS.length}`);
  console.log(`\n  Success criterion: Hook Generator must discover clips V1 misses.`);
  console.log(`  See per-project V1 Overlap Analysis above.\n`);
}

// Polyfill for String.repeat since the environment might not have it... it does.
// Hmm actually I was thinking of something else. Let me just use a simple separator.

// ============================================================================
// Main
// ============================================================================

runBenchmark().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
