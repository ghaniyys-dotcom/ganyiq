# GANYIQ Face Tracking Pipeline Documentation

---

## 1. Overview

The face tracking pipeline converts landscape video (1280×720) into vertical shorts (1080×1920, 9:16) by dynamically cropping to follow speaker faces. It spans 3 files across 3 versions (V1 → V2 → V2.4A).

**Pipeline architecture:**
```
face-detect.py  ──►  face-tracker.ts  ──►  clip-renderer.ts
(OpenCV Haar)       (identity + smooth)     (FFmpeg crop)
```

---

## 2. Version History

### V1 (Initial)
- Detected only the **largest face** per frame
- No identity tracking
- Single face only — completely broken for 2+ speakers
- Average of face positions = mid-air crop

### V2 (Multi-face detection)
- Detected ALL faces per frame
- Still averaged all face positions → "camera stuck in middle" bug
- Identity tracking introduced (Euclidean distance matching)
- Bug: `CONFIDENCE_LOCK_THRESHOLD = 0.6` — too high for Haar scores (actual scores 0.1-0.25)
- Bug: "no face" and "low confidence" treated identically → locked to center

### V2.4A (Current — Multi-face + Identity Tracking)
- Fixed confidence threshold to 0.25
- Separated "no face" from "low confidence" logic
- Per-face smoothing (no cross-face contamination)
- Identity-aware interpolation
- Dominant face selection with scoring
- Dead zone, minimum hold, switch ratio
- Clip-range-only processing (massive perf improvement)
- **Status:** Active development, camera stuck bug fixed

---

## 3. File 1: `face-detect.py`

**Role:** Raw face detection via OpenCV Haar Cascade.

### Algorithm
1. **Parse args:** `video_path`, `output_path`, `sample_rate` (default 1fps), optional `--start-time` / `--end-time`
2. **Clip range:** If start/end given, pad 10s before, 5s after, seek to `start_frame`
3. **Detect:** Convert frame to grayscale, run `detectMultiScale(scaleFactor=1.1, minNeighbors=5, minSize=(60,60))`
4. **Output:** ALL faces per frame as JSON array

### Output Format
```json
[
  {
    "time": 1790.0,
    "face_count": 2,
    "faces": [
      {"cx": 320.0, "cy": 360.0, "w": 200, "h": 200},
      {"cx": 960.0, "cy": 380.0, "w": 180, "h": 180}
    ]
  }
]
```

### Constants
| Constant | Value |
|---|---|
| `sample_rate` | 1.0 fps |
| `scaleFactor` | 1.1 |
| `minNeighbors` | 5 |
| `minSize` | (60, 60) pixels |
| Padding before clip | 10s |
| Padding after clip | 5s |
| Progress logging | Every 200 frames |

### Known Issues
- **Haar Cascade:** Most basic detector — false positives, misses angled/small faces
- **No NMS:** Overlapping detections possible
- **No facial landmarks:** Cannot determine face orientation or direction
- **Performance:** ~7 min for 4688 frames (full video) → ~5s for clip range (V2.4A fix)

---

## 4. File 2: `face-tracker.ts`

**Role:** Identity tracking, smoothing, dominance scoring, segment building.

### Pipeline (8 steps)

#### Step 1: `runFaceDetection()` — Subprocess invocation
- Resolves Python (python3 → python)
- Checks OpenCV is importable
- Timeout: 600s

#### Step 2: `trackFaceIdentity()` — ID assignment
- Sort faces left-to-right per frame
- Match by Euclidean distance (`IDENTITY_MATCH_DIST = 100px`)
- Stale IDs recycled after `IDENTITY_TIMEOUT_FRAMES = 3`

#### Step 3: `smoothPerFace()` — Identity-aware smoothing
- Groups by `id` BEFORE averaging (fixed V2 bug)
- Window: `SMOOTHING_WINDOW = 3` frames

#### Step 4: `interpolatePerFace()` — Gap filling
- Per identity, linear interpolation for missing frames
- Final re-sort by cx (left-to-right)

#### Step 5: `selectCameraTarget()` — Dominant face election
Maintains stateful `CameraState`:
- `targetFaceId` — which face the camera follows
- `holdCounter` — frames held on current target
- `lastKnownCx/Cy` — last good position
- `consecutiveNoFace` — count of empty frames

**Dominance scoring (0-100):**
| Component | Range | Formula |
|---|---|---|
| `faceSizeScore` | 0-40 | `min(40, relativeSize * 700)` |
| `centerScore` | 0-30 | `max(0, 30 * (1 - min(1, distFromCenter * 3)))` |
| `stabilityScore` | 0-30 | `min(30, consecutiveFrames * 3)` |

**Hold logic:** New target requires:
1. No current target, OR
2. Current target disappeared, OR
3. `holdCounter >= MIN_HOLD_FRAMES (1)` AND new score > current score × `DOMINANT_SWITCH_RATIO (1.2)`

#### Step 6: `buildSegments()` — Crop creation
- `cropW = sourceHeight × (1080/1920) = 405px` (for 720p source)
- `cropX = faceCx - cropW/2` (clamped to source bounds)
- `cropY = faceCy - cropH × 0.35` (rule-of-thirds bias)
- Groups frames with movement ≤ `SEGMENT_THRESHOLD_PX (40px)` into same segment
- Filters segments < 0.5s
- No-face frames reuse last good position

#### Step 7: `mergeTinySegments()` — Merge <2s segments

#### Step 8: `fillSegmentGaps()` — Interpolate gaps > 0.1s

### Constants Table

| Constant | Value | Purpose |
|---|---|---|
| `SAMPLE_RATE` | 1.0 | Detection frequency (fps) |
| `SMOOTHING_WINDOW` | 3 | Moving average window (frames) |
| `SEGMENT_THRESHOLD_PX` | 40 | Max movement before new segment |
| `DEAD_ZONE_PX` | 30 | Ignore movement below this |
| `MIN_HOLD_FRAMES` | 1 | Min frames before target switch |
| `DOMINANT_SWITCH_RATIO` | 1.2 | Score ratio required to switch |
| `IDENTITY_MATCH_DIST` | 100 | Max same-identity distance (px) |
| `IDENTITY_TIMEOUT_FRAMES` | 3 | Frames before ID recycled |
| `CONFIDENCE_LOCK_THRESHOLD` | 0.25 | Confidence floor (currently unused in logic) |
| `CROP_Y_OFFSET` | 0.35 (35% from top) | Composition bias |
| **Merge threshold** | 2.0s | Merge segments shorter than this |
| **Segment min duration** | 0.5s | Discard segments below this |
| **Dead zone (Y-axis)** | Not implemented | X-only dead zone check |

### Known Issues
1. **Dead zone is X-only** — vertical jitter within dead zone unchecked
2. **No-face marked as face** — `hasFace: true` even when locked
3. **`CONFIDENCE_LOCK_THRESHOLD` dead code** — declared but never referenced in actual logic
4. **Boundary smoothing** — First/last 1-2 frames get less smoothing (smaller window)
5. **Haar quality** — Cascade quality limits overall accuracy

---

## 5. File 3: `clip-renderer.ts`

**Role:** Orchestrates clip rendering with face tracking.

### Render Modes

#### Landscape (stream copy)
```bash
ffmpeg -y -ss <start> -to <end> -i <video> -c copy -movflags +faststart <output>
```

#### Vertical — Center Crop Fallback (faceRatio < 30%)
```bash
ffmpeg -y -ss <start> -to <end> -i <video>
  -vf "scale=-1:1920,crop=1080:1920"
  -c:v libx264 -preset medium -crf 18
  -c:a aac -b:a 128k -movflags +faststart <output>
```

#### Vertical — Face Tracked (faceRatio > 30%)
Per segment:
```bash
ffmpeg -y -ss <segStart> -to <segEnd> -i <video>
  -vf "crop=<cropW>:<cropH>:<cx>:<cy>,scale=1080:1920"
  -c:v libx264 -preset medium -crf 18
  -c:a aac -b:a 128k -movflags +faststart <segFile>
```
Then concat:
```bash
ffmpeg -y -f concat -safe 0 -i concat.txt -c copy <output>
```

### Constants

| Constant | Value |
|---|---|
| `CACHE_TTL_DAYS` | 7 |
| `CACHE_MAX_GB` | 50 |
| yt-dlp format | `best[height<=720]` |
| CRF | 18 |
| Video codec | libx264, preset medium |
| Audio codec | aac, 128k |
| Output resolution | 1080×1920 |
| Probe timeout | 15s |
| Render timeout | 120s |
| yt-dlp timeout | 300s |
| Upload timeout | 120s, 2 attempts |
| Face ratio threshold | 30% |

### Known Issues
1. **Face ratio threshold (30%)** — binary gate; if <30% face coverage, entire clip uses center crop
2. **No keyframe alignment** — per-segment ffmpeg cut uses fast seek (`-ss as input`)
3. **Upload retry** — hardcoded 3s delay, no exponential backoff
4. **Memory upload** — `new Blob(chunks)` instead of streaming

---

## 6. Data Flow Diagram

```
                    clip-renderer.ts
                    renderClip()
                    │
                    ├─ yt-dlp → cache/{videoId}.mp4
                    │
                    ├─ ffprobe → sourceWidth, sourceHeight
                    │
                    └─ renderMode === 'vertical'?
                        │
                        ├─ YES ─► analyzeFaces(videoPath, ...)
                        │         │
                        │         ├─ runFaceDetection() ──► face-detect.py
                        │         │                           │
                        │         │                           └─ JSON detections
                        │         │
                        │         ├─ trackFaceIdentity()
                        │         ├─ smoothPerFace()
                        │         ├─ interpolatePerFace()
                        │         ├─ selectCameraTarget()
                        │         ├─ buildSegments()
                        │         ├─ mergeTinySegments()
                        │         └─ fillSegmentGaps()
                        │
                        ├─ trackResult && faceRatio > 0.3?
                        │   ├─ YES ─► renderVerticalTracked()
                        │   └─ NO  ─► ffmpeg center-crop
                        │
                        └─ Upload MP4 to API
```

---

## 7. Key Design Decisions

| Decision | Rationale |
|---|---|
| **All faces detected** | V2.4A change from single to multi-face |
| **Per-face smoothing** | Prevents mid-air averaging across identities |
| **Hysteresis hold** | `holdCounter + switchRatio` prevents rapid switching |
| **Lock last position** | Avoids center-crop jump when face occluded |
| **Dead zone (X-axis)** | Prevents micro-jitter |
| **Crop Y at 35%** | Rule-of-thirds composition |
| **Zero-copy concat** | After per-segment encode, concat with `-c copy` |
