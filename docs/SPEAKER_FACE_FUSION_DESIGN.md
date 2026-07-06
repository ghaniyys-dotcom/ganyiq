# Speaker-Face Fusion — Implementation Design

## 1. Current Data Flow (Before)

```
pipeline.py
  ├── 1. diarize.py  →  [{speaker: "SPEAKER_00", start, end}, ...]  (audio domain)
  ├── 2. speaker_identifier.py
  │     ├── a. hybrid_face_detector.py  →  face_data.json           (visual domain)
  │     │      timeline[].faces[] w/ {track_id, speaker_id, cx, cy, w, h, person_id, lip_motion}
  │     ├── b. compute_lip_energy()      →  asd_timeline[]          (lip-activity, unused by render)
  │     ├── c. AVM.build_audio_visual_map()  →  track_id→SPEAKER_XX (fused once)
  │     ├── d. _consolidate_by_position()    →  merge fragmented IDs
  │     ├── e. DirectorAI.create_shot_list() →  [{start, end, layout, primary_id, secondary_id}]
  │     └── f. result.json { face_data_path, split_plan, speakers, ... }
  └── 3. _render_from_shot_list()
         ├── load_face_data() + build_id_bridge()
         ├── for each shot:
         │     get_speaker_bbox()  ←  ONE bbox per entire shot
         │     build_crop/split/two_shot_filter()  ←  ONE crop per entire shot
         │     ffmpeg -ss N -t DUR ...             ←  ONE ffmpeg call per shot
         └── concat segments
```

**Current limitation:** The renderer picks ONE bbox at the beginning of each shot and uses it for the entire shot duration. If the active speaker changes mid-shot (which happens frequently because DirectorAI merges short shots), the camera stays locked on a stale bbox. ASD data (`lip_motion`, `asd_timeline`) exists but feeds only the AVM mapping step — it's discarded before rendering.

---

## 2. Missing Components

| Component | Where should exist | Why needed |
|---|---|---|
| **Per-frame active speaker inference** | Between AVM and renderer | Know which face is actively speaking at each sample point |
| **ASD timeline in result JSON** | `result.json` → `pipeline.py` renders from it | Renderer needs ASD data to update bbox mid-shot |
| **Sub-shot camera update logic** | Inside `_render_from_shot_list` loop | Split a long ffmpeg call into sub-segments when speaker changes |
| **Continuous bbox smoother** | Per-shot state inside render loop | Avoid crop jitter when rapidly switching between active speakers |

---

## 3. Required New Modules

### 3.1 `core/speaker_tracker.py` — **NEW**
The central new module. Builds a per-frame "which face is actively speaking" timeline that the renderer can consume.

```python
class SpeakerTracker:
    """
    Given face_data + diarization + id_bridge, produces a time-indexed
    sequence of {time, active_speaker_id, bbox, confidence}.
    """
    def build_active_speaker_timeline(
        self,
        face_data: dict,
        diarization: list[dict],
        id_bridge: dict,
        asd_timeline: list[dict] | None = None,
    ) -> list[dict]:
        ...

    def get_active_bbox(
        self,
        timeline: list[dict],
        time_sec: float,
        frame_w: int,
        frame_h: int,
    ) -> dict | None:
        ...
```

### 3.2 `config.py` additions — **EXTEND**

```python
@dataclass
class FusionConfig:
    ACTIVE_SPEAKER_MISS_TOLERANCE: float = 0.3   # seconds before falling back
    ASD_FALLBACK_THRESHOLD: float = 0.001         # min lip energy to trust ASD
    CROP_REFRESH_INTERVAL: float = 0.5            # seconds between bbox updates
    SUB_SHOT_MIN_DURATION: float = 0.5            # minimum sub-shot segment
```

---

## 4. Data Structures

### 4.1 `ActiveSpeakerTimeline` (output of SpeakerTracker)

```python
[
    {
        "time": 0.0,
        "active_speaker_id": "SPEAKER_00",   # from diarization
        "canonical_id": "SPEAKER_00",         # resolved through id_bridge
        "track_id": 0,
        "has_face": True,
        "bbox": {"cx": 400, "cy": 300, "w": 100, "h": 120},
        "lip_energy": 0.042,
        "confidence": 0.85,                   # how sure we are
    },
    ...
]
```

### 4.2 `SubShot` (internal to renderer)

```python
@dataclass
class SubShot:
    start: float
    end: float
    bbox: dict | None          # camera target for this interval
    layout: str                # inherited from parent Shot
    primary_id: str | None
    secondary_id: str | None
    secondary_bbox: dict | None
```

Each `Shot` from DirectorAI is potentially split into multiple `SubShot`s when the active speaker changes. Each `SubShot` produces one ffmpeg segment.

---

## 5. Face Tracking Strategy

### 5.1 What exists (reuse, don't rewrite)

| Existing | Role in fusion |
|---|---|
| `compute_lip_energy()` | Outputs per-frame `active_track_id` and `max_lip_energy`. Tells us WHICH face is moving its lips. |
| `build_audio_visual_map()` | Maps `track_id` → `SPEAKER_XX`. Converts raw track IDs to stable audio speaker labels. |
| `build_id_bridge()` | Resolves `track_id`, `person_id`, `speaker_id` to a single canonical ID. |
| `get_speaker_bbox()` | Finds a face bbox for a given `target_id` in a time range. Used at sub-shot resolution. |
| `CameraSmoother` | Smooths crop transitions. Already per-shot — extend to per-update. |
| `_consolidate_by_position()` | Merges fragmented visual tracks that belong to the same person. |

### 5.2 Strategy: Three-level fallback

```
Level 1 — ASD direct (best):
  ASD says track T is lip-active at time t.
  Track T maps to speaker S via AVM.
  Speaker S has a face bbox at time t.
  → Use bbox of track T / speaker S.

Level 2 — Audio diarization match (good):
  Diarization says speaker S is active at time t.
  Speaker S has at least one face bbox in face_data near time t.
  Use the bbox of the face whose speaker_id matches S (or whose
  AVM-mapped speaker matches S).

Level 3 — Visual-only fallback (acceptable):
  No diarization available, or ASD failed (all lip_motion = zero).
  Use the largest/central face in the frame as the "active" target.
  → This is what the CURRENT renderer already does.
```

### 5.3 Bbox interpolation

Between face detection samples (every 0.1–1.0s depending on sample_rate), the renderer should re-use the last known bbox rather than interpolating linearly across them. The `CameraSmoother` already provides exponential smoothing — keep it, just reset it at each `SubShot` boundary.

---

## 6. Speaker ↔ Face Association Algorithm

### 6.1 `SpeakerTracker.build_active_speaker_timeline()`

```
Input:
  - face_data            JSON with timeline[].faces[]
  - diarization          [{speaker, start, end}, ...]
  - id_bridge            {all_ids → canonical_id}
  - asd_timeline         [{time, active_track_id, lip_energy}, ...]

Output:
  - active_timeline      [{time, speaker_id, bbox, confidence}, ...]

Algorithm:
  1. Build ASD lookup: {time_sec → active_track_id}

  2. Build audio speaker lookup: {fuzzy_time_sec → list[speaker_ids]}
     (from diarization, with ANTICIPATION_OFFSET = 0.6s)

  3. For each entry in face_data.timeline:
     a. time = entry.time
     b. Find ASD-active track at this time (if ASD available)
     c. Find diarization-active speaker at this time

     d. RESOLUTION ORDER:
        i.   If ASD has active_track_id AND it maps to a face in this frame:
               active_speaker_id = AVM_map[ASD_active_track]
               bbox = that face's bbox
               confidence = min(1.0, ASD_lip_energy / threshold) 

        ii.  Elif diarization has active_speaker_id:
               Resolve speaker_id through id_bridge
               Find face in this frame whose canonical_id matches
               If found: bbox = that face's bbox
                         confidence = 0.7
               If not found: keep speaker_id but mark has_face=False
                             confidence = 0.4

        iii. Else (no ASD, no diarization, or neither found anything):
               Use largest face in frame as target
               speaker_id = that face's canonical_id
               confidence = 0.3

     e. Append {time, speaker_id, bbox, has_face, confidence}

  4. Post-process: smooth gaps
     - If a speaker goes missing for < 0.3 seconds (MISS_TOLERANCE),
       carry forward the last known bbox for that speaker.
     - After 0.3s with no face, fall back to Level 2 or 3.
```

### 6.2 `get_active_bbox(timeline, time_sec, ...)`

Binary search the active_timeline for the entry at or immediately before `time_sec`. Return its bbox. If more than `CROP_REFRESH_INTERVAL` seconds have passed, the caller (`_render_from_shot_list`) should trigger a sub-shot split.

---

## 7. Changes Required in Renderer

### 7.1 `pipeline.py` — `_render_from_shot_list()`

```python
diff --git a/pipeline.py b/pipeline.py
--- a/pipeline.py
+++ b/pipeline.py
@@ -1,6 +1,7 @@
 from core.id_bridge import load_face_data, build_id_bridge, get_speaker_bbox
 from core.render_utils import CameraSmoother, build_crop_filter, ...
+from core.speaker_tracker import SpeakerTracker
+from config import fusion as FUSION_CFG
```

### 7.2 Render loop changes

```
  face_data = load_face_data(result)
  id_bridge = build_id_bridge(face_data)
+ speaker_tracker = SpeakerTracker()
+ active_timeline = speaker_tracker.build_active_speaker_timeline(
+     face_data, at_result.get("diarization", []), id_bridge,
+     asd_timeline=face_data.get("asd_timeline"),
+ )
```

Inside the shot loop:

```
  for shot in shot_list:
      # old: ONE bbox for entire shot
      # new: split shot into sub-shots when active speaker changes

      sub_shots = _split_shot_by_active_speaker(
          shot, active_timeline, id_bridge,
          frame_w, frame_h, FUSION_CFG.SUB_SHOT_MIN_DURATION,
      )

      for sub_shot in sub_shots:
          cam.reset()
          bbox = sub_shot.bbox
          # ... existing filter building and ffmpeg call
```

### 7.3 New helper: `_split_shot_by_active_speaker()`

```python
def _split_shot_by_active_speaker(
    shot: dict,
    active_timeline: list[dict],
    id_bridge: dict,
    frame_w: int, frame_h: int,
    min_duration: float = 0.5,
) -> list[SubShot]:
    """
    Slice a DirectorAI shot into sub-shots.
    A sub-shot boundary occurs when:
      (a) The active speaker changes (different canonical ID)
      (b) The active speaker's face disappears for > MISS_TOLERANCE
      (c) Crop refresh interval expires

    Each SubShot carries its own bbox so ffmpeg renders the correct
    crop for that interval.
    """
```

### 7.4 ffmpeg invocation unchanged

Each `SubShot` produces exactly the same ffmpeg command as the current per-shot code, using its own `start`, `duration`, and `bbox`. This means the existing `build_crop_filter()`, `build_split_filter()`, `build_two_shot_filter()` and all ffmpeg param values stay **byte-for-byte identical**.

### 7.5 Result structure enrichment

`speaker_identifier.py` already stores `face_data_path` in the result JSON. Add a key `"diarization"` (the raw segments) so the renderer can rebuild the active speaker timeline without re-running diarization:

```python
final_result["diarization"] = diarization_raw.get("segments", [])
```

And add the ASD timeline:

```python
final_result["asd_timeline"] = asd_timeline
```

---

## 8. Failure Cases

| Failure | Symptom | Mitigation |
|---|---|---|
| ASD all lip_motion = 0 (known issue) | `active_track_id` always -1 | Fall through to Level 2 (audio diarization) |
| No face detected for active speaker | Bbox = None for some sub-shots | Use last known bbox for 0.3s, then fall back to largest face in frame |
| Diarization unavailable (visual-only mode) | No `diarization` in result | Run Level 3 only (visual-only = current behavior) |
| ByteTrack track_id=0 (falsy bug) | track_0 not in id_bridge | ASD fallback also fails; final fallback = largest face |
| DirectorAI merges shots aggressively | Long shots with mixed speakers | `_split_shot_by_active_speaker` splits them regardless of DirectorAI boundaries |
| Speaker turns away from camera | Face disappears mid-speech | `has_face=False` → carry forward last bbox for 0.3s → fallback |
| Multiple faces speak simultaneously | ASD picks one, others never framed | Current layout logic handles this via split_screen/two_shot_wide; fusion only affects bbox tracking |

---

## 9. Rollback Strategy

### Feature flag in config

```python
@dataclass
class FusionConfig:
    ENABLED: bool = False   # ← default OFF for roll-forward safety
    ...
```

### Pipeline runner logic

```python
if FUSION_CFG.ENABLED:
    active_timeline = speaker_tracker.build_active_speaker_timeline(...)
    sub_shots = _split_shot_by_active_speaker(...)
else:
    # Legacy path — unchanged behavior, one bbox per shot
    bbox_primary = get_speaker_bbox(...)
```

### Backward-compatible output

- `result.json` gains two new keys (`"diarization"`, `"asd_timeline"`) when available. The renderer ignores them when `ENABLED=False`.
- Existing test vectors (saved result.json files) remain loadable — missing keys produce `[]` or `None` which the renderer already handles.

### Rollback steps

1. Set `FUSION_CFG.ENABLED = False`
2. Delete or rename `core/speaker_tracker.py`
3. Revert `_render_from_shot_list` to single-bbox-per-shot (i.e. the current code)

---

## 10. Incremental Implementation Plan

### Phase A — Data plumbing (no render change)

**Files:** `core/speaker_tracker.py`, `speaker_identifier.py`

1. Create `core/speaker_tracker.py` with `SpeakerTracker` class
2. Implement `build_active_speaker_timeline()` — ASD+diarization fusion (Levels 1 & 2)
3. In `speaker_identifier.process_video()`: store `diarization_raw["segments"]` and `asd_timeline` in `final_result`
4. Add `FusionConfig` dataclass to `config.py`
5. **Verify:** `result.json` now contains `"diarization"` and `"asd_timeline"` keys. Render output unchanged because `FUSION_ENABLED=False`.

### Phase B — Renderer integration (behind flag)

**Files:** `pipeline.py`, `core/speaker_tracker.py`

6. Implement `get_active_bbox()` in `SpeakerTracker` — binary search through timeline
7. Add `_split_shot_by_active_speaker()` helper to `pipeline.py`
8. Modify `_render_from_shot_list()` to optionally use `SpeakerTracker` when `FUSION_CFG.ENABLED=True`
9. **Verify:** With flag OFF = identical output. With flag ON = output changes (expected — camera now follows active speaker).

### Phase C — Tuning & hardening

10. Integration test on 5 representative clips (podcast, interview, vlog, panel, single-speaker)
11. Tune `MISS_TOLERANCE`, `CROP_REFRESH_INTERVAL`, `SUB_SHOT_MIN_DURATION`
12. Compare ASD-vs-no-ASD quality difference
13. Document known edge cases in ARCHITECTURE.md

---

### Files Changed Summary

| File | Change |
|---|---|
| `speaker-hybrid/core/speaker_tracker.py` | **NEW** ~200 lines |
| `speaker-hybrid/config.py` | + FusionConfig dataclass |
| `speaker-hybrid/speaker_identifier.py` | + store diarization + ASD in result |
| `speaker-hybrid/pipeline.py` | + import SpeakerTracker, + _split_shot, + flag gating |
| (No changes to render_utils.py, id_bridge.py, director.py, hybrid_face_detector.py, asd.py) |
