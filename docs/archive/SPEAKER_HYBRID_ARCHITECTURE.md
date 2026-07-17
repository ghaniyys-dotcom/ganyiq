# GANYIQ Speaker Hybrid — Architecture

## Repository Overview

```
GANYIQ-worker/
├── speaker-hybrid/              # Python hybrid speaker pipeline (core)
│   ├── pipeline.py              # Entrypoint orchestrator
│   ├── config.py                # Centralized constants & magic numbers
│   ├── director.py              # DirectorAI shot planning
│   ├── asd.py                   # Active Speaker Detection (lip motion)
│   ├── face_db.py               # Face identity persistence (SQLite + deepface)
│   ├── hybrid_face_detector.py  # YOLOv8-face + MediaPipe detection
│   ├── core/                    # Shared infrastructure
│   │   ├── __init__.py
│   │   ├── logger.py            # Unified logging [GANYIQ:MODULE]
│   │   ├── render_utils.py      # CameraSmoother, crop/split filter builders
│   │   └── id_bridge.py         # Face ID canonicalization and bbox lookup
│   ├── utils/                   # Shared utilities
│   │   ├── __init__.py
│   │   ├── ffmpeg_utils.py      # resolve_ffmpeg(), extract_audio()
│   │   └── env_utils.py         # load_env_vars()
│   ├── identification/          # Speaker identification module
│   │   ├── speaker_identifier.py    # Pipeline orchestrator (face→AVM→Director)
│   │   ├── audio_visual_matcher.py  # Audio-visual speaker matching
│   │   └── __init__.py
│   ├── split/                   # Split decision module
│   │   ├── split_decision_engine.py  # Layout decision engine
│   │   └── __init__.py
│   └── reaction/                # Reaction detection module
│       ├── reaction_detector.py      # Facial reaction analysis
│       └── __init__.py
│
├── diarize.py                   # Audio diarization (standalone)
├── transcribe.py                # Word-level transcription (standalone)
├── run.py                       # Legacy entrypoint wrapper
├── ARCHITECTURE.md              # This file
├── *.ts                         # TypeScript worker agent (separate concern)
└── README.md
```

## Module Dependency Graph

```
run.py
 └── speaker-hybrid/pipeline.py ──────────────────────────────────────────────
      ├── core/logger.py           (used by every module below)
      ├── core/render_utils.py     (CameraSmoother, filter builders)
      ├── core/id_bridge.py        (load_face_data, build_id_bridge, get_speaker_bbox)
      ├── utils/env_utils.py       (load_env_vars)
      ├── utils/ffmpeg_utils.py    (resolve_ffmpeg — used by pipeline#run_cmd)
      ├── config.py                (all constants)
      │
      ├── director.py  <──────────── speaker-hybrid/identification/speaker_identifier.py
      │    ├── config.py                  ├── core/logger.py
      │    └── core/logger.py             ├── config.py
      │                                   ├── director.py
      ├── diarize.py (subprocess)         ├── hybrid_face_detector.py
      │    ├── core/logger.py             │    ├── core/logger.py
      │    ├── utils/ffmpeg_utils.py      │    ├── config.py
      │    └── utils/env_utils.py         │    ├── face_db.py
      │                                   │    │    └── core/logger.py
      └── speaker_identifier.py           │    └── tracker.py (root)
           (subprocess)                   │
           ├── core/logger.py             └── identification/
           ├── config.py                       audio_visual_matcher.py
           └── ...                              └── core/logger.py
```

## Pipeline Execution Flow

```
┌────────────────────────────────────────────────────────────────────┐
│  pipeline.py                                                       │
│                                                                    │
│  1. load_env_vars('.env.local')         [utils/env_utils.py]       │
│  2. Extract audio (ffmpeg -vn -ar 16000) [inline run_cmd()]       │
│  3. Run diarize.py (subprocess)         [diarize.py]               │
│  4. Run speaker_identifier.py (subproc) [identification/...]       │
│  5. Load result JSON                                                │
│  6. Render from shot list                                           │
│     a. load_face_data(result)          [core/id_bridge.py]         │
│     b. build_id_bridge(face_data)      [core/id_bridge.py]         │
│     c. get_speaker_bbox(...)           [core/id_bridge.py]         │
│     d. build_crop/split/two_shot_filter [core/render_utils.py]     │
│     e. ffmpeg segment renders           [inline run_cmd()]         │
│     f. ffmpeg concat                    [inline run_cmd()]         │
└────────────────────────────────────────────────────────────────────┘
         │
         ▼
┌────────────────────────────────────────────────────────────────────┐
│  speaker_identifier.py  (identification/orchestrator)              │
│                                                                    │
│  STEP 1: hybrid_face_detector.process_video()                     │
│          → YOLOv8-face ONNX inference                              │
│          → MediaPipe face mesh + lip tracking                      │
│          → ByteTrack (Kalman) face tracking                        │
│          → SpeakerClusterer assignment                             │
│          → FaceDB persistent person IDs                            │
│                                                                    │
│  STEP 2: Audio-Visual Matching (if diarization provided)           │
│          → AudioVisualMatcher.match()                              │
│          → compute_lip_energy() (ASD)                              │
│          → build_audio_visual_map()                                │
│          → consolidate_by_position()                               │
│                                                                    │
│  STEP 3: analyze_reactions()                                       │
│          → detect_lip_movement / smile / eye closure / head nod    │
│                                                                    │
│  STEP 4: DirectorAI.create_shot_list()                             │
│          → _get_scene_actors() (speaker + listener detection)      │
│          → _determine_layout() (fullscreen/split/two-shot/wide)    │
│          → _merge_consecutive_shots()                              │
└────────────────────────────────────────────────────────────────────┘
```

## Module Responsibilities

### `speaker-hybrid/pipeline.py`
**Purpose:** Entrypoint orchestrator. Reads CLI args, runs subprocesses (diarize, speaker-identify), loads results, manages work directory, renders final video.
**Contains:** `run_cmd()` utility, `Pipeline` class, `main()`.
**Does NOT contain:** Camera math, ID tracking, director logic — all delegated to `core/` modules.

### `speaker-hybrid/core/render_utils.py`
**Purpose:** FFmpeg filter string generation for video cropping and split-screen.
**Exports:** `CameraSmoother`, `build_crop_filter()`, `build_split_filter()`, `build_two_shot_filter()`.
**Constraint:** Produces byte-identical filter strings to original Pipeline methods. Pure functions (no `Pipeline` dependency).

### `speaker-hybrid/core/id_bridge.py`
**Purpose:** Canonical ID resolution for face tracks. Maps between speaker_id, person_id, track_id so the renderer consistently finds a speaker's bounding box.
**Exports:** `load_face_data()`, `build_id_bridge()`, `get_speaker_bbox()`.
**Note:** `track_id=0` is falsy in Python — a pre-existing quirk preserved for backward compatibility.

### `speaker-hybrid/core/logger.py`
**Purpose:** Unified structured logging across all modules.
**Format:** `[GANYIQ:{MODULE}] {message}` on stderr.
**Exports:** `log(module, msg)`, `warn(module, msg)`, `error(module, msg)`.

### `speaker-hybrid/config.py`
**Purpose:** Single source of truth for all magic numbers and thresholds. Uses dataclasses grouped by domain:
- `AudioConfig` — sample rate, channels
- `FaceDetectionConfig` — confidence, min face size, sample rate
- `ASDConfig` — window, threshold, FPS
- `DirectorConfig` — shot duration, offset, merge threshold, filter distances
- `SplitConfig`, `AVMConfig`, `ReactionConfig`, `RenderConfig`, `MiscConfig`

### `speaker-hybrid/director.py`
**Purpose:** DirectorAI — second-by-second analysis of the video timeline. Decides camera shots (fullscreen, split-screen, two-shot, wide) based on active speakers and listener positions.
**Contains:** `Shot` dataclass, `DirectorAI` class, `_is_same_person()`.
**Not modified:** Algorithm, thresholds, heuristics preserved verbatim.

### `speaker-hybrid/hybrid_face_detector.py`
**Purpose:** YOLOv8-face + MediaPipe hybrid face detector. Runs per-frame detection, tracks faces via ByteTrack, assigns speaker cluster IDs, persists face identities via FaceDB.
**Contains:** `process_video()`, `yolo_detect_faces()`, `extract_mp_faces()`, `SpeakerClusterer`, `face_iou()`.

### `speaker-hybrid/asd.py`
**Purpose:** Active Speaker Detection via lip-motion energy analysis. Computes rolling variance of `lip_motion` values per track to determine who is actively speaking.

### `speaker-hybrid/identification/speaker_identifier.py`
**Purpose:** Full pipeline orchestrator. Runs face detection → AVM → reaction detection → DirectorAI. Called as subprocess from pipeline.py.
**Note:** The `self.log()` method delegates to `core.logger.log()`.

### `speaker-hybrid/identification/audio_visual_matcher.py`
**Purpose:** Matches audio diarization to visual face tracks. Uses time-overlap and ASD-boosted correlation to build `track_id → audio_speaker_id` mapping. Detects non-speaking listener tracks.

### `speaker-hybrid/split/split_decision_engine.py`
**Purpose:** Alternative shot planning engine (legacy/standalone). Takes speaker tracks + reaction timelines, produces scene-by-scene layout decisions.
**Note:** Not used by the main pipeline. DirectorAI is the active shot planner.

### `speaker-hybrid/reaction/reaction_detector.py`
**Purpose:** Facial expression analysis from YOLOv8-face landmarks. Detects speaking, smiling, eye closure/blinking, head nodding, surprise.

### `diarize.py` / `transcribe.py`
**Purpose:** Standalone CLI scripts called via subprocess. Share `ffmpeg_utils` and `logger` but are self-contained for portability.
**Diarization strategies:** Deepgram API → PyAnnote → MFCC+KMeans → Energy VAD.
**Transcription strategies:** Whisper → Deepgram API.

## Config System

```python
# config.py — all constants in one place
audio       = AudioConfig()      # SAMPLE_RATE=16000, CHANNELS=1
face        = FaceDetectionConfig()  # CONF_THRESHOLD=0.25, MIN_SIZE=40
asd_cfg     = ASDConfig()        # WINDOW_SEC=0.5, THRESHOLD=0.02
director    = DirectorConfig()   # MIN_SHOT=2.5, OFFSET=0.6, DX_FILTER=150
split       = SplitConfig()      # MIN_SEGMENT=0.8, MIN_STABLE=2.0
avm         = AVMConfig()        # TIME_TOLERANCE=0.5, MIN_OVERLAP=0.3
reaction    = ReactionConfig()   # LIP_THRESHOLD=0.4, SMILE_THRESHOLD=0.5
render      = RenderConfig()     # VCODEC=libx264, CRF=18, BITRATE=128k
misc        = MiscConfig()       # FACE_SAMPLE_RATE=10.0
```

## Extension Points

### Speaker-Face Fusion (future)

Current architecture already separates:
- **Audio domain:** `diarize.py` → `audio_visual_matcher.py` → `speaker_identifier.py`
- **Visual domain:** `hybrid_face_detector.py` → `face_db.py` → `id_bridge.py`
- **Fusion point:** `build_audio_visual_map()` in `audio_visual_matcher.py` is where track→speaker mapping happens.

**To add Speaker-Face Fusion:**

1. Extend `build_audio_visual_map()` to accept per-face embedding vectors alongside ASD data
2. Add a new module `identification/fusion.py` that cross-references FaceDB person IDs with audio speaker labels
3. Wire it in `speaker_identifier.process_video()` between STEP 2 (AVM) and STEP 4 (DirectorAI)
4. The `id_bridge.py` canonical ID resolution will propagate the fused identity to render

### LLM Director (future)

Current shot planning is rule-based in `director.py`:
- `_get_scene_actors()` — heuristic speaker/listener detection
- `_determine_layout()` — fixed layout rules
- `_merge_consecutive_shots()` — threshold-based merging

**To add an LLM-powered Director:**

1. Create `director_llm.py` implementing the same `create_shot_list() -> list[Shot]` interface as `DirectorAI`
2. The signature `def create_shot_list(self) -> list[Shot]` is the stable contract
3. `Shot` dataclass fields remain the same (`start_time`, `end_time`, `layout`, `primary_target_id`, `secondary_target_id`)
4. Wire via strategy pattern: `speaker_identifier.py` picks the active director based on config/feature flag
5. The `DirectorConfig` dataclass in `config.py` already contains all threshold values an LLM could be asked to tune
