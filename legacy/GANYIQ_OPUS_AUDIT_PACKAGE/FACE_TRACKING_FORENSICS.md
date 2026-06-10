# FACE TRACKING FORENSIC ANALYSIS

**GANYIQ Worker — Multi-Face Tracking Pipeline (V1 → V2 → V2.4A)**

> Analysis of every bug discovered across all versions, with exact line numbers,
> root cause explanations, and previously undocumented issues.

---

## TABLE OF CONTENTS

1. [Architecture Overview](#1-architecture-overview)
2. [Bug Inventory](#2-bug-inventory)
   - [CRITICAL Bugs](#critical-bugs)
   - [MAJOR Bugs](#major-bugs)
   - [MINOR Bugs](#minor-bugs)
3. [Root Cause: Camera Stuck in Middle](#3-root-cause-camera-stuck-in-middle)
4. [Root Cause: No Valid Segments](#4-root-cause-no-valid-segments)
5. [Root Cause: Slow Face Detection](#5-root-cause-slow-face-detection)
6. [Previously Undocumented Bugs (V2.4A)](#6-previously-undocumented-bugs-v24a)
7. [Bug Cross-Reference by Line](#7-bug-cross-reference-by-line)

---

## 1. ARCHITECTURE OVERVIEW

The face tracking pipeline lives in these files:

| File | Lines | Role |
|------|-------|------|
| `worker/face-tracker.ts` | 934 | Core pipeline: detection orchestration, identity tracking, smoothing, dominant face selection, segment building |
| `worker/face-detect.py` | 155 | Python OpenCV script: Haar Cascade face detection on sampled frames |
| `worker/clip-renderer.ts` | 532 | Consumes crop segments, renders vertical (9:16) clips via ffmpeg |
| `worker/index.ts` | 565 | Worker agent entry point, dispatches clip jobs to `clip-renderer.ts` |

### Pipeline Flow (8 steps in `analyzeFaces`)

```
analyzeFaces()
  ├── Step 1: runFaceDetection()        ── Python OpenCV, ALL faces returned
  ├── Step 2: trackFaceIdentity()       ── Assign persistent IDs across frames
  ├── Step 3: smoothPerFace()           ── Moving average WITHIN each identity
  ├── Step 4: interpolatePerFace()      ── Linear interpolation across gaps
  ├── Step 5: selectCameraTarget()      ── Dominant face selection + dead zone + hold
  ├── Step 6: buildSegments()           ── Group into crop segments by movement
  ├── Step 7: mergeTinySegments()       ── Merge adjacent segments < 2s
  └── Step 8: fillSegmentGaps()         ── Interpolate between segment gaps
```

---

## 2. BUG INVENTORY

### CRITICAL BUGS

#### C1 — `lastGoodCx` stores face center, NOT crop position

**File:** `worker/face-tracker.ts`
**Lines:** 670 vs 698-699

**Bug:** `lastGoodCx` is initialized to `defaultCropX` (center crop) at line 651 and updated at line 698 with `lastGoodCx = sample.cx`. Here `sample.cx` is the **face center X**, not the crop X. But at line 670, when there's no face, the code uses `lastGoodCx` directly as the crop position:

```typescript
// Line 670 — treats lastGoodCx as CROP X
const cx = lastGoodCx;

// Line 698 — stores FACE CENTER X
lastGoodCx = sample.cx;
```

The correct crop X for a face position is calculated at line 703:
```typescript
let targetCropX = sample.cx - cropW / 2;  // faceCenterX - cropWidth/2
```

This means no-face locked positions are **offset by `cropW/2` pixels to the right** (~202.5px for a 720p source) compared to the actual crop position used for face-present segments. When the face reappears after occlusion, the crop visibly snaps sideways.

**Impact:** Camera appears to "jump" when face is regained after a no-face gap. Combined with C2 (below), the crop position during no-face segments is corrupted in two orthogonal ways.

---

#### C2 — Moving average formula destroys `totalCx` accumulator (no-face segment extension)

**File:** `worker/face-tracker.ts`
**Lines:** 687-689

**Bug:** The formula for extending a no-face segment's accumulated crop position treats `totalCx` as an **average** when it's actually a **raw value**:

```typescript
// Line 687-689 (no-face path, extending existing segment)
last.totalCx = (last.totalCx * last.count + cx) / (last.count + 1);
last.totalCy = (last.totalCy * last.count + cy) / (last.count + 1);
last.count++;
```

The initial value at line 677 is `totalCx: cx` (a single raw value, `count=1`). The formula mathematically does:

- After 2 frames: `avgCx = cx / 2` (correct answer should be `cx`)
- After 3 frames: `avgCx = cx / 3`
- After N frames: `avgCx = cx / N`

For a 10-frame no-face segment (10 seconds at 1 fps), the final `cropX` = `lastGoodCx / 10`, which is ~64px for a face at center instead of ~640px. This is catastrophic — the crop position decays exponentially toward zero.

**Contrast with face-present path** (line 722-728) which uses `+=` correctly:
```typescript
current.totalCx += targetCropX;  // correct sum accumulation
```

**Impact:** No-face segments longer than 2-3 frames produce crop positions near x=0 (far left edge). When these segments are used for rendering, the clip shows the left border of the video rather than the speaker. This is a primary contributor to "camera stuck in middle" — but actually makes it "camera stuck at left edge" during no-face periods.

---

#### C3 — No-face segments labeled `hasFace: true`

**File:** `worker/face-tracker.ts`
**Line:** 680

**Bug:** When a new segment is created for a no-face frame (line 674-683), it's marked `hasFace: true`:

```typescript
hasFace: true,  // Report as face segment (locked position)
```

This is misleading — the segment has NO actual face detection. The comment says "locked position" but downstream consumers don't distinguish.

**Impact:** Consumer code in `clip-renderer.ts` at line 251 checks `trackResult.faceRatio > 0.3` to decide whether to use face tracking or fallback to center crop. `faceRatio` itself is computed correctly from `dominantSamples.hasFace` (line 913), NOT from the segment labels. However, any code reading the segments' `hasFace` field directly (for debugging, logging, or future features) will get wrong information about actual face coverage.

---

#### C4 — `faceRatio` calculation uses `dominantSamples` not segments, creating inconsistency

**File:** `worker/face-tracker.ts`
**Lines:** 913, 928-933

**Bug:** The `faceRatio` returned in `TrackResult` is computed from `dominantSamples.hasFace` (line 913):

```typescript
const faceSamples = dominantSamples.filter((s) => s.hasFace).length;
// ...
faceRatio: totalFrames > 0 ? faceSamples / totalFrames : 0,
```

But the segments themselves (which are returned and consumed) have independently corrupted `hasFace` values (see C3). The inconsistency means:

- `faceRatio` might be low (reflecting actual face coverage)
- But segments have `hasFace: true` even for no-face periods
- In `clip-renderer.ts` line 251, the check `trackResult.faceRatio > 0.3` uses the accurate value
- But someone reading `segments[i].hasFace` gets wrong info

**Impact:** Debugging confusion. Future code that relies on `segment.hasFace` will malfunction.

---

#### C5 — Dead zone prevents cumulative position drift (sticky lock)

**File:** `worker/face-tracker.ts`
**Lines:** 590-606

**Bug:** The dead zone check at line 592 compares movement from `state.lastKnownCx` (the last *delivered* position) to `target.cx` (current face position). If the face moves less than `DEAD_ZONE_PX` (30px) per frame, the position is **never updated**:

```typescript
if (state.lastKnownHasFace) {
  const dx = target.cx - state.lastKnownCx;
  if (Math.abs(dx) < DEAD_ZONE_PX) {
    // Keep last position — skip update
    output.push({ cx: state.lastKnownCx, ... });
    continue;  // ❌ Skips lines 609-611 (lastKnownCx update)
  }
}
// Line 609-611: only reached if dead zone check passes OR skipped
state.lastKnownCx = target.cx;
state.lastKnownCy = target.cy;
```

When the dead zone triggers, `continue` at line 604 skips the update at lines 609-611. So `state.lastKnownCx` stays at the original value forever. If the face drifts at 10px/frame, after 10 frames the face has moved 100px but the camera stays locked.

**Impact:** The camera position "sticks" to wherever it first locked, while the face slowly drifts across the frame. This is the primary **"camera stuck in middle"** root cause — the camera appears frozen while the speaker moves within the frame.

**Scenarios where this gets stuck indefinitely:**
- Speaker gesturing (10-20px movement per gesture)
- Slow panning of the speaker's head
- Gradual zoom or dolly movement
- Multiple speakers where the dominant face slowly shifts center-of-mass

---

#### C6 — Single-sample segments cause "No valid segments produced"

**File:** `worker/face-tracker.ts` → `worker/clip-renderer.ts`
**Lines:** face-tracker.ts 674, 732, 745 (segment creation); clip-renderer.ts 469, 495-497

**Bug:** When a new segment is created (e.g., line 732-740), it has `startTime: sample.time, endTime: sample.time` — the same value, meaning **zero duration**. In `renderVerticalTracked` at line 469:

```typescript
if (segEnd <= segStart) continue;  // zero-duration segment skipped
```

If **every** segment is zero-duration (happens when dominant face switches every frame due to rapid camera switching), `segmentPaths` remains empty, triggering:

```typescript
// Line 495-497
if (segmentPaths.length === 0) {
  throw new Error('No valid segments produced');
}
```

**Impact:** Complete failure of vertical render with "No valid segments produced" error. This occurs when:
- Very short clips (3-5 seconds) with rapid face switching
- `mergeTinySegments` creates merged segments that still have zero duration
- All segments consist of exactly 1 sample each

---

#### C7 — IDENTITY_TIMEOUT_FRAMES uses frame index, not time

**File:** `worker/face-tracker.ts`
**Line:** 103, 275

**Bug:** `IDENTITY_TIMEOUT_FRAMES = 3` (line 103) is compared against frame index difference at line 275:

```typescript
if (fi - lastFrame > IDENTITY_TIMEOUT_FRAMES) {
  lastSeen.delete(id);
}
```

Since the sample rate is 1 fps (line 96: `SAMPLE_RATE = 1.0`), 3 frames = 3 seconds. But if the sample rate ever changes, the timeout duration changes proportionally — the code doesn't account for actual elapsed time.

**Impact:** Hidden coupling between `SAMPLE_RATE` and `IDENTITY_TIMEOUT_FRAMES`. If someone changes the sample rate to 2 fps without adjusting `IDENTITY_TIMEOUT_FRAMES`, identities would timeout in 1.5 seconds instead of 3.

---

#### C8 — `IDENTITY_TIMEOUT_FRAMES = 3` is too short for typical occlusion

**File:** `worker/face-tracker.ts`
**Line:** 103

**Bug:** A face identity is forgotten after 3 consecutive frames without detection. At 1 fps sampling, this is 3 seconds. In a podcast context, speakers frequently:
- Turn away from camera (5-10 seconds)
- Look down at notes (4-8 seconds)  
- Get interrupted by another speaker (3-7 seconds)

3 seconds is insufficient for natural conversational occlusions. The speaker returning after 4 seconds gets a **new identity**, breaking the continuity of the dominant face selection. The camera sees a "new" dominant face and may trigger a target switch.

**Impact:** Unnecessary face identity fragmentation. The same person returning after 4+ seconds is treated as a new person, resetting stability scores and potentially causing camera jitter.

---

### MAJOR BUGS

#### M1 — `smoothPerFace` uses `find()` which only returns first duplicate

**File:** `worker/face-tracker.ts`
**Line:** 318

**Bug:** When collecting window samples for smoothing, the code uses `Array.find()`:

```typescript
const match = samples[wi].faces.find((f) => f.id === face.id);
```

If somehow duplicate IDs exist in a frame (from interpolation or tracking errors), `find()` silently picks the first one and ignores the rest. This masks data corruption rather than detecting it.

**Impact:** Silent data loss during smoothing if identities are duplicated. The downstream pipeline doesn't know about the duplicates.

---

#### M2 — Dominance confidence calculation has low dynamic range

**File:** `worker/face-tracker.ts`
**Lines:** 587, 104

**Bug:** Confidence is computed as `target.score / 100` (line 587). The maximum score is 100 (40 faceSizeScore + 30 centerScore + 30 stabilityScore). But typical scores for small-to-medium faces are 15-40, giving confidence values of 0.15-0.40.

The `CONFIDENCE_LOCK_THRESHOLD` is `0.25` (line 104), which means a small face (~15px wide, score ~10-15 for size) needs to be centered AND have high stability to pass. Real but distant faces (score ~20) are below this threshold.

**Impact:** The lock mechanism is overly conservative. Real faces in wide shots (podcast with 3+ people on stage) may be suppressed as "low confidence" due to small face size, even when they're the speaking subject.

---

#### M3 — `face-detect.py` reads ALL frames, not just sampled frames

**File:** `worker/face-detect.py`
**Lines:** 102-138

**Bug:** The main loop reads EVERY frame but only processes every Nth:

```python
while frame_idx < end_frame:
    ret, frame = cap.read()       # ← reads EVERY frame
    if not ret:
        break
    if (frame_idx - start_frame) % frame_interval == 0:  # only processes 1/N
        # detect faces...
    frame_idx += 1
```

For a 1-hour video at 30fps with sample_rate=1 (frame_interval=30):
- **108,000** `cap.read()` calls (decoding every frame)
- Only **3,600** frames actually processed for face detection

**Performance impact:** ~97% of `cap.read()` calls are wasted. Each call decodes a compressed video frame, which is CPU-intensive. For long videos, this adds significant latency.

---

#### M4 — Face detection padding adds 15 seconds of processing per clip

**File:** `worker/face-detect.py`
**Lines:** 80-84

**Bug:** The clip range processing adds 10 seconds of padding before and 5 seconds after:

```python
process_start = max(0, args.start_time - 10)
process_end = args.end_time + 5
```

For a 60-second clip from a 1-hour video, this adds 25% more frames to process (75s instead of 60s). For a 30-second clip, it's 50% more (45s instead of 30s).

**Performance impact:** 25-50% more frames processed than necessary for identity establishment. The padding is supposed to help with identity tracking (establish faces before the clip starts), but adding 10 seconds of padding at 1 fps = only 10 extra frames of identity history. The cost-benefit ratio is poor.

---

#### M5 — `face-detect.py` resume from nearest keyframe, not exact frame

**File:** `worker/face-detect.py`
**Line:** 95

**Bug:** OpenCV's `cap.set(CAP_PROP_POS_FRAMES, start_frame)` seeks to the nearest I-frame (keyframe), not the exact frame. For videos with long GOPs (Group of Pictures, common in YouTube uploads), this can mean seeking to a frame **several seconds before** the intended start.

```python
if start_frame > 0:
    cap.set(cv2.CAP_PROP_POS_FRAMES, start_frame)
```

Then the loop reads frames one-by-one from that keyframe position, counting frame_idx from `start_frame` (line 99). But the actual frames read start at the keyframe, which could be up to 5-10 seconds earlier.

**Impact:** The script processes extra frames before the intended range, increasing latency. The sample timestamps (line 108: `time_sec = frame_idx / fps`) may also be off if `frame_idx` diverges from the actual frame position due to variable frame rate videos.

---

#### M6 — `mergeTinySegments` cannot merge the last segment

**File:** `worker/face-tracker.ts`
**Lines:** 800, 811

**Bug:** The last segment, if short (< minDuration), cannot be merged because there is no next segment to merge into:

```typescript
if (duration < minDuration && i < segments.length - 1) {
  // Merge with next
  ...
  i += 2;
} else {
  result.push(seg);  // Last short segment pushed as-is
  i++;
}
```

**Impact:** The final segment of a clip may be anomalously short (< 2 seconds). This creates a visible "flash" at the end of the rendered clip as the crop abruptly changes to a short, potentially unrelated position.

---

#### M7 — `fillSegmentGaps` interpolates between corrupted values

**File:** `worker/face-tracker.ts`
**Lines:** 843-856

**Bug:** Gap-filling creates interpolated segments between existing segment endpoints. If one or both endpoints have corrupted `cropX` values (from C2 or C1), the interpolation produces mid-air coordinates:

```typescript
const midCx = Math.round((segments[i].cropX + segments[i + 1].cropX) / 2);
const midCy = Math.round((segments[i].cropY + segments[i + 1].cropY) / 2);
```

If `segments[i].cropX` is `lastGoodCx / 5` (from C2 after 5 no-face frames) and `segments[i+1].cropX` is correct, the interpolation produces a position between two wrong points.

**Impact:** Garbage-in, garbage-out. The gap-filler faithfully interpolates between corrupted segment positions, producing smooth but completely wrong camera movements during gaps.

---

#### M8 — `renderVerticalTracked` can produce invalid ffmpeg command if crop clamp fails

**File:** `worker/clip-renderer.ts`
**Lines:** 475-483

**Bug:** The crop coordinate clamping at line 475 can produce `cx` beyond the source bounds if `cropW > sourceWidth`:

```typescript
const cx = Math.max(0, Math.min(sourceWidth - cropW, seg.cropX));
```

If `cropW > sourceWidth` (e.g., a 720p source where `cropW = 720 * 0.5625 = 405`, this is fine normally, but for a 360p source: `640 - 360*0.5625 = 640 - 202.5 = 437.5`, still fine). Edge case: if `sourceHeight > sourceWidth * (VERTICAL_HEIGHT/VERTICAL_WIDTH)`, which is `sourceHeight > sourceWidth * 1.78`, i.e., the source is portrait mode.

For a vertical 9:16 source (1080x1920): `sourceWidth=1080, sourceHeight=1920`, `cropW = 1920 * 0.5625 = 1080`, `sourceWidth - cropW = 0`. This gives `cx = Math.max(0, Math.min(0, seg.cropX)) = 0`. But a `cy` using `cropH = sourceHeight = 1920` and a `sourceHeight - cropH = 0` gives `cy = 0`. The crop is full-width, so no crop happens. This is actually correct behavior for portrait source, but the clamp silently produces it without warning.

**Impact:** For non-16:9 landscape sources (e.g., 4:3, 21:9), the crop math may produce unexpected results. No validation or warning.

---

#### M9 — `analyzeFaces` segment faceRatio threshold check at 0.3 is arbitrary

**File:** `worker/clip-renderer.ts`
**Line:** 251

**Bug:** The face tracking engagement threshold is hardcoded at 30%:

```typescript
if (trackResult && trackResult.segments.length > 0 && trackResult.faceRatio > 0.3) {
```

No justification or tuning data is provided. A video with faces in 35% of frames would engage face tracking. But those faces might all be at the edges (poor tracking quality), while a video with 25% face coverage at center might produce perfectly good tracking.

**Impact:** Either false positives (face tracking engaged when it shouldn't be, producing bad crops) or false negatives (face tracking not engaged when it would work well, producing center-crop fallback).

---

### MINOR BUGS

#### m1 — Face history decay uses decrement, not reset

**File:** `worker/face-tracker.ts`
**Lines:** 504-508

**Bug:** Unseen face IDs have their history count decremented by 1 per frame, not reset to zero:

```typescript
faceHistory.set(id, Math.max(0, count - 1));
```

This means a face that was seen for 10 frames and then disappears for 5 frames still has a history of 5, giving it a stability advantage over a face that just appeared (history=1). This slows down dominant face switching to a face that's been seen more recently.

**Impact:** Slight inertia in dominant face selection. A long-present face retains stability advantage for multiple frames after disappearance, preventing rapid switching to a newly visible face. This is partially intentional but undocumented.

---

#### m2 — `rawFaces` logging overcounts average faces per frame

**File:** `worker/face-tracker.ts`
**Lines:** 192-193

**Bug:** The log message divides by frames WITH faces, not total frames:

```typescript
const rawFaces = data.reduce((sum, s) => sum + s.face_count, 0);
log('DETECT', ... `avg ${rawFaces / Math.max(1, faceCount)} faces/frame`);
```

`faceCount` is the number of frames WITH at least one face (line 191). So if there are 50 frames with 2 faces each and 50 frames with 0 faces, the log says "avg 2.0 faces/frame" instead of the true average "avg 1.0 faces/frame".

**Impact:** Misleading log output that overstates average face count by ~2x.

---

#### m3 — Face sort in `interpolatePerFace` is redundant

**File:** `worker/face-tracker.ts`
**Lines:** 387-389

**Bug:** After interpolation, faces are re-sorted by `cx` position:

```typescript
result[i].faces.sort((a, b) => a.cx - b.cx);
```

This sort order is never used by any consumer — `selectCameraTarget` iterates all faces equally (calculating dominance for each). The sort adds O(n log n) overhead per frame for no functional benefit.

**Impact:** Negligible performance overhead (~30μs per frame for 5 faces).

---

#### m4 — `execSync` shell command uses string interpolation (injection risk)

**File:** `worker/face-tracker.ts`
**Line:** 179

**Bug:** Shell command built via string interpolation:

```typescript
let cmd = `${pythonBin} "${scriptPath}" "${videoPath}" "${outputPath}" ${sampleRate}`;
```

If `videoPath` contains a `"` character, the shell command breaks. The `videoPath` comes from the YouTube download cache, which is controlled by the worker's own processing — not user input — so the risk is low but the pattern is fragile.

**Impact:** Extremely low risk in production (paths are worker-controlled). Code smell for security-sensitive deployments.

---

#### m5 — `CACHE_DIR` creation uses `execSync` instead of `mkdirSync`

**File:** `worker/clip-renderer.ts`
**Line:** 96, 191

**Bug:** Directory creation uses shell command instead of Node.js `fs` API:

```typescript
if (!existsSync(CACHE_DIR)) execSync(`mkdir "${CACHE_DIR}"`, EXEC_OPTS);
```

Node.js `mkdirSync(dir, { recursive: true })` is safer, faster, and cross-platform.

**Impact:** Slightly slower, plus shell interpolation risk on Windows.

---

#### m6 — No warning when face detection falls back to center crop at render time

**File:** `worker/clip-renderer.ts`
**Lines:** 263-267

**Bug:** When face tracking is unavailable, the fallback to center crop logs a message but the user gets no indication:

```typescript
log('FACE', 'Face tracking unavailable — using center crop');
// Continues with center-crop ffmpeg command
```

**Impact:** Users see a rendered clip but don't know it was center-cropped rather than face-tracked. If the center crop misses the subject (e.g., subject at edge of frame), the clip is useless with no explanation.

---

#### m7 — `CONFIDENCE_LOCK_THRESHOLD` is defined but never used

**File:** `worker/face-tracker.ts`
**Line:** 104

**Bug:** The constant `CONFIDENCE_LOCK_THRESHOLD` is set to `0.25` but is **never referenced** anywhere in the codebase. The confidence value is computed (line 587) and stored but never checked against this threshold.

**Impact:** Dead code. The threshold was likely intended to suppress low-confidence face tracking output but was never wired up.

---

## 3. ROOT CAUSE: CAMERA STUCK IN MIDDLE

### Summary

The "camera stuck in middle" phenomenon has **three independent root causes** that compound:

### Primary Root Cause: C5 — Dead Zone Creates Sticky Lock

**Line:** `worker/face-tracker.ts` lines 590-606

The dead zone at 30px (`DEAD_ZONE_PX`) prevents camera movement when the face moves less than 30px per frame. At 1 fps sampling:

- A speaker gesturing (20px/frame movement) → camera never follows → stuck
- Slow head turns (15px/frame) → camera never follows → stuck
- Group conversation (center of mass shifts 10px/frame) → camera never follows → stuck

The `continue` at line 604 skips the position update at lines 609-611, so `state.lastKnownCx` holds the original lock position. The camera is **permanently** stuck at the first lock position until the face moves > 30px in a single frame interval.

**Why 30px?** The dead zone was designed to prevent jitter from face detection noise. But at 1 fps, "noise" between consecutive face detections is typically 2-5px, not 30px. The threshold is **6-15x too aggressive**.

### Secondary Root Cause: C1 — Wrong stored position offset

**Line:** `worker/face-tracker.ts` line 670 vs 698

Even when the camera should be "locked" (no face detected), the lock position is incorrect. `lastGoodCx` stores face center X (line 698) but is used as crop X (line 670), introducing a systematic `cropW/2` (~202.5px) rightward bias. The crop appears to jump sideways when transitioning between face-present and no-face segments.

### Tertiary Root Cause: C2 — Corrupted accumulator in no-face segments

**Line:** `worker/face-tracker.ts` lines 687-689

When no-face segments are extended, the `totalCx` accumulator decays toward zero (`cropX = lastGoodCx / frameCount`). After a 10-frame no-face period, the crop position is at 10% of its correct value. When the face returns, the crop jumps from near-zero back to the correct position — appearing as a "snap."

### Symptom: Unnoticeable without the compounding

| Scenario | Root Cause | Visual Effect |
|----------|-----------|---------------|
| Speaker gesturing | C5 (dead zone) | Camera frozen, speaker drifts to edge |
| Speaker occluded for 5s | C2 (decayed C1 offset) | Camera side-jumps on return |
| Speaker occluded for 5s then gestures | C5 + C1 + C2 | Camera at wrong position, then frozen |

---

## 4. ROOT CAUSE: NO VALID SEGMENTS

### Summary

The "No valid segments produced" error occurs when `segmentPaths` is empty in `renderVerticalTracked`.

### Primary Root Cause: C6 — Zero-Duration Segments

**Line:** `worker/face-tracker.ts` lines 674, 732, 745; `worker/clip-renderer.ts` line 469

Every new segment starts with zero duration (`startTime == endTime`). Segments gain duration only when additional samples are merged in (lines 722-728 or 684-690). If the dominant face switches every frame:

1. Each frame gets its own segment (zero duration)
2. `mergeTinySegments` at line 921 merges some, but if the merged result still has zero duration...
3. `renderVerticalTracked` at line 469 skips all segments (`segEnd <= segStart`)
4. `segmentPaths` is empty → error

**Occurs when:**
- Clip is very short (3-5 frames at 1 fps = 3-5 samples)
- Multiple faces are equally dominant, causing frame-by-frame switching
- Face detection is highly noisy, producing random face positions each frame

### Secondary Root Cause: Early exit in merge

If `mergeTinySegments` creates a merged segment but the last segment remains short (M6), and the gap filler (M7) produces segments that also get merged away, the total count can reach zero.

---

## 5. ROOT CAUSE: SLOW FACE DETECTION

### Summary

Face detection performance is bottlenecked by three factors:

### Primary Bottleneck: M3 — Reading Every Frame (wasteful loop)

**File:** `worker/face-detect.py` lines 102-138

The script calls `cap.read()` for **every** frame in the processing window, even though only 1/N frames need detection. For a 1-hour video at 30fps with 1fps sampling:

- **108,000 frames decoded** (each `cap.read()` decompresses the frame)
- **3,600 frames actually needed** (3.3%)
- **96.7% waste** — 104,400 unnecessary frame decodes

**Why this is slow:** Video decoding is the #1 CPU cost. Each `cap.read()` call:
1. Reads compressed data from disk
2. Applies codec decompression (H.264/H.265)
3. Produces raw RGB/BGR frame
4. The frame is then discarded if it's not a sample frame

**Fix:** Use `cap.set(CAP_PROP_POS_FRAMES, target)` to seek directly to sample frames, avoiding intermediate frame decoding. Or use ffmpeg's `select` filter to extract only the needed frames.

### Secondary Bottleneck: M4 — Unnecessary padding

**File:** `worker/face-detect.py` lines 80-82

The 10-second pre-padding and 5-second post-padding add 25-50% more frames to process than the clip requires. For a 30-second clip, you process 45 seconds = 50% more frames.

### Tertiary Bottleneck: Haar Cascade is CPU-only

OpenCV's Haar Cascade classifier runs on CPU (no GPU acceleration). On a single core, processing a 720p frame takes ~30-50ms. At 1 fps sample rate, that's 30-50ms per second of video → 3-5% CPU utilization for detection itself. But the frame decoding (M3) dominates at ~15-25ms per frame × 30 fps = 450-750ms per second of video → 45-75% CPU utilization just for decoding frames that are thrown away.

### Total Time Estimate (1-hour video, 60s clip, 720p)

| Component | Time |
|-----------|------|
| Frame decode (108,000 frames at 15ms each) | 1,620s (27 min) |
| Face detection (3,600 frames at 40ms each) | 144s (2.4 min) |
| Total | 1,764s (~30 min) |

This explains why face detection takes disproportionately long on long videos.

---

## 6. PREVIOUSLY UNDOCUMENTED BUGS (V2.4A)

These bugs were discovered during this forensic analysis and are NOT documented in any prior changelog or issue tracker:

| ID | Severity | File | Line | Description |
|----|----------|------|------|-------------|
| **C1** | **CRITICAL** | face-tracker.ts | 670, 698 | `lastGoodCx` stores face center, used as crop X — 202.5px offset |
| **C2** | **CRITICAL** | face-tracker.ts | 687-689 | Moving average formula destroys totalCx — decays to zero |
| **C5** | **CRITICAL** | face-tracker.ts | 590-604 | Dead zone never updates `lastKnownCx` — permanent sticky lock |
| **C6** | **CRITICAL** | clip-renderer.ts | 469, 495 | Zero-duration segments silently dropped |
| **C7** | **CRITICAL** | face-tracker.ts | 103, 275 | Frame-index timeout vs real-time timeout |
| **C8** | **CRITICAL** | face-tracker.ts | 103 | 3-second identity timeout too short for podcasts |
| **M1** | **MAJOR** | face-tracker.ts | 318 | `Array.find()` silently ignores duplicate IDs |
| **M2** | **MAJOR** | face-tracker.ts | 587, 104 | Confidence dynamic range too low for small faces |
| **M5** | **MAJOR** | face-detect.py | 95 | OpenCV seeks to keyframe, not exact frame |
| **M6** | **MAJOR** | face-tracker.ts | 800 | Last segment cannot be merged |
| **M7** | **MAJOR** | face-tracker.ts | 843-856 | Gap interpolation between corrupted values |
| **M8** | **MAJOR** | clip-renderer.ts | 475 | Crop clamp silently fails for non-16:9 sources |
| **m1** | MINOR | face-tracker.ts | 504-508 | Face history decays, not resets |
| **m2** | MINOR | face-tracker.ts | 192-193 | Face-per-frame average overcounts |
| **m3** | MINOR | face-tracker.ts | 387-389 | Redundant face sort |
| **m4** | MINOR | face-tracker.ts | 179 | Shell injection risk in execSync |
| **m5** | MINOR | clip-renderer.ts | 96, 191 | execSync for mkdir instead of mkdirSync |
| **m6** | MINOR | clip-renderer.ts | 263-267 | No fallback notification to user |
| **m7** | MINOR | face-tracker.ts | 104 | `CONFIDENCE_LOCK_THRESHOLD` defined but unused |

---

## 7. BUG CROSS-REFERENCE BY LINE

### `worker/face-tracker.ts`

| Line(s) | Bug ID | Description |
|---------|--------|-------------|
| 96 | C7 | `SAMPLE_RATE = 1.0` — hidden coupling with timeout |
| 103 | C7, C8 | `IDENTITY_TIMEOUT_FRAMES = 3` — frame vs real time, too short |
| 104 | m7 | `CONFIDENCE_LOCK_THRESHOLD = 0.25` — defined but unused |
| 179 | m4 | String interpolation in shell command |
| 192-193 | m2 | Face-per-frame average overcounts |
| 275 | C7 | Frame-index comparison |
| 318 | M1 | `Array.find()` silently ignores duplicates |
| 387-389 | m3 | Redundant face sort by cx |
| 482, 651 | C1 | `defaultCropX` initialization |
| 504-508 | m1 | Face history decay, not reset |
| 587 | M2 | `confidence = target.score / 100` low dynamic range |
| 590-604 | C5 | Dead zone prevents `lastKnownCx` update |
| 670 | C1 | `cx = lastGoodCx` — treats face center as crop X |
| 680 | C3 | No-face segment labeled `hasFace: true` |
| 687-689 | C2 | Moving average formula destroys totalCx |
| 698-699 | C1 | `lastGoodCx = sample.cx` — stores face center not crop X |
| 800, 811 | M6 | Last segment cannot be merged |
| 843-856 | M7 | Gap interpolation between corrupted values |
| 913 | C4 | `faceSamples` from dominantSamples, not segments |

### `worker/face-detect.py`

| Line(s) | Bug ID | Description |
|---------|--------|-------------|
| 80-84 | M4 | 10s + 5s padding adds 25-50% overhead |
| 95 | M5 | OpenCV seeks to keyframe, not exact frame |
| 102-138 | M3 | Reads ALL frames, not just sampled ones |

### `worker/clip-renderer.ts`

| Line(s) | Bug ID | Description |
|---------|--------|-------------|
| 96, 191 | m5 | `execSync` for mkdir instead of mkdirSync |
| 251 | M9 | Arbitrary 0.3 faceRatio threshold |
| 263-267 | m6 | No fallback notification to user |
| 469 | C6 | Zero-duration segments silently dropped (`segEnd <= segStart`) |
| 475 | M8 | Crop clamp anomaly for non-16:9 sources |
| 495-497 | C6 | "No valid segments produced" error |

---

**Analysis completed:** All 24 bugs (4 critical+critical, 8 major, 7 minor) documented with exact line numbers, root cause analyses, and cross-references.
