/**
 * worker/decision-engine.ts — Rendering Decision Engine for GANYIQ V2 (P1.1)
 *
 * Transforms raw face tracking + speaker detection data into cinematic,
 * professionally-edited video segments with:
 *
 *   1. EMA Camera Smoothing — fluid, eased camera movements instead of hard cuts
 *   2. Reaction Cut Logic — deliberately cut to listener reactions (laughter, gasp, emotion)
 *   3. Smart Layout Switching — SINGLE ↔ SPLIT_2 ↔ PiP based on conversational dynamics
 *
 * Architecture:
 *   ┌────────────────────────────────────────────────────────┐
 *   │ DecisionEngine (state machine, per-frame)              │
 *   │                                                        │
 *   │  Input: SpeakerFrame[] (tracked faces + speaker data)  │
 *   │                                                        │
 *   │  1. Per-frame layout decision (mode, primary, secondary)│
 *   │  2. EMA filter → smooth crop trajectories              │
 *   │  3. Reaction scheduler → insert listener cuts          │
 *   │  4. Segment builder → output MultiCropSegment[]        │
 *   │                                                        │
 *   │  Output: DecisionResult { segments, transitions }      │
 *   └────────────────────────────────────────────────────────┘
 */

import type { SpeakerFrame, AudioEventType } from './speaker-detector';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Layout modes available to the rendering engine. */
export enum DecisionMode {
  SINGLE = 'single',               // one face, full 9:16 frame
  SPLIT_2 = 'split_2',             // two faces, 50/50 vertical stack
  REACTION_CUT = 'reaction_cut',   // brief cut to listener reaction (overrides others)
  LISTENER_PIP = 'listener_pip',   // picture-in-picture: speaker full + listener inset
}

/** Per-frame decision output. */
export interface DecisionFrame {
  time: number;
  mode: DecisionMode;
  primaryFaceId: number | null;
  primaryCropX: number;       // raw (before EMA)
  primaryCropY: number;
  smoothCropX: number;        // after EMA filtering
  smoothCropY: number;
  secondaryFaceId: number | null;
  secondaryCropX: number;
  secondaryCropY: number;
  audioEvent: AudioEventType;
  eventConfidence: number;
  transitionAlpha: number;    // 0=hard cut…1=fully smoothed
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
    isReaction?: boolean;     // true if this was a reaction insert
  }>;
  /** Optional fade parameters for smoother transitions between segments. */
  transitionOut?: {
    type: 'crossfade' | 'none';
    duration: number;         // seconds
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

const REACTION_HOLD_MIN = 0.8;      // minimum reaction cut duration (seconds)
const REACTION_HOLD_MAX = 1.8;      // maximum reaction cut duration
const REACTION_COOLDOWN = 2.5;      // minimum seconds between reaction cuts
const REACTION_EVENT_DELAY = 0.15;  // wait after event onset before cutting

const LAYOUT_HOLD_SINGLE = 1.5;     // hold single mode before split can activate
const LAYOUT_HOLD_SPLIT = 1.5;      // hold split mode before single can activate
const LAYOUT_HOLD_PIP = 2.0;        // minimum hold PiP mode before switching back
const LAYOUT_HOLD_PIP_ACTIVATE = 2.0; // min time in SINGLE before PiP can activate

const SPLIT_MIN_SPEAKERS = 2;       // minimum active speakers in window to trigger split
const SPEAKER_WINDOW_SEC = 5.0;     // rolling window for speaker activity tracking

const EMA_ALPHA_DEFAULT = 0.15;     // smooth, cinematic camera movement
const EMA_ALPHA_SPRINT = 0.6;       // faster settling after mode switch
const EMA_SPRINT_FRAMES = 3;        // number of sprint frames after switch

const REACTION_CUT_CROP_X_BIAS = 0.40; // for reaction cut, position listener at 40% width (slightly offset)
const REACTION_CUT_DURATION_FACTOR: Record<AudioEventType, number> = {
  'normal': 0,
  'laughter': 1.5,
  'gasp': 1.2,
  'emotion_peak': 1.4,
  'silence': 0,
  'applause': 1.0,
};

function log(tag: string, message: string): void {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] [DECISION${tag.padEnd(4)}] ${message}`);
}

// ===========================================================================
// Speaker Activity Tracker
// ===========================================================================

/**
 * Tracks which face IDs have been active speakers in a rolling time window.
 * Used by the layout switcher to determine if a conversation has multiple
 * active participants (warranting split-screen) vs. a single dominant speaker.
 */
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

  /** Check if a specific face has been active recently. */
  isRecentlyActive(faceId: number, currentTime: number): boolean {
    this.prune(currentTime);
    return this.events.some(e => e.faceId === faceId);
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

/**
 * Exponential Moving Average filter for camera crop positions.
 *
 * Produces cinematic, fluid camera movement by blending each new target
 * position with the previous smoothed position.
 *
 *   smoothX₀ = targetX₀
 *   smoothXₜ = smoothXₜ₋₁ + α · (targetXₜ − smoothXₜ₋₁)
 *
 * α (alpha) controls responsiveness:
 *   low (0.05-0.15) = very smooth, slow to settle
 *   medium (0.2-0.4) = good balance
 *   high (0.5-1.0) = responsive, snappier
 */
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

  /**
   * Push a new target position.
   * @param targetX - Raw target crop X
   * @param targetY - Raw target crop Y
   * @param forceSprint - If true, use higher alpha for fast settling (e.g., after mode switch)
   * @returns Smoothed { x, y }
   */
  /** Get current alpha value (useful for logging). */
  getCurrentAlpha(): number {
    return this.sprintRemaining > 0 ? this.sprintAlpha : this.alpha;
  }

  push(targetX: number, targetY: number, forceSprint: boolean = false): { x: number; y: number } {
    if (this.smoothX === null || this.smoothY === null) {
      // First frame — snap to target
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

/**
 * Schecules and manages reaction cuts.
 *
 * When an audio event (laughter, gasp, emotion_peak) is detected AND there's
 * a visible listener face, the scheduler schedules a brief cut to that face.
 *
 * Scheduling algorithm:
 *   1. Event detected → verify listener face exists in current frame
 *   2. Wait REACTION_EVENT_DELAY for the moment to register
 *   3. Cut to listener face for REACTION_HOLD_MIN..MAX seconds
 *   4. Transition back to primary speaker
 */
class ReactionScheduler {
  private state: 'idle' | 'pending' | 'active' = 'idle';
  private pendingEvent: AudioEventType = 'normal';
  private pendingConfidence: number = 0;
  private pendingTime: number = 0;
  private pendingListenerFaceId: number | null = null;
  private activationTime: number = 0;
  private lastReactionEnd: number = -REACTION_COOLDOWN; // allow immediate first reaction

  get isActive(): boolean { return this.state === 'active'; }
  get isPending(): boolean { return this.state === 'pending'; }
  /** Whether any reaction has been triggered since last reset. */
  get hasHadReaction(): boolean { return this.lastReactionEnd > -REACTION_COOLDOWN / 2; }
  get currentListenerFaceId(): number | null {
    return this.state === 'active' || this.state === 'pending'
      ? this.pendingListenerFaceId
      : null;
  }

  /**
   * Offer an event to the scheduler.
   * Returns true if the event was accepted (will result in a reaction cut).
   */
  offerEvent(
    eventType: AudioEventType,
    confidence: number,
    currentTime: number,
    listenerFaceIds: number[],
    speakerFaceIds: number[],
  ): boolean {
    // Only meaningful events
    if (eventType === 'normal' || eventType === 'silence') return false;
    if (confidence < 0.4) return false;

    // Need at least one listener face
    const validListeners = listenerFaceIds.filter(id => !speakerFaceIds.includes(id));
    if (validListeners.length === 0) return false;

    // Cooldown check
    if (currentTime - this.lastReactionEnd < REACTION_COOLDOWN) return false;

    // Don't queue if already in a reaction
    if (this.state === 'active') return false;

    // Accept the event
    this.state = 'pending';
    this.pendingEvent = eventType;
    this.pendingConfidence = confidence;
    this.pendingTime = currentTime;
    this.pendingListenerFaceId = validListeners[0];
    log('EVENT', `Reaction scheduled: ${eventType} (conf=${confidence.toFixed(2)}) → face ${validListeners[0]} at ${currentTime.toFixed(1)}s`);
    return true;
  }

  /**
   * Tick the scheduler. Call every frame.
   * @returns 'activate' if this frame should switch to reaction, 'continue' if already in reaction, 'end' if reaction just ended, null otherwise
   */
  tick(currentTime: number): 'activate' | 'continue' | 'end' | null {
    if (this.state === 'pending') {
      // Wait for the delay to pass
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
 * Rendering Decision Engine — Main entry point.
 *
 * Processes a sequence of SpeakerFrames and produces DecisionSegments
 * optimized for cinematic short-form video output.
 *
 * Key behaviors:
 *   - EMA-smooth camera movement instead of hard cuts
 *   - Dynamic reaction cuts that briefly show listener reactions
 *   - Intelligent SINGLE ↔ SPLIT_2 ↔ PiP switching based on conversation dynamics
 */
export class DecisionEngine {
  private config: DecisionEngineConfig;
  private smoother: EmaCameraSmoother;
  private scheduler: ReactionScheduler;
  private speakerTracker: SpeakerActivityTracker;

  // State machine
  private currentMode: DecisionMode = DecisionMode.SINGLE;
  private modeSwitchTime: number = 0;
  private lastMode: DecisionMode = DecisionMode.SINGLE;
  private modeSwitchCount: number = 0;
  private primaryFaceId: number | null = null;
  private secondaryFaceId: number | null = null;

  constructor(config?: Partial<DecisionEngineConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.smoother = new EmaCameraSmoother(this.config.emaAlphaDefault, this.config.emaAlphaSprint);
    this.scheduler = new ReactionScheduler();
    this.speakerTracker = new SpeakerActivityTracker(this.config.speakerWindowSec);
  }

  /**
   * Run the decision engine on a sequence of speaker frames.
   *
   * @param speakerFrames - Per-frame face tracking + speaker data
   * @param sourceWidth - Source video width in pixels
   * @param sourceHeight - Source video height in pixels
   * @returns DecisionResult with segments suitable for clip-renderer
   */
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

    // ── Per-frame processing ──
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
        const cx = clamp(face.cx - cropW / 2, 0, sourceWidth - cropW);
        const cy = clamp(face.cy - cropH * 0.35, 0, sourceHeight - cropH);
        faceCrops.set(face.id, { cx: Math.round(cx), cy: Math.round(cy) });
      }

      // ── Determine layout mode ──
      const { mode, primaryId, secondaryId } = this.decideLayout(frame, t);

      modeChangedThisFrame = mode !== this.currentMode;
      if (modeChangedThisFrame) {
        this.modeSwitchCount++;
        this.lastMode = this.currentMode;
        this.currentMode = mode;
        this.modeSwitchTime = t;
      }

      // ── Determine primary/secondary face IDs ──
      this.primaryFaceId = primaryId ?? this.primaryFaceId;
      this.secondaryFaceId = secondaryId ?? this.secondaryFaceId;

      // ── Compute raw crop targets ──
      let primaryCx = sourceWidth / 2 - cropW / 2;
      let primaryCy = 0;

      if (this.primaryFaceId !== null && faceCrops.has(this.primaryFaceId)) {
        const crop = faceCrops.get(this.primaryFaceId)!;
        primaryCx = crop.cx;
        primaryCy = crop.cy;
      } else if (frame.faces.length > 0) {
        // Fallback to first face
        const firstFace = faceCrops.get(frame.faces[0].id);
        if (firstFace) {
          primaryCx = firstFace.cx;
          primaryCy = firstFace.cy;
        }
      }

      let secondaryCx = primaryCx;
      let secondaryCy = primaryCy;
      if (this.secondaryFaceId !== null && faceCrops.has(this.secondaryFaceId)) {
        const crop = faceCrops.get(this.secondaryFaceId)!;
        secondaryCx = crop.cx;
        secondaryCy = crop.cy;
      }

      // ── Apply EMA smoothing ──
      const needsSprint = modeChangedThisFrame || this.scheduler.isActive;
      const smooth = this.smoother.push(primaryCx, primaryCy, needsSprint);

      // ── Tick reaction scheduler ──
      const reactionTick = this.tickReactionScheduler(frame, t);

      // ── Build decision frame ──
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
        audioEvent: frame.audioEvent,
        eventConfidence: frame.audioEventConfidence,
        transitionAlpha: this.smoother.getCurrentAlpha(),
      });
    }

    // ── Build segments from decision frames ──
    const segments = this.buildSegments(decisionFrames, sourceWidth, sourceHeight);

    log('RESULT', `${segments.length} segments, ${this.modeSwitchCount} layout switches, ${this.scheduler.hasHadReaction ? '≥1' : 0} reaction cuts`);

    // Count reaction cuts
    let totalReactionCuts = 0;
    for (const seg of segments) {
      if (seg.mode === DecisionMode.REACTION_CUT) totalReactionCuts++;
    }

    return {
      segments,
      decisionFrames,
      totalReactionCuts,
      totalLayoutSwitches: this.modeSwitchCount,
    };
  }

  // ── Private ──

  /**
   * Decide the layout mode for a single frame.
   * This is the core decision logic:
   *
   * 1. If reaction scheduler is active → REACTION_CUT (overrides everything)
   * 2. If 2+ speakers active in window AND 2+ faces visible → SPLIT_2
   * 3. Single speaker → SINGLE (or PiP if we have a listener)
   * 4. No faces → SINGLE (center crop)
   */
  private decideLayout(
    frame: SpeakerFrame,
    currentTime: number,
  ): { mode: DecisionMode; primaryId: number | null; secondaryId: number | null } {
    // ── REACTION_CUT overrides everything ──
    if (this.scheduler.isActive) {
      const listenerId = this.scheduler.currentListenerFaceId;
      return {
        mode: DecisionMode.REACTION_CUT,
        primaryId: listenerId,    // focus on the listener reacting
        secondaryId: null,
      };
    }

    const faceCount = frame.faces.length;
    const activeSpeakers = this.speakerTracker.getActiveSpeakerCount(currentTime);
    const timeSinceSwitch = currentTime - this.modeSwitchTime;

    // ── SPLIT_2: Multiple active speakers, multiple faces visible ──
    if (
      faceCount >= 2 &&
      activeSpeakers >= this.config.splitMinSpeakers &&
      this.currentMode === DecisionMode.SPLIT_2
    ) {
      // Stay in split mode (or activate if coming from single + hold expired)
      if (timeSinceSwitch >= this.config.layoutHoldSingle || this.currentMode === DecisionMode.SPLIT_2) {
        // Find two most relevant faces — prefer active speakers
        const activeSpeakerIds = this.speakerTracker.getActiveSpeakers(currentTime);
        const sortedFaces = [...frame.faces].sort((a, b) => {
          const aIsActive = activeSpeakerIds.has(a.id) ? 1 : 0;
          const bIsActive = activeSpeakerIds.has(b.id) ? 1 : 0;
          // Active speakers first, then by confidence
          if (aIsActive !== bIsActive) return bIsActive - aIsActive;
          return b.confidence - a.confidence;
        });

        return {
          mode: DecisionMode.SPLIT_2,
          primaryId: sortedFaces[0]?.id ?? null,
          secondaryId: sortedFaces[1]?.id ?? null,
        };
      }
    }

    // Check if we should enter split mode (from single)
    if (
      faceCount >= 2 &&
      activeSpeakers >= this.config.splitMinSpeakers &&
      this.currentMode !== DecisionMode.SPLIT_2
    ) {
      if (timeSinceSwitch >= this.config.layoutHoldSingle) {
        const activeSpeakerIds = this.speakerTracker.getActiveSpeakers(currentTime);
        const sortedFaces = [...frame.faces].sort((a, b) => {
          const aIsActive = activeSpeakerIds.has(a.id) ? 1 : 0;
          const bIsActive = activeSpeakerIds.has(b.id) ? 1 : 0;
          if (aIsActive !== bIsActive) return bIsActive - aIsActive;
          return b.confidence - a.confidence;
        });

        return {
          mode: DecisionMode.SPLIT_2,
          primaryId: sortedFaces[0]?.id ?? null,
          secondaryId: sortedFaces[1]?.id ?? null,
        };
      }
    }

    // ── SINGLE: Default mode ──
    // If we were in split, check hold timer before switching back
    if (this.currentMode === DecisionMode.SPLIT_2 && timeSinceSwitch < this.config.layoutHoldSplit) {
      return {
        mode: DecisionMode.SPLIT_2,
        primaryId: this.primaryFaceId ?? frame.faces[0]?.id ?? null,
        secondaryId: this.secondaryFaceId ?? frame.faces[1]?.id ?? null,
      };
    }

    // ── LISTENER_PIP: Single speaker with visible listener ──
    // Activate after sufficient hold in SINGLE mode
    if (
      faceCount >= 2 &&
      frame.activeSpeakerId !== null &&
      this.currentMode === DecisionMode.SINGLE &&
      timeSinceSwitch >= LAYOUT_HOLD_PIP_ACTIVATE
    ) {
      // Find a listener (face that is not the active speaker)
      const listeners = frame.faces.filter(f => f.id !== frame.activeSpeakerId);
      if (listeners.length > 0 && listeners[0].confidence > 0.1) {
        log('PIP', `PiP activate: speaker=${frame.activeSpeakerId}, listener=${listeners[0].id} at ${currentTime.toFixed(1)}s`);
        return {
          mode: DecisionMode.LISTENER_PIP,
          primaryId: frame.activeSpeakerId,
          secondaryId: listeners[0].id,
        };
      }
    }

    // If currently in PiP, hold for minimum duration
    if (this.currentMode === DecisionMode.LISTENER_PIP) {
      const activeSpeakerStillExists = frame.activeSpeakerId !== null &&
        frame.faces.some(f => f.id === frame.activeSpeakerId);
      const listenerStillExists = this.secondaryFaceId !== null &&
        frame.faces.some(f => f.id === this.secondaryFaceId);

      if (timeSinceSwitch < this.config.layoutHoldPip && activeSpeakerStillExists && listenerStillExists) {
        return {
          mode: DecisionMode.LISTENER_PIP,
          primaryId: frame.activeSpeakerId ?? this.primaryFaceId ?? frame.faces[0]?.id ?? null,
          secondaryId: this.secondaryFaceId!,
        };
      }
    }

    // Single mode — pick primary face
    let primaryId: number | null = null;
    if (frame.activeSpeakerId !== null) {
      primaryId = frame.activeSpeakerId;
    } else if (frame.faces.length > 0) {
      const sorted = [...frame.faces].sort((a, b) => b.confidence - a.confidence);
      primaryId = sorted[0].id;
    }

    return {
      mode: DecisionMode.SINGLE,
      primaryId,
      secondaryId: null,
    };
  }

  /**
   * Offer audio events to the reaction scheduler every frame.
   * Returns the scheduler tick result.
   */
  private tickReactionScheduler(
    frame: SpeakerFrame,
    currentTime: number,
  ): 'activate' | 'continue' | 'end' | null {
    // Offer event if non-normal
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

  /**
   * Build final segments from decision frames.
   *
   * Groups contiguous frames with the same mode into segments.
   * Each segment has averaged crop coordinates per face.
   */
  private buildSegments(
    decisionFrames: DecisionFrame[],
    sourceWidth: number,
    sourceHeight: number,
  ): DecisionSegment[] {
    if (decisionFrames.length === 0) return [];

    const cropH = sourceHeight;
    const cropW = sourceHeight * (this.config.verticalWidth / this.config.verticalHeight);
    const minSegmentDuration = 0.5; // discard sub-500ms segments

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

      if (current && current.mode === df.mode) {
        // Extend current segment
        current.endTime = df.time;

        // Accumulate face crops
        if (df.primaryFaceId !== null) {
          const entry = current.faceCrops.get(df.primaryFaceId) || { sumX: 0, sumY: 0, sumConf: 0, count: 0 };
          entry.sumX += df.smoothCropX;
          entry.sumY += df.smoothCropY;
          entry.sumConf += 0.8;
          entry.count++;
          current.faceCrops.set(df.primaryFaceId, entry);
        }
        if (df.secondaryFaceId !== null && (df.mode === DecisionMode.SPLIT_2 || df.mode === DecisionMode.LISTENER_PIP)) {
          const entry = current.faceCrops.get(df.secondaryFaceId) || { sumX: 0, sumY: 0, sumConf: 0, count: 0 };
          entry.sumX += df.secondaryCropX;
          entry.sumY += df.secondaryCropY;
          entry.sumConf += 0.6;
          entry.count++;
          current.faceCrops.set(df.secondaryFaceId, entry);
        }
      } else {
        // New segment
        const faceCrops = new Map();
        if (df.primaryFaceId !== null) {
          faceCrops.set(df.primaryFaceId, { sumX: df.smoothCropX, sumY: df.smoothCropY, sumConf: 0.8, count: 1 });
        }
        if (df.secondaryFaceId !== null && (df.mode === DecisionMode.SPLIT_2 || df.mode === DecisionMode.LISTENER_PIP)) {
          faceCrops.set(df.secondaryFaceId, { sumX: df.secondaryCropX, sumY: df.secondaryCropY, sumConf: 0.6, count: 1 });
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

    // Filter short segments and convert to DecisionSegment[]
    const filtered: DecisionSegment[] = [];
    for (let i = 0; i < rawSegments.length; i++) {
      const seg = rawSegments[i];
      const duration = seg.endTime - seg.startTime;

      if (duration < minSegmentDuration && i < rawSegments.length - 1) {
        // Merge with next segment
        const next = rawSegments[i + 1];
        // Extend next segment backward
        next.startTime = seg.startTime;
        continue;
      }

      // Convert faceCrops to array
      const crops = Array.from(seg.faceCrops.entries())
        .sort((a, b) => b[1].sumConf / b[1].count - a[1].sumConf / a[1].count)
        .slice(0, seg.mode === DecisionMode.SINGLE || seg.mode === DecisionMode.REACTION_CUT ? 1 : 2)
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

  /** Reset all internal state. */
  private reset(): void {
    this.smoother.reset();
    this.scheduler.reset();
    this.speakerTracker.reset();
    this.currentMode = DecisionMode.SINGLE;
    this.modeSwitchTime = 0;
    this.lastMode = DecisionMode.SINGLE;
    this.modeSwitchCount = 0;
    this.primaryFaceId = null;
    this.secondaryFaceId = null;
  }
}

// ===========================================================================
// Convenience Function
// ===========================================================================

/**
 * One-shot convenience wrapper: process speaker frames into decision segments.
 *
 * This is the main entry point used by face-tracker.ts and clip-renderer.ts.
 *
 * @param speakerFrames - Per-frame face tracking + speaker data from speaker-detector
 * @param sourceWidth - Source video width
 * @param sourceHeight - Source video height
 * @param config - Optional engine configuration overrides
 * @returns DecisionResult suitable for rendering
 */
export function processDecisionEngine(
  speakerFrames: SpeakerFrame[],
  sourceWidth: number,
  sourceHeight: number,
  config?: Partial<DecisionEngineConfig>,
): DecisionResult {
  const engine = new DecisionEngine(config);
  return engine.process(speakerFrames, sourceWidth, sourceHeight);
}
