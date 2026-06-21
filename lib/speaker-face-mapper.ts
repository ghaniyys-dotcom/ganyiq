/**
 * lib/speaker-face-mapper.ts — Speaker ↔ Face mapping foundation
 *
 * Creates and persists the relationship between speaker labels (from diarization)
 * and face detections (from face-tracker). Enables future:
 *   - Camera switching (switch to active speaker)
 *   - Podcast layouts (speaker-aware framing)
 *   - Active speaker rendering (highlight current talker)
 *
 * This is a FOUNDATION layer only — does NOT implement camera switching.
 */

import { query } from '@/db/client';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SpeakerFaceMapping {
  /** Unique mapping identifier */
  id: string;
  /** Analysis ID */
  analysisId: string;
  /** Speaker label from diarization (e.g. "Speaker 0", "Speaker 1") */
  speakerId: string;
  /** Face tracking ID from face-tracker */
  faceId: number;
  /** Confidence of this mapping (0-1) */
  confidence: number;
  /** When this mapping was established */
  createdAt: string;
}

export interface SpeakerFaceInput {
  analysisId: string;
  speakerId: string;
  faceId: number;
  confidence: number;
}

// ---------------------------------------------------------------------------
// Database Operations
// ---------------------------------------------------------------------------

/**
 * Persist a speaker↔face mapping to the database.
 * Uses upsert — if a mapping for this analysis+speaker+face exists, update it.
 */
export async function saveSpeakerFaceMapping(
  mapping: SpeakerFaceInput,
): Promise<void> {
  await query(
    `INSERT INTO speaker_face_mappings (analysis_id, speaker_id, face_id, confidence)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (analysis_id, speaker_id, face_id)
     DO UPDATE SET confidence = EXCLUDED.confidence`,
    [mapping.analysisId, mapping.speakerId, mapping.faceId, mapping.confidence],
  );
}

/**
 * Save multiple speaker↔face mappings in batch.
 */
export async function saveSpeakerFaceMappings(
  mappings: SpeakerFaceInput[],
): Promise<void> {
  if (mappings.length === 0) return;

  // Use individual upserts to keep it simple
  for (const mapping of mappings) {
    await saveSpeakerFaceMapping(mapping);
  }
}

/**
 * Get all speaker↔face mappings for an analysis.
 */
export async function getMappingsForAnalysis(
  analysisId: string,
): Promise<SpeakerFaceMapping[]> {
  const result = await query<SpeakerFaceMapping>(
    `SELECT id, analysis_id, speaker_id, face_id, confidence, created_at
     FROM speaker_face_mappings
     WHERE analysis_id = $1
     ORDER BY confidence DESC, face_id ASC`,
    [analysisId],
  );
  return result.rows;
}

/**
 * Find which face ID corresponds to a speaker label.
 * Returns the highest-confidence mapping.
 */
export async function getFaceForSpeaker(
  analysisId: string,
  speakerId: string,
): Promise<SpeakerFaceMapping | null> {
  const result = await query<SpeakerFaceMapping>(
    `SELECT id, analysis_id, speaker_id, face_id, confidence, created_at
     FROM speaker_face_mappings
     WHERE analysis_id = $1 AND speaker_id = $2
     ORDER BY confidence DESC
     LIMIT 1`,
    [analysisId, speakerId],
  );
  return result.rows[0] || null;
}

/**
 * Find which speaker label corresponds to a face ID.
 */
export async function getSpeakerForFace(
  analysisId: string,
  faceId: number,
): Promise<SpeakerFaceMapping | null> {
  const result = await query<SpeakerFaceMapping>(
    `SELECT id, analysis_id, speaker_id, face_id, confidence, created_at
     FROM speaker_face_mappings
     WHERE analysis_id = $1 AND face_id = $2
     ORDER BY confidence DESC
     LIMIT 1`,
    [analysisId, faceId],
  );
  return result.rows[0] || null;
}

// ---------------------------------------------------------------------------
// Mapping Algorithm (Deterministic)
// ---------------------------------------------------------------------------

/**
 * Build speaker↔face mappings from co-occurrence data.
 *
 * Algorithm:
 *   1. For each time window, record which speakers are active and which faces are visible
 *   2. Find the face that co-occurs most frequently with each speaker
 *   3. Confidence = (co-occurrence count) / (total speaker appearances)
 *
 * @param analysisId - Analysis to map for
 * @param timeRanges - Array of { time, speakers[], faceIds[] } snapshots
 * @returns Array of mappings
 */
export function buildSpeakerFaceMappings(
  analysisId: string,
  timeRanges: Array<{
    time: number;
    speakers: string[];
    faceIds: number[];
  }>,
): SpeakerFaceInput[] {
  // Track co-occurrence: speaker → face → count
  const cooccurrence: Record<string, Record<number, number>> = {};
  const speakerTotal: Record<string, number> = {};

  for (const range of timeRanges) {
    for (const speaker of range.speakers) {
      if (!cooccurrence[speaker]) {
        cooccurrence[speaker] = {};
      }
      speakerTotal[speaker] = (speakerTotal[speaker] || 0) + 1;

      for (const faceId of range.faceIds) {
        cooccurrence[speaker][faceId] = (cooccurrence[speaker][faceId] || 0) + 1;
      }
    }
  }

  // Build mappings: for each speaker, find most co-occurring face
  const mappings: SpeakerFaceInput[] = [];

  for (const [speaker, faceCounts] of Object.entries(cooccurrence)) {
    const total = speakerTotal[speaker] || 1;
    const sortedFaces = Object.entries(faceCounts)
      .map(([faceIdStr, count]) => ({
        faceId: parseInt(faceIdStr, 10),
        count,
        confidence: count / total,
      }))
      .sort((a, b) => b.confidence - a.confidence);

    // Only create mappings above a confidence threshold
    for (const face of sortedFaces) {
      if (face.confidence >= 0.3) {
        mappings.push({
          analysisId,
          speakerId: speaker,
          faceId: face.faceId,
          confidence: Math.round(face.confidence * 100) / 100,
        });
      }
    }
  }

  return mappings;
}

// ---------------------------------------------------------------------------
// Active Speaker Detection (Helper)
// ---------------------------------------------------------------------------

/**
 * Determine the active speaker at a given timestamp.
 * Uses speaker_face_mappings + face tracking data.
 */
export async function getActiveSpeakerAtTime(
  analysisId: string,
  timestamp: number,
): Promise<{ speakerId: string | null; faceId: number | null }> {
  // Get all mappings for this analysis
  const mappings = await getMappingsForAnalysis(analysisId);

  if (mappings.length === 0) {
    return { speakerId: null, faceId: null };
  }

  // Find face that's visible at this time (from face_tracking data)
  // For now, return the highest-confidence mapping
  const bestMapping = mappings[0];
  return {
    speakerId: bestMapping.speakerId,
    faceId: bestMapping.faceId,
  };
}

/**
 * Get the primary speaker (most mapped) for an analysis.
 */
export async function getPrimarySpeaker(
  analysisId: string,
): Promise<{ speakerId: string | null; faceId: number | null }> {
  const mappings = await getMappingsForAnalysis(analysisId);

  if (mappings.length === 0) {
    return { speakerId: null, faceId: null };
  }

  return {
    speakerId: mappings[0].speakerId,
    faceId: mappings[0].faceId,
  };
}
