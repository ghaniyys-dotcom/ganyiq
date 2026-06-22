/**
 * lib/broll-engine.ts — B-roll candidate generation from transcript keywords + scenes
 *
 * Finds keywords in transcript segments overlapping with a clip's time range,
 * maps them to categories, persists candidate records to the broll_candidates table,
 * and returns the result.
 *
 * Always returns an array (empty on failure) — never throws.
 */

import { query } from '@/db/client';
import type { SceneBoundary } from '@/lib/scene-detector';
import type { TranscriptSegment } from '@/lib/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BrollCandidate {
  keyword: string;
  category: string;
  confidence: number;
  suggested_query: string;
  overlay_mode: string;
  duration: number;
  source_type: string;
}

// ---------------------------------------------------------------------------
// Keyword → Category mapping
// ---------------------------------------------------------------------------

interface KeywordMapping {
  pattern: RegExp;
  category: string;
  query: string;
  confidence: number;
  overlay_mode: string;
}

const KEYWORD_MAP: KeywordMapping[] = [
  // Technology / Science
  { pattern: /(algorithm|code|programming|software|debug|compile)/ig, category: 'visual', query: '', confidence: 0.6, overlay_mode: 'fullscreen' },
  { pattern: /(brain|neuron|neural|synapse|cortex|cerebr)/ig, category: 'concept', query: '', confidence: 0.7, overlay_mode: 'background' },
  { pattern: /(cell|dna|gene|protein|molecule|microscope|bacteria|virus)/ig, category: 'visual', query: '', confidence: 0.7, overlay_mode: 'fullscreen' },
  { pattern: /(quantum|particle|electron|photon|atom|nucleus)/ig, category: 'concept', query: '', confidence: 0.6, overlay_mode: 'background' },

  // Business / Money
  { pattern: /(startup|venture|invest|stock|market|revenue|profit|ipo)/ig, category: 'concept', query: '', confidence: 0.6, overlay_mode: 'fullscreen' },
  { pattern: /(money|cash|budget|salary|income|wealth|funding|valuation)/ig, category: 'object', query: '', confidence: 0.5, overlay_mode: 'fullscreen' },
  { pattern: /(office|meeting|presentation|boardroom|conference|workspace)/ig, category: 'location', query: '', confidence: 0.5, overlay_mode: 'fullscreen' },

  // Health / Wellness
  { pattern: /(exercise|workout|gym|muscle|strength|cardio|run|running|jog)/ig, category: 'visual', query: '', confidence: 0.7, overlay_mode: 'fullscreen' },
  { pattern: /(food|nutrition|diet|vitamin|protein|meal|cook|cooking|recipe|eat)/ig, category: 'object', query: '', confidence: 0.6, overlay_mode: 'fullscreen' },
  { pattern: /(sleep|meditat|breath|breathe|stress|anxiety|calm|mindful|relax)/ig, category: 'emotion', query: '', confidence: 0.6, overlay_mode: 'background' },

  // Nature / Environment
  { pattern: /(ocean|sea|beach|mountain|forest|tree|sunset|sunrise|river|lake|waterfall)/ig, category: 'location', query: '', confidence: 0.7, overlay_mode: 'fullscreen' },
  { pattern: /(city|urban|street|building|skyscraper|neighborhood|downtown)/ig, category: 'location', query: '', confidence: 0.5, overlay_mode: 'fullscreen' },

  // People / Social
  { pattern: /(people|crowd|audience|group|team|community|gathering)/ig, category: 'person', query: '', confidence: 0.5, overlay_mode: 'fullscreen' },
  { pattern: /(child|kid|baby|family|parent|mother|father)/ig, category: 'person', query: '', confidence: 0.5, overlay_mode: 'fullscreen' },

  // Abstract concepts
  { pattern: /(time|journey|process|change|growth|progress|evolution)/ig, category: 'abstract', query: '', confidence: 0.3, overlay_mode: 'background' },
  { pattern: /(future|potential|possibility|vision|innovation|breakthrough)/ig, category: 'abstract', query: '', confidence: 0.4, overlay_mode: 'background' },

  // Numbers / Data
  { pattern: /\b(\d+%|\$\d+|\d+x)\b/g, category: 'concept', query: '', confidence: 0.5, overlay_mode: 'pip' },

  // Emotion keywords
  { pattern: /(love|hate|angry|sad|happy|excite|thrill|fear|surprise|disgust)/ig, category: 'emotion', query: '', confidence: 0.5, overlay_mode: 'background' },
  { pattern: /(inspire|motivat|passion|purpose|meaning|drive|determin)/ig, category: 'emotion', query: '', confidence: 0.5, overlay_mode: 'background' },
];

// ---------------------------------------------------------------------------
// B-roll Candidate Generation
// ---------------------------------------------------------------------------

/**
 * Generate B-roll candidates from transcript keywords within a clip time range.
 *
 * 1. Filters transcript segments overlapping with [clipStartTime, clipEndTime]
 * 2. Matches keywords against the KEYWORD_MAP
 * 3. Creates BrollCandidate records with category, confidence, overlay mode
 * 4. Persists all candidates to the `broll_candidates` table
 * 5. Returns the candidate array (empty on any failure)
 *
 * @param analysisId   — Parent analysis ID
 * @param videoId      — YouTube video ID (stored as clip_id for traceability)
 * @param scenes       — Scene boundaries (used for context, not directly for keyword extraction)
 * @param transcript   — Full transcript segments array
 * @param momentId     — The moment/clip ID these candidates belong to
 * @param clipStartTime — Start of the clip time range (seconds)
 * @param clipEndTime   — End of the clip time range (seconds)
 * @returns Array of BrollCandidate (empty on failure)
 */
export async function generateBrollCandidates(
  analysisId: string,
  videoId: string,
  scenes: SceneBoundary[],
  transcript: TranscriptSegment[],
  momentId: string,
  clipStartTime: number,
  clipEndTime: number,
): Promise<BrollCandidate[]> {
  try {
    // 1. Filter transcript segments overlapping with clip time range
    const overlappingSegments = transcript.filter(seg => {
      const segEnd = seg.start + (seg.duration > 0 ? seg.duration : 2);
      return seg.start < clipEndTime && segEnd > clipStartTime;
    });

    if (overlappingSegments.length === 0) {
      return [];
    }

    // 2. Build timed text blocks from overlapping segments
    const segmentTexts: Array<{ text: string; start: number; end: number }> = [];
    for (const seg of overlappingSegments) {
      const segEnd = seg.start + (seg.duration > 0 ? seg.duration : 2);
      segmentTexts.push({
        text: seg.text || '',
        start: Math.max(seg.start, clipStartTime),
        end: Math.min(segEnd, clipEndTime),
      });
    }

    // 3. Match keywords and build candidates
    const seenKeywords = new Set<string>();
    const candidates: BrollCandidate[] = [];

    for (const seg of segmentTexts) {
      if (!seg.text.trim()) continue;

      for (const mapping of KEYWORD_MAP) {
        // Reset lastIndex for global regexes
        mapping.pattern.lastIndex = 0;

        const matches = seg.text.match(mapping.pattern);
        if (!matches) continue;

        for (const match of matches) {
          const keyword = match.toLowerCase().trim();
          const cleanKeyword = keyword.replace(/^[\$\s]+/, '');

          if (!cleanKeyword || seenKeywords.has(cleanKeyword)) continue;
          seenKeywords.add(cleanKeyword);

          // Build query: use mapping query hint or derive from keyword + category
          const suggestedQuery = mapping.query
            ? mapping.query
            : `${cleanKeyword} stock footage ${mapping.category}`;

          // Duration scales with segment length but clamped to [1.5, 4.0]
          const duration = Math.min(4.0, Math.max(1.5, (seg.end - seg.start) / 2));

          candidates.push({
            keyword: cleanKeyword,
            category: mapping.category,
            confidence: mapping.confidence,
            suggested_query: suggestedQuery,
            overlay_mode: mapping.overlay_mode,
            duration,
            source_type: 'none',
          });
        }
      }
    }

    // 4. Persist to broll_candidates table (non-blocking — log errors, never crash)
    if (candidates.length > 0) {
      try {
        await persistCandidates(
          analysisId,
          videoId,
          momentId,
          clipStartTime,
          clipEndTime,
          candidates,
        );
      } catch (insertErr) {
        console.error('[broll-engine] Failed to persist candidates to DB:', insertErr);
      }
    }

    return candidates;
  } catch (err) {
    console.error('[broll-engine] Failed to generate b-roll candidates:', err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Batch-insert b-roll candidates into the database.
 */
async function persistCandidates(
  analysisId: string,
  videoId: string,
  momentId: string,
  clipStartTime: number,
  clipEndTime: number,
  candidates: BrollCandidate[],
): Promise<void> {
  const values: unknown[] = [];
  const placeholders: string[] = [];
  let paramIdx = 1;

  for (const c of candidates) {
    placeholders.push(
      `($${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++})`,
    );
    values.push(
      momentId,
      analysisId,
      videoId,       // stored as clip_id for traceability
      clipStartTime,
      clipEndTime,
      c.keyword,
      c.category,
      c.confidence,
      c.suggested_query,
      c.overlay_mode,
      c.duration,
      c.source_type,
    );
  }

  const sql = `INSERT INTO broll_candidates
    (moment_id, analysis_id, clip_id, start_time, end_time, keyword, category, confidence, suggested_query, overlay_mode, duration, source_type)
  VALUES ${placeholders.join(', ')}`;

  await query(sql, values);
}
