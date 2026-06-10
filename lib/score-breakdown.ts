/**
 * lib/score-breakdown.ts — CLIP DNA PROFILE
 *
 * Derives qualitative labels from EXISTING pipeline data only.
 * No fabricated precision. No decimal scores.
 *
 * Levels:
 *   Strong:  tag present + confidence=high + score >=85
 *   High:    tag present + confidence in {high, medium}
 *   Medium:  tag present + confidence=low, or related tag present
 *   Low:     no tag, no related tag
 *   —        hidden (no data)
 *
 * Inputs (all real pipeline data):
 *   - worthClippingScore  (LLM)
 *   - dnaTags             (LLM)
 *   - confidence          (LLM)
 *   - rank                (ranking stage)
 *   - totalMomentsFound   (ranking stage)
 */

export type ProfileLevel = 'strong' | 'high' | 'medium' | 'low';

export interface DnaProfileItem {
  label: string;
  key: string;
  level: ProfileLevel | null;  // null = hidden (no data)
}

export interface DnaProfile {
  items: DnaProfileItem[];
  summaryLevel: ProfileLevel; // overall clip quality
}

// ---------------------------------------------------------------------------
// Component definitions
// ---------------------------------------------------------------------------

interface ComponentDef {
  label: string;
  key: string;
  primaryTag: string | null;    // direct DNA tag
  relatedTags: string[];        // secondary signal tags
  isComposite: boolean;         // e.g. retention uses multiple signals
}

const COMPONENTS: ComponentDef[] = [
  { label: 'Hook Strength',  key: 'hook',      primaryTag: 'hookPower',      relatedTags: ['curiosity'], isComposite: false },
  { label: 'Storytelling',   key: 'story',     primaryTag: 'storytelling',   relatedTags: ['humor'], isComposite: false },
  { label: 'Emotion',        key: 'emotion',   primaryTag: 'emotion',        relatedTags: ['vulnerability', 'motivation', 'inspiration'], isComposite: false },
  { label: 'Authority',      key: 'authority', primaryTag: 'authority',      relatedTags: ['educational'], isComposite: false },
  { label: 'Retention',      key: 'retention', primaryTag: null,             relatedTags: ['hookPower', 'curiosity', 'humor', 'shock'], isComposite: true },
  { label: 'Relatability',   key: 'relate',    primaryTag: 'relatability',   relatedTags: ['humor', 'vulnerability'], isComposite: false },
];

// ---------------------------------------------------------------------------
// Level derivation
// ---------------------------------------------------------------------------

function deriveLevel(
  def: ComponentDef,
  dnaTags: string[],
  confidence: string,
  score: number,
): ProfileLevel | null {
  const primaryFound = def.primaryTag ? dnaTags.includes(def.primaryTag) : false;
  const relatedFound = def.relatedTags.some(t => dnaTags.includes(t));

  // Composite components (like retention) use a different rule
  if (def.isComposite) {
    // Retention = tag diversity + hookPower/curiosity presence
    const uniqueTags = new Set(dnaTags);
    const diversity = uniqueTags.size;
    const hasHookOrCuriosity = dnaTags.some(t => ['hookPower', 'curiosity', 'humor', 'shock'].includes(t));

    if (hasHookOrCuriosity && diversity >= 2 && confidence === 'high' && score >= 85) return 'strong';
    if (hasHookOrCuriosity && diversity >= 1) return 'high';
    if (diversity >= 2 || confidence === 'low') return 'medium';
    return 'low';
  }

  // Standard components
  if (primaryFound) {
    if (confidence === 'high' && score >= 85) return 'strong';
    if (confidence === 'high' || confidence === 'medium') return 'high';
    return 'medium'; // primary tag found but confidence low
  }

  if (relatedFound) {
    return 'medium'; // only related tag found
  }

  // No tag at all
  return 'low';
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function deriveDnaProfile(
  score: number,
  confidence: string,
  dnaTags: string[],
): DnaProfile {
  const items: DnaProfileItem[] = COMPONENTS.map(def => {
    const level = deriveLevel(def, dnaTags, confidence, score);
    return {
      label: def.label,
      key: def.key,
      level,
    };
  });

  // Overall summary level
  const levels = items.map(i => i.level).filter(Boolean) as ProfileLevel[];
  let summaryLevel: ProfileLevel = 'low';
  if (levels.some(l => l === 'strong')) summaryLevel = 'strong';
  else if (levels.some(l => l === 'high')) summaryLevel = 'high';
  else if (levels.some(l => l === 'medium')) summaryLevel = 'medium';

  return { items, summaryLevel };
}
