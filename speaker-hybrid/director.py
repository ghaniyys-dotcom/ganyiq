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
        """Creates a per-second lookup of active speaker IDs."""
        timeline = defaultdict(list)
        for segment in self.diarization:
            speaker_id = segment['speaker']
            start, end = segment['start'], segment['end']
            for t in range(int(start), int(end)):
                if speaker_id not in timeline[float(t)]:
                    timeline[float(t)].append(speaker_id)
        return timeline

    def create_shot_list(self) -> list[Shot]:
        """
        The main directorial logic. Iterates through the video timeline and
        makes stateful decisions about camera shots.

        (Logic to be implemented in Step 2, 3, 4)
        """
        # Placeholder logic: create one long fullscreen shot for now
        # This will be replaced with the state machine logic.
        print("[DirectorAI] WARNING: Using placeholder logic. Shot list will be basic.")
        
        shot_list = [
            Shot(
                start_time=0.0,
                end_time=self.video_duration,
                layout="fullscreen",
                debug_info={"reason": "placeholder"}
            )
        ]
        
        return shot_list

