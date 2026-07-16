"""
config.py — GANYIQ Centralized Configuration

All magic numbers, thresholds, and tuning parameters live here.
Each module imports what it needs. Single source of truth.
"""

from dataclasses import dataclass, field
from typing import ClassVar


# ── Audio / Diarization ───────────────────────────────────────────

@dataclass
class AudioConfig:
    SAMPLE_RATE: int = 16000
    CHANNELS: int = 1
    CODEC: str = "pcm_s16le"
    # Diarization
    DEEPGRAM_MODEL: str = "nova-2"
    DEEPGRAM_LANGUAGE: str = "id"
    SPEAKER_GAP_THRESHOLD: float = 1.5  # seconds — gap triggers new segment
    MIN_SEGMENT_DURATION: float = 0.1
    # MFCC clustering
    MFCC_FRAME_LENGTH_S: float = 0.025
    MFCC_HOP_LENGTH_S: float = 0.010
    PRE_EMPHASIS_ALPHA: float = 0.97
    ENERGY_PERCENTILE: float = 15.0
    ENERGY_OFFSET: float = 0.005
    MIN_SPEECH_FRAMES: int = 5
    ESTIMATED_SPEECH_PER_SPEAKER: float = 25.0
    MAX_CLUSTERS: int = 8
    MIN_CLUSTERS: int = 2
    # Energy fallback
    ENERGY_VAD_THRESHOLD: float = 0.02
    ENERGY_MIN_SEGMENT: float = 0.3


# ── Face Detection ────────────────────────────────────────────────

@dataclass
class FaceDetectionConfig:
    YOLO_INPUT_SIZE: int = 640
    YOLO_CONF_THRESHOLD: float = 0.25
    YOLO_MIN_SIZE: int = 20
    MEDIAPIPE_MIN_SIZE: int = 20
    FRAME_SAMPLE_RATE: float = 10.0
    BYTETRACK_MAX_LOST: int = 25
    FACE_IOU_MERGE_THRESHOLD: float = 0.5
    FACEDB_MIN_SIZE: int = 40
    WARM_FRAMES: int = 30
    PROGRESS_INTERVAL: int = 300


# ── Active Speaker Detection (ASD) ────────────────────────────────

@dataclass
class ASDConfig:
    WINDOW_SEC: float = 0.5
    MIN_LIP_THRESHOLD: float = 0.02
    FPS: float = 10.0
    MIN_WINDOW_FRAMES: int = 3


# ── DirectorAI ────────────────────────────────────────────────────

@dataclass
class DirectorConfig:
    MIN_SHOT_DURATION: float = 2.5
    SPEAKER_DOMINANCE_THRESHOLD: float = 4.0
    MERGE_MIN_DURATION: float = 2.5
    ANTICIPATION_OFFSET: float = 0.6
    FACE_MIN_SIZE: int = 40
    DX_FILTER: float = 150.0
    DIST_CLOSE_THRESHOLD: float = 300.0
    FRAME_CENTER_X: int = 640
    CENTRALITY_WEIGHT: float = 0.6
    LIP_SCORE_WEIGHT: float = 0.4


# ── Split Decision Engine ─────────────────────────────────────────

@dataclass
class SplitConfig:
    MIN_SEGMENT: float = 0.8
    MIN_STABLE: float = 2.0
    MIN_SPEAKING_OVERLAP: float = 0.4
    REACTION_LOOKAHEAD: float = 0.5
    REACTION_WEIGHT: float = 0.3
    MAX_SPEAKERS_FULL: int = 1
    MAX_SPEAKERS_SPLIT: int = 3
    TRANSITION_SMOOTHNESS: float = 1.0
    SCENE_CAP_DURATION: float = 12.0


# ── Audio-Visual Matcher (AVM) ────────────────────────────────────

@dataclass
class AVMConfig:
    TIME_TOLERANCE: float = 0.5
    MIN_OVERLAP: float = 0.3
    ASD_TOLERANCE: float = 0.2
    ASD_BOOST_WEIGHT: float = 2.0
    ASD_PENALTY_WEIGHT: float = 0.5
    MIN_APPEARANCES: int = 2
    BEST_RATIO: float = 0.55
    LISTENER_DIFF_THRESHOLD: float = 100.0


# ── Reaction Detection ────────────────────────────────────────────

@dataclass
class ReactionConfig:
    LIP_SPEAKING_THRESHOLD: float = 0.4
    SURPRISE_THRESHOLD: float = 0.6
    SMILE_THRESHOLD: float = 0.5
    HEAD_MOVEMENT_THRESHOLD: float = 0.08
    EYE_CLOSURE_THRESHOLD: float = 0.7


# ── Render / Output ───────────────────────────────────────────────

@dataclass
class RenderConfig:
    VERTICAL_WIDTH: int = 1080
    VERTICAL_HEIGHT: int = 1920
    ASPECT_RATIO: float = 9.0 / 16.0
    VCODEC: str = "libx264"
    PRESET: str = "medium"
    CRF: int = 18
    AUDIO_BITRATE: str = "128k"
    SW_FLAGS: str = "lanczos"
    CAMERA_ALPHA: float = 0.2
    BBOX_PAD: float = 0.2
    BBOX_MIN_W: int = 15
    BBOX_MIN_H: int = 15
    OVERLAP_FALLBACK_RATIO: float = 0.6
    TWO_SHOT_EXTRA_PAD: float = 160.0
    VERTICAL_CROP_OFFSET: float = 0.35
    SPLIT_ZOOM_FACTOR: float = 1.6
    SPLIT_HALF_HEIGHT: int = 640


# ── Misc ──────────────────────────────────────────────────────────

@dataclass
class MiscConfig:
    SPEAKER_FILTER_MIN_SEC: float = 3.0
    CONSOLIDATE_CX_THRESHOLD: float = 100.0


# ── Speaker-Face Fusion ───────────────────────────────────────────

@dataclass
class FusionConfig:
    """
    Speaker-Face Fusion configuration.
    When ENABLED=False, pipeline behaves exactly as before (backward compatible).
    """
    ENABLED: bool = False  # Master switch — OFF by default
    GRACE_PERIOD: float = 0.3  # seconds to wait before switching away from disappeared speaker
    CONFIDENCE_THRESHOLD: float = 0.5  # minimum confidence to trust ASD lip motion


# ── Singleton instances (importable) ──────────────────────────────

audio = AudioConfig()
face = FaceDetectionConfig()
asd_cfg = ASDConfig()
director = DirectorConfig()
split = SplitConfig()
avm = AVMConfig()
reaction = ReactionConfig()
render = RenderConfig()
misc = MiscConfig()
fusion = FusionConfig()
