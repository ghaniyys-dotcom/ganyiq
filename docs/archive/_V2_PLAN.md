# Phase 0 & Phase 1 Implementation Plan — GANYIQ V2

## Codebase Snapshot

| Metric | Value |
|--------|-------|
| Total TS files | 37 (lib: 25, worker: 12) |
| Total lines | 16,863 |
| Current types file | `lib/types.ts` (61 lines) |
| Decision output | `DecisionSegment[]` (decision-engine.ts: 1159 lines) |
| Ranking engine | `lib/ranking.ts` (600 lines, single-score based) |
| Pipeline orchestrator | `lib/analyze-pipeline.ts` (256 lines) |
| Feature flags | `worker/features.ts` (64 lines) |
| Prompts | `lib/prompt.ts` (549 lines) |

## Phase 0: Timeline Architecture (Foundation Layer)

### Objective
Build the permanent contract between Decision Engine and Renderer.
Every future subsystem (Judge, Generator, Stitching, Ranking, Renderer) targets Timeline JSON.

### Files to Create

| File | Purpose | Lines (est) |
|------|---------|-------------|
| `lib/timeline-types.ts` | Timeline JSON schema (tracks, clips, keyframes, transitions) | 200 |
| `lib/timeline-serializer.ts` | DecisionSegment[] → TimelineJSON converter | 150 |
| `lib/timeline-validator.ts` | Schema validation + integrity checks | 120 |

### Files to Modify

| File | Change | Lines |
|------|--------|-------|
| `lib/types.ts` | Add TimelineJSON to exports | +5 |

### Files Unchanged (Phase 0)
decision-engine.ts, clip-renderer.ts, ranking.ts, analyze-pipeline.ts, prompt.ts, analyzer.ts — no changes needed.

### Dependency Graph
```
lib/timeline-types.ts (standalone — no deps)
    ↓
lib/timeline-serializer.ts (imports timeline-types + DecisionSegment from decision-engine)
    ↓
lib/timeline-validator.ts (imports timeline-types)
```

### Timeline JSON Schema Design

```typescript
// Timeline is a renderer-agnostic description of a video clip
interface TimelineJSON {
  version: 1;
  schema: 'ganyiq-timeline-v1';
  metadata: TimelineMetadata;
  duration: number;  // total duration in seconds
  tracks: Track[];
  renderHints?: RenderHints;
}

interface TimelineMetadata {
  projectId: string;
  sourceVideo: string;
  sourceDuration: number;
  createdAt: string;  // ISO
  generator: 'RAW' | 'HOOK' | 'TREND' | 'STORY';
  judgeResult?: JudgeResult;  // Phase 1
}

// Track types (mirrors Opus track types)
type TrackType = 'video' | 'face_crop' | 'caption' | 'text_overlay' 
               | 'emoji' | 'broll' | 'audio' | 'transition';

interface Track {
  id: string;
  type: TrackType;
  zIndex: number;
  enabled: boolean;
  segements: Segment[];
}

interface Segment {
  id: string;
  startTime: number;
  endTime: number;
  // Source clip for video/audio tracks
  sourceClip?: {
    videoId: string;
    offsetStart: number;  // in source video
    offsetEnd: number;
  };
  // Camera crop instruction
  crop?: CropInstruction;
  // Layout mode
  layout?: LayoutInstruction;
  // Subtitle content (for caption tracks)
  text?: SubtitleSegment[];
  // Overlay content (for text/emoji tracks)
  overlay?: OverlayContent;
  // Transition at start of segment
  transitionIn?: TransitionEffect;
  // Keyframe animations within segment
  keyframes?: Keyframe[];
}

interface CropInstruction {
  x: number;
  y: number;
  width: number;
  height: number;
  // Ken Burns effect
  zoomStart?: number;  // 1.0 = no zoom
  zoomEnd?: number;    // 1.04 = 4% zoom over segment
}

interface LayoutInstruction {
  mode: 'fullscreen' | 'split_2' | 'split_3' | 'split_4' | 'pip' | 'hero_reaction';
  // For multi-face layouts
  panels?: PanelInstruction[];
}

interface PanelInstruction {
  faceIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface SubtitleSegment {
  text: string;
  startTime: number;
  endTime: number;
  words: WordTimestamp[];
  speaker?: string;
  emphasis?: 'normal' | 'bold' | 'highlight';
}

interface WordTimestamp {
  word: string;
  start: number;
  end: number;
}

interface OverlayContent {
  type: 'text' | 'emoji' | 'image' | 'rive';
  text?: string;
  emoji?: string;
  imageUrl?: string;
  riveUrl?: string;
  position: { x: number; y: number };
  size?: { width: number; height: number };
  animation?: 'fade_in' | 'slide_in' | 'scale_in';
}

interface TransitionEffect {
  type: 'crossfade' | 'slide' | 'fade' | 'none';
  duration: number;  // seconds
}

interface Keyframe {
  time: number;  // seconds within segment
  properties: Partial<{
    cropX: number;
    cropY: number;
    zoom: number;
    opacity: number;
    positionX: number;
    positionY: number;
    scaleX: number;
    scaleY: number;
  }>;
  easing?: 'linear' | 'ease_in' | 'ease_out' | 'ease_in_out';
}

interface RenderHints {
  resolution: { width: number; height: number };
  fps: number;
  audioSampleRate: number;
}
```

### DecisionSegment[] → TimelineJSON Conversion

```typescript
// Pseudo-code for serializer
function segmentsToTimeline(
  projectId: string,
  segments: DecisionSegment[],
  sourceVideo: string,
  sourceDuration: number,
  options?: { generator?: string }
): TimelineJSON {
  
  const timeline: TimelineJSON = {
    version: 1,
    schema: 'ganyiq-timeline-v1',
    metadata: { projectId, sourceVideo, sourceDuration, 
                createdAt: new Date().toISOString(), generator: options?.generator || 'RAW' },
    duration: segments.reduce((sum, s) => sum + (s.endTime - s.startTime), 0),
    tracks: [],
  };

  for (const seg of segments) {
    // Each segment becomes: face_crop track + audio track + optional transition
    
    // Track 1: Face crop (primary video)
    timeline.tracks.push({
      id: `face_${segIdx}`,
      type: 'face_crop',
      zIndex: 0,
      enabled: true,
      segements: [{
        id: `seg_${segIdx}`,
        startTime: timeline.duration, // cumulative
        endTime: timeline.duration + (seg.endTime - seg.startTime),
        sourceClip: { videoId: sourceVideo, offsetStart: seg.startTime, offsetEnd: seg.endTime },
        crop: buildCrop(seg.crops[0]),
        layout: buildLayout(seg.mode, seg.crops.length),
        transitionIn: seg.transitionOut ? 
          { type: seg.transitionOut.type, duration: seg.transitionOut.duration } : undefined,
        keyframes: buildZoomKeyframes(seg.startTime, seg.endTime),
      }]
    });

    // Track 2: Audio
    timeline.tracks.push({
      id: `audio_${segIdx}`,
      type: 'audio',
      zIndex: 10,
      enabled: true,
      segements: [{
        id: `aud_${segIdx}`,
        startTime: timeline.duration,
        endTime: timeline.duration + (seg.endTime - seg.startTime),
        sourceClip: { videoId: sourceVideo, offsetStart: seg.startTime, offsetEnd: seg.endTime },
      }]
    });
  }

  return timeline;
}
```

### Timeline Validator

```typescript
interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: string[];
}

enum ValidationErrorType {
  MISSING_FIELD = 'missing_field',
  TYPE_MISMATCH = 'type_mismatch',
  TIME_OVERLAP = 'time_overlap',
  TIME_GAP = 'time_gap',
  NEGATIVE_DURATION = 'negative_duration',
  INVALID_VERSION = 'invalid_version',
  Z_INDEX_CONFLICT = 'z_index_conflict',
  MISSING_SOURCE = 'missing_source',
}

function validateTimeline(timeline: TimelineJSON): ValidationResult {
  // 1. Version check
  if (timeline.version !== 1) return error('INVALID_VERSION');
  
  // 2. Required fields
  if (!timeline.metadata?.projectId) return error('MISSING_FIELD', 'projectId');
  if (!timeline.tracks || timeline.tracks.length === 0) return error('MISSING_FIELD', 'tracks');
  
  // 3. Track validation
  for (const track of timeline.tracks) {
    if (!track.id || !track.type) return error('MISSING_FIELD', `track[${track.id}].type`);
    if (track.segements.length === 0) warnings.push('Track ${track.id} has no segments');
    
    for (const seg of track.segements) {
      if (seg.endTime <= seg.startTime) return error('NEGATIVE_DURATION', seg.id);
      if (seg.sourceClip && seg.sourceClip.offsetEnd <= seg.sourceClip.offsetStart) 
        return error('NEGATIVE_DURATION', `${seg.id}.sourceClip`);
    }
  }
  
  // 4. Time continuity check
  // 5. Z-index conflict check
  // 6. Optional: cross-track time alignment
  
  return { valid: true, errors: [], warnings };
}
```

### Implementation Steps (Phase 0)

1. Create `lib/timeline-types.ts` — define all interfaces
2. Create `lib/timeline-serializer.ts` — DecisionSegment → TimelineJSON
3. Create `lib/timeline-validator.ts` — validation logic
4. Update `lib/types.ts` — add TimelineJSON export
5. Integration test: take existing DecisionSegment[], serialize, validate

**Estimated effort:** 4-6 hours
**Risk:** Low — purely additive, touches no existing code

---

## Phase 1: Judge Engine V2

### Objective
Replace single-dimension `worthClippingScore` with 4-dimension scoring (hook, coherence, connection, trend) + curved normalization.

### Files to Create

| File | Purpose | Lines (est) |
|------|---------|-------------|
| `lib/judge-types.ts` | JudgeResult interfaces + scoring formulas | 100 |
| `lib/judge-engine.ts` | JudgeEngine class — orchestrates scoring per dimension | 250 |
| `lib/judge-prompt.ts` | Per-dimension prompts for LLM evaluation | 200 |
| `lib/score-curve.ts` | RawScore → CurvedScore formula + aggregation | 80 |

### Files to Modify

| File | Change | Lines |
|------|--------|-------|
| `lib/types.ts` | Add JudgeResult, replace single-score path | +30 |
| `lib/analyzer.ts` | Add judge engine call after LLM analysis | +20 |
| `lib/analyze-pipeline.ts` | Add judge stage to pipeline | +15 |
| `lib/ranking.ts` | Replace single-score ranking with 4-dim curved ranking | +100 |
| `lib/prompt.ts` | Keep existing prompts, add judge prompt references | +10 |
| `lib/score-breakdown.ts` | Update to use 4-dim scores instead of DNA-derived | +30 |

### Files Unchanged (Phase 1)
decision-engine.ts, clip-renderer.ts, subtitle-renderer.ts, face-tracker.ts — no changes needed. Judge is pipeline-level, not renderer-level.

### Dependency Graph
```
lib/judge-types.ts (imports types.ts)
    ↓
lib/judge-prompt.ts (standalone prompt templates)
    ↓
lib/judge-engine.ts (imports judge-types, judge-prompt, analyzer output)
    ↓
lib/score-curve.ts (imports judge-types)
    ↓
lib/ranking.ts (imports score-curve, judge-types)
```

### JudgeResult Type Design

```typescript
interface JudgeResult {
  // Component scores (0-10 each, internal float precision)
  hookScore: number;
  coherenceScore: number;
  connectionScore: number;
  trendScore: number;
  sponsorshipScore: number;  // always 0 for free tier
  
  // Raw score (sum of components)
  rawScore: number;  // 0-40 range
  
  // Curved score (normalized for display)
  curvedScore: number;  // 0-100 range
  
  // Raw judge metadata
  judgeModel: string;
  judgeVersion: string;
  judgeTimestamp: string;
  
  // Per-dimension reasoning
  hookComment?: string;
  coherenceComment?: string;
  connectionComment?: string;
  trendComment?: string;
}
```

### Score Pipeline

```
LLM Analysis → 4-dim scores → rawScore = sum(h, co, cn, t)
    ↓
curvedScore = 2.817 * rawScore + 7.490  (maps 26-32 range to 83-99)
    ↓
Ranking: curvedScore DESC, rawScore DESC
    ↓
Tiebreaker: internal float precision of rawScore
```

### JudgeEngine Design

```typescript
class JudgeEngine {
  async evaluate(moment: ClipCandidate, context: JudgeContext): Promise<JudgeResult> {
    // 1. Build dimension-specific prompts
    const hookResult = await this.evaluateDimension('hook', moment, context);
    const coherenceResult = await this.evaluateDimension('coherence', moment, context);
    const connectionResult = await this.evaluateDimension('connection', moment, context);
    const trendResult = await this.evaluateDimension('trend', moment, context);
    
    // 2. Aggregate
    const rawScore = hookResult.score + coherenceResult.score 
                   + connectionResult.score + trendResult.score;
    const curvedScore = scoreCurve(rawScore);
    
    return {
      hookScore: hookResult.score,
      coherenceScore: coherenceResult.score,
      connectionScore: connectionResult.score,
      trendScore: trendResult.score,
      sponsorshipScore: 0,
      rawScore,
      curvedScore,
      hookComment: hookResult.reasoning,
      coherenceComment: coherenceResult.reasoning,
      connectionComment: connectionResult.reasoning,
      trendComment: trendResult.reasoning,
      judgeModel: 'deepseek-v4-flash',
      judgeVersion: 'ganyiq-judge-v1',
      judgeTimestamp: new Date().toISOString(),
    };
  }
  
  private async evaluateDimension(
    dimension: Dimension,
    candidate: ClipCandidate,
    context: JudgeContext
  ): Promise<{ score: number; reasoning: string }> {
    // Use dimension-specific prompt
    const prompt = JUDGE_PROMPTS[dimension](candidate, context);
    
    // Call LLM with structured output
    const response = await llm.complete(prompt, {
      response_format: { type: 'json_object' },
      schema: {
        type: 'object',
        properties: {
          score: { type: 'number', minimum: 0, maximum: 10 },
          reasoning: { type: 'string' },
        },
        required: ['score', 'reasoning'],
      },
    });
    
    return JSON.parse(response);
  }
}

// Or more efficiently: batched single LLM call for all 4 dimensions
async evaluateBatch(moments: ClipCandidate[]): Promise<JudgeResult[]> {
  // Analyze multiple candidates in one LLM call
  // Each candidate gets 4-dim scores + reasoning
  // Returns JudgeResult[]
}
```

### Integration into Pipeline

In `lib/analyze-pipeline.ts`, after candidate extraction and before ranking:

```typescript
// ---- Judge Stage (NEW) ----
await setStage(analysisId, 'judging');
const judgedMoments = await judgeEngine.evaluateBatch(candidates);
```

### Ranking Changes

Replace `worthClippingScore`-based sorting with curvedScore-based:

```typescript
// Before
sorted.sort((a, b) => b.worthClippingScore - a.worthClippingScore);

// After 
sorted.sort((a, b) => {
  // Primary: curvedScore DESC
  if (b.judgeResult.curvedScore !== a.judgeResult.curvedScore)
    return b.judgeResult.curvedScore - a.judgeResult.curvedScore;
  // Secondary: rawScore DESC
  return b.judgeResult.rawScore - a.judgeResult.rawScore;
});
```

### Implementation Steps (Phase 1)

1. Create `lib/judge-types.ts` — JudgeResult interface, JudgeConfig
2. Create `lib/judge-prompt.ts` — 4 dimension-specific judge prompts
3. Create `lib/score-curve.ts` — raw → curved formula, aggregation
4. Create `lib/judge-engine.ts` — JudgeEngine class
5. Update `lib/types.ts` — add JudgeResult, extend RawMoment/RankedMoment
6. Update `lib/analyze-pipeline.ts` — add 'judging' stage
7. Update `lib/ranking.ts` — curved-score ranking, keep multi-factor dedup intact
8. Update `lib/score-breakdown.ts` — derive from 4-dim scores instead of DNA tags

**Estimated effort:** 12-16 hours
**Risk:** Medium — changes ranking pipeline, LLM prompt tuning needed

### Migration Strategy

Phase 1 runs ALONGSIDE existing scoring. No breaking changes:

1. Add JudgeResult to RawMoment as optional field
2. Judge engine runs after analyzer, stores 4-dim scores
3. Ranking uses curvedScore if available, falls back to worthClippingScore
4. Old analysis results still display correctly
5. Feature flag: `GANYIQ_FEATURE_JUDGE_V2=1` to enable

---

## Total Phase 0 + Phase 1

| Metric | Phase 0 | Phase 1 | Total |
|--------|---------|---------|-------|
| Files created | 3 | 4 | 7 |
| Files modified | 1 | 6 | 7 |
| Lines added | ~470 | ~680 | ~1,150 |
| Estimated hours | 4-6 | 12-16 | 16-22 |
| Risk | Low | Medium | — |

## Acceptance Criteria (Phase 0)
- [ ] TimelineJSON type compiles without errors
- [ ] DecisionSegment[] successfully serializes to TimelineJSON
- [ ] TimelineJSON validates correctly (valid cases pass, invalid fail)
- [ ] Serialized timeline can be round-tripped (JSON.parse(JSON.stringify(timeline)))
- [ ] All existing tests pass
- [ ] No existing files modified except `lib/types.ts` (export addition)

## Acceptance Criteria (Phase 1)
- [ ] JudgeResult type compiles without errors
- [ ] JudgeEngine evaluates all 4 dimensions per candidate
- [ ] curvedScore = rawToCurved(rawScore) matches formula
- [ ] Ranking uses curvedScore DESC, rawScore DESC
- [ ] Feature flag toggle works (judge ON/OFF)
- [ ] Backward compatible: old data displays correctly
- [ ] All existing tests pass
