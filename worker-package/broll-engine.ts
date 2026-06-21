/**
 * worker/broll-engine.ts — B-roll insertion infrastructure for GANYIQ
 *
 * Architecture for automatic B-roll support.
 * Does NOT call external stock providers.
 *
 * Components:
 *   1. brollCandidates: generate B-roll insertion points from transcript keywords
 *   2. brollSegments: generate timeline segments for B-roll overlays
 *   3. Keyword mapping: transcript → B-roll concept mapping
 *
 * NOTE: This is the ARCHITECTURE layer. Actual stock footage fetching
 * will be added in a future phase (external provider integration).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BrollCandidate {
  /** Unique ID for this B-roll candidate */
  id: string;
  /** Start time in video (seconds) */
  startTime: number;
  /** End time in video (seconds) */
  endTime: number;
  /** Keyword that triggered the B-roll suggestion */
  keyword: string;
  /** Category of the keyword for stock search */
  category: string;
  /** Confidence this needs B-roll (0-1) */
  confidence: number;
  /** Suggested search query for stock footage */
  suggestedQuery: string;
}

export interface BrollSegment {
  /** Temporal position in final clip */
  clipStartTime: number;
  clipEndTime: number;
  /** B-roll type */
  type: 'visual_illustration' | 'context_establishing' | 'concept_visualization' | 'transition';
  /** Source of B-roll footage (empty = not yet provided) */
  sourceType: 'local' | 'generated' | 'external' | 'none';
  /** Path to B-roll footage (empty if not fetched yet) */
  sourcePath: string;
  /** Duration in seconds */
  duration: number;
  /** Opacity/overlay mode */
  overlayMode: 'fullscreen' | 'pip' | 'split' | 'background';
}

// ---------------------------------------------------------------------------
// Keyword → Category mapping
// ---------------------------------------------------------------------------

const KEYWORD_MAP: Array<{ pattern: RegExp; category: string; query: string; confidence: number }> = [
  // Technology / Science
  { pattern: /(algorithm|code|programming|software)/ig, category: 'technology', query: '', confidence: 0.6 },
  { pattern: /(brain|neuron|neural|synapse|cortex)/ig, category: 'neuroscience', query: '', confidence: 0.7 },
  { pattern: /(cell|dna|gene|protein|molecule|microscope)/ig, category: 'biology', query: '', confidence: 0.7 },
  { pattern: /(quantum|particle|electron|photon|atom)/ig, category: 'physics', query: '', confidence: 0.6 },
  
  // Business / Money
  { pattern: /(startup|venture|invest|stock|market|revenue|profit)/ig, category: 'business', query: '', confidence: 0.6 },
  { pattern: /(money|cash|budget|salary|income|wealth)/ig, category: 'finance', query: '', confidence: 0.5 },
  { pattern: /(office|meeting|presentation|boardroom)/ig, category: 'workplace', query: '', confidence: 0.5 },
  
  // Health / Wellness
  { pattern: /(exercise|workout|gym|muscle|strength|cardio|run)/ig, category: 'fitness', query: '', confidence: 0.7 },
  { pattern: /(food|nutrition|diet|vitamin|protein|meal|cook)/ig, category: 'food', query: '', confidence: 0.6 },
  { pattern: /(sleep|meditat|breath|stress|anxiety|calm)/ig, category: 'wellness', query: '', confidence: 0.6 },
  
  // Nature / Environment
  { pattern: /(ocean|sea|beach|mountain|forest|tree|sunset|sunrise)/ig, category: 'nature', query: '', confidence: 0.7 },
  { pattern: /(city|urban|street|building|skyscraper)/ig, category: 'urban', query: '', confidence: 0.5 },
  
  // People / Social
  { pattern: /(people|crowd|audience|group|team|community)/ig, category: 'social', query: '', confidence: 0.5 },
  { pattern: /(child|kid|baby|family|parent)/ig, category: 'family', query: '', confidence: 0.5 },
  
  // Abstract concepts
  { pattern: /(time|journey|process|change|growth|progress)/ig, category: 'abstract', query: '', confidence: 0.3 },
  { pattern: /(future|potential|possibility|vision)/ig, category: 'future', query: '', confidence: 0.4 },
  
  // Numbers / Data
  { pattern: /\b(\d+%|\$\d+|\d+x|\d+:1)\b/g, category: 'data', query: '', confidence: 0.5 },
];

// ---------------------------------------------------------------------------
// B-roll Candidate Generation
// ---------------------------------------------------------------------------

/**
 * Generate B-roll candidates from a transcript.
 * Finds keywords that indicate visual illustration would improve the clip.
 */
export function generateBrollCandidates(
  transcript: string,
  startTime: number,
  endTime: number,
  clipId: string
): BrollCandidate[] {
  const candidates: BrollCandidate[] = [];
  const seenKeywords = new Set<string>();
  
  const lines = transcript.split(/\n|\.\s+/);
  let lineStartTime = startTime;
  const lineDuration = (endTime - startTime) / Math.max(1, lines.length);
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.length < 20) {
      lineStartTime += lineDuration;
      continue;
    }
    
    for (const mapping of KEYWORD_MAP) {
      const matches = line.match(mapping.pattern);
      if (matches) {
        const keyword = matches[0].toLowerCase();
        const key = `${keyword}-${i}`;
        
        if (!seenKeywords.has(key)) {
          seenKeywords.add(key);
          
          const candidate: BrollCandidate = {
            id: `${clipId}-broll-${candidates.length}`,
            startTime: lineStartTime,
            endTime: min(lineStartTime + lineDuration, endTime),
            keyword,
            category: mapping.category,
            confidence: mapping.confidence,
            suggestedQuery: `${keyword} stock footage ${mapping.category}`,
          };
          
          candidates.push(candidate);
        }
      }
    }
    
    lineStartTime += lineDuration;
  }
  
  // Deduplicate overlapping candidates: keep highest confidence
  return deduplicateCandidates(candidates);
}

function min(a: number, b: number): number {
  return a < b ? a : b;
}

/**
 * Deduplicate overlapping B-roll candidates, keeping highest confidence.
 */
function deduplicateCandidates(candidates: BrollCandidate[]): BrollCandidate[] {
  if (candidates.length <= 1) return candidates;
  
  const sorted = [...candidates].sort((a, b) => b.confidence - a.confidence);
  const result: BrollCandidate[] = [];
  const blocked: Array<{ start: number; end: number }> = [];
  
  for (const c of sorted) {
    const overlaps = blocked.some(b => c.startTime < b.end && c.endTime > b.start);
    if (!overlaps) {
      result.push(c);
      blocked.push({ start: c.startTime, end: c.endTime });
    }
  }
  
  return result.sort((a, b) => a.startTime - b.startTime);
}

/**
 * Generate B-roll segment timeline from candidates.
 */
export function generateBrollTimeline(
  candidates: BrollCandidate[],
  clipDuration: number,
  clipStartTime: number
): BrollSegment[] {
  return candidates.map((c, i) => {
    // Determine B-roll duration (min 1.5s, max 4s)
    const maxDur = Math.min(4, c.endTime - c.startTime);
    const duration = Math.max(1.5, maxDur);
    
    // Determine overlay mode based on category
    let overlayMode: BrollSegment['overlayMode'] = 'fullscreen';
    if (c.category === 'data') {
      overlayMode = 'pip';
    } else if (['abstract', 'future'].includes(c.category)) {
      overlayMode = 'background';
    }
    
    return {
      clipStartTime: c.startTime - clipStartTime,
      clipEndTime: c.startTime - clipStartTime + duration,
      type: 'visual_illustration',
      sourceType: 'none',
      sourcePath: '',
      duration,
      overlayMode,
    } as BrollSegment;
  });
}

/**
 * Check if a B-roll candidate should trigger an actual download (confidence > threshold).
 */
export function shouldFetchBroll(candidate: BrollCandidate, threshold: number = 0.5): boolean {
  return candidate.confidence >= threshold;
}
