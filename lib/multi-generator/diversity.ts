// ============================================================================
// lib/multi-generator/diversity.ts — Diversity Safeguard Implementation
// ============================================================================
// Pure functions. No side effects. No async. No external deps.
//
// Pipeline position:
//   Aggregate → [CLUSTER → DEDUP → SCORE] → Judge V2 → Output
// ============================================================================

import type { GeneratorCandidate, GeneratorStrategy, PoolConstraints } from './types';
import {
  DEFAULT_POOL_CONSTRAINTS,
} from './types';
import type {
  OverlapScore,
  ClipPairOverlap,
  OverlapWeights,
  MomentCluster,
  ClusterMap,
  DiversityScore,
  DedupResult,
} from './diversity-types';
import { DEFAULT_OVERLAP_WEIGHTS } from './diversity-types';

// ============================================================================
// 1. computePairOverlap
// ============================================================================

/**
 * Compute three-layer overlap between two candidates.
 *
 * Layer 1 — Time: Jaccard on [start, end] intervals
 * Layer 2 — Transcript: Jaccard on word tokens (lowercased, deduplicated)
 * Layer 3 — Semantic: Jaccard on triggerSignals (fallback: TF-IDF-like word overlap)
 *
 * Returns normalised [0, 1] scores plus weighted composite.
 */
export function computePairOverlap(
  a: GeneratorCandidate,
  b: GeneratorCandidate,
  weights: OverlapWeights = DEFAULT_OVERLAP_WEIGHTS,
): ClipPairOverlap {
  const timeOverlap = computeTimeOverlap(a.startTime, a.endTime, b.startTime, b.endTime);
  const transcriptOverlap = computeTranscriptOverlap(a.transcriptExcerpt, b.transcriptExcerpt);
  const semanticOverlap = computeSemanticOverlap(a.metadata.triggerSignals, b.metadata.triggerSignals);

  const totalWeight = weights.time + weights.transcript + weights.semantic;
  const normalised = {
    time: weights.time / totalWeight,
    transcript: weights.transcript / totalWeight,
    semantic: weights.semantic / totalWeight,
  };

  const composite =
    timeOverlap * normalised.time +
    transcriptOverlap * normalised.transcript +
    semanticOverlap * normalised.semantic;

  return {
    a,
    b,
    scores: { timeOverlap, transcriptOverlap, semanticOverlap },
    composite: clamp01(composite),
    flagged: composite >= 0.65,
  };
}

function computeTimeOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  const intersectionStart = Math.max(aStart, bStart);
  const intersectionEnd = Math.min(aEnd, bEnd);
  const intersection = Math.max(0, intersectionEnd - intersectionStart);

  const aDur = Math.max(0, aEnd - aStart);
  const bDur = Math.max(0, bEnd - bStart);
  const union = aDur + bDur - intersection;

  if (union <= 0) return 0;
  return intersection / union;
}

function computeTranscriptOverlap(aText: string, bText: string): number {
  const tokensA = tokenise(aText);
  const tokensB = tokenise(bText);
  if (tokensA.size === 0 && tokensB.size === 0) return 1.0;
  if (tokensA.size === 0 || tokensB.size === 0) return 0.0;

  const intersectionSize = intersectSize(tokensA, tokensB);
  const unionSize = tokensA.size + tokensB.size - intersectionSize;
  return intersectionSize / unionSize;
}

function computeSemanticOverlap(aSignals: string[], bSignals: string[]): number {
  if (aSignals.length === 0 && bSignals.length === 0) return 1.0;
  if (aSignals.length === 0 || bSignals.length === 0) return 0.0;

  const setA = new Set(aSignals.map((s) => s.toLowerCase().trim()));
  const setB = new Set(bSignals.map((s) => s.toLowerCase().trim()));

  const intersectionSize = intersectSize(setA, setB);
  const unionSize = setA.size + setB.size - intersectionSize;
  return intersectionSize / unionSize;
}

// ============================================================================
// 2. buildClusterMap
// ============================================================================

/**
 * Greedy single-link agglomeration.
 *
 * 1. Each candidate starts as its own cluster.
 * 2. Sort all pairs by composite DESC.
 * 3. Merge any pair where composite >= threshold.
 * 4. Compute cluster properties (startSec, endSec, centroid, strategies, density).
 */
export function buildClusterMap(
  candidates: GeneratorCandidate[],
  threshold: number = 0.65,
): ClusterMap {
  if (candidates.length === 0) {
    return { clusters: [], totalClips: 0, uniquenessRatio: 1.0 };
  }

  // Phase 1: pairwise composites
  const pairs = computeAllPairs(candidates);

  // Phase 2: union-find clustering
  const parent = new Map<string, string>();
  const clusterMembers = new Map<string, GeneratorCandidate[]>();

  for (const c of candidates) {
    parent.set(c.candidateId, c.candidateId);
    clusterMembers.set(c.candidateId, [c]);
  }

  function find(id: string): string {
    const p = parent.get(id)!;
    if (p !== id) {
      parent.set(id, find(p));
    }
    return parent.get(id)!;
  }

  function union(idA: string, idB: string): void {
    const rootA = find(idA);
    const rootB = find(idB);
    if (rootA === rootB) return;
    // Merge smaller into larger
    const membersA = clusterMembers.get(rootA)!;
    const membersB = clusterMembers.get(rootB)!;
    if (membersA.length >= membersB.length) {
      parent.set(rootB, rootA);
      membersA.push(...membersB);
      clusterMembers.delete(rootB);
    } else {
      parent.set(rootA, rootB);
      membersB.push(...membersA);
      clusterMembers.delete(rootA);
    }
  }

  // Merge flagged pairs
  for (const pair of pairs) {
    if (pair.composite >= threshold) {
      union(pair.a.candidateId, pair.b.candidateId);
    }
  }

  // Phase 3: build MomentCluster objects
  let clusterIndex = 0;
  const clusters: MomentCluster[] = [];

  for (const [rootId, members] of clusterMembers.entries()) {
    const sorted = [...members].sort((x, y) => y.metadata.internalScore - x.metadata.internalScore);
    const starts = members.map((c) => c.startTime);
    const ends = members.map((c) => c.endTime);
    const startSec = Math.min(...starts);
    const endSec = Math.max(...ends);
    const strategies = Array.from(new Set(members.map((c) => c.generator)));

    // Density: 1 - (variance of start times normalised by cluster span)
    const span = endSec - startSec || 1;
    const meanStart = starts.reduce((s, v) => s + v, 0) / starts.length;
    const variance = starts.reduce((s, v) => s + (v - meanStart) ** 2, 0) / starts.length;
    const density = clamp01(1 - Math.sqrt(variance) / span);

    clusters.push({
      id: `cluster-${clusterIndex++}`,
      clips: members,
      startSec,
      endSec,
      density,
      strategies,
      centroid: sorted[0], // highest internalScore
      label: sorted[0].transcriptExcerpt.slice(0, 80),
    });
  }

  // Sort clusters by start time
  clusters.sort((a, b) => a.startSec - b.startSec);

  // Reassign sequential IDs
  for (let i = 0; i < clusters.length; i++) {
    clusters[i] = { ...clusters[i], id: `cluster-${i}` };
  }

  const singletons = clusters.filter((c) => c.clips.length === 1).length;

  return {
    clusters,
    totalClips: candidates.length,
    uniquenessRatio: candidates.length > 0 ? singletons / clusters.length : 1.0,
  };
}

// ============================================================================
// 3. dedupPool
// ============================================================================

/**
 * Cluster-aware pool dedup.
 *
 * Steps:
 *   1. Cluster all raw candidates
 *   2. Per cluster: keep top `maxPerCluster` by internalScore
 *   3. Survivor pairwise overlap check
 *   4. Diversity score threshold
 *   5. Overflow cap to maxDedupedCandidates
 *
 * Returns survivors, clusters, removed log, and stats.
 */
export function dedupPool(
  candidates: GeneratorCandidate[],
  constraints: PoolConstraints = DEFAULT_POOL_CONSTRAINTS,
): DedupResult {
  const removed: DedupResult['removed'] = [];
  let workingSet = [...candidates];

  // Step 0: safety cap raw input
  if (workingSet.length > constraints.maxRawCandidates) {
    const excess = workingSet.length - constraints.maxRawCandidates;
    const dropped = workingSet.splice(constraints.maxRawCandidates, excess);
    for (const d of dropped) {
      removed.push({ candidate: d, reason: 'Exceeded maxRawCandidates' });
    }
  }

  // Step 1: cluster
  const clusterMap = buildClusterMap(workingSet, constraints.maxPairOverlap);

  // Step 2: per-cluster maxPerCluster enforcement
  let survivors: GeneratorCandidate[] = [];
  for (const cluster of clusterMap.clusters) {
    const sorted = [...cluster.clips].sort(
      (a, b) => b.metadata.internalScore - a.metadata.internalScore,
    );
    const kept = sorted.slice(0, constraints.maxPerCluster);
    survivors.push(...kept);

    const dropped = sorted.slice(constraints.maxPerCluster);
    for (const d of dropped) {
      removed.push({
        candidate: d,
        reason: `Cluster ${cluster.id} exceeded maxPerCluster (${constraints.maxPerCluster})`,
        clusterId: cluster.id,
      });
    }
  }

  // Step 3: pairwise overlap check on survivors
  const pairChecked: GeneratorCandidate[] = [];
  for (const candidate of survivors) {
    let exceeds = false;
    for (const existing of pairChecked) {
      const pair = computePairOverlap(candidate, existing);
      if (pair.composite > constraints.maxPairOverlap) {
        exceeds = true;
        removed.push({
          candidate: candidate,
          reason: `Pairwise overlap ${pair.composite.toFixed(3)} exceeds maxPairOverlap ${constraints.maxPairOverlap} with ${existing.candidateId}`,
        });
        break;
      }
    }
    if (!exceeds) {
      pairChecked.push(candidate);
    }
  }
  survivors = pairChecked;

  // Step 4: diversity score threshold
  const diversities = new Map<string, DiversityScore>();
  for (const candidate of survivors) {
    const ds = computeDiversityScore(candidate, survivors);
    diversities.set(candidate.candidateId, ds);
  }

  const aboveMin: GeneratorCandidate[] = [];
  for (const candidate of survivors) {
    const ds = diversities.get(candidate.candidateId)!;
    if (ds.composite >= constraints.minDiversityScore) {
      aboveMin.push(candidate);
    } else {
      removed.push({
        candidate,
        reason: `Diversity score ${ds.composite.toFixed(3)} below minDiversityScore ${constraints.minDiversityScore}`,
      });
    }
  }
  survivors = aboveMin;

  // Step 5: cap to maxDedupedCandidates (keep highest diversity)
  if (survivors.length > constraints.maxDedupedCandidates) {
    survivors.sort((a, b) => {
      const da = diversities.get(a.candidateId)!.composite;
      const db = diversities.get(b.candidateId)!.composite;
      return db - da;
    });
    const excess = survivors.splice(constraints.maxDedupedCandidates);
    for (const d of excess) {
      removed.push({
        candidate: d,
        reason: `Exceeded maxDedupedCandidates (${constraints.maxDedupedCandidates})`,
      });
    }
  }

  const avgDs =
    survivors.length > 0
      ? survivors.reduce((s, c) => s + (diversities.get(c.candidateId)?.composite ?? 0), 0) /
        survivors.length
      : 0;

  const singletons = clusterMap.clusters.filter((c) => c.clips.length === 1).length;

  return {
    survivors,
    clusters: clusterMap.clusters,
    removed,
    stats: {
      before: candidates.length,
      after: survivors.length,
      removedCount: removed.length,
      clusterCount: clusterMap.clusters.length,
      singletonCount: singletons,
      avgDiversityScore: avgDs,
    },
  };
}

// ============================================================================
// 4. computeDiversityScore
// ============================================================================

/**
 * Per-candidate diversity score within a survivor pool.
 *
 * Components:
 *   — Novelty (0.40): 1 − mean pairwise composite with all others
 *   — Moment spread (0.35): distance from median start time, normalised
 *   — Intent diversity (0.25): strategy scarcity in the pool
 */
export function computeDiversityScore(
  candidate: GeneratorCandidate,
  pool: GeneratorCandidate[],
): DiversityScore {
  if (pool.length <= 1) {
    return { composite: 1.0, novelty: 1.0, momentSpread: 1.0, intentDiversity: 1.0 };
  }

  // Novelty: mean pairwise difference from all others
  let totalComposite = 0;
  let count = 0;
  for (const other of pool) {
    if (other.candidateId === candidate.candidateId) continue;
    const pair = computePairOverlap(candidate, other);
    totalComposite += pair.composite;
    count++;
  }
  const meanOverlap = count > 0 ? totalComposite / count : 0;
  const novelty = clamp01(1 - meanOverlap);

  // Moment spread: normalised distance from median start
  const starts = pool.map((c) => c.startTime).sort((a, b) => a - b);
  const medianStart = starts[Math.floor(starts.length / 2)];
  const allStarts = [candidate.startTime, ...starts];
  const maxStart = Math.max(...allStarts);
  const minStart = Math.min(...allStarts);
  const spread = maxStart - minStart || 1;
  const distance = Math.abs(candidate.startTime - medianStart);
  const momentSpread = clamp01(distance / spread);

  // Intent diversity: how many other candidates share this strategy
  const sameStrategy = pool.filter(
    (c) => c.generator === candidate.generator && c.candidateId !== candidate.candidateId,
  ).length;
  const intentDiversity = clamp01(1 - sameStrategy / (pool.length - 1));

  const composite = novelty * 0.40 + momentSpread * 0.35 + intentDiversity * 0.25;

  return { composite: clamp01(composite), novelty, momentSpread, intentDiversity };
}

// ============================================================================
// Internal helpers
// ============================================================================

function computeAllPairs(candidates: GeneratorCandidate[]): ClipPairOverlap[] {
  const pairs: ClipPairOverlap[] = [];
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      pairs.push(computePairOverlap(candidates[i], candidates[j]));
    }
  }
  pairs.sort((a, b) => b.composite - a.composite);
  return pairs;
}

function tokenise(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter((w) => w.length > 0);
  return new Set(words);
}

function intersectSize(a: Set<string>, b: Set<string>): number {
  let count = 0;
  for (const item of a) {
    if (b.has(item)) count++;
  }
  return count;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
