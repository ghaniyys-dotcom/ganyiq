/**
 * lib/multi-generator/index.ts — Barrel exports for Phase 2.1
 *
 * Import from here when using multi-generator types or pipeline.
 *
 * @example
 *   import { GeneratorCandidate, IGenerator } from '@/lib/multi-generator';
 */

export type {
  GeneratorStrategy,
  GeneratorCandidate,
  GeneratorMetadata,
  GeneratorResult,
  GeneratorConfig,
  AggregationConfig,
  CandidatePool,
  MultiGeneratorPipelineConfig,
  IGenerator,
  GeneratorEvalMetrics,
  PoolConstraints,
} from './types';

export {
  GENERATOR_LABELS,
  DEFAULT_GENERATOR_CONFIGS,
  DEFAULT_AGGREGATION_CONFIG,
  DEFAULT_PIPELINE_CONFIG,
  DEFAULT_POOL_CONSTRAINTS,
} from './types';

export {
  runMultiGeneratorPipeline,
  aggregateGenerators,
  isMultiGeneratorEnabled,
  getPoolSize,
} from './pipeline';

export type { RunPipelineParams } from './pipeline';

// ─── Diversity Types ────────────────────────────────────────────────────────

export type {
  OverlapScore,
  ClipPairOverlap,
  OverlapWeights,
  MomentCluster,
  ClusterMap,
  DiversityScore,
  DedupResult,
  DiversityStageResult,
} from './diversity-types';

export {
  DEFAULT_OVERLAP_WEIGHTS,
} from './diversity-types';
