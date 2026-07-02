from dataclasses import dataclass, field
from collections import defaultdict
import math


@dataclass
class Shot:
    """Represents a single shot in the final video."""
    start_time: float
    end_time: float
    layout: str = "fullscreen"
    primary_target_id: int | None = None
    secondary_target_id: int | None = None
    debug_info: dict = field(default_factory=dict)

    @property
    def duration(self) -> float:
        return self.end_time - self.start_time


def _is_same_person(a, b):
    """Compare by person_id > speaker_id > track_id."""
    ap = a.get("person_id")
    bp = b.get("person_id")
    if ap is not None and bp is not None and ap > 0 and bp > 0:
        return ap == bp
    asid = a.get("speaker_id", "").upper()
    bsid = b.get("speaker_id", "").upper()
    if asid and bsid and asid != "UNKNOWN" and bsid != "UNKNOWN":
        if asid == bsid:
            return True
    return a.get("track_id") == b.get("track_id")


class DirectorAI:
    """Analyzes face+audio data to create an intelligent shot list."""

    def __init__(self, face_data: dict, diarization: list, video_duration: float,
                 min_shot_duration: float = 2.0,
                 frame_w: int = 1280, frame_h: int = 720):
        self.face_data = face_data
        self.diarization = diarization
        self.video_duration = video_duration
        self.min_shot_duration = min_shot_duration
        self.frame_w = frame_w
        self.frame_h = frame_h
        self.speech_timeline = self._build_speech_timeline()

    def _build_speech_timeline(self) -> defaultdict[float, list[str]]:
        """Map each second to active speaker IDs."""
        tl: defaultdict[float, list[str]] = defaultdict(list)
        for seg in self.diarization:
            start = float(seg.get("start", 0))
            end = float(seg.get("end", 0))
            speaker = seg.get("speaker")
            if not speaker:
                continue
            for t in range(math.floor(start), math.ceil(end) + 1):
                if start <= t < end:
                    tl[t].append(speaker)
        return tl

    def create_shot_list(self) -> list[Shot]:
        """Stateful shot creation with per-second evaluation."""
        raw_shots = []
        current_layout: str | None = None
        current_primary: str | None = None
        current_secondary: str | None = None
        last_cut_time = 0.0

        for t in range(int(self.video_duration)):
            tf = float(t)
            all_faces = self._get_faces_at_time(tf)
            speaker_id = self._get_active_speaker(tf)
            speaker_face = self._find_speaker_face(speaker_id, all_faces)

            # Find main reactor (non-speaker with best centrality + lip_motion)
            reactor_face = self._find_main_reactor(speaker_face, all_faces) if speaker_face else None

            # Convert faces to target ID strings
            primary = self._face_to_target_id(speaker_face) or speaker_id
            secondary = self._face_to_target_id(reactor_face)

            # === Logic kamera pinter ===
            if speaker_id and secondary:
                ideal_layout = "split_screen"
            elif speaker_id:
                ideal_layout = "fullscreen"
            else:
                ideal_layout = "wide_shot"
                primary = None
                secondary = None

            # === Cut decision ===
            layout_changed = ideal_layout != current_layout
            primary_changed = primary != current_primary
            time_since_cut = tf - last_cut_time

            if (layout_changed or primary_changed) and time_since_cut >= self.min_shot_duration:
                # Close previous shot
                if current_layout is not None:
                    raw_shots.append(Shot(
                        start_time=last_cut_time, end_time=tf,
                        layout=current_layout,
                        primary_target_id=current_primary,
                        secondary_target_id=current_secondary,
                        debug_info={"cut_reason":
                            "layout" if layout_changed else "primary_change"}
                    ))
                # Start new shot
                current_layout = ideal_layout
                current_primary = primary
                current_secondary = secondary
                last_cut_time = tf

        # Final shot
        if current_layout is not None and last_cut_time < self.video_duration:
            raw_shots.append(Shot(
                start_time=last_cut_time, end_time=self.video_duration,
                layout=current_layout,
                primary_target_id=current_primary,
                secondary_target_id=current_secondary,
                debug_info={"cut_reason": "end"}
            ))

        return self._merge_consecutive_shots(raw_shots)

    # ── Helper: get faces at time ──
    def _get_faces_at_time(self, time_sec: float) -> list[dict]:
        for entry in self.face_data.get("timeline", []):
            if abs(entry.get("time", 0) - time_sec) < 0.5:
                return entry.get("faces", [])
        return []

    # ── Helper: active speaker ──
    def _get_active_speaker(self, time_sec: float) -> str | None:
        active = self.speech_timeline.get(int(time_sec), [])
        return active[0] if active else None

    # ── Helper: find speaker face ──
    def _find_speaker_face(self, speaker_id: str | None, faces: list[dict]) -> dict | None:
        if not speaker_id or not faces:
            return None
        speaker_upper = speaker_id.upper()
        for face in faces:
            if face.get("speaker_id", "").upper() == speaker_upper:
                return face
        # Fallback: most central face
        valid = [f for f in faces if f.get("w", 0) >= 40 and f.get("h", 0) >= 40]
        if valid:
            valid.sort(key=lambda f: abs(f.get("cx", 640) - 640))
            return valid[0]
        return None

    # ── Helper: find main reactor (non-speaker with best score) ──
    def _find_main_reactor(self, speaker_face: dict | None, all_faces: list[dict]) -> dict | None:
        if not speaker_face or not all_faces:
            return None
        candidates = []
        for face in all_faces:
            if _is_same_person(face, speaker_face):
                continue
            if face.get("w", 0) < 40 or face.get("h", 0) < 40:
                continue
            # Proximity filter: too close = tracking artifact
            dx = abs(face.get("cx", 0) - speaker_face.get("cx", 0))
            if dx < 150.0:
                continue
            # Score: centrality + lip_motion
            cx = face.get("cx", 640)
            centrality = max(0.0, 1.0 - abs(cx - 640) / 640)
            lip = float(face.get("lip_motion", 0.0))
            lip_score = min(1.0, lip * 500.0) if lip > 0 else 0.0
            score = centrality * 0.6 + lip_score * 0.4
            if score > 0.3:
                candidates.append((score, face))
        candidates.sort(key=lambda x: x[0], reverse=True)
        return candidates[0][1] if candidates else None

    # ── Helper: face dict -> target ID string ──
    def _face_to_target_id(self, face: dict | None) -> str | None:
        if not face:
            return None
        pid = face.get("person_id")
        if pid is not None and pid > 0:
            return f"person_{pid}"
        sid = face.get("speaker_id")
        if sid:
            return sid
        tid = face.get("track_id")
        if tid is not None:
            return f"track_{tid}"
        return None

    # ── Merge adjacent same shots, absorb micro-shots ──
    def _merge_consecutive_shots(self, shots: list[Shot]) -> list[Shot]:
        if not shots:
            return []
        merged = [shots[0]]
        for s in shots[1:]:
            last = merged[-1]
            # Same layout + same primary target -> merge
            if last.layout == s.layout and last.primary_target_id == s.primary_target_id:
                last.end_time = s.end_time
                if s.secondary_target_id:
                    last.secondary_target_id = s.secondary_target_id
                continue
            # Micro-shot (< half min_duration) -> absorb
            if s.duration < self.min_shot_duration * 0.5:
                last.end_time = s.end_time
                continue
            merged.append(s)
        return merged
