# GANYIQ Worker Stabilization Roadmap

**Audit reference:** `WORKER-STABILIZATION-AUDIT.md`  
**Goal:** STABILITY → CORRECTNESS → QUALITY (not new features)

---

## PHASE A — CRITICAL (freeze prevention + data integrity)

These fix the PC freeze, subtitle disappearance, and face identity fragmentation.  
**Estimated total effort: ~150 lines changed, 2-3 test cycles.**  
**No new architecture — pure bug fixes.**

### A1: Fix ByteTrack Stage 2 track deletion (1 line)
**File:** `tracker.py` line 238  
**Change:** `if self.tracks[tid].time_since_update > self.max_lost:` guard before `del self.tracks[tid]`  
**Impact:** Identity fragmentation drops from 27→8 IDs for 4 speakers. Every downstream component (decision engine, layout, subtitles) immediately works better.  
**Risk:** None. This is a standard ByteTrack pattern. Only unmatched tracks beyond max_lost are deleted.  
**Verification:** 4-person podcast → ≤8 unique IDs in tracker output.

### A2: Wire ParticipantRegistry into detectSpeakers() (~50 lines)
**File:** `speaker-detector.ts` — `detectSpeakers()` function  
**Change:** After calling `runDiarization()` + `runTranscription()` + `runReactionDetection()`, create `ParticipantRegistry`, `ingestTrackedFrames(trackedFrames)`, `ingestSpeakerSegments(speakerSegments)`, `buildParticipants()`, then map tracker IDs → stable participant IDs before building speaker frames.  
**Impact:** 8 ByteTrack IDs → 4 stable participants. Decision engine sees 4 "people" for a 4-person podcast, not 8 fragmented IDs.  
**Risk:** Low. The registry class already exists and is tested. Just needs wiring.  
**Verification:** 4-person podcast → 4 participants in `registry.getParticipantMap()`.

### A3: Fix subtitle timestamp normalization (1 line)
**File:** `speaker-detector.ts` — `runTranscription()`  
**Change:** Ensure `clipStart` is ALWAYS added to word timestamps, even when transcription returns 0 words (defensive coding). OR: Change the filter in `generateAssSubtitle()` to expect 0-relative timestamps.  
**Recommended approach:** Make `generateAssSubtitle()` expect RELATIVE timestamps (0 = clip start). Remove the absolute timestamp assumptions. This simplifies the entire subtitle pipeline.  
**Impact:** Subtitles never disappear due to timestamp mismatch.  
**Risk:** Low. Test with a known-working clip to verify timing.  
**Verification:** 10 different clips → subtitles visible in all.

### A4: Flip LAYOUT_TRANSITIONS default to DISABLED (1 line)
**File:** `features.ts` or `clip-renderer.ts`  
**Change:** Invert the default so simplified render is the norm. `isEnabled('LAYOUT_TRANSITIONS')` returns `false` unless explicitly set to `1`. OR: Create a `RENDERER_QUALITY` env var: `quality` (current full) vs `stable` (simplified as default).  
**Impact:** IMMEDIATE — ffmpeg memory drops from ~3GB to ~500MB. Freezes eliminated instantly.  
**Risk:** Minor — clips lose Ken Burns zoom, slide-in animations, and crossfade transitions. Output looks more basic but stays stable.  
**Verification:** Previously-freezing clip renders successfully in simplified mode.

### A5: Disable REACTION_DETECTION + VISUAL_REACTION by default (2 lines)
**File:** `features.ts`  
**Change:** Flip default to OFF for these two features. Or update `.env.local` template to include `GANYIQ_FEATURE_REACTION_DETECTION=0` and `GANYIQ_FEATURE_VISUAL_REACTION=0`.  
**Impact:** Eliminates 2 heavy Python subprocesses. Saves 500-900MB RAM.  
**Risk:** Low — these are additive features, not core pipeline.  
**Verification:** Clips render successfully with these disabled.

### Phase A Total Impact:
- **PC freeze risk:** ELIMINATED (ffmpeg + Python memory halved)
- **Identity fragmentation:** 27→4 IDs (tracker fix + registry wiring)
- **Subtitles disappearing:** ELIMINATED (normalization fix)
- **Lines changed:** ~55
- **Files touched:** tracker.py, speaker-detector.ts, features.ts, subtitle-renderer.ts

---

## PHASE B — IMPORTANT (correctness + predictability)

These make the pipeline reliable and deterministic.  
**Estimated total effort: ~300 lines changed.**

### B1: Segment-by-Segment Rendering (~200 lines)
**File:** `clip-renderer.ts` — new `renderSegmentsSequentially()` function  
**Architecture:**
```
for each segment:
  ffmpeg -ss START -to END -i source.mp4 \
    -vf "crop...+scale...${subtitleFilter}" \
    segment_N.mp4

concat all segment_N.mp4 via concat demuxer → final.mp4
```
This is similar to the existing `renderVerticalTracked()` (lines 565-658) but generalized for all layouts.  
**Benefits:**
- ffmpeg memory per segment: ~200MB instead of 3GB
- If one segment fails, can retry just that segment
- Can parallelize render across segments
- Eliminates need for filter_complex entirely for most segments
- Removes xfade timebase mismatch errors  
**Trade-off:**
- Slightly slower (ffmpeg startup per segment)
- No crossfade transitions between segments (acceptable)  
**Risk:** Medium — requires refactoring filter chain building. But the code pattern already exists in `renderVerticalTracked()`.  
**Verification:** Side-by-side comparison of old vs new output.

### B2: Use sourceFps Instead of Hardcoded 29.97 (10 lines)
**File:** `clip-renderer.ts`  
**Change:** Replace all `fps=30000/1001` with `fps=${sourceFps}`  
**Current:** 8+ locations hardcode 29.97fps  
**Impact:** Eliminates unnecessary frame interpolation for 24fps/60fps sources. Reduces ffmpeg work by 20-60%.  
**Risk:** Low. sourceFps is already parsed and passed to the function.  
**Verification:** ffmpeg logs show correct fps for each source type.

### B3: Fix Decision Engine Face-Count Fallback Timers (6 lines)
**File:** `decision-engine.ts`  
**Change:** Reduce fallback timers: 8→3s (SPLIT_2), 10→4s (SPLIT_3), 12→5s (SPLIT_4)  
**Rationale:** Current timers (8-12s) activate so late they feel random. The conversation has already moved on. 3-5s is closer to professional editing (OpusClip typically splits within 2-3s of multi-speaker detection).  
**Risk:** Low. Timers are tunable constants.  
**Verification:** A/B test split timing on 10 podcast clips.

### B4: Add Timeline Alignment Validation (~30 lines)
**File:** `clip-renderer.ts` — after building segments, before ffmpeg  
**Change:** Sum all segment durations, compare to `endTime - startTime`. If mismatch > 1s, log WARNING with segment breakdown.  
**Impact:** Catches silent frame drops, gap-filling bugs, and segment generation errors before ffmpeg runs (saving 5+ minutes of wasted render time).  
**Risk:** None. Pure diagnostic.  
**Verification:** Mismatches show up in logs for investigation.

### B5: Fix stayInCurrentMode() null-face bug (5 lines)
**File:** `decision-engine.ts` lines 960-976  
**Change:** When primary face is missing AND no faces in frame, return SINGLE mode with null primary face instead of keeping current mode with null crop coordinates.  
**Impact:** Prevents black frames in output when all faces temporarily disappear.  
**Risk:** None.  
**Verification:** Test with clip where speakers look away from camera momentarily.

### Phase B Total Impact:
- **ffmpeg memory:** 3GB→200MB per segment (with B1)
- **Split timing:** Feels natural instead of random
- **Pipeline reliability:** Catches errors before expensive ffmpeg render
- **Lines changed:** ~251
- **Files touched:** clip-renderer.ts, decision-engine.ts

---

## PHASE C — QUALITY (output improvement)

These improve output quality AFTER stability is proven.  
**Estimated total effort: ~150 lines changed.**

### C1: Consolidate Duplicated execAsync() (~30 lines)
**File:** Create `worker-package/exec-utils.ts`  
**Change:** Move `execAsync()` from face-tracker.ts and speaker-detector.ts into shared module  
**Impact:** Fix one, fix both. Single error handling strategy.  
**Risk:** None. Pure refactor.  
**Verification:** Same output.

### C2: Add Subtitle Position-Aware Decision Engine Integration (fix mispositioned subtitles) (~50 lines)
**File:** `subtitle-renderer.ts` `getLayoutPositionTag()`  
**Change:** Currently maps to fixed positions for SPLIT_2/3/4 and HERO_REACTION. Add positions for REACTION_CUT, WIDE_CONTEXT, LISTENER_PIP. Ensure positions don't overlap with face regions.  
**Impact:** Subtitles never cover faces.  
**Risk:** Low.  
**Verification:** Visual check on all layout types.

### C3: Remove Visual-Reaction-Detector.py from Active Codebase (~50 lines)
**File:** Delete `visual-reaction-detector.py` and remove `runVisualReactionDetection()` call from `speaker-detector.ts`  
**Rationale:** 739 lines of experimental Python that adds ~200-400MB RAM for marginal visual reaction detection. Feature flag already exists to disable it. Remove permanently. Can be restored from git if needed.  
**Impact:** -739 lines of dead code. -200MB minimum RAM.  
**Risk:** None — gated behind feature flag.  
**Verification:** Visual_REACTION flag works without the file.

### C4: Re-enable LAYOUT_TRANSITIONS with Segment-by-Segment Fallback (~20 lines)
**File:** `clip-renderer.ts`  
**Change:** When `LAYOUT_TRANSITIONS=1` (opt-in), use current full filter graph. When `LAYOUT_TRANSITIONS=0` (default), use segment-by-segment.  
**Impact:** Users who want zoompan/transitions can opt-in with understanding of memory trade-off.  
**Risk:** Low.  
**Verification:** Both paths produce correct output.

### Phase C Total Impact:
- **Code quality:** Cleaner, smaller pipeline
- **Output quality:** Better subtitle positioning
- **RAM:** Additional ~200MB saved

---

## ESTIMATED IMPACT SUMMARY

| Phase | Lines Changed | RAM Reduction | Freeze Eliminated | Subtitles Fixed | Identity Fixed |
|-------|--------------|--------------|-------------------|----------------|----------------|
| A | ~55 | ~1-2GB | ✅ YES | ✅ YES | ✅ YES |
| B | ~251 | ~2-3GB | ✅ YES (reinforced) | — | — |
| C | ~150 | ~200MB | — | ✅ Enhanced | — |
| **Total** | **~456** | **~3-5GB** | **YES** | **YES** | **YES** |

---

## IMMEDIATE NEXT STEPS (approval needed)

1. ✅ Audit completed
2. ⬜ Review, ask questions, modify
3. ⬜ Approve Phase A
4. ⬜ Implement Phase A fixes
5. ⬜ Test on PC-GANY with previously-freezing clips
6. ⬜ Phase B (if Phase A passes)
7. ⬜ Phase C (if Phase B is stable)

**No new features until ALL phases are deployed and stable.**
