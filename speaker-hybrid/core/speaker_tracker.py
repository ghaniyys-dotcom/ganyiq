#!/usr/bin/env python3
"""
core/speaker_tracker.py — Active Speaker Timeline Builder

Fuses diarization (audio), ASD (lip motion), and face detection (visual)
into a unified per-frame active speaker timeline.

Used by renderer to follow the active speaker instead of just any detected face.
"""

from dataclasses import dataclass
from typing import Optional, Any
import bisect
import json


# ── Data Structures ──────────────────────────────────────────────

@dataclass
class ActiveSpeakerFrame:
    """Per-frame active speaker state."""
    timestamp: float
    speaker_id: Optional[str]
    track_id: Optional[int]
    bbox: Optional[dict]
    confidence: float
    source: str  # "asd" | "diarization" | "visual_fallback"


class ActiveSpeakerTimeline:
    """Binary-searchable timeline of active speaker per frame."""

    def __init__(self, frames: list[ActiveSpeakerFrame]):
        self.frames = sorted(frames, key=lambda f: f.timestamp)
        self.timestamps = [f.timestamp for f in self.frames]

    def get_active_at(self, timestamp: float) -> Optional[ActiveSpeakerFrame]:
        """Binary search for nearest frame <= timestamp."""
        if not self.frames:
            return None
        idx = bisect.bisect_right(self.timestamps, timestamp)
        if idx == 0:
            return None
        return self.frames[idx - 1]

    def to_dict(self) -> list[dict]:
        return [
            {
                "timestamp": f.timestamp,
                "speaker_id": f.speaker_id,
                "track_id": f.track_id,
                "bbox": f.bbox,
                "confidence": f.confidence,
                "source": f.source,
            }
            for f in self.frames
        ]

    @classmethod
    def from_dict(cls, data: list[dict]) -> "ActiveSpeakerTimeline":
        frames = [
            ActiveSpeakerFrame(
                timestamp=d["timestamp"],
                speaker_id=d.get("speaker_id"),
                track_id=d.get("track_id"),
                bbox=d.get("bbox"),
                confidence=d.get("confidence", 0.0),
                source=d.get("source", "unknown"),
            )
            for d in data
        ]
        return cls(frames)


# ── Speaker Tracker ──────────────────────────────────────────────

class SpeakerTracker:
    """
    Fuses diarization, ASD (lip motion), and face tracking
    into an active speaker timeline for the renderer.

    Data sources (from result.json):
      - diarization: result["speakers"][]["segments"][{"start", "end"}]
      - face data:   face_data_file.json → {"timeline": [{"time", "faces":[{...}]}]}
        Each face has: {track_id, speaker_id, lip_motion, cx, cy, w, h, confidence}
      - id_bridge:   {diar_speaker —> canonical_id, track_N —> canonical_id}
    """

    def __init__(self, grace_period: float = 0.3, confidence_threshold: float = 0.5):
        self.grace_period = grace_period
        self.confidence_threshold = confidence_threshold

    def build_active_speaker_timeline(
        self,
        diarization: list[dict],
        asd_timeline: list[dict],
        id_bridge: dict,
        face_detections: Any,
    ) -> ActiveSpeakerTimeline:
        """
        Build per-frame active speaker timeline from available data.

        Resolution order:
          1. ASD lip-motion (> threshold) → highest lip_motion face bbox (best)
          2. Diarization → id_bridge → track_id → bbox (good)
          3. Grace period → keep last active speaker for GRACE_PERIOD (smooth)
          4. Visual fallback → largest face in frame (current behavior)
        """
        frames = []

        # Normalize face_detections to a timeline list
        face_timeline = self._normalize_face_data(face_detections)
        if not face_timeline:
            return ActiveSpeakerTimeline([])

        # Build diarization lookup: time -> speaker_id
        speaker_at_time = self._build_diarization_lookup(diarization)

        last_speaker: Optional[str] = None
        last_time: Optional[float] = None

        for entry in face_timeline:
            timestamp: float = entry.get("time", 0.0)
            faces: list[dict] = entry.get("faces", [])

            # Get diarization speaker at this timestamp
            diar_speaker = self._speaker_at(timestamp, speaker_at_time)

            # Three-level resolution
            result = self._resolve(
                faces=faces,
                timestamp=timestamp,
                diar_speaker=diar_speaker,
                id_bridge=id_bridge,
                last_speaker=last_speaker,
                last_time=last_time,
            )
            frames.append(result)

            # Track last active speaker for grace period
            if result.speaker_id:
                last_speaker = result.speaker_id
                last_time = timestamp

        return ActiveSpeakerTimeline(frames)

    # ── Helpers ──────────────────────────────────────────────────

    def _normalize_face_data(self, face_detections: Any) -> list[dict]:
        """Convert face_detections into a list of {time, faces} entries."""
        if isinstance(face_detections, str):
            try:
                with open(face_detections) as f:
                    face_detections = json.load(f)
            except (FileNotFoundError, json.JSONDecodeError):
                return []
        if isinstance(face_detections, dict) and "timeline" in face_detections:
            return face_detections["timeline"]
        if isinstance(face_detections, list):
            return face_detections
        return []

    def _build_diarization_lookup(
        self, diarization: list[dict]
    ) -> list[dict]:
        """Flatten diarization segments into a sorted list of {start, end, speaker}."""
        segments = []
        for spk in diarization:
            sid = spk.get("speaker_id", "")
            for seg in spk.get("segments", []):
                segments.append({
                    "start": seg.get("start", 0),
                    "end": seg.get("end", 0),
                    "speaker": sid,
                })
        return sorted(segments, key=lambda s: s["start"])

    def _speaker_at(self, timestamp: float, segments: list[dict]) -> Optional[str]:
        """Find diarization speaker active at timestamp."""
        for seg in segments:
            if seg["start"] <= timestamp <= seg["end"]:
                return seg["speaker"]
        return None

    def _resolve(
        self,
        faces: list[dict],
        timestamp: float,
        diar_speaker: Optional[str],
        id_bridge: dict,
        last_speaker: Optional[str],
        last_time: Optional[float],
    ) -> ActiveSpeakerFrame:
        """Three-level resolution + grace period within a single frame."""

        # Level 1: ASD lip-motion (highest lip_motion > threshold)
        if faces and self.confidence_threshold > 0:
            # Find face with highest lip_motion
            best_face = max(
                [f for f in faces if f.get("lip_motion", 0) > self.confidence_threshold],
                key=lambda f: f.get("lip_motion", 0),
                default=None,
            )
            if best_face and best_face.get("lip_motion", 0) > self.confidence_threshold:
                return ActiveSpeakerFrame(
                    timestamp=timestamp,
                    speaker_id=best_face.get("speaker_id") or diar_speaker,
                    track_id=best_face.get("track_id"),
                    bbox=self._face_to_bbox(best_face),
                    confidence=best_face.get("lip_motion", 0),
                    source="asd",
                )

        # Level 2: Diarization → id_bridge → track_id → bbox
        if diar_speaker:
            canonical = id_bridge.get(diar_speaker)
            if canonical:
                bbox = self._find_bbox_for_canonical(faces, canonical, id_bridge)
                if bbox:
                    return ActiveSpeakerFrame(
                        timestamp=timestamp,
                        speaker_id=diar_speaker,
                        track_id=self._track_id_for_canonical(faces, canonical, id_bridge),
                        bbox=bbox,
                        confidence=0.7,
                        source="diarization",
                    )
                # Diarization matches but no face with that canonical — still report speaker
                return ActiveSpeakerFrame(
                    timestamp=timestamp,
                    speaker_id=diar_speaker,
                    track_id=None,
                    bbox=None,
                    confidence=0.5,
                    source="diarization",
                )
            # Try direct speaker_id comparison
            for face in faces:
                if face.get("speaker_id") == diar_speaker:
                    return ActiveSpeakerFrame(
                        timestamp=timestamp,
                        speaker_id=diar_speaker,
                        track_id=face.get("track_id"),
                        bbox=self._face_to_bbox(face),
                        confidence=0.7,
                        source="diarization",
                    )

        # Grace period: keep last speaker within window
        if last_speaker and last_time is not None:
            if (timestamp - last_time) <= self.grace_period:
                canonical = id_bridge.get(last_speaker)
                if canonical:
                    bbox = self._find_bbox_for_canonical(faces, canonical, id_bridge)
                    if bbox:
                        return ActiveSpeakerFrame(
                            timestamp=timestamp,
                            speaker_id=last_speaker,
                            track_id=self._track_id_for_canonical(faces, canonical, id_bridge),
                            bbox=bbox,
                            confidence=0.5,
                            source="diarization",
                        )
                # Try direct speaker_id match
                for face in faces:
                    if face.get("speaker_id") == last_speaker:
                        return ActiveSpeakerFrame(
                            timestamp=timestamp,
                            speaker_id=last_speaker,
                            track_id=face.get("track_id"),
                            bbox=self._face_to_bbox(face),
                            confidence=0.5,
                            source="diarization",
                        )

        # Level 3: Visual fallback — largest face
        if faces:
            largest = max(faces, key=lambda f: f.get("w", 0) * f.get("h", 0))
            return ActiveSpeakerFrame(
                timestamp=timestamp,
                speaker_id=largest.get("speaker_id"),
                track_id=largest.get("track_id"),
                bbox=self._face_to_bbox(largest),
                confidence=0.3,
                source="visual_fallback",
            )

        # No faces at all
        return ActiveSpeakerFrame(
            timestamp=timestamp,
            speaker_id=None,
            track_id=None,
            bbox=None,
            confidence=0.0,
            source="visual_fallback",
        )

    # ── Bbox utilities ───────────────────────────────────────────

    def _face_to_bbox(self, face: dict) -> dict:
        """Convert face detection entry to unified bbox format (cx/cy/w/h)."""
        # Direct cx/cy format (most common in face data)
        if "cx" in face and "cy" in face:
            return {
                "cx": face["cx"],
                "cy": face["cy"],
                "w": face.get("w", 0),
                "h": face.get("h", 0),
            }
        # x/y format — convert to cx/cy
        return {
            "cx": face.get("x", 0) + face.get("w", 100) / 2,
            "cy": face.get("y", 0) + face.get("h", 100) / 2,
            "w": face.get("w", 0),
            "h": face.get("h", 0),
        }

    def _find_bbox_for_canonical(
        self, faces: list[dict], canonical: str, id_bridge: dict
    ) -> Optional[dict]:
        """Find a face that matches the canonical speaker ID."""
        for face in faces:
            if self._match_canonical(face, canonical, id_bridge):
                return self._face_to_bbox(face)
        return None

    def _track_id_for_canonical(
        self, faces: list[dict], canonical: str, id_bridge: dict
    ) -> Optional[int]:
        """Get track_id for the face matching canonical ID."""
        for face in faces:
            if self._match_canonical(face, canonical, id_bridge):
                return face.get("track_id")
        return None

    def _match_canonical(self, face: dict, canonical: str, id_bridge: dict) -> bool:
        """Check if a face dict matches the canonical identifier via the bridge."""
        face_sid = face.get("speaker_id")
        if face_sid and id_bridge.get(face_sid) == canonical:
            return True
        face_pid = face.get("person_id")
        if face_pid and id_bridge.get(f"person_{face_pid}") == canonical:
            return True
        face_tid = face.get("track_id")
        if face_tid is not None and id_bridge.get(f"track_{face_tid}") == canonical:
            return True
        return False
