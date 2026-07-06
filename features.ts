/**
 * worker-package/features.ts -- Feature flags for GANYIQ render pipeline
 *
 * STABILIZATION MODE:
 *   Most features ON by default.
 *   Memory-heavy/experimental features OFF by default (opt-in via env).
 *
 * To enable an opt-in feature on PC-GANY, add to .env.local:
 *   GANYIQ_FEATURE_REACTION_DETECTION=1
 *   GANYIQ_FEATURE_VISUAL_REACTION=1
 *   GANYIQ_FEATURE_LAYOUT_TRANSITIONS=1
 *
 * To disable a stable feature (debugging):
 *   GANYIQ_FEATURE_DIARIZATION=0
 *   GANYIQ_FEATURE_V2_TRACKING=0
 *   GANYIQ_FEATURE_SUBTITLES=0
 */

const PREFIX = 'GANYIQ_FEATURE_';

export const FEATURES = {
  REACTION_DETECTION: 'REACTION_DETECTION',
  VISUAL_REACTION: 'VISUAL_REACTION',
  DIARIZATION: 'DIARIZATION',
  V2_TRACKING: 'V2_TRACKING',
  SUBTITLES: 'SUBTITLES',
  LAYOUT_TRANSITIONS: 'LAYOUT_TRANSITIONS',
};

export type FeatureName = keyof typeof FEATURES;

/**
 * Features that default to DISABLED (opt-in).
 * These consume significant RAM and are not required for core clip rendering.
 */
const OFF_BY_DEFAULT: Set<FeatureName> = new Set<FeatureName>([
  'REACTION_DETECTION',
  'VISUAL_REACTION',
  'LAYOUT_TRANSITIONS',
]);

export function isEnabled(feature: FeatureName): boolean {
  const envVar = PREFIX + FEATURES[feature];
  const value = process.env[envVar] || '';
  // Empty env var → use the default for this feature
  if (value === '') {
    return !OFF_BY_DEFAULT.has(feature);
  }
  // Explicit env var: 1 = enabled, anything else = disabled
  return value === '1';
}

export function logFeatureFlags(): void {
  const statuses = Object.entries(FEATURES).map(([name, envValue]) => {
    const envVar = PREFIX + envValue;
    const val = process.env[envVar] || '(default)';
    const enabled = isEnabled(name as FeatureName);
    return (enabled ? '+' : '-') + ' ' + name + ' (' + envVar + '=' + val + ')';
  });
  console.log('[FEATURES] Flags:');
  for (const s of statuses) {
    console.log('  ' + s);
  }
}
