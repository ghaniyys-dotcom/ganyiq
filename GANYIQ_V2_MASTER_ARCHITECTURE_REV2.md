# GANYIQ V2 MASTER ARCHITECTURE — REVISION 2

## Principal Architect & CTO Advisor — Final Blueprint

> Revision basis: Timeline JSON is the permanent heart of the system.
> Renderers are interchangeable consumers of that timeline.
> Decision Engine → Timeline JSON → Any Renderer.

---

## TABLE OF CONTENTS

1. [Architecture Philosophy — The Timeline Contract](#1-architecture-philosophy)
2. [Final Target Architecture](#2-final-target-architecture)
3. [Timeline JSON — The Permanent Contract](#3-timeline-json)
4. [Renderer Maturity Model](#4-renderer-maturity-model)
5. [Layer Ownership — Who Owns What](#5-layer-ownership)
6. [Multi Generator Design](#6-multi-generator-design)
7. [Judge Engine V2 Design](#7-judge-engine-v2)
8. [Global Ranking Engine](#8-global-ranking-engine)
9. [Stitching Engine](#9-stitching-engine)
10. [Timeline Builder](#10-timeline-builder)
11. [FFmpeg Renderer (Level 1)](#11-ffmpeg-renderer)
12. [Hybrid Renderer (Level 2-3)](#12-hybrid-renderer)
13. [WASM NLE Compositor (Level 4-5)](#13-wasm-nle-compositor)
14. [Feedback Loop](#14-feedback-loop)
15. [Execution Order for Solo Founder](#15-execution-order)
16. [File-by-File Migration Map](#16-file-migration-map)
17. [Phase Plan — 6 Phases](#17-phase-plan)
18. [Risk Register](#18-risk-register)
19. [Success Metrics](#19-success-metrics)

---

## 1. ARCHITECTURE PHILOSOPHY

### The Timeline Contract

Timeline JSON is the permanent contract between decision layer and render layer.

```
Decision Layer                   Render Layer
     │                                │
     │   Timeline JSON                │
     ├────────────────────────────────▶│
     │   (permanent contract)          │
     │                                │
     │   NEVER CHANGE THIS FORMAT      │
     │   WITHOUT VERSION BUMP          │
     │                                │
     │   Renderers come and go.        │
     │   Timeline JSON stays forever.  │
```

### Renderer Agnosticism

A feature is complete ONLY when:

```
DecisionEngine → TimelineJSON → AnyRenderer
```

This means you can swap ffmpeg for WASM without changing any decision logic. You can add a new layout mode by adding a track type, not by hacking filter strings.

### Why This Matters

OpusClip's evidence proves:

- **editingScript.tracks** is their permanent contract. The JS frontend consumes it. The renderer consumes it. The editor consumes it. Everything targets tracks.
- **AVEditorEngine WASM** is just ONE consumer of that contract. If they switched to a different renderer, the frontend would not change.
- **Segment stitching** works because the timeline has multi-segment tracks. Each clip's sources are timeline segments.
- **Multi-layout** works because layout is a per-segment track property, not a renderer filter.

GANYIQ's current architecture conflates decision and rendering in one filter graph. This is the single biggest architectural debt.

### Architecture Decisions

| Decision | Rationale |
|----------|-----------|
| Timeline JSON is versioned | Backward compatibility for stored projects |
| Tracks are independent | A face crop track does not block subtitle rendering |
| Keyframes are interpolated | LERP for position/scale/opacity — exact same as Opus WASM |
| Renderer never contains business logic | No layout decisions, no cropping math in renderer |
| Decision Engine owns ALL layout logic | DecisionSegment[] includes exact crop coordinates, layout mode, transitions |
| Subtitle is a first-class track | Not a separate ASS file overlay. Native word timing track. |

---

## 2. FINAL TARGET ARCHITECTURE

### High-Level Flow

```
Source Video (YouTube URL)
     │
     ▼
┌──────────────────────────────────────────────┐
│              ANALYSIS LAYER                   │
│  ├─ Transcript (Deepgram STT)                │
│  ├─ Genre Detection                          │
│  ├─ Scene Detection (threshold-based)         │
│  └─ Speaker Diarization                      │
└──────────────────────┬───────────────────────┘
                       │ Transcript, segments, speakers
                       ▼
┌──────────────────────────────────────────────┐
│          CANDIDATE GENERATORS                 │
│  ├─ RAW Generator    (baseline speaking)      │
│  ├─ HOOK Generator   (hook-potential moments) │
│  ├─ TREND Generator  (viral/topical moments)  │
│  └─ STORY Generator  (narrative arcs)         │
│                                               │
│  Each produces: CandidateWindow[]             │
└──────────────────────┬───────────────────────┘
                       │ Candidates with time ranges
                       ▼
┌──────────────────────────────────────────────┐
│              JUDGE ENGINE V2                  │
│  ├─ HookScore     (0-10)                     │
│  ├─ CoherenceScore (0-10)                    │
│  ├─ ConnectionScore (0-10)                   │
│  └─ TrendScore     (0-10)                    │
│                                               │
│  Output: rawScore = hook + coh + conn + trend │
└──────────────────────┬───────────────────────┘
                       │ Scored candidates
                       ▼
┌──────────────────────────────────────────────┐
│              STITCHING ENGINE                 │
│  ├─ Merge adjacent candidates                │
│  ├─ Score-aware segment combination          │
│  ├─ Transition generation (crossfade/slide)  │
│  └─ Duration optimization                    │
└──────────────────────┬───────────────────────┘
                       │ Stitched clips with segments
                       ▼
┌──────────────────────────────────────────────┐
│            RANKING ENGINE                     │
│  ├─ curvedScore = 2.817 × rawScore + 7.490   │
│  └─ Sort by curvedScore DESC, rawScore DESC  │
└──────────────────────┬───────────────────────┘
                       │ Ranked clip list
                       ▼
┌──────────────────────────────────────────────┐
│            TIMELINE BUILDER                   │
│  ├─ Convert DecisionSegment[] → TimelineJSON │
│  ├─ Track generation per component           │
│  │   ├─ VideoTrack (source timing)           │
│  │   ├─ FaceCropTrack (crop coords per frame)│
│  │   ├─ SubtitleTrack (word-level timing)    │
│  │   ├─ LayoutTrack (layout mode per segment)│
│  │   └─ OverlayTrack (hook, emoji, b-roll)  │
│  └─ Timeline validation                      │
└──────────────────────┬───────────────────────┘
                       │ Timeline JSON (THE CONTRACT)
                       │
                       ├───────────────────────────────────────┐
                       │                                       │
                       ▼                                       ▼
┌──────────────────────────────┐     ┌──────────────────────────────┐
│     FFMPEG RENDERER (L1)     │     │     WASM PREVIEW (L4)        │
│  ├─ Read Timeline JSON       │     │  ├─ Read Timeline JSON       │
│  ├─ Convert tracks→filter    │     │  ├─ Canvas/WebGL compositing │
│  ├─ Encode MP4               │     │  ├─ 30fps preview            │
│  └─ Output final video       │     │  └─ Interactive editing      │
└──────────────────────────────┘     └──────────────────────────────┘
                                            │
                                            ▼
                                      ┌──────────────────────────────┐
                                      │  WASM EXPORT (L5)            │
                                      │  ├─ Server-side NLE          │
                                      │  ├─ Frame-by-frame render    │
                                      │  ├─ GPU-accelerated encoding │
                                      │  └─ Final video output       │
                                      └──────────────────────────────┘

### Layer Responsibilities

#### ANALYSIS LAYER
- **Input**: YouTube URL or uploaded video
- **Output**: Transcript, scene boundaries, detected speakers, genre classification
- **Files**: `lib/analyze-pipeline.ts`, `lib/analyzer.ts`, Deepgram integration
- **Current state**: EXISTS in GANYIQ. Minimal changes needed.
- **Migration**: Add scene detection (threshold-based) and genre detection.

#### CANDIDATE GENERATORS
- **Input**: Transcript, scene boundaries, detected speakers
- **Output**: CandidateWindow[] (time range + code + metadata)
- **Files**: `lib/candidate-extraction.ts` (current), `lib/generators/*.ts` (new)
- **Current state**: Single deterministic pipeline (15 signals).
- **Migration**: Replace with 4 specialized parallel generators.

#### JUDGE ENGINE V2
- **Input**: CandidateWindow[] + transcript excerpt
- **Output**: ScoredCandidate (rawScore + 4 dimension scores)
- **Files**: `lib/judge/*.ts` (new)
- **Current state**: Single LLM call → worthClippingScore + DNA tags.
- **Migration**: Add 4-dimension LLM scoring with structural rubric.

#### STITCHING ENGINE
- **Input**: ScoredCandidate[]
- **Output**: StitchedClip[] (merge candidates + transitions)
- **Files**: `lib/stitching.ts` (new)
- **Current state**: No stitching. Single segment per clip.
- **Migration**: Add score-aware candidate merging logic.

#### RANKING ENGINE
- **Input**: StitchedClip[]
- **Output**: RankedClip[] (rank + curvedScore)
- **Files**: `lib/ranking.ts` (refactor existing)
- **Current state**: Deterministic score + diversity + tier assignment.
- **Migration**: Replace with curvedScore DESC, rawScore DESC ranking.

#### TIMELINE BUILDER
- **Input**: RankedClip[] + DecisionSegment[] + face tracking data + subtitle data
- **Output**: Timeline JSON
- **Files**: `lib/timeline/*.ts` (new)
- **Current state**: DOES NOT EXIST. DecisionSegment[] goes directly to ffmpeg.
- **Migration**: THIS IS PHASE 0. Build before anything else.

#### FFMPEG RENDERER (Level 1)
- **Input**: Timeline JSON
- **Output**: MP4 video file
- **Files**: `worker/clip-renderer.ts` (refactor existing)
- **Current state**: Giant filter graph. Direct segment→filter conversion.
- **Migration**: Replace with Timeline JSON → filter graph converter.

#### WASM PREVIEW (Level 4)
- **Input**: Timeline JSON
- **Output**: Real-time canvas preview (30fps)
- **Files**: New: `worker/wasm/*.ts` or frontend component
- **Current state**: DOES NOT EXIST.
- **Migration**: Phase 6. Not urgent.

#### WASM EXPORT (Level 5)
- **Input**: Timeline JSON
- **Output**: High-quality MP4 via server-side WASM compositor
- **Files**: New: `worker/wasm/compositor.c`, `wasm-build/`
- **Current state**: DOES NOT EXIST.
- **Migration**: Phase 6. Long-term. Year+ horizon.

---

## 3. TIMELINE JSON — THE PERMANENT CONTRACT

### Design Principles

1. **Renderers are interchangeable** — the same Timeline JSON must work with ffmpeg, hybrid, and WASM renderers
2. **Tracks are independent** — each track has its own timeline, keyframes, and interpolation
3. **Versioned** — `timelineVersion` field allows backward-compatible evolution
4. **Self-contained** — all data needed for rendering is in the JSON (no external .ass files)
5. **Human-readable** — debugging should not require a decoder

### Schema

```typescript
// ─── Top-Level ───
interface TimelineDocument {
  timelineVersion: 1;
  meta: TimelineMeta;
  tracks: Track[];
  durationMs: number;
  resolution: { width: 1080; height: 1920 };
  fps: number;
}

interface TimelineMeta {
  projectId: string;
  clipId: string;
  sourceVideoUrl: string;
  sourceDurationMs: number;
  clipRank: number;
  clipCurvedScore: number;
  createdAt: string;  // ISO timestamp
}

// ─── Tracks ───
type TrackType = 
  | 'video_source'      // Original video
  | 'face_crop'         // Cropped face region
  | 'layout_composite'  // How face tracks are composited (side-by-side, PiP, etc.)
  | 'subtitle'          // Word-level caption
  | 'overlay_hook'      // Hook text overlay
  | 'overlay_emoji'     // Emoji overlay
  | 'overlay_broll'     // B-roll footage overlay
  | 'overlay_watermark' // Brand watermark
  | 'transition'        // Transition between segments
  | 'audio_source'      // Original audio
  | 'audio_effect'      // Audio processing (voice enhancement, etc.);

interface Track {
  id: string;                  // Unique track identifier
  type: TrackType;
  enabled: boolean;
  zIndex: number;              // Compositing order (lower = first rendered)
  opacity: number;             // 0.0 - 1.0
  segments: TrackSegment[];   // Time-bound segments with content
}

interface TrackSegment {
  id: string;
  startMs: number;   // When this segment starts in the final clip
  endMs: number;     // When this segment ends
  sourceStartMs: number;  // Corresponding time in source video (for source-based tracks)
  sourceEndMs: number;
  
  // Transform keyframes (interpolated by renderer)
  transform?: TrackTransform;
  
  // Content (type-specific)
  content: TrackContent;
}

interface TrackTransform {
  position?: KeyframeProperty<{x: number; y: number}>;
  scale?: KeyframeProperty<{x: number; y: number}>;
  rotation?: KeyframeProperty<number>;  // degrees
  crop?: KeyframeProperty<{x: number; y: number; w: number; h: number}>;
  opacity?: KeyframeProperty<number>;
}

interface KeyframeProperty<T> {
  keyframes: Keyframe<T>[];
  interpolation: 'linear' | 'ease_in_out' | 'step';
}

interface Keyframe<T> {
  t: number;   // Normalized time (0.0 - 1.0 within the segment)
  value: T;
}

// ─── Track-Specific Content ───

// Video source track
interface VideoSourceContent {
  type: 'video_source';
  url: string;  // Signed URL or local path
}

// Face crop track
interface FaceCropContent {
  type: 'face_crop';
  faceId: string;
  speakerLabel?: string;
  cropX: number;      // Center X in source coordinates
  cropY: number;      // Center Y
  cropWidth: number;   // Crop window width
  cropHeight: number;  // Crop window height
}

// Layout composite track
interface LayoutCompositeContent {
  type: 'layout_composite';
  mode: 'single' | 'split_2' | 'split_3' | 'split_4' | 'pip' | 'hero_reaction';
  faceIds: string[];  // Ordered list of face tracks to composite
}

// Subtitle track
interface SubtitleContent {
  type: 'subtitle';
  words: WordItem[];
  style: SubtitleStyle;
}

interface WordItem {
  text: string;
  startMs: number;    // When this word appears
  endMs: number;      // When this word disappears
  emphasis?: 'highlight' | 'dim' | 'number' | 'none';
}

interface SubtitleStyle {
  fontFamily: string;
  fontSize: number;
  color: string;       // Hex
  strokeColor: string;
  strokeWidth: number;
  position: 'bottom' | 'middle' | 'top' | 'auto';
  animation: 'karaoke_fill_pop' | 'pop' | 'scale' | 'none';
  highlightColor: string;
  uppercase: boolean;
}

// Overlay hook track
interface OverlayHookContent {
  type: 'overlay_hook';
  text: string;
  position: 'top' | 'bottom';
  animation: 'fade_in' | 'slide_in' | 'none';
  durationMs: number;
}

// Overlay emoji track
interface OverlayEmojiContent {
  type: 'overlay_emoji';
  emoji: string;      // Unicode emoji character
  position: { x: number; y: number };
  scale: number;
}

// Transition track
interface TransitionContent {
  type: 'transition';
  transitionType: 'crossfade' | 'slide' | 'fade_to_black' | 'none';
  durationMs: number;
}

// Audio source track
interface AudioSourceContent {
  type: 'audio_source';
  url: string;
  volume: number;  // 0.0 - 1.0
}
```

### Example Timeline JSON

```json
{
  "timelineVersion": 1,
  "meta": {
    "projectId": "P3061506SPKq",
    "clipId": "8t753DPmUM",
    "sourceVideoUrl": "https://...",
    "sourceDurationMs": 2883000,
    "clipRank": 1,
    "clipCurvedScore": 99,
    "createdAt": "2026-06-15T06:30:00.000Z"
  },
  "durationMs": 16938,
  "resolution": { "width": 1080, "height": 1920 },
  "fps": 30,
  "tracks": [
    {
      "id": "source_video",
      "type": "video_source",
      "enabled": true,
      "zIndex": 0,
      "opacity": 1.0,
      "segments": [
        {
          "id": "seg_0",
          "startMs": 0,
          "endMs": 2478,
          "sourceStartMs": 2069924,
          "sourceEndMs": 2072402,
          "content": { "type": "video_source", "url": "signed://..." }
        },
        {
          "id": "seg_1",
          "startMs": 2478,
          "endMs": 16938,
          "sourceStartMs": 2077287,
          "sourceEndMs": 2091750,
          "content": { "type": "video_source", "url": "signed://..." }
        }
      ]
    },
    {
      "id": "face_crop_0",
      "type": "face_crop",
      "enabled": true,
      "zIndex": 1,
      "opacity": 1.0,
      "segments": [
        {
          "id": "fc_seg_0",
          "startMs": 0,
          "endMs": 2478,
          "sourceStartMs": 2069924,
          "sourceEndMs": 2072402,
          "transform": {
            "crop": {
              "keyframes": [
                { "t": 0, "value": { "x": 563, "y": 0, "w": 563, "h": 1080 } },
                { "t": 1, "value": { "x": 570, "y": 0, "w": 563, "h": 1080 } }
              ],
              "interpolation": "linear"
            }
          },
          "content": {
            "type": "face_crop",
            "faceId": "face_0",
            "cropX": 845,
            "cropY": 540,
            "cropWidth": 563,
            "cropHeight": 1080
          }
        }
      ]
    },
    {
      "id": "layout",
      "type": "layout_composite",
      "enabled": true,
      "zIndex": 2,
      "opacity": 1.0,
      "segments": [
        {
          "id": "layout_seg_0",
          "startMs": 0,
          "endMs": 16938,
          "content": {
            "type": "layout_composite",
            "mode": "single",
            "faceIds": ["face_0"]
          }
        }
      ]
    },
    {
      "id": "subtitle",
      "type": "subtitle",
      "enabled": true,
      "zIndex": 3,
      "opacity": 1.0,
      "segments": [
        {
          "id": "sub_seg_0",
          "startMs": 0,
          "endMs": 16938,
          "content": {
            "type": "subtitle",
            "words": [
              { "text": "Lo", "startMs": 0, "endMs": 75 },
              { "text": "paling", "startMs": 95, "endMs": 296 },
              { "text": "terganggu", "startMs": 316, "endMs": 736 }
            ],
            "style": {
              "fontFamily": "Montserrat",
              "fontSize": 40,
              "color": "#ffffff",
              "strokeColor": "#000000",
              "strokeWidth": 8,
              "position": "auto",
              "animation": "karaoke_fill_pop",
              "highlightColor": "#04f827",
              "uppercase": true
            }
          }
        }
      ]
    },
    {
      "id": "hook_overlay",
      "type": "overlay_hook",
      "enabled": true,
      "zIndex": 4,
      "opacity": 1.0,
      "segments": [
        {
          "id": "hook_seg_0",
          "startMs": 0,
          "endMs": 2000,
          "content": {
            "type": "overlay_hook",
            "text": "Suara makan berisik ganggu banget?",
            "position": "top",
            "animation": "slide_in",
            "durationMs": 2000
          }
        }
      ]
    }
  ]
}
```

### Versioning Strategy

```
timelineVersion 1 — Initial (Phase 0, Week 2)
  - video_source, face_crop, layout_composite, subtitle, overlay_hook, audio_source tracks
  - Linear keyframe interpolation
  - 1080×1920 resolution

timelineVersion 2 (Phase 4, Week 15)
  - overlay_emoji, overlay_broll, overlay_watermark
  - transition track
  - Ease-in-out interpolation

timelineVersion 3 (Phase 6, Month 7+)
  - audio_effect track
  - WASM-specific annotations (non-binding for ffmpeg renderer)
```

The Timeline Builder always emits the latest version. Each renderer explicitly declares which versions it supports. A renderer receiving an unsupported version either rejects or falls back to ffmpeg.

---

## 4. RENDERER MATURITY MODEL

### Level 0 — Giant Filter Graph
**Current GANYIQ state.** DecisionSegment[] is concatenated into one ffmpeg filter\_complex string. No timeline concept. Business logic and rendering are one spaghetti.

```
DecisionSegment[] ─→ Filter String Builder ─→ ffmpeg ─→ MP4
                   (clip-renderer.ts)
```

### Level 1 — Timeline → FFmpeg Renderer
**Phase 4 target.** DecisionSegment[] → Timeline JSON → FFmpeg converter → MP4. The filter graph builder is replaced with a Timeline JSON reader. Renderer has ZERO business logic.

```
DecisionSegment[] ─→ Timeline Builder ─→ Timeline JSON ─→ FFmpeg Reader ─→ MP4
                   (Phase 0)             (Phase 4)
```

### Level 2 — Timeline → Multi-Track Renderer
**Phase 4+ target.** Each track is an independent ffmpeg filter chain. Tracks are composited by Z-order. Subtitle track, face crop track, video source track — each rendered as independent streams, then stacked.

```
Timeline JSON ─→ Track Splitter ─→ [Video Filter] ─→┐
                                  ├→ [Crop Filter] ─→┤ Composite ─→ MP4
                                  ├→ [Sub Filter]  ─→┤
                                  └→ [Overlay]     ─→┘
```

### Level 3 — Timeline → Hybrid Renderer
**Phase 4-5 target.** Some tracks rendered by ffmpeg (video source, audio), some by native code (subtitle, emoji). The renderer selects optimal backend per track type.

```
Timeline JSON ─→ Route ─→ FFmpeg tracks ─→┐
                       └→ Native tracks  ─→┤ Composite ─→ MP4
```

### Level 4 — Timeline → WASM NLE Preview
**Phase 6 target.** Browser-side WASM compositor renders Timeline JSON to canvas at 30fps. Interactive editing: drag tracks, adjust timing, change layout. No server-side rendering for preview.

```
Timeline JSON ─→ WASM Preview ─→ Canvas (30fps browser)
```

### Level 5 — Timeline → Full NLE Ecosystem
**Long-term vision.** WASM compositor runs server-side for final export. Full editing UI. Multiple render backends (MP4, GIF, Premiere XML). Plugin architecture for custom renderers.

```
Timeline JSON ─→ WASM Server Export ─→ MP4 (GPU encoded)
              ─→ WASM Preview ─→ Canvas (browser)
              ─→ XML Exporter ─→ Premiere XML
              ─→ Custom Renderer ─→ Any output
```

### Current State Assessment

| Renderer | Level | Status | Timeline Support |
|----------|-------|--------|------------------|
| GANYIQ Today | Level 0 | IN PRODUCTION | None |
| Phase 4 Target | Level 1-2 | BUILDING | Phase 0 schema |
| Phase 6 Target | Level 3-4 | PLANNED | Version 2+ |

---

## 5. LAYER OWNERSHIP — WHO OWNS WHAT

### Decision Layer (Timeline Producers)

| Component | Ownership | Produces |
|-----------|-----------|----------|
| Analysis Pipeline | Transcript + segments | `AnalysisChunk[]` |
| Candidate Generators | 4 parallel generators | `CandidateWindow[]` |
| Judge Engine V2 | 4-dimension scoring | `ScoredCandidate[]` |
| Stitching Engine | Score-aware merging | `StitchedClip[]` |
| Ranking Engine | curvedScore DESC sorting | `RankedClip[]` |
| Timeline Builder | Timeline JSON construction | `TimelineDocument` |

### Timeline Layer (The Contract)

| Component | Ownership | Input | Output |
|-----------|-----------|-------|--------|
| Timeline JSON Schema | P0, never changes without version bump | — | `timelineVersion` |
| Timeline Serializer | DecisionSegment[] → Timeline JSON | `DecisionSegment[]` | `TimelineDocument` |
| Timeline Validator | Validate timeline before sending to renderer | `TimelineDocument` | Validation errors |
| Timeline Version Manager | Handle version migration | `TimelineDocument` | Upgraded document |

### Render Layer (Timeline Consumers)

| Component | Ownership | Input | Output |
|-----------|-----------|-------|--------|
| FFmpeg Renderer (L1) | Convert tracks to ffmpeg commands | `TimelineDocument` | MP4 |
| Multi-Track Renderer (L2) | Independent track ffmpeg chains | `TimelineDocument` | MP4 |
| Hybrid Renderer (L3) | Route tracks to optimal backend | `TimelineDocument` | MP4 |
| WASM Preview (L4) | Canvas compositing in browser | `TimelineDocument` | 30fps preview |
| WASM Export (L5) | Server-side NLE compositor | `TimelineDocument` | MP4/XML |

### Strict Rules

1. **Decision Layer NEVER references ffmpeg.** No `scale=`, no `crop=`, no filter syntax.
2. **Timeline Layer NEVER references ffmpeg.** Pure JSON schema + validation.
3. **Render Layer NEVER references DecisionSegment.** Only reads Timeline JSON.
4. **Business logic lives in Decision Layer.** Layout selection, face tracking math, transition timing — all in Decision Engine.
5. **Render logic lives in Render Layer.** Codec selection, pixel manipulation, GPU encoding — all in Renderer.

---

## 6. MULTI GENERATOR DESIGN

### Generator Architecture

```
Transcript + Scene Boundaries + Speakers
                 │
    ┌────────────┼────────────┬───────────┐
    ▼            ▼            ▼           ▼
  RAW        HOOK         TREND       STORY
 Generator  Generator    Generator   Generator
    │            │            │           │
    └────────────┼────────────┼───────────┘
                 ▼
         Candidate Pool
         (merged, deconflicted)
```

### Generator Specifications

#### RAW Generator

| Property | Value |
|----------|-------|
| **Objective** | Baseline coverage. Extract ALL speaking segments as candidates. |
| **Type** | Deterministic (no LLM needed) |
| **Trigger** | Any speaking segment ≥5s |
| **Expected duration** | 15-60s |
| **Stitching behavior** | None. Single segment only. |
| **Optimization target** | Coverage. Every speaker, every major segment. |
| **Implementation** | Reuse existing `candidate-extraction.ts` 15 signals. Filter by threshold. Emit all passing segments. |
| **Expected count** | 30-50 candidates per 48-min video |
| **Opus equivalent** | RAW (66.7% of clips) |

**Selection strategy:**
```
1. Parse transcript into segments with speaker labels
2. For each segment ≥5s:
   a. Calculate base score from 15 deterministic signals
   b. If base score > threshold (e.g. 30/100): emit as candidate
3. Also emit segments adjacent to high-score moments (context windows)
4. No LLM call needed — purely deterministic
```

#### HOOK Generator

| Property | Value |
|----------|-------|
| **Objective** | Identify hook-potential moments — questions, opinions, surprising statements. |
| **Type** | LLM-assisted (1 LLM call per batch) |
| **Trigger** | Moments with hook signals (questions, contrasts, strong opinions) |
| **Expected duration** | 15-45s |
| **Stitching behavior** | HIGH. Combine hook setup + hook delivery + reaction into multi-segment clip. |
| **Optimization target** | HookScore. Opening question/statement must grab attention. |
| **Implementation** | LLM prompt: analyze transcript for hook moments. Score by hook strength. Stitch hook parts. |
| **Expected count** | 8-15 candidates per 48-min video |
| **Opus equivalent** | HPv2 (19.4% of clips) |

**Selection strategy:**
```
1. Filter transcript segments by hook signals:
   - Questions (?, tanya, apakah, bagaimana)
   - Contrast phrases (tapi, namun, actually, honestly)
   - Opinion markers (menurut gua, gua rasa, honestly)
   - Surprise markers (anjir, wait, what, serius?)
2. For each hook signal cluster:
   a. Extract window: 5s before hook + hook + 10s after (for reaction)
   b. LLM evaluates: "On a scale of 1-10, how attention-grabbing is this moment?"
   c. If hookScore ≥ 7/10: emit as candidate
3. Include adjacent segments for stitching context
```

#### TREND Generator

| Property | Value |
|----------|-------|
| **Objective** | Identify trending/viral topics — named entities, current events, controversial opinions. |
| **Type** | LLM-assisted (1 LLM call per batch) |
| **Trigger** | Named entities, trending topics, controversial statements, hot takes |
| **Expected duration** | 45-120s (longer — need to develop the topic) |
| **Stitching behavior** | MODERATE. Combine related topical segments across video. |
| **Optimization target** | TrendScore. Is this topic currently relevant/viral? |
| **Implementation** | LLM prompt: evaluate topical relevance. Score by trend potential. |
| **Expected count** | 4-8 candidates per 48-min video |
| **Opus equivalent** | TPv3 (11.1% of clips) |

**Selection strategy:**
```
1. Filter transcript segments by trend signals:
   - Named entities (people, brands, events)
   - Temporal markers (sekarang, nowadays, currently, baru-baru ini)
   - Controversy markers (kontroversi, debate, hot take, unpopular opinion)
   - Viral markers (viral, trending, everyone's talking about)
2. For each trend cluster:
   a. Determine if topic is evergreen or time-sensitive
   b. LLM evaluates: "How relevant/viral is this topic RIGHT NOW?"
   c. If trendScore ≥ 7/10: emit as candidate
3. Prefer LONGER windows (60-120s) to fully develop the topic
```

#### STORY Generator

| Property | Value |
|----------|-------|
| **Objective** | Identify narrative arcs — storytelling sequences with beginning, middle, end. |
| **Type** | LLM-assisted (1 LLM call per batch) |
| **Trigger** | Story markers (personal anecdotes, "let me tell you", chronological sequences) |
| **Expected duration** | 30-90s |
| **Stitching behavior** | MODERATE. Combine narrative arc segments. |
| **Optimization target** | CoherenceScore. Does the clip tell a complete story? |
| **Implementation** | LLM prompt: evaluate narrative completeness. Score by storytelling quality. |
| **Expected count** | 3-6 candidates per 48-min video |
| **Opus equivalent** | RHP-like + additional narrative focus |

**Selection strategy:**
```
1. Filter transcript segments by narrative signals:
   - Story openings (cerita, dulu, waktu itu, let me tell you)
   - Sequence markers (pertama, kedua, kemudian, after that)
   - Personal pronouns (gue, gua, I, my, we)
   - Emotional markers (senang, sedih, marah, excited)
   - Resolution markers (akhirnya, so, that's why, jadi)
2. For each story cluster:
   a. Identify narrative arc: setup → conflict → resolution
   b. LLM evaluates: "Does this segment tell a complete story?"
   c. If present: emit as candidate with narrative metadata
3. Stitch story segments in chronological order for coherence
```

### Generator Parallelism

All 4 generators run in PARALLEL on the same transcript. They are independent — one generator's failure does not affect others. Output is merged into a single candidate pool before deduplication.

### Candidate Deduplication (Post-Generator)

After all 4 generators emit candidates, deduplicate:

```
1. Group candidates by time proximity (overlap > 50% = same moment)
2. Within each group:
   a. Keep the candidate with HIGHEST score
   b. Merge generatorOrigin tags (RAW, HOOK, TREND, STORY)
3. Apply diversity enforcement:
   a. If two candidates overlap > 30% but have DIFFERENT generators:
      Keep both (different perspectives on same moment)
   b. If they have the SAME generator:
      Keep only the higher-scored one
```

---

## 7. JUDGE ENGINE V2

### Architecture

```
CandidateWindow (time range + transcript excerpt + metadata)
         │
         ▼
┌─────────────────────────────────────┐
│       JUDGE ENGINE V2               │
│                                     │
│  ┌──────────────────────────────┐   │
│  │  Hook Evaluator              │   │
│  │  → hookScore (0-10)          │   │
│  └──────────────────────────────┘   │
│  ┌──────────────────────────────┐   │
│  │  Coherence Evaluator         │   │
│  │  → coherenceScore (0-10)     │   │
│  └──────────────────────────────┘   │
│  ┌──────────────────────────────┐   │
│  │  Connection Evaluator        │   │
│  │  → connectionScore (0-10)    │   │
│  └──────────────────────────────┘   │
│  ┌──────────────────────────────┐   │
│  │  Trend Evaluator             │   │
│  │  → trendScore (0-10)         │   │
│  └──────────────────────────────┘   │
│                                     │
│  Aggregation:                       │
│  rawScore = hook + coherence +      │
│             connection + trend      │
└──────────────────────┬──────────────┘
                       ▼
              ScoredCandidate
```

### Dimension Definitions

#### HookScore (0-10)

| Aspect | Detail |
|--------|--------|
| **Definition** | How well does the opening of this clip grab attention and relate to the clip's topic? |
| **Input** | First 3 transcript lines of the candidate + segment metadata |
| **Rubric** | |
| 9-10 | Opens with a compelling question, controversial statement, or surprising fact. Immediate attention grab. |
| 7-8 | Opens with a relatable observation or interesting statement. Good but could be more direct. |
| 5-6 | Opens with a neutral statement or factual description. Not framed as a hook. |
| 3-4 | Opens mid-sentence or with filler. Unclear what the clip is about. |
| 1-2 | No clear opening. Rambling or off-topic start. |
| **Prompt design** | `Evaluate the HOOK STRENGTH of this clip's opening. Does the first statement grab attention? Is it framed as a question, surprising fact, or strong opinion? Score 1-10.` |
| **Scoring range** | 6-9 observed in Opus (clip-dependent) |

#### CoherenceScore (0-10)

| Aspect | Detail |
|--------|--------|
| **Definition** | Does the clip flow logically as a self-contained narrative? Do the segments connect naturally? |
| **Input** | Full candidate transcript + segment structure (single vs multi-segment) |
| **Rubric** | |
| 9-10 | Clear logical flow. One topic developed completely. Single-segment preferred. Transitions between ideas are natural. |
| 7-8 | Multiple related points connected coherently. Minor jumps but overall logical. |
| 5-6 | Several distinct ideas. Topic shifts are abrupt. Stitching visible. |
| 3-4 | Unrelated segments stitched together. Topic changes mid-clip without connection. |
| 1-2 | Incoherent. Multiple unrelated topics. Impossible to follow. |
| **Prompt design** | `Evaluate the NARRATIVE COHERENCE of this clip. Does it flow logically from start to finish? Does it develop ONE clear topic? Are any transitions between segments jarring? Score 1-10. PenalIZE multi-segment clips with unrelated content.` |
| **Scoring range** | 6-9 observed in Opus |

#### ConnectionScore (0-10)

| Aspect | Detail |
|--------|--------|
| **Definition** | How emotionally resonant or relatable is this content to the average viewer? |
| **Input** | Full candidate transcript + genre metadata |
| **Rubric** | |
| 9-10 | Highly relatable. Universal human experience described. Emotional resonance is strong. |
| 7-8 | Relatable observations. Audience can see themselves in the content. |
| 5-6 | Informative but not emotionally engaging. Topic-driven rather than people-driven. |
| 3-4 | Niche or specialized content. Limited audience resonance. |
| 1-2 | Confusing or alienating. Audience cannot relate. |
| **Prompt design** | `Evaluate the EMOTIONAL CONNECTION of this clip. How relatable is this content to a general audience? Does it describe universal experiences or feelings? Score 1-10.` |
| **Scoring range** | 5-10 observed in Opus |

#### TrendScore (0-10)

| Aspect | Detail |
|--------|--------|
| **Definition** | How timely, relevant, or viral-potential is this topic right now? |
| **Input** | Full candidate transcript + named entities extract |
| **Rubric** | |
| 9-10 | Currently trending topic. Named entities are in recent news. Highly viral potential. |
| 7-8 | Topical but not time-sensitive. Would perform well on social media. |
| 5-6 | Evergreen content. Interesting but unlikely to trend. |
| 3-4 | Niche topic. Limited viral potential. |
| 1-2 | Completely off-trend. No topical relevance. |
| **Prompt design** | `Evaluate the TOPICAL RELEVANCE of this clip. Is this topic currently trending or viral? Does it reference recent events or popular culture? Would people share this? Score 1-10.` |
| **Scoring range** | 5-8 observed in Opus |

### Aggregation Logic

```typescript
function calculateScores(candidate: CandidateWindow): ScoredCandidate {
  // Run 4 evaluations (can be parallel)
  const hook = evaluateHook(candidate);         // 0-10
  const coherence = evaluateCoherence(candidate); // 0-10
  const connection = evaluateConnection(candidate); // 0-10
  const trend = evaluateTrend(candidate);        // 0-10
  
  // Raw score = exact sum (matching Opus formula)
  const rawScore = hook + coherence + connection + trend;
  
  return {
    candidateId: candidate.id,
    hookScore: hook,
    coherenceScore: coherence,
    connectionScore: connection,
    trendScore: trend,
    rawScore: rawScore,
  };
}
```

### LLM Implementation Strategy

**Option A: Single Combined Call** (cheaper)
One LLM call evaluates all 4 dimensions at once:
```
System: You are a clip quality judge. Evaluate on 4 dimensions: hook, coherence, connection, trend.
User: [transcript excerpt]
Output: { "hookScore": 7, "coherenceScore": 8, "connectionScore": 6, "trendScore": 7, "rawScore": 28 }
```

**Option B: Four Independent Calls** (more accurate but 4x cost)
Each dimension gets a focused LLM call with specialized prompt. Better scoring per dimension but 4x the token cost.

**Recommendation**: Start with Option A (single combined call). This gives 80% accuracy at 25% of the cost. Upgrade to Option B only if per-dimension accuracy is insufficient.

### Token Budget Estimate (per candidate)

| Component | Tokens (Option A) | Tokens (Option B) |
|-----------|-------------------|-------------------|
| System prompt | ~200 | ~400 (4 × 100) |
| Transcript excerpt | ~500 | ~500 |
| Output | ~50 | ~50 |
| **Total per candidate** | **~750** | **~950** |

For 50 candidates: 37.5K tokens (A) vs 47.5K tokens (B). At current LLM pricing, Option A costs ~$0.03 per video. Option B costs ~$0.04.

---

## 8. GLOBAL RANKING ENGINE

### Formula

```
rawScore = hookScore + coherenceScore + connectionScore + trendScore
          (integer, 0-40 range, observed 26-32)

curvedScore = round(2.817 × rawScore + 7.490)
            (integer, 83-99 range, observed 83-99)

rank:
  1. SORT by curvedScore DESC
  2. TIEBREAK by rawScore DESC
  3. FINAL TIEBREAK by internal precision (fractional rawScore before rounding)
```

### Confirmed from Opus

```
raw → curved mapping:
  raw=32 → curved 97-99
  raw=31 → curved 94-97
  raw=30 → curved 89-94
  raw=29 → curved 87-89
  raw=28 → curved 86-87
  raw=27 → curved 85
  raw=26 → curved 83

ZERO rank inversions: curvedScore DESC + rawScore DESC = exact rank order.
```

### Pipeline

```typescript
interface ScoredCandidate {
  id: string;
  hookScore: number;      // 0-10
  coherenceScore: number; // 0-10
  connectionScore: number;// 0-10
  trendScore: number;     // 0-10
  rawScore: number;       // sum of above (integer)
}

interface RankedClip extends ScoredCandidate {
  curvedScore: number;    // transformed rawScore
  rank: number;           // position (1-indexed)
}

function rankCandidates(candidates: ScoredCandidate[]): RankedClip[] {
  // Step 1: Calculate curved scores
  const withCurved = candidates.map(c => ({
    ...c,
    curvedScore: Math.round(2.817 * c.rawScore + 7.490),
  }));
  
  // Step 2: Sort by curvedScore DESC, then rawScore DESC
  // (stable sort preserves internal precision order)
  withCurved.sort((a, b) => {
    if (b.curvedScore !== a.curvedScore) return b.curvedScore - a.curvedScore;
    return b.rawScore - a.rawScore;  // rawScore DESC as secondary sort
  });
  
  // Step 3: Assign ranks
  return withCurved.map((c, i) => ({
    ...c,
    rank: i + 1,
  }));
}
```

### Implementation Notes

1. **Internal precision**: The LLM evaluation produces continuous scores (e.g., hook=7.8). These are stored as floats. `rawScore` is computed from continuous values before rounding to integer. The rank preserves the continuous order even when integer scores are identical.

2. **Secondary sort**: When curvedScore is identical, rawScore DESC breaks the tie. This matches Opus's observed behavior — ZERO inversions.

3. **Tertiary tiebreaker**: When both curvedScore and integer rawScore are identical, the continuous rawScore (before integer rounding) determines order. This explains why four clips with components (9,8,6,7) and integer rawScore=30 can have curved scores 94, 93, 91, 89.

4. **No diversity enforcement**: Opus does NOT enforce per-arch diversity in ranking. All clips compete globally. GANYIQ currently enforces diversity (elite/secondary tier + dedup). Remove diversity enforcement for Opus-compatible ranking. Add diversity as a SEPARATE, optional post-processing step.

---

## 9. STITCHING ENGINE

### Purpose

Convert single-segment candidates into multi-segment clips by merging adjacent or thematically related candidates. This is what transforms GANYIQ's single-segment clips into Opus-style narrative clips.

### Algorithm

```typescript
interface CandidateWindow {
  id: string;
  startMs: number;
  endMs: number;
  transcriptExcerpt: string;
  scores: { hook: number; coherence: number; connection: number; trend: number };
  generatorOrigin: 'raw' | 'hook' | 'trend' | 'story';
}

interface StitchedClip {
  id: string;
  segments: {
    sourceStartMs: number;
    sourceEndMs: number;
    transitionIn: { type: 'crossfade' | 'slide' | 'none'; durationMs: number } | null;
  }[];
  scores: { hook: number; coherence: number; connection: number; trend: number };
}

function stitchCandidates(candidates: CandidateWindow[]): StitchedClip[] {
  const stitched: StitchedClip[] = [];
  
  // Phase 1: Sort by start time
  const sorted = [...candidates].sort((a, b) => a.startMs - b.startMs);
  
  // Phase 2: Identify merge opportunities
  let current = sorted[0];
  let mergeGroup = [current];
  
  for (let i = 1; i < sorted.length; i++) {
    const next = sorted[i];
    const gap = next.startMs - current.endMs;
    
    // Conditions for merging:
    // 1. Small gap (≤30s) — adjacent interesting moments
    // 2. Same generator origin — same topic/theme
    // 3. Score improvement — merging creates a better clip
    
    const shouldMerge = (
      gap <= 30000 &&                                    // gap ≤ 30s
      next.generatorOrigin === current.generatorOrigin && // same generator
      next.scores.hook >= 6                               // next moment is also engaging
    );
    
    if (shouldMerge) {
      mergeGroup.push(next);
    } else {
      // Finalize current merge group
      stitched.push(buildClip(mergeGroup));
      mergeGroup = [next];
    }
    current = next;
  }
  stitched.push(buildClip(mergeGroup));
  
  // Phase 3: Generate transitions between segments
  for (const clip of stitched) {
    for (let i = 1; i < clip.segments.length; i++) {
      const prevEnd = clip.segments[i-1].sourceEndMs;
      const currStart = clip.segments[i].sourceStartMs;
      const gap = currStart - prevEnd;
      
      if (gap <= 2000) {
        // Contiguous or near-contiguous: short crossfade
        clip.segments[i].transitionIn = {
          type: 'crossfade',
          durationMs: Math.min(gap + 200, 500),  // 200-500ms crossfade
        };
      } else {
        // Gap > 2s: slide transition
        clip.segments[i].transitionIn = {
          type: 'slide',
          durationMs: 400,
        };
      }
    }
  }
  
  return stitched;
}

function buildClip(mergeGroup: CandidateWindow[]): StitchedClip {
  // Merge scores from all segments in group
  const totalScores = {
    hook: Math.max(...mergeGroup.map(c => c.scores.hook)),
    coherence: calculateCoherenceScore(mergeGroup),  // decreases with more segments
    connection: Math.max(...mergeGroup.map(c => c.scores.connection)),
    trend: Math.max(...mergeGroup.map(c => c.scores.trend)),
  };
  
  return {
    id: `stitched_${mergeGroup[0].id}_${mergeGroup.length}seg`,
    segments: mergeGroup.map((c, i) => ({
      sourceStartMs: c.startMs,
      sourceEndMs: c.endMs,
      transitionIn: i === 0 ? null : { type: 'crossfade', durationMs: 300 },
    })),
    scores: totalScores,
  };
}

function calculateCoherenceScore(segments: CandidateWindow[]): number {
  // Coherence DECREASES with more segments
  // Base: average of individual coherence scores
  const avgCoh = segments.reduce((s, c) => s + c.scores.coherence, 0) / segments.length;
  
  // Penalty: -1 for each additional segment beyond the first
  const segmentPenalty = Math.max(0, segments.length - 1);
  
  // Gap penalty: wider gaps = less coherent
  const maxGap = Math.max(...segments.map((c, i) => {
    if (i === 0) return 0;
    return c.startMs - segments[i-1].endMs;
  }));
  const gapPenalty = maxGap > 10000 ? 1 : 0;
  
  return Math.max(1, Math.round(avgCoh - segmentPenalty - gapPenalty));
}
```

### Stitching Patterns (Based on Opus Evidence)

| Pattern | Segments | Gap | Transition | When to Use |
|---------|----------|-----|------------|-------------|
| Single | 1 | N/A | None | Standalone moment, complete thought |
| Adjacent stitch | 2-3 | ≤2s | Crossfade (200ms) | Same topic, same speaker, continuous |
| Thematic stitch | 2-3 | 2-30s | Slide (400ms) | Same topic, different parts of conversation |
| Montage | 3-5 | ≤1s | Crossfade (100ms) | Multiple hook moments, rapid cuts |
| Opener | 3 | Overlapping (-20ms) | Overlap transition | RHP-style opening montage |

---

## 10. TIMELINE BUILDER

### Purpose

Convert a RankedClip + its metadata into a complete TimelineDocument. This is the bridge between decision layer and render layer.

### Inputs

| Input | Source | Description |
|-------|--------|-------------|
| `RankedClip` | Ranking Engine | Clip details, scores, segments |
| `DecisionSegment[]` | Decision Engine | Per-frame face tracking data, crop coordinates |
| `SubtitleData` | Subtitle Renderer | Word-level timestamps with emphasis |
| `HookText` | Judge Engine (autoHook) | Generated hook overlay text |
| `VideoMetadata` | Analysis Layer | Source video URL, duration, resolution |

### Build Process

```typescript
function buildTimeline(
  clip: RankedClip,
  decisionSegments: DecisionSegment[],
  subtitleWords: WordItem[],
  hookText: string,
  videoMeta: VideoMetadata,
): TimelineDocument {
  // Track 1: Video source
  const videoTrack = buildVideoTrack(clip.segments, videoMeta);
  
  // Track 2: Face crop
  const faceCropTrack = buildFaceCropTrack(clip.segments, decisionSegments);
  
  // Track 3: Layout composite
  const layoutTrack = buildLayoutTrack(clip.segments, decisionSegments);
  
  // Track 4: Subtitle
  const subtitleTrack = buildSubtitleTrack(subtitleWords);
  
  // Track 5: Hook overlay (optional)
  const hookTrack = hookText ? buildHookTrack(hookText, clip.durationMs) : null;
  
  // Track 6: Audio source
  const audioTrack = buildAudioTrack(clip.segments, videoMeta);
  
  // Compile tracks
  const tracks: Track[] = [
    videoTrack,
    faceCropTrack,
    layoutTrack,
    subtitleTrack,
    ...(hookTrack ? [hookTrack] : []),
    audioTrack,
  ];
  
  return {
    timelineVersion: 1,
    meta: {
      projectId: '...',
      clipId: clip.id,
      sourceVideoUrl: videoMeta.url,
      sourceDurationMs: videoMeta.durationMs,
      clipRank: clip.rank,
      clipCurvedScore: clip.curvedScore,
      createdAt: new Date().toISOString(),
    },
    durationMs: calculateClipDuration(clip.segments),
    resolution: { width: 1080, height: 1920 },
    fps: 30,
    tracks,
    // Sort tracks by zIndex
    tracks: tracks.sort((a, b) => a.zIndex - b.zIndex),
  };
}
```

### Track Builders

```typescript
function buildVideoTrack(segments: Segment[], videoMeta: VideoMetadata): Track {
  return {
    id: 'source_video',
    type: 'video_source',
    enabled: true,
    zIndex: 0,
    opacity: 1.0,
    segments: segments.map((seg, i) => ({
      id: `seg_${i}`,
      startMs: calculateAccumulatedTime(segments, i),
      endMs: calculateAccumulatedTime(segments, i) + (seg.sourceEndMs - seg.sourceStartMs),
      sourceStartMs: seg.sourceStartMs,
      sourceEndMs: seg.sourceEndMs,
      content: { type: 'video_source', url: videoMeta.url },
    })),
  };
}

function buildFaceCropTrack(segments: Segment[], decisionSegments: DecisionSegment[]): Track {
  const cropSegments: TrackSegment[] = [];
  
  let accumulatedMs = 0;
  for (const seg of segments) {
    // Find corresponding face tracking data
    const faceData = decisionSegments.find(
      ds => seg.sourceStartMs >= ds.startTime * 1000 && seg.sourceEndMs <= ds.endTime * 1000
    );
    
    const duration = seg.sourceEndMs - seg.sourceStartMs;
    
    if (faceData?.crops?.length > 0) {
      const crop = faceData.crops[0]; // Primary speaker
      const OLD_CROP_W = 1080 * (1080 / 1920); // ~607px
      
      cropSegments.push({
        id: `fc_seg_${segments.indexOf(seg)}`,
        startMs: accumulatedMs,
        endMs: accumulatedMs + duration,
        sourceStartMs: seg.sourceStartMs,
        sourceEndMs: seg.sourceEndMs,
        transform: {
          crop: {
            keyframes: [
              { t: 0, value: { x: crop.cropX - 300, y: 0, w: OLD_CROP_W, h: 1080 } },
            ],
            interpolation: 'linear',
          },
        },
        content: {
          type: 'face_crop',
          faceId: `face_${crop.cropId || 0}`,
          cropX: crop.cropX,
          cropY: 540,
          cropWidth: OLD_CROP_W,
          cropHeight: 1080,
        },
      });
    }
    
    accumulatedMs += duration;
  }
  
  return {
    id: 'face_crop_0',
    type: 'face_crop',
    enabled: true,
    zIndex: 1,
    opacity: 1.0,
    segments: cropSegments,
  };
}
```

---

## 11. FFMPEG RENDERER (Phase 4, Level 1)

### Design

The ffmpeg renderer reads Timeline JSON and produces an MP4. It replaces the current `clip-renderer.ts` filter graph builder.

### Architecture

```
Timeline JSON
     │
     ▼
FFmpegRenderSession
  ├── parseTimeline()
  ├── buildFilterGraph()  
  ├── executeFFmpeg()
  └── validateOutput()
     │
     ▼
    MP4
```

### Timeline → Filter Graph Mapping

```typescript
function buildFilterGraph(timeline: TimelineDocument): string[] {
  const filterParts: string[] = [];
  const segmentLabels: string[] = [];
  
  // Step 1: Process each video_source segment
  for (const track of timeline.tracks.filter(t => t.type === 'video_source')) {
    for (const seg of track.segments) {
      segLabel = `sv_${seg.id}`;
      filterParts.push(
        `[0:v]trim=start=${seg.sourceStartMs/1000}:end=${seg.sourceEndMs/1000},`
        + `setpts=PTS-STARTPTS[${segLabel}]`
      );
      segmentLabels.push(`[${segLabel}]`);
    }
  }
  
  // Step 2: Apply face crop transforms
  for (const track of timeline.tracks.filter(t => t.type === 'face_crop')) {
    for (const seg of track.segments) {
      if (seg.transform?.crop) {
        const crop = seg.transform.crop.keyframes[0].value;
        // Apply crop=w:h:x:y from the first keyframe
        // ffmpeg doesn't support interpolation, so use approximate
        filterParts.push(
          // Hook into the video source label and apply crop
          `[${segmentLabels[0]}]crop=${crop.w}:${crop.h}:${crop.x}:${crop.y},`
          + `scale=1080:1920:flags=lanczos,`
          + `setsar=1[fc_${seg.id}]`
        );
      }
    }
  }
  
  // Step 3: Layout composite (vstack/hstack/overlay)
  for (const track of timeline.tracks.filter(t => t.type === 'layout_composite')) {
    for (const seg of track.segments) {
      switch (seg.content.mode) {
        case 'single':
          // Single face, just pass through
          break;
        case 'split_2':
          filterParts.push(
            `[fc_0][fc_1]vstack=inputs=2[single_${seg.id}]`
          );
          break;
        case 'pip':
          filterParts.push(
            `[fc_0][fc_1]overlay=W-w-20:H-h-20[pip_${seg.id}]`
          );
          break;
      }
    }
  }
  
  // Step 4: Overlay subtitles (use .ass file)
  // (Subtitle track is rendered as ASS, then overlaid via ass filter)
  
  // Step 5: Concat segments
  filterParts.push(
    `${segmentLabels.join('')}concat=n=${segmentLabels.length}:v=1:a=0,`
    + `format=yuv420p[vout]`
  );
  
  return filterParts;
}
```

### What Changes vs Current clip-renderer.ts

| Aspect | Current | Phase 4 Target |
|--------|---------|---------------|
| **Input** | DecisionSegment[] + direct params | Timeline JSON |
| **Filter logic** | Hardcoded in renderer (mode→filter switch) | Read from timeline (mode is in JSON) |
| **Crop coordinates** | In renderer code | In Timeline JSON keyframes |
| **Layout mode** | In renderer code | In Timeline JSON layout_track |
| **Transitions** | Computed in renderer | In Timeline JSON transition_track |
| **Subtitle** | Separate .ass file | Timeline JSON subtitle track (still rendered as ASS for ffmpeg) |
| **Business logic** | Mixed with rendering | ZERO. All logic is in Timeline JSON. |

### Files Changed

| File | Change |
|------|--------|
| `worker/clip-renderer.ts` | Replace buildFilterGraph() with Timeline JSON parser |
| `worker/render.ts` (existing entry point) | Minimal — pass Timeline JSON instead of DecisionSegment[] |
| `worker/features.ts` | Add `USE_TIMELINE_RENDERER` flag |

---

## 12. HYBRID RENDERER (Phase 4+, Level 2-3)

### Why Hybrid

Some track types are better rendered by ffmpeg (video source, audio). Some are better rendered natively (subtitle, emoji, hook overlay). A hybrid renderer routes each track to its optimal backend.

### Routing Logic

```typescript
function renderTimeline(timeline: TimelineDocument): Promise<string> {
  const ffmpegTracks: Track[] = [];
  const nativeTracks: Track[] = [];
  
  for (const track of timeline.tracks) {
    switch (track.type) {
      case 'video_source':
      case 'face_crop':
      case 'layout_composite':
      case 'audio_source':
        ffmpegTracks.push(track);
        break;
      
      case 'subtitle':
      case 'overlay_hook':
      case 'overlay_emoji':
      case 'overlay_watermark':
        nativeTracks.push(track);
        break;
    }
  }
  
  // Render ffmpeg tracks to video (no subtitles, no overlays)
  const baseVideo = await renderFFmpegTracks(timeline, ffmpegTracks);
  
  // Render native tracks to PNG sequence
  const overlayFrames = await renderNativeTracks(timeline, nativeTracks);
  
  // Composite overlay onto base video
  const finalVideo = await compositeOverlay(baseVideo, overlayFrames);
  
  return finalVideo;
}
```

### Native Rendering (for subtitle track)

```typescript
function renderSubtitleTrack(track: Track, fps: number): PNGSequence {
  const frames: Buffer[] = [];
  const totalFrames = Math.ceil(track.segments[0].endMs / 1000 * fps);
  
  for (let f = 0; f < totalFrames; f++) {
    const t = f / fps * 1000; // current time in ms
    
    // Find active words at this time
    const activeWords = track.segments[0].content.words.filter(
      w => t >= w.startMs && t < w.endMs
    );
    
    // Render to canvas/Cairo
    const frame = renderSubtitleFrame(activeWords, track.segments[0].content.style);
    frames.push(frame);
  }
  
  return frames;
}
```

---

## 13. WASM NLE COMPOSITOR (Phase 6, Level 4-5)

### Why WASM Compositor Exists

1. **Frame-perfect control**: ffmpeg filter graphs are limited in expressiveness. WASM allows arbitrary pixel manipulation per frame.
2. **Real-time preview**: The same WASM engine can render in the browser for instant feedback.
3. **Deterministic output**: Same Timeline JSON → same output, regardless of renderer.
4. **Future-proofing**: As rendering requirements grow (more overlay types, complex transitions), ffmpeg filter strings become unmanageable. WASM compositor scales.

### What Problems It Solves

| Problem | FFmpeg | WASM Compositor |
|---------|--------|-----------------|
| Word-level karaoke animation | Requires complex ASS styling | Native text rendering, per-word pixel control |
| Emoji overlay | Requires image files + overlay filter | Native emoji rendering |
| Smooth keyframe interpolation | No native support. Workaround: zoompan expressions. | Native LERP between keyframes |
| Z-order compositing | Requires multiple overlay filters | Single compositing pass |
| Frame-by-frame debugging | Must render full video first | Render single frame at any timestamp |
| Interactive editing | Not possible | Real-time parameter adjustment |

### What Stays on Server

| Component | Rationale |
|-----------|-----------|
| LLM calls (Judge Engine) | Cloud API, not feasible in-browser |
| Face tracking | Requires full video decode, better on server |
| Transcript generation | Deepgram API, server-side |
| Final video encoding | GPU acceleration available on server |
| Project storage | Database, file system |

### What Stays in FFmpeg

| Component | Rationale |
|-----------|-----------|
| Source video decoding | ffmpeg is best-in-class for codec support |
| Audio processing | ffmpeg audio filters are mature |
| Final encoding | x264/h264_nvenc — best quality/speed ratio |
| Concatenation | Concat demuxer for seamless segment joins |

### WASM Compositor Architecture (Preview)

```c
// Minimal WASM compositor — AVEditorEngine-style
// Each track is a layer rendered to a RGBA framebuffer

struct Compositor {
    tracks: Track[];
    framebuffer: RGBA[1920 * 1080];
};

void render_frame(Compositor* comp, float timestamp_ms) {
    // Clear framebuffer
    memset(comp->framebuffer, 0, 1920 * 1080 * 4);
    
    // Sort tracks by zIndex
    sort_tracks_by_zindex(comp->tracks);
    
    // Compose each track
    for each track in comp->tracks {
        if (!track->enabled) continue;
        
        // Get segment active at this timestamp
        Segment* seg = get_active_segment(track, timestamp_ms);
        if (!seg) continue;
        
        // Apply transforms (interpolate keyframes)
        Transform t = interpolate_transform(seg->transform, timestamp_ms);
        
        // Render track content to temp buffer
        RGBA* layer = render_segment(seg, timestamp_ms);
        
        // Apply transform (crop, scale, position)
        RGBA* transformed = apply_transform(layer, t);
        
        // Composite onto framebuffer (Z-order)
        composite(comp->framebuffer, transformed, seg->opacity);
        
        free(layer);
        free(transformed);
    }
}

RGBA* render_segment(Segment* seg, float timestamp_ms) {
    switch (seg->content.type) {
        case VIDEO_SOURCE:
            return decode_video_frame(seg->content.url, timestamp_ms);
        case FACE_CROP:
            return apply_crop(decode_video_frame(...), seg->content.crop);
        case SUBTITLE:
            return render_text(seg->content.words, timestamp_ms, seg->content.style);
        case OVERLAY_HOOK:
            return render_overlay_text(seg->content.text, timestamp_ms);
        case OVERLAY_EMOJI:
            return render_emoji(seg->content.emoji, timestamp_ms);
    }
}
```

### WASM Compositor — Server Export Architecture

```
Timeline JSON
     │
     ▼
┌─────────────────────────────────────┐
│  WASM Export Server                 │
│                                     │
│  For each frame (0 to duration):    │
│    render_frame(compositor, t)      │
│    → RGBA framebuffer              │
│    → send to GPU encoder           │
│    → H.264 NAL unit                │
│                                     │
│  GPU encoder (NVENC) segments       │
│  H.264 stream into MP4             │
└─────────────────────────────────────┘
     │
     ▼
    MP4
```

### WASM Compositor — Browser Preview Architecture

```
Timeline JSON (fetched from server)
     │
     ▼
┌─────────────────────────────────────┐
│  Browser WASM Compositor            │
│                                     │
│  WASM module loaded from CDN        │
│  Same code as server compositor     │
│                                     │
│  For each animation frame:          │
│    render_frame(compositor, t)      │
│    → RGBA framebuffer              │
│    → putImageData to canvas        │
│                                     │
│  30fps playback via requestAnimation│
└─────────────────────────────────────┘
     │
     ▼
  Canvas (visible to user)
```

### Migration Strategy (Phase 6)

**Step 1** (2 weeks): Build minimal WASM compositor that renders 2 tracks: video_source + subtitle. Target: browser preview only.

**Step 2** (4 weeks): Add face_crop track rendering. Add keyframe interpolation (position, scale, crop). Add layout_composite (single mode only).

**Step 3** (6 weeks): Add all layout modes (split, PiP, hero_reaction). Add multi-layer compositing with proper Z-order. Add transition rendering (crossfade via opacity keyframes).

**Step 4** (8 weeks): Port WASM compositor to Node.js server. Add NVENC GPU encoding. Match ffmpeg output quality.

**Step 5** (ongoing): Feature parity with ffmpeg renderer. Each new track type added to both renderers simultaneously.

---

## 14. FEEDBACK LOOP

### Data Collection Strategy

Every user interaction with a clip generates feedback data:

```typescript
interface ClipEvent {
  clipId: string;
  projectId: string;
  timestamp: string;  // ISO
  eventType: 'view' | 'like' | 'dislike' | 'export' | 'download' | 'edit' | 'delete' | 'reorder';
  
  // Clip state at time of event
  clipState: {
    rank: number;
    scores: { hook: number; coherence: number; connection: number; trend: number };
    curvedScore: number;
    archId: string;       // Which generator produced this
    isStitched: boolean;  // Was this a multi-segment clip?
    segmentCount: number;
    durationMs: number;
  };
  
  // For 'edit' events: what did user change?
  editDelta?: {
    trimmedMs?: number;
    changedLayout?: string;
    modifiedSubtitle?: boolean;
    addedTransition?: boolean;
    changedHook?: boolean;
  };
}
```

### Event Handlers

```typescript
// Frontend: Track user interactions
clipRenderer.on('like', () => recordEvent('like'));
clipRenderer.on('export', () => recordEvent('export'));
clipRenderer.on('trim', (newStart, newEnd) => recordEvent('edit', { trimmedMs: ... }));

function recordEvent(eventType: string, extra?: any) {
  fetch('/api/feedback', {
    method: 'POST',
    body: JSON.stringify({
      clipId: currentClip.id,
      projectId: currentProject.id,
      timestamp: new Date().toISOString(),
      eventType,
      clipState: {
        rank: currentClip.rank,
        scores: currentClip.scores,
        curvedScore: currentClip.curvedScore,
        archId: currentClip.archId,
        isStitched: currentClip.segments.length > 1,
        segmentCount: currentClip.segments.length,
        durationMs: currentClip.durationMs,
      },
      ...extra,
    }),
  });
}
```

### Database Schema

```sql
CREATE TABLE clip_feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clip_id VARCHAR(20) NOT NULL,
  project_id VARCHAR(30) NOT NULL,
  event_type VARCHAR(20) NOT NULL, -- view, like, dislike, export, download, edit, delete
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  
  -- Clip state snapshot
  clip_rank INT,
  hook_score INT,
  coherence_score INT,
  connection_score INT,
  trend_score INT,
  curved_score INT,
  arch_id VARCHAR(10),
  is_stitched BOOLEAN,
  segment_count INT,
  duration_ms INT,
  
  -- Edit delta (nullable)
  edit_trimmed_ms INT,
  edit_layout_changed VARCHAR(20),
  
  -- Metadata
  user_id VARCHAR(50),
  session_id VARCHAR(50)
);

CREATE INDEX idx_feedback_clip ON clip_feedback(clip_id);
CREATE INDEX idx_feedback_type ON clip_feedback(event_type);
CREATE INDEX idx_feedback_created ON clip_feedback(created_at);
```

### Training Data Usage

After collecting 1,000+ feedback events, the dataset can be used for:

1. **Score calibration**: If clips with hookScore=8 are consistently disliked, the hook evaluation rubric needs adjustment.
2. **Generator tuning**: If HOOK generator's clips are never exported, its selection strategy needs revision.
3. **Personalization**: If a user consistently likes clips with trendScore > 7, prioritize trend-generator clips for that user.
4. **A/B testing**: Compare clip quality metrics (export rate, like rate) before and after architectural changes.

### Feedback API

```typescript
// POST /api/feedback
app.post('/api/feedback', async (req, res) => {
  const { clipId, projectId, eventType, clipState, editDelta } = req.body;
  
  await db.query(
    `INSERT INTO clip_feedback 
     (clip_id, project_id, event_type, clip_rank, hook_score, ...)
     VALUES ($1, $2, $3, $4, $5, ...)`,
    [clipId, projectId, eventType, clipState.rank, clipState.hook, ...]
  );
  
  res.json({ success: true });
});

// GET /api/feedback/stats — for analysis
app.get('/api/feedback/stats', async (req, res) => {
  const { projectId } = req.query;
  
  const stats = await db.query(`
    SELECT 
      event_type,
      COUNT(*) as count,
      AVG(hook_score) as avg_hook,
      AVG(curved_score) as avg_curved
    FROM clip_feedback
    WHERE project_id = $1
    GROUP BY event_type
  `, [projectId]);
  
  res.json({ data: stats.rows });
});
```

---

## 15. EXECUTION ORDER FOR SOLO FOUNDER

### Principle: Maximum Quality Improvement Per Engineering Hour

For a solo founder, every hour must improve clip quality perceptibly. Do NOT build infrastructure before features. Do NOT build WASM before you have 10 paying users.

### Priority Ranking

| Rank | Item | Hours | Quality Impact | Why Now |
|------|------|-------|---------------|---------|
| 1 | Timeline JSON schema + validator | 20h | Foundational | All future work depends on this |
| 2 | DecisionSegment → Timeline serializer | 15h | Foundational | Converts existing data into timeline format |
| 3 | Judge Engine V2 (Option A single call) | 25h | **CRITICAL** | Single biggest quality improvement — 4-dimension scoring replaces 1-dimension |
| 4 | Curved score + new ranking | 10h | HIGH | Better clip ordering. Works immediately after Judge V2. |
| 5 | Multi-generator (RAW + HOOK) | 40h | **CRITICAL** | More diverse candidate pool. 2 generators > 1. |
| 6 | Stitching engine (merge adjacent) | 30h | HIGH | Opus-quality clips. 47% single only → multi-segment. |
| 7 | Multi-generator (TREND + STORY) | 30h | MEDIUM | Additional diversity. Lower priority than RAW+HOOK. |
| 8 | Timeline → FFmpeg renderer | 40h | MEDIUM | Architectural purity. Quality impact is indirect (enables future improvements). |
| 9 | Feedback loop | 15h | LOW | Only useful after sufficient user base. |
| 10 | Hybrid/WASM renderer | 120h+ | LOW | Premature optimization until ffmpeg is proven bottleneck. |

### Solo Founder Calendar

```
Week 1-2:   Timeline JSON (35h)
Week 3-5:   Judge Engine V2 + Ranking (35h)
Week 6-9:   Multi-generator RAW + HOOK + Stitching (70h)
Week 10-11: Multi-generator TREND + STORY + Stitching (30h)
Week 12-15: Timeline → FFmpeg renderer (40h)
Week 16:    Feedback loop + polish (15h)
```

**Total: ~225 hours = 6 weeks full-time or 14 weeks part-time (16h/week)**

### What NOT to Build (Yet)

1. **WASM NLE Compositor** — 120h+ of work. Zero quality impact without users.
2. **Social scheduling** — Add-on, not core.
3. **4K export** — No social media platform needs 4K shorts.
4. **Premiere XML export** — Niche feature for 0.1% of users.
5. **Browser preview** — Requires WASM compositor. Wait for user demand.
6. **Multi-language interface** — Only Indonesian needed.

---

## 16. FILE-BY-FILE MIGRATION MAP

### Current GANYIQ Files (estimated from codebase scan)

| File | Approx Lines | Current Role | V2 Action | Migration |
|------|-------------|-------------|-----------|-----------|
| `lib/candidate-extraction.ts` | 400 | Single-pass 15-signal candidate extraction | **REPLACE** | Replace with 4 specialized generators |
| `lib/analyzer.ts` | 250 | LLM scoring of candidates (single score) | **REFACTOR** | Add 4-dimension scoring. Keep transcript analysis. |
| `lib/multi-pass.ts` | 605 | 5 specialized LLM passes | **REPLACE** | Replace with 4 generators. Passes are redundant with new architecture. |
| `lib/ranking.ts` | 200 | Score-based dedup + tier assignment | **REFACTOR** | Replace with curvedScore DESC ranking. Keep diversity enforcement. |
| `lib/title-generator.ts` | 100 | AI title generation | **KEEP** | No change needed. |
| `lib/score-spread.ts` | 100 | Display score normalization | **KEEP** | No change needed. |
| `lib/score-breakdown.ts` | 123 | DNA profile labels | **REFACTOR** | Update to use 4-dimension scores instead of DNA tags. |
| `lib/genre-detector.ts` | 100 | Genre classification | **REFACTOR** | Add scene detection (threshold-based). |
| `lib/types.ts` | 61 | Type definitions | **REFACTOR** | Add TimelineDocument, JudgeResult, Generator types. |
| `lib/analyze-pipeline.ts` | 200 | Pipeline orchestrator | **REFACTOR** | Add generator dispatch + timeline builder step. |
| `lib/prompt.ts` | 300 | LLM prompt templates | **REFACTOR** | Add judge engine prompts (hook, coherence, connection, trend). |

| File | Approx Lines | Current Role | V2 Action | Migration |
|------|-------------|-------------|-----------|-----------|
| `worker/decision-engine.ts` | 1159 | Per-frame camera decision, layout selection | **KEEP** | 100% reusable. Add Timeline JSON serializer. |
| `worker/clip-renderer.ts` | 1408 | FFmpeg filter graph builder (500L) + support code (900L) | **REFACTOR** | Replace filter graph builder (~500L) with Timeline JSON reader. Keep support code (download, caching, probe). |
| `worker/subtitle-renderer.ts` | 644 | ASS subtitle generation | **REFACTOR** | Add Timeline JSON subtitle track output alongside ASS. |
| `worker/emphasis-engine.ts` | 300 | Word emphasis analysis | **KEEP** | Add emphasis info to Timeline JSON subtitle track. |
| `worker/subtitle-templates.ts` | 200 | Subtitle style templates | **KEEP** | Templates become SubtitleStyle in Timeline JSON. |
| `worker/face-tracker.ts` | 500 | Face detection + tracking | **KEEP** | Output used by Timeline Builder for face_crop tracks. |
| `worker/speaker-detector.ts` | 300 | Speaker diarization | **KEEP** | Used by Generator layer for speaker-aware selection. |
| `worker/features.ts` | 50 | Feature flags | **REFACTOR** | Add USE_TIMELINE_RENDERER, ENABLE_STITCHING flags. |

| File | Approx Lines | Current Role | V2 Action | Migration |
|------|-------------|-------------|-----------|-----------|
| New: `lib/timeline/schema.ts` | 100 | Timeline JSON type definitions | **NEW** | TypeScript types matching schema. |
| New: `lib/timeline/serializer.ts` | 200 | DecisionSegment[] → Timeline JSON | **NEW** | Converts GANYIQ's existing data. |
| New: `lib/timeline/validator.ts` | 150 | Timeline JSON validation | **NEW** | Validates output before render. |
| New: `lib/generators/raw.ts` | 200 | RAW generator | **NEW** | Deterministic baseline extraction. |
| New: `lib/generators/hook.ts` | 250 | HOOK generator | **NEW** | LLM-assisted hook detection. |
| New: `lib/generators/trend.ts` | 200 | TREND generator | **NEW** | LLM-assisted trend detection. |
| New: `lib/generators/story.ts` | 200 | STORY generator | **NEW** | LLM-assisted narrative detection. |
| New: `lib/judge/engine.ts` | 200 | Judge Engine V2 orchestrator | **NEW** | 4-dimension scoring + aggregation. |
| New: `lib/judge/prompts.ts` | 150 | Judge LLM prompts | **NEW** | Hook, coherence, connection, trend prompts. |
| New: `lib/stitching.ts` | 300 | Stitching engine | **NEW** | Candidate merge + transition generation. |
| New: `lib/renderer/ffmpeg-converter.ts` | 400 | Timeline JSON → ffmpeg filter graph | **NEW** | Replaces the 500-line filter graph builder. |
| New: `lib/renderer/native-overlay.ts` | 300 | Native overlay rendering | **NEW** | Hybrid renderer for subtitle/emoji tracks. |
| New: `lib/migration/version-manager.ts` | 100 | Timeline version handling | **NEW** | Backward compatibility. |

### Summary

| Action | Count | Approx Lines |
|--------|-------|-------------|
| **KEEP** (no change) | 12 files | ~3,000 lines |
| **REFACTOR** (add to) | 10 files | ~4,000 lines |
| **REPLACE** (rewrite) | 2 files | ~800 lines |
| **NEW** (create) | ~18 files | ~5,000 lines |

**Existing code preserved: ~7,000 lines (70% of codebase)**
**New code to write: ~5,000 lines**

---

## 17. PHASE PLAN — 6 PHASES

### PHASE 0: Timeline Architecture (Week 1-2)

**Goal**: Establish the permanent Timeline JSON contract. Everything else builds on this.

**Deliverables**:
1. `lib/timeline/schema.ts` — TypeScript types for TimelineDocument
2. `lib/timeline/serializer.ts` — DecisionSegment[] → Timeline JSON
3. `lib/timeline/validator.ts` — Validate Timeline JSON before rendering
4. `lib/timeline/version-manager.ts` — Version bump strategy

**Files affected**:
- NEW: `lib/timeline/schema.ts`
- NEW: `lib/timeline/serializer.ts`
- NEW: `lib/timeline/validator.ts`
- NEW: `lib/timeline/version-manager.ts`
- REFACTOR: `lib/types.ts` (add TimelineDocument types)

**Estimated complexity**: Low (pure data transformation, no rendering changes)

**Dependencies**: None

**Success criteria**:
- DecisionSegment[] can be converted to valid Timeline JSON
- Timeline JSON round-trips through validator without errors
- Version 1 schema is documented and frozen

---

### PHASE 1: Judge Engine V2 (Week 3-5)

**Goal**: Replace single-score LLM call with 4-dimension evaluation (hook, coherence, connection, trend).

**Deliverables**:
1. `lib/judge/engine.ts` — Judge orchestrator (parallel evaluation + aggregation)
2. `lib/judge/prompts.ts` — Per-dimension LLM prompts
3. `lib/ranking.ts` — Update to use curvedScore DESC
4. New scoring in `lib/analyze-pipeline.ts`

**Files affected**:
- NEW: `lib/judge/engine.ts`
- NEW: `lib/judge/prompts.ts`
- REFACTOR: `lib/analyzer.ts` (replace single-score with 4-dimension)
- REFACTOR: `lib/ranking.ts` (add curvedScore)
- REFACTOR: `lib/score-breakdown.ts` (update for new scores)

**Estimated complexity**: Medium (LLM prompt engineering + testing)

**Dependencies**: Phase 0 (receive Timeline JSON for scoring candidates)

**Success criteria**:
- Every clip has hookScore, coherenceScore, connectionScore, trendScore
- curvedScore formula produces 83-99 range
- Ranking is purely curvedScore DESC with zero inversions

---

### PHASE 2: Multi-Generator Architecture (Week 5-9)

**Goal**: Replace single candidate-extraction pipeline with 4 parallel generators.

**Deliverables**:
1. `lib/generators/raw.ts` — Deterministic baseline extraction
2. `lib/generators/hook.ts` — Hook-potential detection
3. Generator orchestrator in `lib/analyze-pipeline.ts`

**Files affected**:
- NEW: `lib/generators/raw.ts`
- NEW: `lib/generators/hook.ts`
- REPLACE: `lib/candidate-extraction.ts` (move relevant signals to RAW generator)
- REPLACE: `lib/multi-pass.ts` (remove — Hook Discovery pass replaced by HOOK generator)
- REFACTOR: `lib/analyze-pipeline.ts` (add generator dispatch)

**Estimated complexity**: High (LLM integration + candidate pool management)

**Dependencies**: Phase 1 (Judge V2 scores candidates)

**Success criteria**:
- RAW generator produces 30-50 candidates
- HOOK generator produces 8-15 candidates
- Both generators run in parallel
- Candidate pool is deduplicated and merged correctly

---

### PHASE 3: Stitching + Ranking + Generators 3-4 (Week 9-11)

**Goal**: Add segment stitching, complete ranking overhaul, add TREND and STORY generators.

**Deliverables**:
1. `lib/stitching.ts` — Candidate merge + transition generation
2. Complete ranking pipeline (curvedScore + rawScore + tiebreaker)
3. `lib/generators/trend.ts`
4. `lib/generators/story.ts`

**Files affected**:
- NEW: `lib/stitching.ts`
- NEW: `lib/generators/trend.ts`
- NEW: `lib/generators/story.ts`
- REFACTOR: `lib/ranking.ts` (finalize ranking pipeline)

**Estimated complexity**: Medium (stitching math + LLM prompts)

**Dependencies**: Phase 2 (multi-generator output)

**Success criteria**:
- Stitched clips have proper transitions
- Stitched clips have adjusted coherence scores
- All 4 generators produce candidates independently
- Ranking is purely curvedScore DESC
- Tiebreaker works via internal precision

---

### PHASE 4: Timeline → FFmpeg Renderer (Week 11-15)

**Goal**: Replace giant filter graph with Timeline JSON → ffmpeg converter.

**Deliverables**:
1. `lib/renderer/ffmpeg-converter.ts` — Timeline JSON → filter graph
2. Refactored `worker/clip-renderer.ts` (dual backend: legacy + timeline)
3. `worker/features.ts` — Feature flag: USE_TIMELINE_RENDERER

**Files affected**:
- NEW: `lib/renderer/ffmpeg-converter.ts`
- REFACTOR: `worker/clip-renderer.ts` (add Timeline JSON reader)
- REFACTOR: `worker/features.ts` (add flags)
- REFACTOR: `worker/subtitle-renderer.ts` (add Timeline JSON output)
- MAYBE DELETE: the old filter graph builder (once timeline path is verified)

**Estimated complexity**: High (ffmpeg filter graph is complex. Must match all layout modes.)

**Dependencies**: Phase 0 (Timeline JSON), Phase 1-3 (fully populated Timeline)

**Success criteria**:
- Same Timeline JSON produces same visual output from both renderers
- All layout modes work (single, split_2/3/4, PiP, hero_reaction)
- Subtitles, hook overlay work
- Feature flag switches between renderers

---

### PHASE 5: Feedback + Telemetry (Week 15-16)

**Goal**: Collect user interaction data for future optimization.

**Deliverables**:
1. Frontend event tracking (like, dislike, export, edit, delete)
2. `POST /api/feedback` endpoint
3. Database schema for clip_feedback
4. Basic stats endpoint

**Files affected**:
- NEW: `app/api/feedback/route.ts`
- REFACTOR: Frontend components (add event handlers)
- NEW: DB migration for clip_feedback table

**Estimated complexity**: Low (CRUD API + frontend hooks)

**Dependencies**: Production deployment (must have real users)

**Success criteria**:
- Events captured and stored correctly
- Stats endpoint returns meaningful aggregate data
- No performance impact on clip rendering

---

### PHASE 6: WASM NLE Compositor (Long-term, 8-12 weeks)

**Goal**: Browser-side preview + server-side WASM export.

**Deliverables**:
1. Minimal WASM compositor (2 tracks: video + subtitle)
2. Browser preview (30fps canvas)
3. Server-side export (NVENC encoded MP4)

**Files affected**:
- NEW: `worker/wasm/compositor.c` (C source for WASM)
- NEW: `worker/wasm/build.sh` (Emscripten/Clang build)
- NEW: `lib/renderer/wasm-preview.ts` (browser integration)
- NEW: `lib/renderer/wasm-export.ts` (server integration)

**Estimated complexity**: Very High (12 weeks for solo founder)

**Dependencies**:
- Phase 4 (Timeline → ffmpeg renderer stable, provides reference output)
- Existence of paying users who need higher quality

**Success criteria**:
- WASM preview renders Timeline JSON in browser at 30fps
- WASM export produces visually identical output to ffmpeg
- Both use SAME Timeline JSON input

---

## 18. RISK REGISTER

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Timeline JSON schema needs frequent changes | Medium | High | Versioned schema + backward compat. Freeze v1 early. |
| LLM scoring is inconsistent | Medium | High | Rubric+structured output in prompts. Option B (per-dimension calls) if accuracy insufficient. |
| Multi-generator produces too many low-quality candidates | Medium | Medium | Score threshold. Dedup. Generators are additive — disable weak ones. |
| Stitching creates worse clips than single-segment | Low | Medium | Compare stitched vs single-segment scores. Only keep stitch if score improves. |
| ffmpeg Timeline reader can't match all layout modes | Low | Medium | Dual backend. Legacy ffmpeg stays as fallback. |
| WASM compositor perf too slow for 30fps | Medium | High | Render at reduced resolution for preview. Use GPU on server. |
| Solo founder burnout | Medium | Very High | Phase 1-3 first (weeks 1-11). Phase 4-6 defer if needed. Prioritize quality over architecture purity. |

---

## 19. SUCCESS METRICS

### Feature Complete (Phase 1-3 done)

```
1. All 4 generators produce candidates in parallel
2. Judge Engine assigns 4 dimension scores to each candidate
3. Stitching merges adjacent candidates with transitions
4. Ranking is global curvedScore DESC
5. Clip quality perception improves vs V1
```

### Architecture Complete (Phase 4 done)

```
1. DecisionSegment[] → Timeline JSON → renderer works end-to-end
2. FFmpeg renderer reads Timeline JSON (no business logic)
3. Feature flag switches between old and new renderer
4. Output quality is indistinguishable between renderers
```

### Renderer Independent (Phase 6 done)

```
1. Same Timeline JSON produces same output from ffmpeg and WASM
2. Browser preview renders at 30fps from WASM
3. Server export at full quality from WASM
4. Adding new renderer requires ZERO changes to decision layer
```

### Adoption Metric

```
Phase 1-3: Launch to all users (replaces V1 pipeline)
Phase 4:   Roll out to 10% of users, compare quality metrics
Phase 5:   Enable for all users once feedback loop validated
Phase 6:   Beta only, opt-in by power users
```

---

*End of GANYIQ V2 Master Architecture — Revision 2*
*Principal Architect & CTO Advisor*
*June 2026*
