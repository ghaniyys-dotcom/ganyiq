# V2.5 Dynamic Split Screen — Design Document

## For GANYIQ Shorts/TikTok/Reels Output

---

## Executive Summary

**Current problem:** Face tracking on 3-5 person podcasts often selects the wrong speaker. Output looks unprofessional when camera targets a non-speaker.

**Hypothesis:** Split screen makes output look professional even when speaker mapping is imperfect. Showing both/all participants = viewer always sees who's relevant.

**Question:** Does Dynamic Split Screen give higher ROI than Speaker Tracking right now?

**Short answer:** **YES — for 3+ person videos.** For 2-person videos, Speaker Tracking has higher ROI. But Dynamic Split Screen is a SUPERSET that works WITHOUT needing perfect speaker mapping, making it the higher-ROI first investment.

---

## 1. Current Pipeline Audit

### 1.1 Face Tracking V2.4A Pipeline

```
face-detect.py                              face-tracker.ts
┌──────────────────────┐                    ┌──────────────────────┐
│ OpenCV Haar Cascade  │                    │ 1. trackIdentity()   │
│ Returns ALL faces    │─── JSON ──────────►│ 2. smoothPerFace()   │
│ 1fps sampling        │                    │ 3. interpolate()     │
│ clip-range only      │                    │ 4. selectDominant()  │
└──────────────────────┘                    │ 5. buildSegments()   │
                                            │ 6. mergeSegments()   │
                                            │ 7. fillGaps()        │
                                            └──────────┬───────────┘
                                                       │ TrackResult
                                                       ▼
                                  ┌──────────────────────────────┐
                                  │ CropSegment[]                │
                                  │ {startTime, endTime, cropX,  │
                                  │  cropY, hasFace}              │
                                  └──────────┬───────────────────┘
                                             │
                                             ▼
                          clip-renderer.ts — renderVerticalTracked()
                          FFmpeg per-segment crop + scale + concat
```

### 1.2 Key Data Structures

```typescript
// Current — single face per frame
interface CropSegment {
  startTime: number;
  endTime: number;
  cropX: number;      // single dominant face crop
  cropY: number;
  hasFace: boolean;
}

// ALL face data available but DISCARDED in segment building:
interface MultiFaceSample {
  time: number;
  faces: FaceInfo[];     // ALL faces with IDs — currently only dominant used
  face_count: number;
}
```

### 1.3 Critical Finding

The `face-tracker.ts` pipeline **already detects ALL faces** and tracks their identities. The `MultiFaceSample.faces[]` array at step 1-3 contains every face per frame. But `buildSegments()` (step 5) and `selectCameraTarget()` (step 4) DISCARD non-dominant faces.

**This is the key leverage point for split screen:** The data is already there. We just need to use it.

### 1.4 Current Segment Generation

```
selectCameraTarget() → DominantFaceSample[] (1 face per frame)
       ↓
buildSegments() → CropSegment[] (1 cropX/cropY per segment)
       ↓
mergeTinySegments() + fillSegmentGaps()
       ↓
renderVerticalTracked() → per-segment FFmpeg crop
```

**Split screen insertion point:** **Between step 4 and step 5** — after identity tracking but during segment building. Instead of selecting ONE dominant face, we generate MULTIPLE face tracks and decide dynamically which layout to use.

---

## 2. Design Options

### OPTION A: Top-Bottom Split (Primary + Reaction)

```
┌──────────────────────┐
│                      │  60% — Primary speaker
│   Face A (main)      │  (dominant face, full width)
│                      │
├──────────────────────┤
│                      │  40% — Reaction/person B
│   Face B (reaction)  │  (secondary face, full width)
│                      │
└──────────────────────┘
```

| Criteria | Score |
|---|---|
| **UX Score** | 8/10 |
| **TikTok Suitability** | 7/10 |
| **Shorts Suitability** | 8/10 |
| **Reels Suitability** | 8/10 |
| **CPU Impact** | +80% (2x crop + 2x scale + overlay) |
| **RAM Impact** | +50% (per segment) |
| **Render Time Impact** | +60-100% |
| **Complexity** | Medium |
| **Failure Modes** | If only 1 face → render as normal. If wrong face dominant → shows wrong speaker big. |

**Best for:** Interview-style (host + guest). Reaction content.

---

### OPTION B: 50/50 Static Split

```
┌──────────────────────┐
│                      │  50% — Person A
│      Face A          │
│                      │
├──────────────────────┤
│                      │  50% — Person B
│      Face B          │
│                      │
└──────────────────────┘
```

| Criteria | Score |
|---|---|
| **UX Score** | 6/10 |
| **TikTok Suitability** | 5/10 |
| **Shorts Suitability** | 6/10 |
| **Reels Suitability** | 6/10 |
| **CPU Impact** | +100% |
| **RAM Impact** | +50% |
| **Render Time Impact** | +80-120% |
| **Complexity** | Low |
| **Failure Modes** | For 3+ people, 50/50 only shows 2. For solo moments, unnecessarily split. |

**Best for:** Debate-style (2 equal speakers). Worst for solo moments.

---

### OPTION C: Dynamic Focus Split (Recommended)

```
Speaker dominan bicara:             2+ orang aktif:
┌──────────────────────┐            ┌──────────────────────┐
│                      │            │                      │
│                      │            │      Face A          │
│                      │            │                      │
│    Face A (100%)     │            ├──────────────────────┤
│                      │            │                      │
│                      │            │      Face B          │
│                      │            │                      │
└──────────────────────┘            └──────────────────────┘

Full screen saat 1 dominan          Split saat 2+ aktif

3+ orang aktif:
┌──────────────────────┐
│      Face A          │
├──────────────────────┤
│      Face B          │
├──────────────────────┤
│      Face C          │
└──────────────────────┘

Stack all active speakers
(max 3 visible — scroll jika lebih)
```

| Criteria | Score |
|---|---|
| **UX Score** | **9/10** |
| **TikTok Suitability** | **9/10** |
| **Shorts Suitability** | **9/10** |
| **Reels Suitability** | **9/10** |
| **CPU Impact** | Variable: 0-100% (only when split active) |
| **RAM Impact** | +50% max |
| **Render Time Impact** | +40-100% depending on split transitions |
| **Complexity** | **High** (dynamic detection + smooth transitions) |
| **Failure Modes** | Flicker if inactive/split detection too sensitive. Mitigation: hold timer. |

**Best for:** Podcasts 2-5 people. Covers ALL cases optimally.

---

### OPTION D: Picture-in-Picture

```
┌──────────────────────┐
│                      │
│                      │
│   Face A (100%)      │
│                      │
│  ┌────┐              │
│  │B   │              │  PiP corner: 25% size
│  └────┘              │
│                      │
└──────────────────────┘
```

| Criteria | Score |
|---|---|
| **UX Score** | 5/10 |
| **TikTok Suitability** | 4/10 |
| **Shorts Suitability** | 4/10 |
| **Reels Suitability** | 4/10 |
| **CPU Impact** | +50% |
| **RAM Impact** | +30% |
| **Render Time Impact** | +40-60% |
| **Complexity** | Medium |
| **Failure Modes** | If wrong PiP face → confusing. Small face hard to see on mobile. |

**Verdict:** Low suitability for mobile-first vertical format. Small PiP face is too small on phone screens.

---

### OPTION E: Podcast Layout (Active Speaker + Stack)

```
┌──────────────────────┐
│                      │  65% — Active speaker
│   Active Speaker     │  (largest frame)
│                      │
├──────────────────────┤
│ A    │ B    │ C      │  35% — All other participants
│      │      │        │  (equal grid, max 3)
└──────────────────────┘
```

| Criteria | Score |
|---|---|
| **UX Score** | 8/10 |
| **TikTok Suitability** | 6/10 |
| **Shorts Suitability** | 7/10 |
| **Reels Suitability** | 7/10 |
| **CPU Impact** | +150% (n crop + overlay) |
| **RAM Impact** | +80% |
| **Render Time Impact** | +100-150% |
| **Complexity** | **Very High** (n-way dynamic + transition) |
| **Failure Modes** | Small frames for 4-5 people may be unwatchable on mobile. |

**Best for:** Desktop/tablet viewing. Poor for mobile-first TikTok format.

---

## 3. Recommendation: OPTION C — Dynamic Focus Split

### Why Option C Wins

| Reason | Detail |
|---|---|
| **Mobile-first** | Full screen for single speaker = maximum detail on phone |
| **Only splits when needed** | No unnecessary split during solo moments |
| **Graceful degradation** | Falls back to single-face tracking when no overlap |
| **Works with current data** | Uses MultiFaceSample.faces[] — already available |
| **No speaker mapping needed** | Split based on face activity, not speaker identity |

---

## 4. Multi-Person Podcast Analysis

### 2-Person Podcast

| Aspect | Design |
|---|---|
| **Best layout** | Dynamic Focus — full screen for active speaker, 50/50 split when both talking |
| **Split trigger** | Both faces active AND speaking overlap > 1s |
| **Speaker fallback** | If face tracking picks wrong speaker → split shows BOTH → no wrong information |
| **When split active** | ~20-30% of clip (overlapping conversation) |
| **When split off** | Silence > 2s from second speaker, or single speaker > 3s |
| **Hold timer** | Minimum split duration: 3s. Prevent split flicker. |
| **Transition** | 0.3s crossfade between split ↔ single |

### 3-Person Podcast

| Aspect | Design |
|---|---|
| **Best layout** | Dynamic Focus — 60/40 split for active + secondary, OR 33/33/33 stack for all 3 |
| **Split trigger** | 2+ faces active in last 2s window |
| **3-way layout** | A (50%) + B+C (25% each) — or stack A/B/C equal (33%) |
| **When 3-way active** | ~10% of clip (rare) |
| **Fallback** | If tracking wrong → all 3 shown = safe |
| **Maximum people visible** | 3 (more than 3 = too small on mobile) |

### 4-5 Person Roundtable

| Aspect | Design |
|---|---|
| **Best layout** | Active speaker (50%) + scrolling bottom row (50%). Active speaker swaps based on tracking. |
| **Bottom row** | Max 3 faces visible in bottom row. Additional faces shown via scroll/cut. |
| **Active speaker** | 50% top — face with highest dominance score OR most recently active |
| **Fallback** | Top-3 faces only. Faces 4-5 are too small for 1080×1920. |
| **When split active** | Always split for 4+ (no single-face mode — too risky) |
| **Mobile compromise** | At 4+ people, each face is ~360×360px on a phone. Still watchable. |

---

## 5. Camera Behavior Rules

### State Machine

```
                    ┌──────────┐
         ┌─────────►│  SINGLE  │◄─────────┐
         │          │  FACE    │          │
         │          └────┬─────┘          │
         │               │                │
    Single > 3s    2+ active > 1s    Split < 2s
         │               │                │
         │          ┌────▼─────┐          │
         └──────────┤  SPLIT   ├──────────┘
                    │  MODE    │
                    └──────────┘
```

### Rules

| Rule | Value | Rationale |
|---|---|---|
| **MIN_HOLD_SINGLE** | 3.0s | Prevent switching to split for brief overlaps |
| **MIN_HOLD_SPLIT** | 3.0s | Prevent split flicker — viewer needs to register layout |
| **OVERLAP_WINDOW** | 2.0s | How far back to check for second active face |
| **ACTIVE_CONFIDENCE** | 0.3 | Minimum confidence for a face to be "active" in split decision |
| **TRANSITION_DURATION** | 0.3s | Crossfade between single↔split. Fast enough to not be distracting |
| **MAX_FACES_VISIBLE** | 3 | Safety limit — mobile screen can't show more |
| **DEAD_ZONE** | 30px | Same as current — prevents camera jitter |
| **DOMINANT_SWITCH_RATIO** | 1.2× | Same as current — requires 20% higher score to switch |

### Split Mode Sub-states

```
SPLIT MODE
├── 2-WAY (50/50)    — 2 active faces detected
├── 2-WAY (60/40)    — 1 active + 1 reaction (asymmetric)
├── 3-WAY (33/33/33) — 3 active faces
└── 3-WAY (50/25/25) — 1 active + 2 background
```

### Transition Smoothing

```
Single → Split:   0.3s crossfade. Primary face scales from 100%→50%,
                   secondary face fades in from 0%→50%.

Split → Single:   0.3s crossfade. Active face scales from 50%→100%,
                   inactive face fades out.
```

---

## 6. FFmpeg Architecture

### Current (V2.4A single per segment)

```bash
ffmpeg -y -ss ${segStart} -to ${segEnd} -i "${sourceVideo}" \
  -vf "crop=${cropW}:${cropH}:${cx}:${cy},scale=1080:1920" \
  -c:v libx264 -preset medium -crf 18 \
  -c:a aac -b:a 128k \
  -movflags +faststart "${segFile}"
```

### V2.5 Dynamic Split — Single FFmpeg Command

```bash
ffmpeg -y -ss ${segStart} -to ${segEnd} -i "${sourceVideo}" \
  -filter_complex "
    # Crop face A (primary)
    [0:v]crop=${cropW}:${cropH}:${cxA}:${cyA},scale=1080:${splitHeight}[faceA];

    # Crop face B (secondary)
    [0:v]crop=${cropW}:${cropH}:${cxB}:${cyB},scale=1080:${splitHeight}[faceB];

    # Stack: A on top, B on bottom
    [faceA][faceB]vstack=inputs=2[stacked]
  " \
  -map "[stacked]" -map 0:a \
  -c:v libx264 -preset medium -crf 18 \
  -c:a aac -b:a 128k \
  -movflags +faststart "${segFile}"
```

### 3-Way Stack

```bash
-filter_complex "
  [0:v]crop=${cropW}:${cropH}:${cxA}:${cyA},scale=1080:640[faceA];
  [0:v]crop=${cropW}:${cropH}:${cxB}:${cyB},scale=1080:640[faceB];
  [0:v]crop=${cropW}:${cropH}:${cxC}:${cyC},scale=1080:640[faceC];
  [faceA][faceB][faceC]vstack=inputs=3[stacked]
"
```

### Transition: Single → Split (Crossfade)

```bash
# Segments use separate FFmpeg calls with different -filter_complex
# Transition handled at concat level or via crossfade filter:

# Segment A: single face (no split)
-filter_complex "crop=${cropW}:${cropH}:${cx}:${cy},scale=1080:1920"

# Segment B: split (transition at boundary — 0.3s overlap at cut point)
# Handled by renderVerticalTracked() splitting the overlap frames
```

### Architecture Flow

```
For each segment in CropSegment[]:
├── if split mode active:
│   ├── Face A: cxA, cyA from dominant face tracking
│   ├── Face B: cxB, cyB from SECOND tracker (second-highest dominance)
│   ├── Face C: cxC, cyC from THIRD tracker (if 3-way)
│   └── FFmpeg complex filter with vstack
│
├── if single mode active:
│   └── Standard crop (current V2.4A behavior)
│
└── Concat all segments via concat demuxer (same as current)
```

---

## 7. Performance Analysis: V2.4A vs Dynamic Split

### Current V2.4A — Single Segment (78s clip, 2 segments)

| Resource | Per Segment | Total |
|---|---|---|
| **CPU** | ~10s encode | ~20s |
| **RAM** | ~200 MB (ffmpeg) | ~200 MB |
| **Temp Storage** | ~30 MB/segment | ~60 MB + concat |
| **Output Size** | ~29 MB | ~29 MB |
| **Total Time** | — | ~1-2 min |

### Dynamic Split Screen — Same Clip

| Resource | Single Mode | Split Mode (2-way) | Split Mode (3-way) |
|---|---|---|---|
| **CPU** | ~10s (+0%) | ~18s (+80%) | ~25s (+150%) |
| **RAM** | ~200 MB | ~300 MB | ~400 MB |
| **Temp Storage** | ~30 MB | ~40 MB | ~50 MB |
| **Output Size** | ~29 MB | ~32 MB | ~35 MB |
| **Total Time (70% single, 30% split)** | — | ~1.5-3 min | |

**Worst case:** 3-way split for entire 78s = ~25-35s FFmpeg. Still acceptable (under 5 min target).

**Conclusion:** Performance impact is manageable. Split activation for ~20-30% of total clip time means average render time increase of ~20-40%.

---

## 8. Implementation Plan

### Phase 1: Data Plumbing (Effort: 2-3 days)

1. **Modify `selectCameraTarget()` to return ALL tracked faces**, not just dominant
   - New return type: `{ dominant: DominantFaceSample, alternatives: DominantFaceSample[] }`
   - Or add `faceId` to output so segment builder can group

2. **Modify `buildSegments()` to generate MULTIPLE crop per segment**
   - Each segment has: `{ startTime, endTime, crops: [{ faceId, cx, cy, dominance }] }`
   - New `SplitCrop` interface

### Phase 2: Split Detection (Effort: 1-2 days)

3. **Implement split decision engine**
   - Track face activity over rolling 2s window
   - Determine: single / 2-way / 3-way / transition
   - Hold timers, switch cooldown, flicker prevention

### Phase 3: Rendering (Effort: 2-3 days)

4. **Modify `renderVerticalTracked()` for split output**
   - New `renderMode: 'vertical-split'` in ClipParams
   - FFmpeg complex filter with vstack for 2-way or 3-way
   - Single-face segments render with current crop logic

5. **Transition handling**
   - At single↔split boundaries, split the segment at transition point
   - Or add 0.3s overlap with crossfade

### Phase 4: Frontend & API (Effort: 1 day)

6. **Add `renderMode: 'vertical-split'` option to UI**
7. **API handles new render mode in clip_params**

**Total estimated effort:** 6-9 days for complete implementation.

---

## 9. Risk Assessment

| Risk | Probability | Impact | Mitigation |
|---|---|---|---|
| **Split flicker** | Medium | High | Minimum hold 3s + activity window 2s |
| **Wrong face in split** | Medium | Medium | Both faces shown — less harmful than single wrong face |
| **FFmpeg complex filter too slow** | Low | High | Fallback to center crop if render time exceeds threshold |
| **3-way split too small on mobile** | Medium | Medium | Cap at 3 faces. For 4+ use active+scrolling row. |
| **Memory spike from multiple crop paths** | Low | Medium | Per-segment render (already done), not all-at-once |
| **Transition flicker at segment boundaries** | Medium | Low | Separate transition segments with crossfade |

---

## 10. Final Answer: Does Dynamic Split Screen Beat Speaker Tracking?

### Evidence from Codebase

**Current state:**

```
MultiFaceSample.faces[] → ALL faces with IDs (AVAILABLE)
         ↓
selectCameraTarget() → CHOOSES 1 (DISCARDS rest)
         ↓
CropSegment[] → 1 crop per segment (SINGLE FACE ONLY)
```

**Key finding:** The data for split screen ALREADY EXISTS in `face-tracker.ts`. The `MultiFaceSample.faces[]` array has every face per frame with persistent IDs. We're currently throwing it away at step 4.

### ROI Comparison

| Factor | Speaker Tracking (V2.4B) | Dynamic Split (V2.5) |
|---|---|---|
| **Fixes wrong camera** | ✅ Yes — follows speaker | ⚠️ Partially — shows both if unsure |
| **Works without perfect mapping** | ❌ No — requires diarization | ✅ Yes — uses face activity |
| **Mobile UX improvement** | Moderate | **High** |
| **Code reuse** | New module (diarization) | Reuses existing `MultiFaceSample[]` |
| **Implementation effort** | 3-5 days | 6-9 days |
| **Failure mode** | Follows wrong speaker | Shows both → still useful |
| **Prerequisite for split** | No | No (can do split first) |
| **Prerequisite for speaker** | — | Split helps but not required |

### Verdict

**For 2-person podcasts:** Speaker Tracking has higher ROI. Fixes camera 100% of the time.

**For 3-5 person podcasts:** Dynamic Split Screen has **significantly** higher ROI. The current system fails on multi-person setups. Split makes EVERY output watchable regardless of tracking accuracy.

**Overall recommendation:** **Do Split Screen first** because:

1. **Data already exists** — face data is already detected and tracked. Only the render step needs change.
2. **Works without perfect tracking** — even if face tracking picks wrong face, split mode shows BOTH faces → output is still useful
3. **Covers multi-person immediately** — the current biggest UX gap is 3-5 person podcasts
4. **Speaker tracking can come AFTER** — once split is working, add speaker-weighted dominance to decide which face gets primary slot in split

### Recommended Order

```
Phase 1: Data plumbing (modify segment gen to keep all faces)   2-3 days
Phase 2: Split decision engine + camera rules                    1-2 days
Phase 3: FFmpeg complex filter rendering                          2-3 days
Phase 4: Frontend + API polish                                    1 day
─────────────────────────────────────────────────────────────
Phase 5: Speaker-weighted dominance (enhance split primary)      2-3 days
Phase 6: Full diarization (independent of split)                  2-4 days
```

**Phase 1-4 = Dynamic Split Screen. Phase 5-6 = Speaker Tracking enhancement on top.**
