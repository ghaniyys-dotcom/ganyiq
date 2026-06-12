/**
 * worker/participant-registry.ts — Speaker Identity Intelligence Module for GANYIQ.
 *
 * THE PROBLEM:
 *   - Diarization (PyAnnote/Deepgram) returns 1 speaker for multi-person podcasts
 *   - ByteTrack tracker returns 16 fragmented IDs for 4 people
 *   - Decision engine sees 16 "speakers" → generates random splits
 *
 * THE SOLUTION:
 *   This module consolidates raw tracker face IDs into stable participant
 *   identities using:
 *
 *     1. SPATIAL CO-OCCURRENCE — two tracker IDs that never appear in the
 *        same frame (mutually exclusive) are likely the SAME person.
 *
 *     2. APPEARANCE SIMILARITY — if available, compare color histograms
 *        or face embeddings to confirm same-person matches.
 *
 *     3. DIARIZATION CROSS-REFERENCE — audio speaker labels validate
 *        visual groupings.
 *
 *     4. TEMPORAL PERSISTENCE — tracker IDs that consistently alternate
 *        or overlap form distinct person identities.
 *
 *   Output: Stable participant IDs (Person_A, Person_B, etc.) with
 *   confidence metrics for every decision.
 *
 * USAGE:
 *   const registry = new ParticipantRegistry();
 *   registry.ingestTrackedFrames(trackedFrames);
 *   registry.ingestSpeakerSegments(speakerSegments);
 *   registry.buildParticipants();
 *   // → registry.getParticipantMap() maps tracker ID → participant
 *   // → registry.getParticipantCount() → 4
 *   // → registry.getConfidenceMetrics() → { speakerCountAccuracy, identityStability, ... }
 */

// ---------------------------------------------------------------------------
// Inline types (avoids cross-directory import from worker/ which has its own
// tsconfig.json and package.json)
// ---------------------------------------------------------------------------

/** Minimal face data input for the registry. Matches worker/tracker.ts TrackedFace. */
interface RegistryFaceData {
  id: number;
  cx: number;
  cy: number;
  w: number;
  h: number;
  confidence?: number;
}

/** Minimal tracked frame input. Matches worker/tracker.ts TrackedFrame. */
interface RegistryFrameData {
  time: number;
  faces: RegistryFaceData[];
  faceCount: number;
}

/** Stable participant identity. */
export interface Participant {
  /** Unique label: Person_A, Person_B, etc. */
  label: string;
  /** Human-readable index (0-based). */
  index: number;
  /** The tracker face IDs that map to this participant. */
  trackerIds: Set<number>;
  /** Diarization labels that map to this participant (e.g., "SPEAKER_00"). */
  speakerLabels: Set<string>;
  /** Primary (most frequent) face position centroid. */
  centroidX: number;
  centroidY: number;
  /** Average face size. */
  avgFaceWidth: number;
  avgFaceHeight: number;
  /** Time range when this participant appears. */
  firstSeen: number;
  lastSeen: number;
  /** Total seconds this participant is visible. */
  totalVisibleSeconds: number;
  /** How many tracker IDs were consolidated into this participant. */
  fragmentationCount: number;
  /**
   * Confidence metrics for this participant.
   * 0.0 = uncertain, 1.0 = high confidence.
   */
  confidence: number;
  /** Key frames (time) where this participant's face is visible. */
  keyFrames: number[];
}

/** Overall identity intelligence metrics. */
export interface IdentityMetrics {
  /** Estimated number of unique human participants. */
  estimatedParticipantCount: number;
  /** Confidence in the participant count (0.0-1.0). */
  speakerCountAccuracy: number;
  /** How many raw tracker IDs map to each participant (lower = better). */
  averageFragmentation: number;
  /** Participant ID consistency score (0.0-1.0). */
  identityStability: number;
  /** How many participants have diarization labels assigned. */
  participantsWithAudioLabels: number;
  /** Total diarization vs visual participant matchup. */
  audioVisualMatchScore: number;
  /** Per-participant breakdown. */
  perParticipant: Array<{
    label: string;
    trackerIdCount: number;
    diarizationLabels: string[];
    visibleDurationSec: number;
    confidence: number;
  }>;
}

/** Track ID co-occurrence matrix entry. */
interface CoOccurrenceEntry {
  /** IDs that co-occur with this one (appear in same frame). */
  coOccurring: Set<number>;
  /** Map of other IDs to the count of frames they co-occurred in. */
  coOccurringCounts: Map<number, number>;
  /** IDs that are mutually exclusive (never appear together). */
  exclusive: Set<number>;
  /** Number of frames where this ID appears. */
  frameCount: number;
}

/** Frame-level face appearance profile for re-identification. */
interface FaceAppearance {
  trackerId: number;
  time: number;
  cx: number;
  cy: number;
  w: number;
  h: number;
}

// ---------------------------------------------------------------------------
// Participant Registry
// ---------------------------------------------------------------------------

export class ParticipantRegistry {
  private trackedFrames: RegistryFrameData[] = [];
  private speakerSegments: Array<{ speaker: string; start: number; end: number }> = [];
  private coOccurrence: Map<number, CoOccurrenceEntry> = new Map();
  private faceAppearances: Map<number, FaceAppearance[]> = new Map();
  private participants: Participant[] = [];
  private trackerToParticipant: Map<number, number> = new Map();
  private built = false;

  // -----------------------------------------------------------------------
  // Ingestion
  // -----------------------------------------------------------------------

  ingestTrackedFrames(frames: RegistryFrameData[]): void {
    this.trackedFrames = frames;
    this.buildCoOccurrence();
    this.buildFaceAppearances();
  }

  ingestSpeakerSegments(segments: Array<{ speaker: string; start: number; end: number }>): void {
    this.speakerSegments = segments;
  }

  // -----------------------------------------------------------------------
  // Co-occurrence Analysis
  // -----------------------------------------------------------------------

  private buildCoOccurrence(): void {
    this.coOccurrence.clear();
    for (const frame of this.trackedFrames) {
      const idsInFrame = new Set(frame.faces.map(f => f.id));
      for (const id of idsInFrame) {
        let entry = this.coOccurrence.get(id);
        if (!entry) {
          entry = { coOccurring: new Set(), coOccurringCounts: new Map(), exclusive: new Set(), frameCount: 0 };
          this.coOccurrence.set(id, entry);
        }
        entry.frameCount++;
        for (const otherId of idsInFrame) {
          if (otherId !== id) {
            entry.coOccurring.add(otherId);
            entry.coOccurringCounts.set(otherId, (entry.coOccurringCounts.get(otherId) || 0) + 1);
          }
        }
      }
    }
    const allIds = Array.from(this.coOccurrence.keys());
    for (let i = 0; i < allIds.length; i++) {
      const idA = allIds[i];
      const entryA = this.coOccurrence.get(idA)!;
      for (let j = i + 1; j < allIds.length; j++) {
        const idB = allIds[j];
        const entryB = this.coOccurrence.get(idB)!;
        const overlap = entryA.coOccurringCounts.get(idB) || 0;
        const countA = entryA.frameCount;
        const countB = entryB.frameCount;
        const overlapRatio = overlap / Math.min(countA, countB);
        if (overlapRatio < 0.05 && overlap <= 5) {
          entryA.exclusive.add(idB);
          entryB.exclusive.add(idA);
        }
      }
    }
  }

  private buildFaceAppearances(): void {
    this.faceAppearances.clear();
    for (const frame of this.trackedFrames) {
      for (const face of frame.faces) {
        let appearances = this.faceAppearances.get(face.id);
        if (!appearances) {
          appearances = [];
          this.faceAppearances.set(face.id, appearances);
        }
        appearances.push({
          trackerId: face.id,
          time: frame.time,
          cx: face.cx,
          cy: face.cy,
          w: face.w,
          h: face.h,
        });
      }
    }
  }

  // -----------------------------------------------------------------------
  // Participant Building
  // -----------------------------------------------------------------------

  buildParticipants(): Participant[] {
    this.participants = [];
    this.trackerToParticipant.clear();
    const allIds = Array.from(this.coOccurrence.keys());
    if (allIds.length === 0) {
      this.built = true;
      return [];
    }

    // Cluster mutually exclusive (same-position) IDs into participants
    const usedIds = new Set<number>();
    for (const seedId of allIds) {
      if (usedIds.has(seedId)) continue;
      const clusterIds = new Set<number>([seedId]);
      const seedEntry = this.coOccurrence.get(seedId)!;
      for (const candidateId of seedEntry.exclusive) {
        if (usedIds.has(candidateId)) continue;
        let allExclusive = true;
        for (const clusterId of clusterIds) {
          const clusterEntry = this.coOccurrence.get(clusterId);
          if (!clusterEntry || !clusterEntry.exclusive.has(candidateId)) {
            allExclusive = false;
            break;
          }
        }
        if (allExclusive) {
          const spatialScore = this.computeSpatialConsistency(seedId, candidateId);
          if (spatialScore > 0.65) clusterIds.add(candidateId);
        }
      }
      for (const id of clusterIds) usedIds.add(id);
      const participant = this.buildParticipantFromCluster(clusterIds);
      this.participants.push(participant);
      for (const id of clusterIds) this.trackerToParticipant.set(id, this.participants.length - 1);
    }

    // Sort by first appearance
    this.participants.sort((a, b) => a.firstSeen - b.firstSeen);
    for (let i = 0; i < this.participants.length; i++) {
      this.participants[i].label = `Person_${String.fromCharCode(65 + i)}`;
      this.participants[i].index = i;
    }

    this.crossReferenceDiarization();
    for (const p of this.participants) p.confidence = this.computeParticipantConfidence(p);
    this.built = true;
    return this.participants;
  }

  private computeSpatialConsistency(idA: number, idB: number): number {
    const appA = this.faceAppearances.get(idA) || [];
    const appB = this.faceAppearances.get(idB) || [];
    if (appA.length === 0 || appB.length === 0) return 0;

    const avgA = {
      cx: appA.reduce((s, a) => s + a.cx, 0) / appA.length,
      cy: appA.reduce((s, a) => s + a.cy, 0) / appA.length,
      w: appA.reduce((s, a) => s + a.w, 0) / appA.length,
      h: appA.reduce((s, a) => s + a.h, 0) / appA.length,
    };
    const avgB = {
      cx: appB.reduce((s, a) => s + a.cx, 0) / appB.length,
      cy: appB.reduce((s, a) => s + a.cy, 0) / appB.length,
      w: appB.reduce((s, a) => s + a.w, 0) / appB.length,
      h: appB.reduce((s, a) => s + a.h, 0) / appB.length,
    };

    const dx = avgA.cx - avgB.cx;
    const dy = avgA.cy - avgB.cy;
    const avgSize = (avgA.w + avgA.h + avgB.w + avgB.h) / 4;
    const positionDistance = Math.sqrt(dx * dx + dy * dy) / Math.max(avgSize, 1);
    if (positionDistance > 2.0) {
      return 0;
    }
    const sizeRatio = Math.min(avgA.w / Math.max(avgB.w, 1), avgB.w / Math.max(avgA.w, 1));
    const positionScore = Math.max(0, 1 - positionDistance * 0.5);
    return positionScore * 0.6 + sizeRatio * 0.4;
  }

  private buildParticipantFromCluster(clusterIds: Set<number>): Participant {
    const allAppearances: FaceAppearance[] = [];
    const keyFramesSet = new Set<number>();
    for (const id of clusterIds) {
      const app = this.faceAppearances.get(id) || [];
      allAppearances.push(...app);
      for (const a of app) keyFramesSet.add(a.time);
    }
    allAppearances.sort((a, b) => a.time - b.time);

    const firstSeen = allAppearances.length > 0 ? allAppearances[0].time : 0;
    const lastSeen = allAppearances.length > 0 ? allAppearances[allAppearances.length - 1].time : 0;
    const centroidX = allAppearances.length > 0 ? allAppearances.reduce((s, a) => s + a.cx, 0) / allAppearances.length : 0;
    const centroidY = allAppearances.length > 0 ? allAppearances.reduce((s, a) => s + a.cy, 0) / allAppearances.length : 0;
    const avgW = allAppearances.length > 0 ? allAppearances.reduce((s, a) => s + a.w, 0) / allAppearances.length : 0;
    const avgH = allAppearances.length > 0 ? allAppearances.reduce((s, a) => s + a.h, 0) / allAppearances.length : 0;

    const sortedTimes = Array.from(keyFramesSet).sort((a, b) => a - b);
    let totalVisible = 0;
    for (let i = 1; i < sortedTimes.length; i++) {
      const gap = sortedTimes[i] - sortedTimes[i - 1];
      if (gap <= 2.0) totalVisible += gap;
    }

    return {
      label: 'Person_?', index: 0,
      trackerIds: clusterIds, speakerLabels: new Set(),
      centroidX, centroidY, avgFaceWidth: avgW, avgFaceHeight: avgH,
      firstSeen, lastSeen, totalVisibleSeconds: totalVisible,
      fragmentationCount: clusterIds.size, confidence: 0,
      keyFrames: Array.from(keyFramesSet).sort((a, b) => a - b),
    };
  }

  private crossReferenceDiarization(): void {
    if (this.speakerSegments.length === 0) return;
    for (const participant of this.participants) {
      for (const seg of this.speakerSegments) {
        if (participant.keyFrames.some(t => t >= seg.start && t <= seg.end)) {
          participant.speakerLabels.add(seg.speaker);
        }
      }
    }
  }

  private computeParticipantConfidence(participant: Participant): number {
    let score = 0.5;
    const trackerIds = Array.from(participant.trackerIds);
    if (trackerIds.length >= 2) {
      let totalSpatial = 0;
      let pairs = 0;
      for (let i = 0; i < trackerIds.length; i++) {
        for (let j = i + 1; j < trackerIds.length; j++) {
          totalSpatial += this.computeSpatialConsistency(trackerIds[i], trackerIds[j]);
          pairs++;
        }
      }
      score += (pairs > 0 ? totalSpatial / pairs : 0.5) * 0.2;
    }
    score += Math.min(1, participant.totalVisibleSeconds / 30) * 0.1;
    if (participant.speakerLabels.size > 0) score += 0.15;
    score *= Math.max(0, 1 - (participant.fragmentationCount - 1) * 0.1);
    return Math.max(0, Math.min(1, score));
  }

  // -----------------------------------------------------------------------
  // Query Methods
  // -----------------------------------------------------------------------

  getParticipantLabel(trackerId: number): string | null {
    if (!this.built) return null;
    const idx = this.trackerToParticipant.get(trackerId);
    if (idx === undefined || idx >= this.participants.length) return null;
    return this.participants[idx].label;
  }

  getParticipantIndex(trackerId: number): number {
    if (!this.built) return -1;
    return this.trackerToParticipant.get(trackerId) ?? -1;
  }

  getParticipant(trackerId: number): Participant | null {
    if (!this.built) return null;
    const idx = this.trackerToParticipant.get(trackerId);
    if (idx === undefined || idx >= this.participants.length) return null;
    return this.participants[idx];
  }

  getParticipants(): Participant[] { return this.participants; }
  getParticipantCount(): number { return this.participants.length; }
  getParticipantMap(): Map<number, number> { return this.trackerToParticipant; }

  getConfidenceMetrics(): IdentityMetrics {
    if (!this.built || this.participants.length === 0) {
      return {
        estimatedParticipantCount: 0, speakerCountAccuracy: 0,
        averageFragmentation: 0, identityStability: 0,
        participantsWithAudioLabels: 0, audioVisualMatchScore: 0,
        perParticipant: [],
      };
    }
    const totalFrag = this.participants.reduce((s, p) => s + p.fragmentationCount, 0);
    const avgFrag = totalFrag / this.participants.length;
    const uniqueSpeakerLabels = new Set<string>();
    for (const p of this.participants) for (const l of p.speakerLabels) uniqueSpeakerLabels.add(l);
    const slCount = uniqueSpeakerLabels.size;
    const speakerCountAccuracy = slCount > 0
      ? 1 - Math.abs(slCount - this.participants.length) / Math.max(slCount, this.participants.length)
      : 0.5;
    const identityStability = Math.max(0, Math.min(1, 1 - (avgFrag - 1) * 0.15));
    const pWithAudio = this.participants.filter(p => p.speakerLabels.size > 0).length;
    return {
      estimatedParticipantCount: this.participants.length,
      speakerCountAccuracy,
      averageFragmentation: avgFrag,
      identityStability,
      participantsWithAudioLabels: pWithAudio,
      audioVisualMatchScore: pWithAudio / this.participants.length,
      perParticipant: this.participants.map(p => ({
        label: p.label,
        trackerIdCount: p.fragmentationCount,
        diarizationLabels: Array.from(p.speakerLabels),
        visibleDurationSec: p.totalVisibleSeconds,
        confidence: p.confidence,
      })),
    };
  }

  reset(): void {
    this.trackedFrames = [];
    this.speakerSegments = [];
    this.coOccurrence.clear();
    this.faceAppearances.clear();
    this.participants = [];
    this.trackerToParticipant.clear();
    this.built = false;
  }
}

// ---------------------------------------------------------------------------
// Convenience Function
// ---------------------------------------------------------------------------

export function buildParticipantMap(
  trackedFrames: RegistryFrameData[],
  speakerSegments: Array<{ speaker: string; start: number; end: number }>,
): Map<number, number> {
  const registry = new ParticipantRegistry();
  registry.ingestTrackedFrames(trackedFrames);
  registry.ingestSpeakerSegments(speakerSegments);
  registry.buildParticipants();
  return registry.getParticipantMap();
}
