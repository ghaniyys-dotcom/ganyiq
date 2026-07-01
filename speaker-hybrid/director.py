from dataclasses import dataclass, field
from collections import defaultdict

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

class DirectorAI:
    """
    Analyzes the entire video's worth of data (audio diarization, face tracks)
    to create a stateful, intelligent shot list, mimicking a human director.
    """
    def __init__(self, face_data: dict, diarization: list, video_duration: float, 
                 min_shot_duration: float = 2.5, speaker_dominance_threshold: float = 4.0):
        self.face_data = face_data
        self.diarization = diarization
        self.video_duration = video_duration
        self.min_shot_duration = min_shot_duration
        self.speaker_dominance_threshold = speaker_dominance_threshold

        # Pre-process data for quick lookups
        self.speech_timeline = self._build_speech_timeline()

    def _build_speech_timeline(self) -> defaultdict[float, list[str]]:
        """Creates a per-second lookup of active speaker IDs with anticipation offset."""
        timeline = defaultdict(list)
        anticipation_offset = 0.6  # Shift cuts 0.6s earlier than audio to anticipate speaking
        for segment in self.diarization:
            speaker_id = segment['speaker']
            start = max(0.0, segment['start'] - anticipation_offset)
            end = max(0.0, segment['end'] - anticipation_offset)
            for t in range(int(start), int(end) + 1):
                if speaker_id not in timeline[float(t)]:
                    timeline[float(t)].append(speaker_id)
        return timeline

    def create_shot_list(self) -> list[Shot]:
        """
        The main directorial logic. Iterates through the video timeline and
        makes stateful decisions about camera shots.
        """
        raw_shots = []
        
        # State variables
        current_layout = None
        current_primary = None
        current_secondary = None
        last_cut_time = 0.0

        # Loop through time, second by second
        for t in range(int(self.video_duration)):
            # 1. Who is active at this second?
            speaker, listener, is_close = self._get_scene_actors(float(t))
            
            # 2. What's the best layout for them?
            ideal_layout = self._determine_layout(speaker, listener, is_close)
            
            # 3. Time to cut? (Layout changed AND min duration passed)
            if (ideal_layout != current_layout or speaker != current_primary) and (t - last_cut_time > self.min_shot_duration):
                # Finalize the previous shot
                if current_layout is not None:
                    raw_shots.append(Shot(
                        start_time=last_cut_time,
                        end_time=float(t),
                        layout=current_layout,
                        primary_target_id=current_primary,
                        secondary_target_id=current_secondary,
                    ))
                
                # Start a new shot
                current_layout = ideal_layout
                current_primary = speaker
                current_secondary = listener
                last_cut_time = float(t)

        # Add the final shot
        if current_layout is not None:
            raw_shots.append(Shot(
                start_time=last_cut_time,
                end_time=self.video_duration,
                layout=current_layout,
                primary_target_id=current_primary,
                secondary_target_id=current_secondary
            ))

        # Post-processing: merge consecutive identical shots
        return self._merge_consecutive_shots(raw_shots)

    def _get_scene_actors(self, time_sec: float) -> tuple[str | None, str | None, bool]:
        """
        Find the primary speaker, best listener, and whether they sit close to each other.
        THIS IS THE CORE INTELLECT OF THE DIRECTOR.
        """
        active_speakers = self.speech_timeline.get(time_sec, [])
        if not active_speakers:
            return None, None, False
        
        speaker_id = active_speakers[0]
        
        # Get all faces visible at this specific time
        all_faces_now = []
        for entry in self.face_data.get("timeline", []):
            if abs(entry.get("time", 0) - time_sec) < 0.5:
                all_faces_now = entry.get("faces", [])
                break

        # If no faces at all, speaker is off-screen → wide/audio-only shot
        if not all_faces_now:
            return speaker_id, None, False

        # Try to find speaker's face by matching speaker_id
        speaker_face = None
        for face in all_faces_now:
            if face.get('speaker_id') == speaker_id:
                speaker_face = face
                break

        # If speaker not found by id, pick the most central face as primary
        if not speaker_face:
            valid_faces = [f for f in all_faces_now if f.get('w', 0) >= 40 and f.get('h', 0) >= 40]
            if valid_faces:
                valid_faces.sort(key=lambda f: abs(f.get('cx', 640) - 640))
                speaker_face = valid_faces[0]

        if not speaker_face:
            return speaker_id, None, False

        # Collect other faces (listeners) that are NOT the speaker
        other_faces = []
        for face in all_faces_now:
            # Skip if it is the primary speaker face
            if face == speaker_face:
                continue
            # Apply size filter to filter out hands/noise
            if face.get('w', 0) >= 40 and face.get('h', 0) >= 40:
                other_faces.append(face)

        # Score and pick the best listener from remaining faces
        if other_faces:
            # Sort by distance to center (ascending)
            other_faces.sort(key=lambda f: abs(f.get('cx', 640) - 640))
            best_listener = other_faces[0]
            
            # Use speaker_id if available, otherwise track_id
            listener_id = best_listener.get('speaker_id') or f"track_{best_listener.get('track_id')}"
            
            # Check if they are sitting very close (threshold: 300px horizontally)
            dist_x = abs(speaker_face.get('cx', 0) - best_listener.get('cx', 0))
            is_close = dist_x < 300.0
            
            return speaker_id, listener_id, is_close

        return speaker_id, None, False

    def _determine_layout(self, speaker_id: str | None, listener_id: str | None, is_close: bool) -> str:
        """Determines the layout based on who is present."""
        if speaker_id and listener_id:
            if is_close:
                return "two_shot_wide"
            return "split_screen"
        elif speaker_id:
            return "fullscreen"
        else:
            return "wide_shot" # Fallback if no one is active

    def _merge_consecutive_shots(self, shots: list[Shot]) -> list[Shot]:
        """Merge consecutive shots with the same layout.
        
        This is more aggressive than exact-match merging. Since the DirectorAI
        creates shots second-by-second, the speaker IDs can fluctuate even
        when the scene is the same. We merge by layout to produce longer,
        more natural segments.
        
        Minimum shot duration is enforced: if a segment is <2.5s, it gets
        absorbed into the previous segment (merged by layout).
        """
        if not shots:
            return []
        
        # First pass: merge by layout only (ignore primary/secondary changes)
        layout_merged = [shots[0]]
        for next_shot in shots[1:]:
            last_shot = layout_merged[-1]
            if last_shot.layout == next_shot.layout:
                # Same layout → merge (even if targets changed)
                last_shot.end_time = next_shot.end_time
                # Keep primary target from the longer segment
                if next_shot.end_time - next_shot.start_time > last_shot.end_time - last_shot.start_time:
                    last_shot.primary_target_id = next_shot.primary_target_id
                    last_shot.secondary_target_id = next_shot.secondary_target_id
            else:
                layout_merged.append(next_shot)
        
        # Second pass: absorb micro-shots (<2.5s) into previous shot
        final = [layout_merged[0]]
        for next_shot in layout_merged[1:]:
            last_shot = final[-1]
            if next_shot.duration < 2.5:
                # Absorb into previous shot (keep that layout)
                last_shot.end_time = next_shot.end_time
            else:
                final.append(next_shot)
        
        return final

