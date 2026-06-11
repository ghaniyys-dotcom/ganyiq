/**
 * worker/decision-engine.ts — Rendering Decision Engine for GANYIQ V3 (P1.1)
 *
 * Transforms raw face tracking + speaker detection data into cinematic,
 * professionally-edited video segments with:
 *
 *   1. EMA Camera Smoothing — fluid, eased camera movements
 *   2. Reaction Cut Logic — deliberately cut to listener reactions
 *   3. Smart Layout Switching — conversation-aware multi-person layouts
 *   4. Peak Moment Escalation — escalate layout during high-energy moments
 *
 * Supported layouts:
 *   SINGLE         — 1 face, full 1080x1920
 *   SPLIT_2        — 2 faces, 50/50 vertical stack
 *   SPLIT_3        — 3 faces, 33/33/33 or hero+2 grid
 *   SPLIT_4        — 4 faces, 2x2 grid
 *   REACTION_CUT   — brief cut to listener reaction (overrides others)
 *   LISTENER_PIP   — picture-in-picture: speaker full + listener inset
 *   HERO_REACTION  — 60/40 top/bottom: primary speaker + 1-2 reaction panels
 *   WIDE_CONTEXT   — wider crop (10% less zoom) for gesturing/context
 */

import type { SpeakerFrame, AudioEventType } from './speaker-detector';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Layout modes available to the rendering engine. */
export enum DecisionMode {
  SINGLE = 'single',               // 1 face, full 9:16 frame
  SPLIT_2 = 'split_2',             // 2 faces, 50/50 vertical stack
  SPLIT_3 = 'split_3',             // 3 faces, 33/33/33 vertical stack
  SPLIT_4 = 'split_4',             // 4 faces, 2x2 grid
  REACTION_CUT = 'reaction_cut',   // brief cut to listener reaction
  LISTENER_PIP = 'listener_pip',   // speaker full + listener inset
  HERO_REACTION = 'hero_reaction', // 60/40 speaker + reaction panels
  WIDE_CONTEXT = 'wide_context',   // wider crop (90% zoom)
}

/** Per-frame decision output. */
export interface DecisionFrame {
  time: number;
  mode: DecisionMode;
  /** Primary speaker face ID and crop (EMA-smoothed). */
  primaryFaceId: number | null;
  primaryCropX: number;       // raw (before EMA)
  primaryCropY: number;
  smoothCropX: number;        // after EMA filtering
  smoothCropY: number;
  secondaryFaceId: number | null;
  secondaryCropX: number;
  secondaryCropY: number;
  tertiaryFaceId: number | null;
  tertiaryCropX: number;
  tertiaryCropY: number;
  quaternaryFaceId: number | null;
  quaternaryCropX: number;
  quaternaryCropY: number;
  audioEvent: AudioEventType;
  eventConfidence: number;
  transitionAlpha: number;
  /** Peak moment score (0-100). >50 triggers escalation. */
  peakScore: number;
}

/** A rendered segment exported to clip-renderer. */
export interface DecisionSegment {
  startTime: number;
  endTime: number;
  mode: DecisionMode;
  crops: Array<{
    cropX: number;
    cropY: number;
    faceId: number;
    confidence: number;
    isReaction?: boolean;
  }>;
  transitionOut?: {
    type: 'crossfade' | 'none';
    duration: number;
  };
}

/** Full engine output. */
export interface DecisionResult {
  segments: DecisionSegment[];
  decisionFrames: DecisionFrame[];
  totalReactionCuts: number;
  totalLayoutSwitches: number;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Reaction cut tunables
const REACTION_HOLD_MIN = 0.8;
const REACTION_HOLD_MAX = 1.8;
const REACTION_COOLDOWN = 2.5;
const REACTION_EVENT_DELAY = 0.15;

// Layout hold timers (prevent flicker)
const LAYOUT_HOLD_SINGLE = 1.5;
const LAYOUT_HOLD_SPLIT = 1.5;
const LAYOUT_HOLD_SPLIT_3 = 2.0;
const LAYOUT_HOLD_SPLIT_4 = 2.5;
const LAYOUT_HOLD_PIP = 2.0;
const LAYOUT_HOLD_PIP_ACTIVATE = 2.0;
const LAYOUT_HOLD_HERO = 2.0;
const LAYOUT_HOLD_WIDE = 1.5;

// Speaker activity thresholds
const SPLIT_MIN_SPEAKERS = 2;
const SPEAKER_WINDOW_SEC = 5.0;

// EMA smoothing
const EMA_ALPHA_DEFAULT = 0.15;
const EMA_ALPHA_SPRINT = 0.6;
const EMA_SPRINT_FRAMES = 3;

// Reaction duration by event type
const REACTION_CUT_DURATION_FACTOR: Record<AudioEventType, number> = {
  'normal': 0,
  'laughter': 1.5,
  'gasp': 1.2,
  'emotion_peak': 1.4,
  'silence': 0,
  'applause': 1.0,
};

// Peak moment thresholds
const PEAK_MOMENT_ESCALATE = 50;   // min score to escalate layout
const PEAK_MOMENT_MAX = 80;        // max escalation level
const PEAK_HOLD_DECAY = 0.5;       // seconds decay after peak ends

// Visual rhythm
const MIN_SHOT_DURATION = 0.5;     // discard sub-500ms segments
const MAX_SHOT_DURATION = 8.0;     // force cut after 8s
const MAX_CUTS_PER_WINDOW = 3;     // max cuts in 5s window
const CUT_SUPPRESSION_WINDOW = 5.0;

function log(tag: string, message: string): void {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] [DECISION${tag.padEnd(4)}] ${message}`);
}

// ===========================================================================
// Speaker Activity Tracker
// ===========================================================================

class SpeakerActivityTracker {
  private events: Array<{ faceId: number; time: number }> = [];
  private readonly windowSec: number;

  constructor(windowSec: number = SPEAKER_WINDOW_SEC) {
    this.windowSec = windowSec;
  }

  recordSpeaker(faceId: number, time: number): void {
    this.events.push({ faceId, time });
    this.prune(time);
  }

  getActiveSpeakers(currentTime: number): Set<number> {
    this.prune(currentTime);
    return new Set(this.events.map(e => e.faceId));
  }

  getActiveSpeakerCount(currentTime: number): number {
    return this.getActiveSpeakers(currentTime).size;
  }

  isRecentlyActive(faceId: number, currentTime: number): boolean {
    this.prune(currentTime);
    return this.events.some(e => e.faceId === faceId);
  }

  /** Get speaker count for a specific face */
  getSpeakerFrequency(faceId: number, currentTime: number): number {
    this.prune(currentTime);
    return this.events.filter(e => e.faceId === faceId).length;
  }

  private prune(currentTime: number): void {
    const cutoff = currentTime - this.windowSec;
    this.events = this.events.filter(e => e.time >= cutoff);
  }

  reset(): void {
    this.events = [];
  }
}

// ===========================================================================
// EMA Camera Smoother
// ===========================================================================

class EmaCameraSmoother {
  private smoothX: number | null = null;
  private smoothY: number | null = null;
  private alpha: number;
  private sprintRemaining: number = 0;
  private sprintAlpha: number;

  constructor(alpha: number = EMA_ALPHA_DEFAULT, sprintAlpha: number = EMA_ALPHA_SPRINT) {
    this.alpha = alpha;
    this.sprintAlpha = sprintAlpha;
  }

  getCurrentAlpha(): number {
    return this.sprintRemaining > 0 ? this.sprintAlpha : this.alpha;
  }

  push(targetX: number, targetY: number, forceSprint: boolean = false): { x: number; y: number } {
    if (this.smoothX === null || this.smoothY === null) {
      this.smoothX = targetX;
      this.smoothY = targetY;
      return { x: this.smoothX, y: this.smoothY };
    }

    const effectiveAlpha = forceSprint || this.sprintRemaining > 0
      ? this.sprintAlpha
      : this.alpha;

    this.smoothX = this.smoothX + effectiveAlpha * (targetX - this.smoothX);
    this.smoothY = this.smoothY + effectiveAlpha * (targetY - this.smoothY);

    if (forceSprint) {
      this.sprintRemaining = EMA_SPRINT_FRAMES;
    } else if (this.sprintRemaining > 0) {
      this.sprintRemaining--;
    }

    return { x: Math.round(this.smoothX), y: Math.round(this.smoothY) };
  }

  reset(): void {
    this.smoothX = null;
    this.smoothY = null;
    this.sprintRemaining = 0;
  }
}

// ===========================================================================
// Reaction Cut Scheduler
// ===========================================================================

class ReactionScheduler {
  private state: 'idle' | 'pending' | 'active' = 'idle';
  private pendingEvent: AudioEventType = 'normal';
  private pendingConfidence: number = 0;
  private pendingTime: number = 0;
  private pendingListenerFaceId: number | null = null;
  private activationTime: number = 0;
  private lastReactionEnd: number = -REACTION_COOLDOWN;

  get isActive(): boolean { return this.state === 'active'; }
  get isPending(): boolean { return this.state === 'pending'; }
  get hasHadReaction(): boolean { return this.lastReactionEnd > -REACTION_COOLDOWN / 2; }
  get currentListenerFaceId(): number | null {
    return this.state === 'active' || this.state === 'pending'
      ? this.pendingListenerFaceId
      : null;
  }

  offerEvent(
    eventType: AudioEventType,
    confidence: number,
    currentTime: number,
    listenerFaceIds: number[],
    speakerFaceIds: number[],
  ): boolean {
    if (eventType === 'normal' || eventType === 'silence') return false;
    if (confidence < 0.4) return false;

    const validListeners = listenerFaceIds.filter(id => !speakerFaceIds.includes(id));
    if (validListeners.length === 0) return false;

    if (currentTime - this.lastReactionEnd < REACTION_COOLDOWN) return false;
    if (this.state === 'active') return false;

    this.state = 'pending';
    this.pendingEvent = eventType;
    this.pendingConfidence = confidence;
    this.pendingTime = currentTime;
    this.pendingListenerFaceId = validListeners[0];
    log('EVENT', `Reaction scheduled: ${eventType} (conf=${confidence.toFixed(2)}) → face ${validListeners[0]} at ${currentTime.toFixed(1)}s`);
    return true;
  }

  tick(currentTime: number): 'activate' | 'continue' | 'end' | null {
    if (this.state === 'pending') {
      if (currentTime - this.pendingTime >= REACTION_EVENT_DELAY) {
        this.state = 'active';
        this.activationTime = currentTime;
        log('EVENT', `Reaction ACTIVATED: ${this.pendingEvent} at ${currentTime.toFixed(1)}s`);
        return 'activate';
      }
      return null;
    }

    if (this.state === 'active') {
      const duration = currentTime - this.activationTime;
      const maxHold = REACTION_CUT_DURATION_FACTOR[this.pendingEvent] || REACTION_HOLD_MIN;
      const holdDuration = Math.max(REACTION_HOLD_MIN, Math.min(REACTION_HOLD_MAX, maxHold));

      if (duration >= holdDuration) {
        this.state = 'idle';
        this.lastReactionEnd = currentTime;
        log('EVENT', `Reaction ended at ${currentTime.toFixed(1)}s (held ${duration.toFixed(1)}s)`);
        return 'end';
      }
      return 'continue';
    }

    return null;
  }

  reset(): void {
    this.state = 'idle';
    this.pendingEvent = 'normal';
    this.pendingConfidence = 0;
    this.pendingTime = 0;
    this.pendingListenerFaceId = null;
    this.activationTime = 0;
    this.lastReactionEnd = -REACTION_COOLDOWN;
  }
}

// ===========================================================================
// Peak Moment Detector
// ===========================================================================

/**
 * Detects high-energy moments and computes a peak score for layout escalation.
 *
 * Signals considered:
 *   - Simultaneous reactions (2+ faces with non-normal event)
 *   - Rapid speaker exchange (3+ turns in 8s)
 *   - High-confidence audio events (laughter, applause)
 *   - Visual reactions from multiple faces
 */
class PeakMomentDetector {
  private turnTimes: number[] = [];
  private reactionWindowEvents: Array<{ time: number; type: AudioEventType; confidence: number }> = [];
  private lastReactionCount: number = 0;
  private peakScore: number = 0;
  private peakStartTime: number = 0;
  private isPeaking: boolean = false;

  get currentPeakScore(): number { return this.peakScore; }
  get isCurrentlyPeaking(): boolean { return this.isPeaking; }

  recordTurn(time: number): void {
    this.turnTimes.push(time);
    this.pruneTurns(time);
  }

  recordReaction(time: number, eventType: AudioEventType, confidence: number): void {
    if (eventType !== 'normal' && eventType !== 'silence') {
      this.reactionWindowEvents.push({ time, type: eventType, confidence });
    }
    this.pruneReactions(time);
  }

  tick(currentTime: number): number {
    this.pruneTurns(currentTime);
    this.pruneReactions(currentTime);

    let score = 0;

    // Factor 1: Rapid speaker exchange (max 30 pts)
    const turnsInWindow = this.turnTimes.length;
    if (turnsInWindow >= 3) {
      score += Math.min(30, turnsInWindow * 8);
    }

    // Factor 2: Multiple simultaneous reactions (max 40 pts)
    const recentReactions = this.reactionWindowEvents;
    const uniqueTypes = new Set(recentReactions.map(e => e.type));
    const highConfEvents = recentReactions.filter(e => e.confidence > 0.6);
    if (highConfEvents.length >= 2) {
      score += Math.min(40, highConfEvents.length * 15);
    } else if (recentReactions.length >= 2) {
      score += Math.min(20, recentReactions.length * 8);
    }

    // Factor 3: High-confidence laughter/applause (max 30 pts)
    const laughterEvents = recentReactions.filter(
      e => (e.type === 'laughter' || e.type === 'applause') && e.confidence > 0.5
    );
    if (laughterEvents.length > 0) {
      score += Math.min(30, laughterEvents.length * 12);
    }

    // Smooth and track peak state
    this.peakScore = this.peakScore * 0.8 + score * 0.2;

    if (this.peakScore > PEAK_MOMENT_ESCALATE && !this.isPeaking) {
      this.isPeaking = true;
      this.peakStartTime = currentTime;
      log('PEAK', `Peak moment detected: score=${this.peakScore.toFixed(0)}`);
    }

    if (this.isPeaking && this.peakScore < PEAK_MOMENT_ESCALATE * 0.6 &&
        currentTime - this.peakStartTime > PEAK_HOLD_DECAY) {
      this.isPeaking = false;
      log('PEAK', `Peak moment ended: score=${this.peakScore.toFixed(0)}`);
    }

    return Math.round(this.peakScore);
  }

  private pruneTurns(time: number): void {
    const cutoff = time - CUT_SUPPRESSION_WINDOW;
    this.turnTimes = this.turnTimes.filter(t => t >= cutoff);
  }

  private pruneReactions(time: number): void {
    const cutoff = time - 3.0;
    this.reactionWindowEvents = this.reactionWindowEvents.filter(e => e.time >= cutoff);
  }

  reset(): void {
    this.turnTimes = [];
    this.reactionWindowEvents = [];
    this.peakScore = 0;
    this.isPeaking = false;
  }
}

// ===========================================================================
// Cut Suppression Tracker
// ===========================================================================

class CutSuppressionTracker {
  private cutTimes: number[] = [];

  recordCut(time: number): void {
    this.cutTimes.push(time);
    this.prune(time);
  }

  isSuppressed(time: number): boolean {
    this.prune(time);
    return this.cutTimes.length >= MAX_CUTS_PER_WINDOW;
  }

  timeSinceLastCut(time: number): number {
    this.prune(time);
    if (this.cutTimes.length === 0) return Infinity;
    return time - this.cutTimes[this.cutTimes.length - 1];
  }

  private prune(time: number): void {
    const cutoff = time - CUT_SUPPRESSION_WINDOW;
    this.cutTimes = this.cutTimes.filter(t => t >= cutoff);
  }

  reset(): void {
    this.cutTimes = [];
  }
}

// ===========================================================================
// Main Decision Engine
// ===========================================================================

export interface DecisionEngineConfig {
  emaAlphaDefault: number;
  emaAlphaSprint: number;
  emaSprintFrames: number;
  reactionHoldMin: number;
  reactionHoldMax: number;
  reactionCooldown: number;
  layoutHoldSingle: number;
  layoutHoldSplit: number;
  layoutHoldPip: number;
  splitMinSpeakers: number;
  speakerWindowSec: number;
  verticalWidth: number;
  verticalHeight: number;
}

const DEFAULT_CONFIG: DecisionEngineConfig = {
  emaAlphaDefault: EMA_ALPHA_DEFAULT,
  emaAlphaSprint: EMA_ALPHA_SPRINT,
  emaSprintFrames: EMA_SPRINT_FRAMES,
  reactionHoldMin: REACTION_HOLD_MIN,
  reactionHoldMax: REACTION_HOLD_MAX,
  reactionCooldown: REACTION_COOLDOWN,
  layoutHoldSingle: LAYOUT_HOLD_SINGLE,
  layoutHoldSplit: LAYOUT_HOLD_SPLIT,
  layoutHoldPip: LAYOUT_HOLD_PIP,
  splitMinSpeakers: SPLIT_MIN_SPEAKERS,
  speakerWindowSec: SPEAKER_WINDOW_SEC,
  verticalWidth: 1080,
  verticalHeight: 1920,
};

/**
 * Rendering Decision Engine V3 — Multi-person split-screen intelligence.
 *
 * Key behaviors:
 *   - Conversation-aware layout switching (SINGLE ↔ SPLIT_2/3/4 ↔ PiP ↔ HERO)
 *   - Peak moment escalation (escalate layout during high-energy moments)
 *   - Cut suppression (prevents rapid flickering)
 *   - EMA-smooth camera movement
 *   - Dynamic reaction cuts
 */
export class DecisionEngine {
  private config: DecisionEngineConfig;
  private smoother: EmaCameraSmoother;
  private scheduler: ReactionScheduler;
  private speakerTracker: SpeakerActivityTracker;
  private peakDetector: PeakMomentDetector;
  private cutSuppressor: CutSuppressionTracker;

  // State machine
  private currentMode: DecisionMode = DecisionMode.SINGLE;
  private modeSwitchTime: number = 0;
  private modeSwitchCount: number = 0;
  private primaryFaceId: number | null = null;
  private secondaryFaceId: number | null = null;
  private tertiaryFaceId: number | null = null;
  private quaternaryFaceId: number | null = null;

  constructor(config?: Partial<DecisionEngineConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.smoother = new EmaCameraSmoother(this.config.emaAlphaDefault, this.config.emaAlphaSprint);
    this.scheduler = new ReactionScheduler();
    this.speakerTracker = new SpeakerActivityTracker(this.config.speakerWindowSec);
    this.peakDetector = new PeakMomentDetector();
    this.cutSuppressor = new CutSuppressionTracker();
  }

  process(
    speakerFrames: SpeakerFrame[],
    sourceWidth: number,
    sourceHeight: number,
  ): DecisionResult {
    if (speakerFrames.length === 0) {
      return { segments: [], decisionFrames: [], totalReactionCuts: 0, totalLayoutSwitches: 0 };
    }

    this.reset();
    const cropH = sourceHeight;
    const cropW = sourceHeight * (this.config.verticalWidth / this.config.verticalHeight);
    const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

    const decisionFrames: DecisionFrame[] = [];
    let modeChangedThisFrame = false;
    let peakEscalatedMode: DecisionMode | null = null;

    for (let fi = 0; fi < speakerFrames.length; fi++) {
      const frame = speakerFrames[fi];
      const t = frame.time;

      // Track speaker activity
      if (frame.activeSpeakerId !== null) {
        this.speakerTracker.recordSpeaker(frame.activeSpeakerId, t);
      }

      // Compute raw crop positions for each distinct face
      const faceCrops = new Map<number, { cx: number; cy: number }>();
      for (const face of frame.faces) {
        const isWideContext = this.currentMode === DecisionMode.WIDE_CONTEXT;
        const effectiveCropW = isWideContext ? cropW * 0.9 : cropW;
        const cx = clamp(face.cx - effectiveCropW / 2, 0, sourceWidth - effectiveCropW);
        const cy = clamp(face.cy - cropH * 0.35, 0, sourceHeight - cropH);
        faceCrops.set(face.id, { cx: Math.round(cx), cy: Math.round(cy) });
      }

      // Track peak moment
      this.peakDetector.recordReaction(t, frame.audioEvent, frame.audioEventConfidence);
      const peakScore = this.peakDetector.tick(t);

      // Determine if peak escalation overrides current layout
      if (this.peakDetector.isCurrentlyPeaking && !this.scheduler.isActive) {
        peakEscalatedMode = this.getEscalatedMode(frame, t);
      } else {
        peakEscalatedMode = null;
      }

      // Determine layout mode
      const { mode, primaryId, secondaryId, tertiaryId, quaternaryId } =
        this.decideLayout(frame, t, peakEscalatedMode);

      modeChangedThisFrame = mode !== this.currentMode;
      if (modeChangedThisFrame) {
        this.modeSwitchCount++;
        this.currentMode = mode;
        this.modeSwitchTime = t;
        this.cutSuppressor.recordCut(t);
      }

      // Update face IDs
      this.primaryFaceId = primaryId ?? this.primaryFaceId;
      this.secondaryFaceId = secondaryId ?? this.secondaryFaceId;
      this.tertiaryFaceId = tertiaryId ?? this.tertiaryFaceId;
      this.quaternaryFaceId = quaternaryId ?? this.quaternaryFaceId;

      // Compute raw crop targets
      const allFaceIds = [primaryId, secondaryId, tertiaryId, quaternaryId];
      const allFaceCrops = allFaceIds.map(fid =>
        fid !== null && faceCrops.has(fid) ? faceCrops.get(fid)! : null
      );

      let primaryCx = sourceWidth / 2 - cropW / 2;
      let primaryCy = 0;
      if (primaryId !== null && faceCrops.has(primaryId)) {
        primaryCx = faceCrops.get(primaryId)!.cx;
        primaryCy = faceCrops.get(primaryId)!.cy;
      } else if (frame.faces.length > 0) {
        const firstFace = faceCrops.get(frame.faces[0].id);
        if (firstFace) { primaryCx = firstFace.cx; primaryCy = firstFace.cy; }
      }

      const secondaryCx = secondaryId !== null && faceCrops.has(secondaryId) ? faceCrops.get(secondaryId)!.cx : primaryCx;
      const secondaryCy = secondaryId !== null && faceCrops.has(secondaryId) ? faceCrops.get(secondaryId)!.cy : primaryCy;
      const tertiaryCx = tertiaryId !== null && faceCrops.has(tertiaryId) ? faceCrops.get(tertiaryId)!.cx : primaryCx;
      const tertiaryCy = tertiaryId !== null && faceCrops.has(tertiaryId) ? faceCrops.get(tertiaryId)!.cy : primaryCy;
      const quaternaryCx = quaternaryId !== null && faceCrops.has(quaternaryId) ? faceCrops.get(quaternaryId)!.cx : primaryCx;
      const quaternaryCy = quaternaryId !== null && faceCrops.has(quaternaryId) ? faceCrops.get(quaternaryId)!.cy : primaryCy;

      // Apply EMA smoothing (primary only)
      const needsSprint = modeChangedThisFrame || this.scheduler.isActive || peakEscalatedMode !== null;
      const smooth = this.smoother.push(primaryCx, primaryCy, needsSprint);

      // Tick reaction scheduler
      this.tickReactionScheduler(frame, t);

      // Tick turn detection for peak detector
      if (frame.turnDetected && frame.activeSpeakerId !== null) {
        this.peakDetector.recordTurn(t);
      }

      decisionFrames.push({
        time: t,
        mode: this.currentMode,
        primaryFaceId: this.primaryFaceId,
        primaryCropX: Math.round(primaryCx),
        primaryCropY: Math.round(primaryCy),
        smoothCropX: smooth.x,
        smoothCropY: smooth.y,
        secondaryFaceId: this.secondaryFaceId,
        secondaryCropX: Math.round(secondaryCx),
        secondaryCropY: Math.round(secondaryCy),
        tertiaryFaceId: this.tertiaryFaceId,
        tertiaryCropX: Math.round(tertiaryCx),
        tertiaryCropY: Math.round(tertiaryCy),
        quaternaryFaceId: this.quaternaryFaceId,
        quaternaryCropX: Math.round(quaternaryCx),
        quaternaryCropY: Math.round(quaternaryCy),
        audioEvent: frame.audioEvent,
        eventConfidence: frame.audioEventConfidence,
        transitionAlpha: this.smoother.getCurrentAlpha(),
        peakScore,
      });
    }

    const segments = this.buildSegments(decisionFrames, sourceWidth, sourceHeight);

    log('RESULT', `${segments.length} segments, ${this.modeSwitchCount} switches, ` +
      `${this.scheduler.hasHadReaction ? '≥1' : 0} reactions`);

    const totalReactionCuts = segments.filter(s => s.mode === DecisionMode.REACTION_CUT).length;

    return { segments, decisionFrames, totalReactionCuts, totalLayoutSwitches: this.modeSwitchCount };
  }

  // ── Private ──

  /**
   * Get the escalated layout mode during a peak moment.
   * Based on how many faces are visible.
   */
  private getEscalatedMode(
    frame: SpeakerFrame,
    currentTime: number,
  ): DecisionMode {
    const faceCount = frame.faces.length;

    if (faceCount === 0) return DecisionMode.SINGLE;
    if (faceCount === 1) return DecisionMode.SINGLE;

    // During peak, escalate to show more participants
    const current = this.currentMode;

    // If already in a multi-face layout, stay there
    if (current === DecisionMode.SPLIT_3 || current === DecisionMode.SPLIT_4 ||
        current === DecisionMode.HERO_REACTION) {
      return current;
    }

    // Escalate based on face count
    if (faceCount >= 4) return DecisionMode.SPLIT_4;
    if (faceCount >= 3) return DecisionMode.HERO_REACTION;
    if (faceCount >= 2) return DecisionMode.SPLIT_2;

    return DecisionMode.SINGLE;
  }

  /**
   * Core layout decision logic — conversation-aware, not face-count-based.
   *
   * Decision hierarchy:
   *   1. REACTION_CUT overrides everything
   *   2. Peak escalation (if active)
   *   3. Multi-person layouts (SPLIT_2/3/4, HERO) based on speaker activity
   *   4. LISTENER_PIP for single speaker with listener
   *   5. WIDE_CONTEXT for solo speaker with gestures
   *   6. SINGLE default
   */
  private decideLayout(
    frame: SpeakerFrame,
    currentTime: number,
    peakEscalatedMode: DecisionMode | null,
  ): {
    mode: DecisionMode;
    primaryId: number | null;
    secondaryId: number | null;
    tertiaryId: number | null;
    quaternaryId: number | null;
  } {
    // ── REACTION_CUT overrides everything ──
    if (this.scheduler.isActive) {
      return {
        mode: DecisionMode.REACTION_CUT,
        primaryId: this.scheduler.currentListenerFaceId,
        secondaryId: null,
        tertiaryId: null,
        quaternaryId: null,
      };
    }

    // ── Peak escalation ──
    if (peakEscalatedMode !== null) {
      return this.assignFacesToMode(frame, currentTime, peakEscalatedMode);
    }

    const faceCount = frame.faces.length;
    const activeSpeakerIds = this.speakerTracker.getActiveSpeakers(currentTime);
    const activeSpeakerCount = activeSpeakerIds.size;
    const timeSinceSwitch = currentTime - this.modeSwitchTime;
    const current = this.currentMode;

    // Check cut suppression
    if (this.cutSuppressor.isSuppressed(currentTime) && timeSinceSwitch < MAX_SHOT_DURATION) {
      // Stay in current mode — too many cuts
      return this.stayInCurrentMode(frame);
    }

    // ── SPLIT_2: Two active speakers — OR two faces visible for 3s+ ──
    if (faceCount >= 2 && activeSpeakerCount >= 2) {
      if (current === DecisionMode.SPLIT_2 || current === DecisionMode.SINGLE) {
        if (timeSinceSwitch >= this.config.layoutHoldSingle) {
          return this.assignFacesToMode(frame, currentTime, DecisionMode.SPLIT_2);
        }
      }
    }
    // FACE-COUNT FALLBACK: 2 faces visible for 5s+ even if speaker count uncertain
    if (faceCount >= 2 && activeSpeakerCount < 2 && current === DecisionMode.SINGLE) {
      if (timeSinceSwitch >= 5.0) {
        log('LAYOUT', `Face-count fallback: ${faceCount} faces → SPLIT_2 (activeSpeakers=${activeSpeakerCount})`);
        return this.assignFacesToMode(frame, currentTime, DecisionMode.SPLIT_2);
      }
    }

    // ── SPLIT_3: Three active speakers — OR three faces visible ──
    if (faceCount >= 3 && activeSpeakerCount >= 3) {
      if (current === DecisionMode.SPLIT_3 ||
          (current === DecisionMode.SINGLE && timeSinceSwitch >= LAYOUT_HOLD_SPLIT_3) ||
          (current === DecisionMode.SPLIT_2 && timeSinceSwitch >= LAYOUT_HOLD_SPLIT_3)) {
        return this.assignFacesToMode(frame, currentTime, DecisionMode.SPLIT_3);
      }
    }
    // FACE-COUNT FALLBACK: 3+ faces visible for 6s+
    if (faceCount >= 3 && activeSpeakerCount < 3 && 
        (current === DecisionMode.SINGLE || current === DecisionMode.SPLIT_2)) {
      if (timeSinceSwitch >= 6.0) {
        log('LAYOUT', `Face-count fallback: ${faceCount} faces → SPLIT_3 (activeSpeakers=${activeSpeakerCount})`);
        return this.assignFacesToMode(frame, currentTime, DecisionMode.SPLIT_3);
      }
    }

    // ── SPLIT_4: Four active speakers — OR four faces visible ──
    if (faceCount >= 4 && activeSpeakerCount >= 3) {
      if (current === DecisionMode.SPLIT_4 || timeSinceSwitch >= LAYOUT_HOLD_SPLIT_4) {
        return this.assignFacesToMode(frame, currentTime, DecisionMode.SPLIT_4);
      }
    }
    // FACE-COUNT FALLBACK: 4+ faces visible for 7s+
    if (faceCount >= 4 && activeSpeakerCount < 3 &&
        (current === DecisionMode.SINGLE || current === DecisionMode.SPLIT_2 || current === DecisionMode.SPLIT_3)) {
      if (timeSinceSwitch >= 7.0) {
        log('LAYOUT', `Face-count fallback: ${faceCount} faces → SPLIT_4 (activeSpeakers=${activeSpeakerCount})`);
        return this.assignFacesToMode(frame, currentTime, DecisionMode.SPLIT_4);
      }
    }

    // ── Hold current multi-face modes ──
    if (current === DecisionMode.SPLIT_2 && timeSinceSwitch < this.config.layoutHoldSplit) {
      return this.stayInCurrentMode(frame);
    }
    if (current === DecisionMode.SPLIT_3 && timeSinceSwitch < LAYOUT_HOLD_SPLIT_3) {
      return this.stayInCurrentMode(frame);
    }
    if (current === DecisionMode.SPLIT_4 && timeSinceSwitch < LAYOUT_HOLD_SPLIT_4) {
      return this.stayInCurrentMode(frame);
    }
    if (current === DecisionMode.HERO_REACTION && timeSinceSwitch < LAYOUT_HOLD_HERO) {
      return this.stayInCurrentMode(frame);
    }
    if (current === DecisionMode.LISTENER_PIP && timeSinceSwitch < LAYOUT_HOLD_PIP) {
      return this.stayInCurrentMode(frame);
    }

    // ── HERO_REACTION: Single speaker with 2+ reacting listeners ──
    if (faceCount >= 3 && activeSpeakerCount === 1 && this.shouldUseHeroReaction(frame, currentTime)) {
      return this.assignFacesToMode(frame, currentTime, DecisionMode.HERO_REACTION);
    }

    // ── LISTENER_PIP: Single speaker with reacting listener ──
    if (faceCount >= 2 && activeSpeakerCount === 1 &&
        this.currentMode === DecisionMode.SINGLE && timeSinceSwitch >= LAYOUT_HOLD_PIP_ACTIVATE) {
      const listeners = frame.faces.filter(f => f.id !== frame.activeSpeakerId);
      if (listeners.length > 0 && listeners[0].confidence > 0.1) {
        log('PIP', `PiP activate: speaker=${frame.activeSpeakerId}, listener=${listeners[0].id}`);
        return {
          mode: DecisionMode.LISTENER_PIP,
          primaryId: frame.activeSpeakerId,
          secondaryId: listeners[0].id,
          tertiaryId: null,
          quaternaryId: null,
        };
      }
    }

    // ── WIDE_CONTEXT: Solo speaker with gestures ──
    if (activeSpeakerCount === 1 && current === DecisionMode.SINGLE && timeSinceSwitch >= LAYOUT_HOLD_WIDE) {
      // Check if speaker seems to be gesturing (we can't detect gestures well, but
      // we can use speaker duration as heuristic: if same speaker > 3s, try wide)
      if (timeSinceSwitch > 3.0 && faceCount === 1) {
        return {
          mode: DecisionMode.WIDE_CONTEXT,
          primaryId: frame.activeSpeakerId ?? frame.faces[0]?.id ?? null,
          secondaryId: null,
          tertiaryId: null,
          quaternaryId: null,
        };
      }
    }

    // ── SINGLE: Default ──
    const primaryId = frame.activeSpeakerId ??
      (frame.faces.length > 0
        ? [...frame.faces].sort((a, b) => b.confidence - a.confidence)[0].id
        : null);

    return {
      mode: DecisionMode.SINGLE,
      primaryId,
      secondaryId: null,
      tertiaryId: null,
      quaternaryId: null,
    };
  }

  /**
   * Check if hero reaction layout should be used.
   * Activated when one speaker dominates and there are 2+ visible listeners.
   */
  private shouldUseHeroReaction(frame: SpeakerFrame, currentTime: number): boolean {
    if (!frame.activeSpeakerId) return false;
    const listeners = frame.faces.filter(f => f.id !== frame.activeSpeakerId);
    if (listeners.length < 2) return false;

    // Hero is good when listeners have been recently active (reacted)
    const recentlyActiveCount = listeners.filter(
      l => this.speakerTracker.isRecentlyActive(l.id, currentTime)
    ).length;

    return recentlyActiveCount >= 1;
  }

  /**
   * Assign face IDs to a layout mode, sorted by speaker activity then confidence.
   */
  private assignFacesToMode(
    frame: SpeakerFrame,
    currentTime: number,
    mode: DecisionMode,
  ): {
    mode: DecisionMode;
    primaryId: number | null;
    secondaryId: number | null;
    tertiaryId: number | null;
    quaternaryId: number | null;
  } {
    const maxFaces = mode === DecisionMode.SPLIT_4 ? 4 :
                     mode === DecisionMode.SPLIT_3 ? 3 :
                     mode === DecisionMode.HERO_REACTION ? 3 :
                     mode === DecisionMode.SPLIT_2 ? 2 : 1;

    const activeSpeakerIds = this.speakerTracker.getActiveSpeakers(currentTime);

    // Sort: active speakers first, then by confidence
    const sortedFaces = [...frame.faces].sort((a, b) => {
      const aIsActive = activeSpeakerIds.has(a.id) ? 1 : 0;
      const bIsActive = activeSpeakerIds.has(b.id) ? 1 : 0;
      if (aIsActive !== bIsActive) return bIsActive - aIsActive;
      return b.confidence - a.confidence;
    });

    const selected = sortedFaces.slice(0, maxFaces);

    return {
      mode,
      primaryId: selected[0]?.id ?? null,
      secondaryId: selected[1]?.id ?? null,
      tertiaryId: selected[2]?.id ?? null,
      quaternaryId: selected[3]?.id ?? null,
    };
  }

  /**
   * Stay in the current mode, keeping existing face assignments.
   */
  private stayInCurrentMode(frame: SpeakerFrame): {
    mode: DecisionMode;
    primaryId: number | null;
    secondaryId: number | null;
    tertiaryId: number | null;
    quaternaryId: number | null;
  } {
    const count = this.currentMode === DecisionMode.SPLIT_4 ? 4 :
                  this.currentMode === DecisionMode.SPLIT_3 ? 3 :
                  this.currentMode === DecisionMode.HERO_REACTION ? 3 :
                  this.currentMode === DecisionMode.SPLIT_2 ? 2 : 1;

    const ids = [this.primaryFaceId, this.secondaryFaceId, this.tertiaryFaceId, this.quaternaryFaceId];

    // Verify each face still exists in current frame
    const validIds = ids.map(id =>
      id !== null && frame.faces.some(f => f.id === id) ? id : null
    );

    // If primary is missing, find a replacement
    if (validIds[0] === null && frame.faces.length > 0) {
      const activeSpeakerIds = this.speakerTracker.getActiveSpeakers(frame.time);
      const sorted = [...frame.faces].sort((a, b) => {
        const aIsActive = activeSpeakerIds.has(a.id) ? 1 : 0;
        const bIsActive = activeSpeakerIds.has(b.id) ? 1 : 0;
        if (aIsActive !== bIsActive) return bIsActive - aIsActive;
        return b.confidence - a.confidence;
      });

      for (let i = 0; i < Math.min(count, sorted.length); i++) {
        validIds[i] = sorted[i].id;
      }
      // Clear remaining slots
      for (let i = sorted.length; i < count; i++) {
        validIds[i] = null;
      }
    }

    return {
      mode: this.currentMode,
      primaryId: validIds[0],
      secondaryId: count >= 2 ? validIds[1] : null,
      tertiaryId: count >= 3 ? validIds[2] : null,
      quaternaryId: count >= 4 ? validIds[3] : null,
    };
  }

  private tickReactionScheduler(
    frame: SpeakerFrame,
    currentTime: number,
  ): 'activate' | 'continue' | 'end' | null {
    if (frame.audioEvent !== 'normal' && frame.audioEvent !== 'silence') {
      const activeSpeakerIds = frame.activeSpeakerId !== null
        ? new Set([frame.activeSpeakerId])
        : new Set<number>();

      this.scheduler.offerEvent(
        frame.audioEvent,
        frame.audioEventConfidence,
        currentTime,
        frame.listenerIds,
        Array.from(activeSpeakerIds),
      );
    }

    return this.scheduler.tick(currentTime);
  }

  private buildSegments(
    decisionFrames: DecisionFrame[],
    sourceWidth: number,
    sourceHeight: number,
  ): DecisionSegment[] {
    if (decisionFrames.length === 0) return [];

    const cropW = sourceHeight * (this.config.verticalWidth / this.config.verticalHeight);

    interface SegBuilder {
      mode: DecisionMode;
      startTime: number;
      endTime: number;
      faceCrops: Map<number, { sumX: number; sumY: number; sumConf: number; count: number }>;
      isReaction: boolean;
    }

    const rawSegments: SegBuilder[] = [];

    for (const df of decisionFrames) {
      const current: SegBuilder | undefined = rawSegments.length > 0
        ? rawSegments[rawSegments.length - 1]
        : undefined;

      const maxFaces = df.mode === DecisionMode.SPLIT_4 ? 4 :
                       df.mode === DecisionMode.SPLIT_3 ? 3 :
                       df.mode === DecisionMode.HERO_REACTION ? 3 :
                       df.mode === DecisionMode.SPLIT_2 ? 2 :
                       df.mode === DecisionMode.LISTENER_PIP ? 2 : 1;

      if (current && current.mode === df.mode) {
        current.endTime = df.time;

        const cropPairs: Array<{ id: number | null; x: number; y: number }> = [
          { id: df.primaryFaceId, x: df.smoothCropX, y: df.smoothCropY },
          { id: df.secondaryFaceId, x: df.secondaryCropX, y: df.secondaryCropY },
          { id: df.tertiaryFaceId, x: df.tertiaryCropX, y: df.tertiaryCropY },
          { id: df.quaternaryFaceId, x: df.quaternaryCropX, y: df.quaternaryCropY },
        ];

        for (let i = 0; i < Math.min(maxFaces, 4); i++) {
          const cp = cropPairs[i];
          if (cp.id !== null) {
            const entry = current.faceCrops.get(cp.id) || { sumX: 0, sumY: 0, sumConf: 0, count: 0 };
            entry.sumX += cp.x;
            entry.sumY += cp.y;
            entry.sumConf += i === 0 ? 0.8 : i === 1 ? 0.6 : 0.4;
            entry.count++;
            current.faceCrops.set(cp.id, entry);
          }
        }
      } else {
        const faceCrops = new Map<number, { sumX: number; sumY: number; sumConf: number; count: number }>();
        const cropPairs: Array<{ id: number | null; x: number; y: number }> = [
          { id: df.primaryFaceId, x: df.smoothCropX, y: df.smoothCropY },
          { id: df.secondaryFaceId, x: df.secondaryCropX, y: df.secondaryCropY },
          { id: df.tertiaryFaceId, x: df.tertiaryCropX, y: df.tertiaryCropY },
          { id: df.quaternaryFaceId, x: df.quaternaryCropX, y: df.quaternaryCropY },
        ];

        for (let i = 0; i < Math.min(maxFaces, 4); i++) {
          const cp = cropPairs[i];
          if (cp.id !== null) {
            faceCrops.set(cp.id, { sumX: cp.x, sumY: cp.y, sumConf: i === 0 ? 0.8 : i === 1 ? 0.6 : 0.4, count: 1 });
          }
        }

        rawSegments.push({
          mode: df.mode,
          startTime: df.time,
          endTime: df.time,
          faceCrops,
          isReaction: df.mode === DecisionMode.REACTION_CUT,
        });
      }
    }

    // Filter short segments and convert
    const filtered: DecisionSegment[] = [];
    for (let i = 0; i < rawSegments.length; i++) {
      const seg = rawSegments[i];
      const duration = seg.endTime - seg.startTime;

      if (duration < MIN_SHOT_DURATION && i < rawSegments.length - 1) {
        const next = rawSegments[i + 1];
        next.startTime = seg.startTime;
        continue;
      }

      const maxCrops = seg.mode === DecisionMode.SPLIT_4 ? 4 :
                       seg.mode === DecisionMode.SPLIT_3 ? 3 :
                       seg.mode === DecisionMode.HERO_REACTION ? 3 :
                       seg.mode === DecisionMode.SPLIT_2 ? 2 :
                       seg.mode === DecisionMode.LISTENER_PIP ? 2 : 1;

      const crops = Array.from(seg.faceCrops.entries())
        .sort((a, b) => b[1].sumConf / b[1].count - a[1].sumConf / a[1].count)
        .slice(0, maxCrops)
        .map(([faceId, data]) => ({
          cropX: Math.round(data.sumX / data.count),
          cropY: Math.round(data.sumY / data.count),
          faceId,
          confidence: data.sumConf / data.count,
          isReaction: seg.isReaction,
        }));

      filtered.push({
        startTime: seg.startTime,
        endTime: seg.endTime,
        mode: seg.mode,
        crops,
        transitionOut: i < rawSegments.length - 1
          ? { type: 'crossfade', duration: 0.15 }
          : undefined,
      });
    }

    return filtered;
  }

  private reset(): void {
    this.smoother.reset();
    this.scheduler.reset();
    this.speakerTracker.reset();
    this.peakDetector.reset();
    this.cutSuppressor.reset();
    this.currentMode = DecisionMode.SINGLE;
    this.modeSwitchTime = 0;
    this.modeSwitchCount = 0;
    this.primaryFaceId = null;
    this.secondaryFaceId = null;
    this.tertiaryFaceId = null;
    this.quaternaryFaceId = null;
  }
}

// ===========================================================================
// Convenience Function
// ===========================================================================

export function processDecisionEngine(
  speakerFrames: SpeakerFrame[],
  sourceWidth: number,
  sourceHeight: number,
  config?: Partial<DecisionEngineConfig>,
): DecisionResult {
  const engine = new DecisionEngine(config);
  return engine.process(speakerFrames, sourceWidth, sourceHeight);
}
