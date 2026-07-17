# GANYIQ Worker Stabilization Audit

**Date:** June 2026  
**Scope:** `worker-package/` (11,721 lines across 19 files: 13 TypeScript + 7 Python)  
**Goal:** Stabilize before adding more features

---

## 1. CURRENT ARCHITECTURE

```
index.ts (worker loop)
  └→ clip-renderer.ts (orchestrator)
       ├→ face-tracker.ts
       │    ├→ face-detect-v2.py (YOLOv8-face ONNX) or face-detect.py (Haar V1)
       │    ├→ tracker.py (ByteTrack + Kalman) or tracker.ts (JS greedy fallback)
       │    └→ speaker-detector.ts
       │         ├→ diarize.py (PyAnnote → sklearn KMeans → energy VAD)
       │         ├→ transcribe.py (Deepgram API)
       │         ├→ reaction-detector.py (librosa audio analysis)
       │         └→ visual-reaction-detector.py (face landmarks)
       ├→ decision-engine.ts (DecisionEngine class or legacy buildSplitSegments)
       ├→ subtitle-renderer.ts (ASS generation via ffmpeg ass filter)
       │    ├→ subtitle-templates.ts (7 templates)
       │    └→ emphasis-engine.ts (NLP word emphasis)
       ├→ participant-registry.ts (imported but NOT wired — dead)
       ├→ features.ts (feature flags)
       └→ memory-profiler.ts (periodic RAM tracking)
```

**Subprocess chain per render (up to 7):**
1. `face-detect-v2.py` — YOLOv8-face ONNX (~6MB model + OpenCV + onnxruntime)
2. `tracker.py` — ByteTrack + Kalman (pure numpy, lightweight)
3. `reaction-detector.py` — librosa + scipy + numpy + soundfile (~300-500MB)
4. `diarize.py` — PyAnnote (torch, ~2GB) OR sklearn KMeans (~200MB) OR energy VAD
5. `transcribe.py` — Deepgram API (fs/network, lightweight locally)
6. `visual-reaction-detector.py` — OpenCV + numpy face landmarks (~200-400MB)
7. `ffmpeg` — single giant filter graph + ASS → final MP4

Each Python spawn from TypeScript via `execAsync()` → full interpreter load + import of deps.

---

## 2. MEMORY HOTSPOTS (RANKED BY IMPACT)

### #1: ffmpeg Single Giant Filter Graph
- **File:** `clip-renderer.ts` `renderVerticalSplit()` (lines 840-1367)
- **Root cause:** One `ffmpeg -filter_complex` command processes ALL segments, transitions, overlays, and subtitles in a single graph
- **Typical graph:** 80-120 filter nodes for a 10-segment clip with xfade transitions
- **ASS frame buffering:** Even after the post-xfade ASS consolidation fix, zoompan + unsharp + overlay + xfade each add their own frame buffers
- **Memory estimate:** 2-3GB+ for a typical clip, can spike to 5GB+
- **Fix options:**
  - (a) Segment-by-segment rendering with concat (eliminates the giant graph entirely)
  - (b) Force `LAYOUT_TRANSITIONS=0` always (reduces to ~25 nodes, 500MB-1GB)
  - (c) Use hardware acceleration for NVENC properly (already detected but still uses software scalers)

### #2: Python Process Cascade
- **Root cause:** 6 sequential Python processes, each loading full dependencies
- `reaction-detector.py` — librosa + scipy (~300-500MB)
- `diarize.py` — PyAnnote/torch (~2GB) OR sklearn (~200MB)
- `visual-reaction-detector.py` — OpenCV + numpy (~200-400MB)
- **Problem:** No proper inter-process memory management. On Windows, Python processes don't release memory immediately after exit (OS caching), and by the time ffmpeg runs, 2-3 Python processes may still have resident memory
- **Total Python peak:** Could reach 3-4GB before ffmpeg even starts

### #3: visual-reaction-detector.py (739 lines)
- **File:** `worker-package/visual-reaction-detector.py`
- **Impact:** 739 lines of Python for face landmark analysis. Unknown memory profile but adds another torch/opencv-style dependency load
- **Current status:** Gated by `GANYIQ_FEATURE_VISUAL_REACTION=0` feature flag
- **Recommendation:** Keep disabled in production. Revisit only after everything else is stable

### #4: reaction-detector.py (619 lines)
- **File:** `worker-package/reaction-detector.py`
- **Impact:** librosa + scipy + numpy full import. 300-500MB RAM
- **Current status:** Gated by `GANYIQ_FEATURE_REACTION_DETECTION=0` feature flag
- **Recommendation:** Keep disabled in production. Audio reaction detection adds minimal value for podcast clips compared to memory cost

### #5: memory-profiler.ts execSync Overhead
- **File:** `worker-package/memory-profiler.ts`
- **Impact:** Running `wmic` or `ps` + `free` every 5 seconds via `execSync` blocks the Node event loop on Windows. On a memory-thrashing system, this makes the freeze WORSE
- **Recommendation:** Disable in normal operation. Only enable for targeted profiling

### #6: V2 Detection Pipeline (face-detect-v2.py + tracker.py)
- **File:** `face-detect-v2.py`, `tracker.py`
- **Impact:** ONNX runtime + YOLOv8-face model. ~200-300MB. Relatively lightweight
- **Recommendation:** Keep as primary path. This is the most lightweight Python component

---

## 3. FFMPEG BOTTLENECKS (DETAILED)

### Filter Graph Complexity

**Current architecture:** One filter_complex containing:
- N trim/scale/crop/zoompan/unsharp nodes per segment
- N-1 xfade/acrossfade transition nodes
- N-1 overlay slide-in animation nodes (SPLIT_2/3 only)
- 1 post-concat ASS subtitle node
- Video + audio concat/concat nodes

**For a 10-segment clip with transitions and split-screen:**
- ~60 video filter nodes
- ~10 audio filter nodes  
- ~1 ASS filter node (after fix)
- Total: ~70+ nodes

**For a 15-segment clip:**
- ~90+ video filter nodes
- ~15 audio filter nodes
- Total: ~100+ nodes

**Perceived freezes happen with 12+ segments and NVENC.** The NVENC encoder (`h264_nvenc`) requires contiguous GPU memory for the entire graph output, and filter graph intermediates are stored in system RAM / GPU VRAM.

### Critical Issues Found

1. **Hardcoded fps=30000/1001 everywhere** (lines 949, 992, 1020, 1055, 1063, 1073, 1129, 1190, 1194, 1204, 1210)
   - `sourceFps` is parsed from ffprobe and passed to `renderVerticalSplit()` but NEVER used
   - Hardcoded 30000/1001 ≈ 29.97fps. If source is 24fps or 60fps, this adds unnecessary frame interpolation work
   - **Fix:** Use `fps={sourceFps}` everywhere instead

2. **`settb=AVTB` applied inconsistently**
   - Some segments have `settb=AVTB,setpts=PTS-STARTPTS` (correct)
   - PiP chain applies `settb=AVTB` only at final overlay, not on all sub-streams
   - This can cause timebase mismatch errors on xfade

3. **zoompan still uses `t`-variable expressions** (line 1046)
   - Line 1046: `crop=w='${effectiveCw}*(1-${kbZoom}*t/${segDuration})'`
   - The skill doc says `t`-variable crop dimensions crash ffmpeg (P0-3)
   - This is the non-simplified single-face path that uses dynamic crop instead of zoompan
   - Wait — lines 1057-1066 show the zoompan path: `zoompan=z='1.0+0.04*time/${durationStr}'` — this uses `time` variable not `t`. The `time` variable IS supported by zoompan. But line 1046 is a **different expression** using `t` that may or may not crash depending on context
   - This needs testing

4. **Filter script files accumulate** in `temp/` — cleanup only happens per-file, but if render crashes mid-way, leftover `filter_*.txt` files accumulate

### Simplified Mode Already Exists But Not Default

`LAYOUT_TRANSITIONS=0` works and reduces filter graph from ~100→~25 nodes. **This should be the DEFAULT until stability is proven.** Currently it must be set manually in `.env.local`.

---

## 4. FACE TRACKING — ROOT CAUSES

### ByteTrack Identity Fragmentation

**Tracker:** `tracker.py` (ByteTrack + Kalman)

**ROOT CAUSE — Stage 2 track deletion bug:**
- Line 238 of `tracker.py`: `del self.tracks[tid]` — executed for ALL unmatched tracks regardless of `time_since_update`
- A face missing detection for even 1 frame (partial occlusion, motion blur, head turn) has its track DESTROYED
- Next frame, the face is detected again → brand new ID
- With 30fps source sampled at 1fps → each frame has 30x more opportunity for detection gaps at full rate
- ByteTrack's `max_lost` parameter (currently 50) is SUPPOSED to keep tracks alive through occlusion, but the Stage 2 bug bypasses it

**Fix (documented but NOT applied):**
- Add `and self.tracks[tid].time_since_update > self.max_lost` guard before `del self.tracks[tid]`
- Effect: 27+ IDs for 4 speakers → ~8 IDs

### ParticipantRegistry NOT Wired

**File:** `participant-registry.ts` (463 lines)
**Status:** Imported by `speaker-detector.ts` but `detectSpeakers()` never calls it
**Impact:** Even if ByteTrack produces 16 IDs, there's NO consolidation step in the current code path
**Evidence from skill:** "Must wire participant-registry.ts into speaker-detector.ts detectSpeakers()"

### Two Tracking Systems, No Synchronization

- **V2 path:** face-detect-v2.py → tracker.py → V2 tracking data → speaker-detector.ts → DecisionEngine
- **V1 path:** face-detect.py (Haar Cascade) → trackFaceIdentity() (greedy JS matching) → dominant face → segments
- These two paths have COMPLETELY different identity assignment logic
- When V2 fails partially (faces detected but speaker detection fails), falls back to V1 dominant face — identity semantics change mid-pipeline

### Speaker-Id Mapping Fragile

In `buildV2Segments()` (face-tracker.ts line 1078-1203):
- Maps face IDs to crops using `frame.activeSpeakerId`
- If speaker ID is `null`, falls back to first face in frame
- If frame has no faces, `continue` — drops the frame entirely
- Drops frames with no faces → can create time gaps → segments get merged → jump cuts

---

## 5. DYNAMIC SPLIT — ROOT CAUSES

### Decision Engine Has Two Parallel Code Paths

**Path A (DecisionEngine class — decision-engine.ts):** 1159 lines of sophisticated layout logic
**Path B (buildSplitSegments — clip-renderer.ts):** 134 lines of simple face-count-based split logic  

Path A runs when V2+ASD succeeds. Path B runs as fallback. They produce DIFFERENT segment structures.

### "Layout Switches Too Frequently" — Real Causes

1. **ByteTrack ID fragmentation** feeds 16+ "speakers" to the decision engine → engine thinks there are 6+ active speakers → constantly switches layouts

2. **Hold timers already increased** (3.5s/5.0s/6.0s/7.0s) but the decision engine's `decideLayout()` has complex override logic:
   - REACTION_CUT overrides EVERYTHING (correct)
   - Peak escalation overrides holds (questionable)
   - Face-count fallback uses VERY long timers (8s/10s/12s) → activates when conversation has already moved on → feels "wrong"

3. **`stayInCurrentMode()` has a bug** (decision-engine.ts line 960-976):
   - If primary face is missing AND no faces in frame → `validIds[0]` stays null
   - But the function returns `primaryId: validIds[0]` which is null
   - This creates a segment with `crops=[]` (no face crops) → ffmpeg gets empty crops → render may produce black frames

4. **`MIN_SHOT_DURATION=1.0s` still too short** for professional feel. OpusClip holds 2-4s minimum.

5. **Crossfade transitions add 0.15s to every segment boundary** (decision-engine.ts line 1120: `{ type: 'crossfade', duration: 0.15 }`). Every segment transition triggers a crossfade render in ffmpeg → more filter graph complexity.

### Face-Count Fallback Timers Are Backwards

Face-count fallback is meant for when diarization is uncertain. But:
- SPLIT_2 fallback: 8s hold (too long — if 2 faces visible for 8s, the split should activate sooner)
- SPLIT_3 fallback: 10s hold
- SPLIT_4 fallback: 12s hold
- **Result:** Split activates 8-12s AFTER two people start talking → viewer sees single face for 8s while 2 people converse → feels robotic

---

## 6. SUBTITLE SYSTEM — ROOT CAUSES

### "Subtitles Sometimes Disappear" — Cascade of Silent Failures

1. **Transcription returns 0 words silently** (transcribe.py without `sys.exit(1)`):
   - ffmpeg not in PATH on Windows → audio extraction fails → Deepgram gets silence → 0 words
   - OR Deepgram API times out (500MB+ audio being sent without `-ss`/`-to`) → 0 words
   - OR Deepgram returns words with no timestamps → filtered out
   - In ALL cases, TypeScript sees `wordTimestamps.length === 0` → "No word-level timestamps available" → subtitles skipped

2. **Timestamp normalization inconsistency:**
   - `generateAssSubtitle()` filters `w.start >= clipStart && w.end <= clipEnd` (line 151)
   - `groupWordsIntoLines()` ALSO filters `w.start >= clipStart && w.end <= clipEnd` (line 225)
   - **If normalization happened** (added clipStart to all word timestamps):
     - `w.start >= clipStart` → always true (normalized start ≥ clipStart)
     - `w.end <= clipEnd` → checks if word end is within clip
   - **If normalization did NOT happen** (word timestamps are 0-based from clip start):
     - `w.start >= clipStart` → 0 >= 1722 → FALSE → ALL WORDS FILTERED → NO SUBTITLES
   - The normalization step is in `runTranscription()` in speaker-detector.ts — if that function isn't called or errors, words remain 0-based → subtitles silently disappear

3. **Double `clipStart` subtraction bug** (subtitle-renderer.ts lines 286-293):
   - `start: lineStart - clipStart` — this is applied to word timestamps that are ALREADY relative (after the first filter)
   - If normalization was done (adding clipStart), then lineStart already has clipStart embedded, so `lineStart - clipStart` correctly makes it 0-based for ASS output
   - If normalization was NOT done, `lineStart - clipStart` produces NEGATIVE timestamps → SUBTITLES NOT VISIBLE (ASS filters out negative-time events)
   - **This is the most likely "subtitles sometimes disappear" bug** — inconsistent normalization

### "Incorrect Timing" Causes

1. **Subtitle edge case: last word timing** (subtitle-renderer.ts lines 500-506):
   - Known scoping bug documented in skill: `wStartTimeFmt` is used outside its for-loop scope
   - Line 500: `const wStartTimeFmt = formatAssTime(wStart);` — this is INSIDE the `for (let wi = 0; wi < wordCount; wi++)` loop
   - Line 509: `const lastWordStart = wordTimings[wordCount - 1].start;` — uses array, not loop variable (CORRECT per fix)
   - But the "final dim event" (line 509-518) uses `lastWordStart` from the array — this is the fixed version. Good.
   - BUT: `wEndTimeFmt` on line 501 gets `wStart` from the loop — this is fine because it's used inside the same loop iteration

2. **Word timing interpolation** (lines 467-473):
   - Word N+1's start time is used as word N's end time (standard Opus-style)
   - First word: `wStart = Math.max(line.start, line.words[wi].start)`
   - Last word: `wEnd = line.end`
   - If Deepgram timestamps have gaps between words > 0.5s, this creates long pauses in subtitle display

---

## 7. DEAD CODE INVENTORY

### SAFE TO DELETE

| Item | Lines | Reason |
|------|-------|--------|
| `visual-reaction-detector.py` | 739 | Not reliably used. Feature-flagged OFF by default. Adds memory pressure. Pure experimental code. |
| `face-detect.py` (V1 Haar) | 155 | V2 works. If V2 fails, the pipeline should too — not silently degrade. |
| `participant-registry.ts` | 463 | Imported but NOT wired into `detectSpeakers()`. Dead code. Either wire it or delete. |
| `emphasis-engine.ts` | 432 | Adds complexity to subtitle rendering. Visual impact is marginal (~15% of words highlighted gold). Causes formatting bugs. |
| Duplicated `execAsync()` functions | ~30 (2 copies) | Both `face-tracker.ts` and `speaker-detector.ts` define the identical `execAsync()`. Extract to shared module. |

### SAFE TO DISABLE (via Feature Flags — Already Possible)

| Feature Flag | Effect | Current Default |
|--------------|--------|-----------------|
| `REACTION_DETECTION` | Skip librosa audio analysis | ON (should be OFF) |
| `VISUAL_REACTION` | Skip face-landmark reactions | ON (should be OFF) |
| `DIARIZATION` | Skip PyAnnote/sklearn diarization | ON (keep ON — needed for speakers) |
| `V2_TRACKING` | Fall back to V1 Haar | ON (keep ON) |
| `SUBTITLES` | Remove ASS filter from ffmpeg | ON (keep ON) |
| `LAYOUT_TRANSITIONS` | Strip all animation from ffmpeg | ON (should be OFF as default) |

### SAFE TO REFACTOR

| Item | Lines | Reason |
|------|-------|--------|
| `buildSplitSegments()` in clip-renderer.ts | 134 | Legacy path. DecisionEngine does this better. V2 pipeline bypasses it. |
| `tracker.ts` (TS wrapper) | 414 | Wraps 380-line Python. Can fold into face-tracker.ts. |
| `memory-profiler.ts` stage markers | 226 | Useful for debugging but adds noise. Extract to separate debug module. |

---

## 8. TOP 10 FIXES RANKED BY IMPACT

| Rank | Fix | Impact | Effort | Phase |
|------|-----|--------|--------|-------|
| **1** | **Fix ByteTrack Stage 2 track deletion bug** (tracker.py:238): `add time_since_update > max_lost guard` | Stops identity fragmentation at source. 27→8 IDs for 4 speakers. Everything downstream (decision engine, layout, subtitles) benefits. | 1 line | A |
| **2** | **Wire ParticipantRegistry into detectSpeakers()** — consolidate 8 ByteTrack IDs into 4 stable participants | Fixes "wrong speaker focus" and "too many unique IDs" permanently | ~50 lines | A |
| **3** | **Change LAYOUT_TRANSITIONS default to DISABLED** — flip `isEnabled()` default or invert the flag semantic | Immediately halves ffmpeg memory usage. Eliminates freeze risk. Most impactful single change. | 1 line | A |
| **4** | **Segment-by-segment rendering** — render each segment individually, then concat. Remove xfade chain. | Eliminates the single giant filter graph. ffmpeg memory drops from 3GB to ~200MB per segment. Enables parallel processing. | ~200 lines | B |
| **5** | **Fix subtitle timestamp normalization bug** — ensure `runTranscription()` always adds clipStart, or change filter to use relative timestamps consistently | Eliminates subtitles-disappear bug permanently. Currently subtitles are non-deterministic. | 1 line | A |
| **6** | **Use `sourceFps` instead of hardcoded `30000/1001`** everywhere in clip-renderer.ts | Prevents unnecessary frame interpolation. Reduces ffmpeg work by 20%+ when source is 24fps. | 10 lines | B |
| **7** | **Disable REACTION_DETECTION + VISUAL_REACTION by default** — feature-flag them OFF | Eliminates 2 Python subprocesses (librosa + visual analysis). Saves 500-900MB RAM. | 1 line each | A |
| **8** | **Fix decision engine face-count fallback timers** — reduce from 8/10/12s to 3/4/5s | Makes split layout feel natural. Current fallback activates too late. | 6 lines | B |
| **9** | **Add timeline alignment check** — after building segments, verify total duration matches clip duration ±1s | Catches dropped frames, gap-filling failures, and silent frame drops before ffmpeg runs | ~30 lines | B |
| **10** | **Consolidate duplicated execAsync() into shared module** | Reduces maintenance surface. Fix one, fix both. | ~30 lines | C |

---

## 9. PIPELINE COMPLEXITY METRICS

| Metric | Value |
|--------|-------|
| Total lines worker-package | 11,721 |
| TypeScript files | 13 (9,256 lines) |
| Python files | 7 (3,120 lines) |
| Feature flags | 6 (currently all default ON) |
| Python subprocesses per render | 6 (potentially 7 with ffmpeg) |
| Python deps per process | OpenCV/onnxruntime · numpy · scipy · torch · librosa · soundfile |
| ffmpeg filter nodes (full mode) | 70-120 for typical 10-segment clip |
| ffmpeg filter nodes (simplified) | 20-30 for same clip |
| Decision engine hold constants | 14 individual tunables |
| Subtitle templates | 7 (7 style definitions × 3 render modes) |
| Empathy engine word patterns | ~50 regex patterns for 15% highlight rate |
| Segment filtering passes | 7 (build + smooth + interpolate + select + buildSegments + mergeTiny + fillGaps) |

---

## 10. RECOMMENDED "SAFE MODE RENDERER"

**Design:** A dedicated `renderSafeMode()` function parallel to `renderVerticalSplit()` with:

1. **No xfade** — plain concat
2. **No zoompan/Ken Burns** — static crop + scale
3. **No overlay animations** — plain vstack/hstack
4. **No PiP or HERO_REACTION** — fall back to vstack
5. **No reaction cuts** — single-face and split-screen only
6. **Single ASS filter** — post-concat (already done)
7. **Segment-by-segment rendering** — render each segment individually, then concat

This is 70% already implemented via `LAYOUT_TRANSITIONS=0` + the simplified path. The remaining gap is segment-by-segment rendering.

**Safety guarantee:** Even with 30+ segments and 4 faces, safe mode stays under 1GB ffmpeg memory.
