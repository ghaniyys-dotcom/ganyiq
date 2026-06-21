// ============================================================================
// lib/canary-controller.ts — Phase 3C Canary Rollout Controller
// ============================================================================
//
// Routes analyses to V1 (control) or V2 (treatment) based on canary percentage.
// Switches V2 output for users when enabled (V2_CANARY_ENABLED=true).
// Includes automatic rollback detection.
//
// Architecture:
//   POST /api/analyze → canaryRouter.selectPipeline(analysisId)
//     → "v1" (control, 100% - canary_percent)
//     → "v2" (treatment, canary_percent)
//
// Rollback triggers:
//   - success_rate < 99%
//   - latency_regression > 30%
//   - failure_rate > 5%
//   - severe generator starvation
//   - severe strategy dominance
// ============================================================================

import { createHash } from 'crypto';

// ─── Config ──────────────────────────────────────────────────────────────

export interface CanaryConfig {
  /** Master switch: false = all traffic stays V1 */
  enabled: boolean;
  /** Percentage of traffic to route to V2 (0-100) */
  percent: number;
  /** Stage label for logging */
  stage: string;
}

export const CANARY_STAGES: Record<string, CanaryConfig> = {
  stage_1: { enabled: false, percent: 1, stage: '1% Canary' },
  stage_2: { enabled: false, percent: 5, stage: '5% Canary' },
  stage_3: { enabled: false, percent: 10, stage: '10% Canary' },
  stage_4: { enabled: false, percent: 25, stage: '25% Expansion' },
  stage_5: { enabled: false, percent: 50, stage: '50% Expansion' },
  stage_6: { enabled: false, percent: 100, stage: '100% Full Rollout' },
};

// ─── Routing ────────────────────────────────────────────────────────────

/**
 * Determine which pipeline to use for a given analysis.
 *
 * Uses deterministic hashing so the same analysis always routes
 * to the same pipeline (consistent experiment assignment).
 */
export function selectPipeline(analysisId: string): 'v1' | 'v2' {
  // 1. Feature flag check
  if (process.env.V2_CANARY_ENABLED !== 'true') return 'v1';

  // 2. Read canary percentage
  const rawPct = process.env.V2_CANARY_PERCENT || '0';
  const canaryPct = Math.max(0, Math.min(100, parseInt(rawPct, 10) || 0));

  if (canaryPct <= 0) return 'v1';
  if (canaryPct >= 100) return 'v2';

  // 3. Deterministic hash — same analysisId always same bucket
  const hash = createHash('md5').update(analysisId).digest('hex');
  const bucket = parseInt(hash.slice(0, 8), 16) % 100;

  return bucket < canaryPct ? 'v2' : 'v1';
}

/**
 * Get the current canary stage configuration.
 */
export function getCurrentStage(): CanaryConfig {
  const enabled = process.env.V2_CANARY_ENABLED === 'true';
  const percent = Math.max(0, Math.min(100, parseInt(process.env.V2_CANARY_PERCENT || '0', 10) || 0));

  // Find matching stage
  for (const [name, stage] of Object.entries(CANARY_STAGES)) {
    if (stage.percent === percent) {
      return { ...stage, enabled };
    }
  }

  // Custom percentage
  return {
    enabled,
    percent,
    stage: `${percent}% Custom`,
  };
}

// ─── Rollback Detection ────────────────────────────────────────────────

export interface RollbackCheckResult {
  shouldRollback: boolean;
  reasons: string[];
  severity: 'none' | 'warning' | 'critical';
}

/**
 * Analyze shadow results for rollback conditions.
 * Designed to be called before each canary traffic batch.
 */
export function checkRollbackConditions(
  metrics: {
    totalRuns: number;
    successCount: number;
    failureCount: number;
    avgLatency: number;
    baselineLatency: number;
    genRawPcts: Record<string, number>;
    genTop5Pcts: Record<string, number>;
  },
): RollbackCheckResult {
  const reasons: string[] = [];
  let severity: 'none' | 'warning' | 'critical' = 'none';

  const total = metrics.totalRuns || 1;

  // 1. Success rate < 99%
  const successRate = (metrics.successCount / total) * 100;
  if (successRate < 99) {
    reasons.push(`CRITICAL: Success rate ${successRate.toFixed(1)}% < 99%`);
    severity = 'critical';
  } else if (successRate < 99.5) {
    reasons.push(`WARNING: Success rate ${successRate.toFixed(1)}% approaching threshold`);
    if (severity === 'none') severity = 'warning';
  }

  // 2. Latency regression > 30%
  if (metrics.baselineLatency > 0 && metrics.avgLatency > 0) {
    const regression = ((metrics.avgLatency - metrics.baselineLatency) / metrics.baselineLatency) * 100;
    if (regression > 30) {
      reasons.push(`CRITICAL: Latency regression ${regression.toFixed(0)}% > 30% (${metrics.baselineLatency}ms → ${metrics.avgLatency}ms)`);
      severity = 'critical';
    } else if (regression > 15) {
      reasons.push(`WARNING: Latency regression ${regression.toFixed(0)}% approaching threshold`);
      if (severity === 'none') severity = 'warning';
    }
  }

  // 3. Failure rate > 5%
  const failureRate = (metrics.failureCount / total) * 100;
  if (failureRate > 5) {
    reasons.push(`CRITICAL: Failure rate ${failureRate.toFixed(1)}% > 5%`);
    severity = 'critical';
  }

  // 4. Severe generator starvation (< 5%)
  for (const [gen, pct] of Object.entries(metrics.genRawPcts)) {
    if (pct < 5) {
      reasons.push(`WARNING: Generator "${gen}" starvation at ${pct.toFixed(1)}% of raw candidates`);
      if (severity === 'none') severity = 'warning';
    }
  }

  // 5. Severe strategy dominance (single gen > 60% of top-5)
  for (const [gen, pct] of Object.entries(metrics.genTop5Pcts)) {
    if (pct > 60) {
      reasons.push(`WARNING: Generator "${gen}" dominates top-5 at ${pct.toFixed(0)}%`);
      if (severity === 'none') severity = 'warning';
    }
  }

  return {
    shouldRollback: severity === 'critical',
    reasons,
    severity,
  };
}

// ─── Environment helpers ────────────────────────────────────────────────

/**
 * Check if V2 output should be returned to users (vs shadow-only).
 */
export function isV2OutputEnabled(): boolean {
  return process.env.V2_MULTI_GENERATOR_OUTPUT === 'true';
}

/**
 * Check if shadow mode is active.
 */
export function isShadowModeEnabled(): boolean {
  return process.env.V2_MULTI_GENERATOR_SHADOW === 'true';
}

/**
 * Check if canary is active (enabled AND percent > 0).
 */
export function isCanaryActive(): boolean {
  if (process.env.V2_CANARY_ENABLED !== 'true') return false;
  const pct = parseInt(process.env.V2_CANARY_PERCENT || '0', 10);
  return pct > 0;
}
