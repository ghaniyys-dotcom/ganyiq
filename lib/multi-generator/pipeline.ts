/**
 * lib/multi-generator/pipeline.ts — Phase 2.1 Pipeline Stub
 *
 * Orchestrates the two-stage ranking flow:
 *   Generators → local ranking → aggregation → Judge V2 → final ranking
 *
 * Currently a STUB for Phase 2.1. Generators will be added in Phases 2.2-2.5.
 * This file defines the pipeline orchestration interface without implementation.
 */

import type {
  MultiGeneratorPipelineConfig,
  GeneratorResult,
  CandidatePool,
  GeneratorCandidate,
} from './types';

export { DEFAULT_PIPELINE_CONFIG } from './types';
export type { MultiGeneratorPipelineConfig } from './types';

// ---------------------------------------------------------------------------
// Pipeline Orchestrator
// ---------------------------------------------------------------------------

/**
 * Run the full multi-generator pipeline.
 *
 * Stages:
 *   1. Run all 4 generators in parallel (Promise.allSettled)
 *   2. Each generator does local ranking → top K
 *   3. Aggregate top K from each → dedup → diversity filter
 *   4. Run Judge V2 on aggregated pool
 *   5. Return final ranked candidates
 *
 * @param params - Pipeline parameters
 * @returns Ranked candidates (top N)
 *
 * @note STUB — actual generator implementations coming in Phases 2.2-2.5.
 *       This function currently throws because no generators are registered.
 */
export async function runMultiGeneratorPipeline(
  params: RunPipelineParams,
): Promise<GeneratorCandidate[]> {
  console.log('[MULTI-GENERATOR] Pipeline called — generators not yet implemented');
  console.log('[MULTI-GENERATOR] Falling through to legacy pipeline');
  
  // Phase 2.1: Always fall through to legacy pipeline
  // Phase 2.7+: Actually run generators
  throw new Error('Multi-generator pipeline not yet implemented (Phase 2.1)');
}

/** Parameters for a pipeline run. */
export interface RunPipelineParams {
  videoId: string;
  transcript: import('../types').TranscriptSegment[];
  config: MultiGeneratorPipelineConfig;
}

// ---------------------------------------------------------------------------
// Aggregation (implemented in Phase 2.1 for architecture review)
// ---------------------------------------------------------------------------

/**
 * Aggregate candidates from all generators into a single pool.
 * Handles: flattening, deduplication, diversity enforcement.
 *
 * Two-stage flow:
 *   GeneratorResult[] (one per strategy)
 *     → flatten topCandidates
 *     → dedup (remove exact + near-duplicate)
 *     → enforce strategy diversity
 *     → CandidatePool
 */
export function aggregateGenerators(
  results: GeneratorResult[],
  config: import('./types').AggregationConfig,
): CandidatePool {
  const dropped: CandidatePool['dropped'] = [];
  const strategyCounts: Record<string, number> = {};

  // Stage 1: Flatten top K from each generator
  const allCandidates: GeneratorCandidate[] = [];
  for (const result of results) {
    const strategy = result.strategy;
    strategyCounts[strategy] = (strategyCounts[strategy] || 0) + result.topCandidates.length;
    allCandidates.push(...result.topCandidates);
  }

  const rawTotal = allCandidates.length;

  // Stage 2: Exact dedup (same startTime + endTime)
  const seenKeys = new Set<string>();
  const deduped: GeneratorCandidate[] = [];
  for (const c of allCandidates) {
    const key = `${c.startTime}-${c.endTime}-${c.generator}`;
    if (seenKeys.has(key)) {
      dropped.push({ candidateId: c.candidateId, reason: 'exact_dedup' });
      continue;
    }
    seenKeys.add(key);
    deduped.push(c);
  }

  const dedupedTotal = deduped.length;

  // Stage 3: Diversity enforcement — ensure minimum strategy count in top N
  // (Full implementation in Phase 2.6)
  const candidates = enforceDiversity(deduped, config);

  return {
    candidates,
    strategyCounts: strategyCounts as Record<import('./types').GeneratorStrategy, number>,
    rawTotal,
    dedupedTotal,
    dropped,
  };
}

/**
 * Enforce minimum strategy representation in the final pool.
 * If a strategy has fewer than 1 candidate, it won't appear in output.
 * If all strategies have candidates, the pool passes through.
 */
function enforceDiversity(
  candidates: GeneratorCandidate[],
  config: import('./types').AggregationConfig,
): GeneratorCandidate[] {
  const byStrategy = new Map<string, GeneratorCandidate[]>();
  for (const c of candidates) {
    const list = byStrategy.get(c.generator) || [];
    list.push(c);
    byStrategy.set(c.generator, list);
  }

  const strategiesPresent = byStrategy.size;
  if (strategiesPresent < config.minStrategiesInOutput) {
    console.warn(
      `[AGGREGATOR] Only ${strategiesPresent}/${config.minStrategiesInOutput} strategies present in pool. ` +
      `Diversity enforcement may reduce final N.`
    );
  }

  // Phase 2.1: pass through (Post-Judge-V2 diversity enforcement TBD in Phase 2.6)
  return candidates;
}

// ---------------------------------------------------------------------------
// Feature Flag
// ---------------------------------------------------------------------------

/**
 * Check if multi-generator is enabled.
 * Controlled by USE_MULTI_GENERATOR env var (default: false).
 */
export function isMultiGeneratorEnabled(): boolean {
  return process.env.USE_MULTI_GENERATOR === 'true';
}

/**
 * Get total candidate pool size (before Judge V2).
 * = sum of localTopK across all active generators.
 */
export function getPoolSize(config: MultiGeneratorPipelineConfig): number {
  return Object.values(config.generators).reduce(
    (total, genConfig) => total + genConfig.localTopK,
    0,
  );
}
