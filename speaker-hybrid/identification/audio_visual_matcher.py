#!/usr/bin/env python3
"""
audio-visual-matcher.py — GANYIQ Audio-Visual Speaker Matcher

Matches audio diarization results (from PyAnnote / Deepgram)
with visual face tracking (from hybrid-face-detector.py)
to produce accurate speaker timelines.

Pipeline:
  Audio diarization → speaker segments with timestamps
  Visual tracking   → face tracks with timestamps
  → Match by time overlap + speaker count
  → Output unified speaker timeline
"""

import json
import sys
import os
from pathlib import Path


# =============================================================================
# Types
# =============================================================================

class AudioSegment:
    """Single audio speaker segment from diarization."""
    def __init__(self, speaker_id: str, start: float, end: float):
        self.speaker_id = speaker_id
        self.start = start
        self.end = end
        self.duration = end - start

    def to_dict(self):
        return {
            "speaker_id": self.speaker_id,
            "start": round(self.start, 2),
            "end": round(self.end, 2),
            "duration": round(self.duration, 2),
        }


class VisualFrame:
    """Single frame face detection from hybrid detector."""
    def __init__(self, time: float, faces: list[dict]):
        self.time = time
        self.faces = faces

    def speaker_count(self) -> int:
        """Number of unique speakers in this frame."""
        speakers = set()
        for f in self.faces:
            sid = f.get("speaker_id") or f.get("track_id", -1)
            speakers.add(str(sid))
        return len(speakers)

    def active_speakers(self) -> list[str]:
        """List of speaker IDs active in this frame."""
        speakers = set()
        for f in self.faces:
            sid = f.get("speaker_id") or f.get("track_id", -1)
            speakers.add(str(sid))
        return sorted(speakers)


# =============================================================================
# Matcher
# =============================================================================

class AudioVisualMatcher:
    """
    Matches audio diarization segments with visual face tracks
    to produce a unified speaker timeline.
    """

    def __init__(
        self,
        time_tolerance: float = 0.5,
        min_overlap: float = 0.3,
        prefer_visual: bool = True,
    ):
        self.time_tolerance = time_tolerance
        self.min_overlap = min_overlap
        self.prefer_visual = prefer_visual

    def match(
        self,
        audio_segments: list[AudioSegment],
        visual_frames: list[VisualFrame],
    ) -> list[dict]:
        """
        Match audio segments with visual frames.

        Returns unified timeline:
        [
            {
                "start": 0.0,
                "end": 2.5,
                "visual_speakers": ["speaker_0"],
                "audio_speakers": ["SPEAKER_00"],
                "matched_speakers": ["speaker_0"],
                "confidence": 0.85,
            },
            ...
        ]
        """
        if not audio_segments:
            return self._build_from_visual_only(visual_frames)
        if not visual_frames:
            return self._build_from_audio_only(audio_segments)

        timeline = []

        for audio_seg in audio_segments:
            # Find overlapping visual frames
            overlapping_frames = self._find_overlapping_frames(
                audio_seg, visual_frames
            )

            # Determine active visual speakers in this segment
            visual_speakers = set()
            for vf in overlapping_frames:
                for sid in vf.active_speakers():
                    visual_speakers.add(sid)

            # Determine active audio speakers
            audio_speakers = {audio_seg.speaker_id}

            # Match speakers
            matched = self._match_speakers(
                list(visual_speakers), list(audio_speakers), audio_seg
            )

            # Confidence based on overlap
            overlap_ratio = (
                len(overlapping_frames) / max(len(visual_frames), 1)
                if visual_frames
                else 0
            )
            confidence = min(
                0.5 + overlap_ratio * 0.5,
                0.95,
            )

            timeline.append({
                "start": round(audio_seg.start, 2),
                "end": round(audio_seg.end, 2),
                "visual_speakers": sorted(visual_speakers),
                "audio_speakers": sorted(audio_speakers),
                "matched_speakers": sorted(matched),
                "confidence": round(confidence, 3),
            })

        # ── Fill gaps between audio segments with visual-only data ──
        timeline.sort(key=lambda x: x["start"])
        filled = []
        video_start = visual_frames[0].time if visual_frames else 0.0
        video_end = visual_frames[-1].time if visual_frames else (timeline[-1]["end"] if timeline else 0.0)

        # Gap before first audio segment
        if timeline and timeline[0]["start"] > video_start:
            gap_visuals = self._get_visual_speakers_in_range(visual_frames, video_start, timeline[0]["start"])
            if gap_visuals:
                filled.append({
                    "start": round(video_start, 2),
                    "end": round(timeline[0]["start"], 2),
                    "visual_speakers": sorted(gap_visuals),
                    "audio_speakers": [],
                    "matched_speakers": [],
                    "confidence": 0.3,
                    "gap_fill": True,
                })

        # Fill between audio segments and after last
        prev_end = video_start
        for entry in timeline:
            if entry["start"] > prev_end + 0.3:  # gap > 0.3s
                gap_visuals = self._get_visual_speakers_in_range(visual_frames, prev_end, entry["start"])
                if gap_visuals:
                    filled.append({
                        "start": round(prev_end, 2),
                        "end": round(entry["start"], 2),
                        "visual_speakers": sorted(gap_visuals),
                        "audio_speakers": [],
                        "matched_speakers": [],
                        "confidence": 0.3,
                        "gap_fill": True,
                    })
            filled.append(entry)
            prev_end = entry["end"]

        # Gap after last audio segment
        if filled and filled[-1]["end"] < video_end:
            gap_visuals = self._get_visual_speakers_in_range(visual_frames, filled[-1]["end"], video_end)
            if gap_visuals:
                filled.append({
                    "start": round(filled[-1]["end"], 2),
                    "end": round(video_end, 2),
                    "visual_speakers": sorted(gap_visuals),
                    "audio_speakers": [],
                    "matched_speakers": [],
                    "confidence": 0.3,
                    "gap_fill": True,
                })

        return filled if filled else timeline

    def _find_overlapping_frames(
        self, segment: AudioSegment, frames: list[VisualFrame]
    ) -> list[VisualFrame]:
        """Find visual frames that overlap with an audio segment."""
        overlapping = []
        for vf in frames:
            if (segment.start - self.time_tolerance <= vf.time <= segment.end + self.time_tolerance):
                overlapping.append(vf)
        return overlapping

    def _get_visual_speakers_in_range(
        self, frames: list[VisualFrame], t_start: float, t_end: float
    ) -> list[str]:
        """Get unique visual speaker IDs visible in a time range."""
        speakers = set()
        for vf in frames:
            if t_start <= vf.time <= t_end:
                for sid in vf.active_speakers():
                    speakers.add(sid)
        return sorted(speakers)

    def _match_speakers(
        self,
        visual_speakers: list[str],
        audio_speakers: list[str],
        segment: AudioSegment,
    ) -> list[str]:
        """
        Match visual speaker IDs with audio speaker IDs.
        Uses count heuristics when audio/visual counts align.
        """
        if not visual_speakers:
            return audio_speakers
        if not audio_speakers:
            return visual_speakers

        # If same count, map directly
        if len(visual_speakers) == len(audio_speakers):
            if self.prefer_visual:
                return visual_speakers
            return audio_speakers

        # If visual has more (some listeners detected as speakers)
        if len(visual_speakers) > len(audio_speakers):
            if self.prefer_visual:
                return visual_speakers[:len(audio_speakers)]
            return audio_speakers

        # Audio has more → return all
        if self.prefer_visual and visual_speakers:
            return visual_speakers + audio_speakers[:len(audio_speakers) - len(visual_speakers)]
        return audio_speakers

    def _build_from_visual_only(
        self, frames: list[VisualFrame]
    ) -> list[dict]:
        """Fallback: build timeline from visual only."""
        if not frames:
            return []

        timeline = []
        current_speakers = set()
        segment_start = frames[0].time

        for vf in frames:
            speakers = set(vf.active_speakers())
            if speakers != current_speakers:
                if current_speakers:
                    timeline.append({
                        "start": round(segment_start, 2),
                        "end": round(vf.time, 2),
                        "visual_speakers": sorted(current_speakers),
                        "audio_speakers": [],
                        "matched_speakers": sorted(current_speakers),
                        "confidence": 0.6,
                    })
                current_speakers = speakers
                segment_start = vf.time

        # Last segment
        if current_speakers and frames:
            timeline.append({
                "start": round(segment_start, 2),
                "end": round(frames[-1].time, 2),
                "visual_speakers": sorted(current_speakers),
                "audio_speakers": [],
                "matched_speakers": sorted(current_speakers),
                "confidence": 0.5,
            })

        return timeline

    def _build_from_audio_only(
        self, segments: list[AudioSegment]
    ) -> list[dict]:
        """Fallback: build timeline from audio only."""
        return [
            {
                "start": seg.start,
                "end": seg.end,
                "visual_speakers": [],
                "audio_speakers": [seg.speaker_id],
                "matched_speakers": [seg.speaker_id],
                "confidence": 0.4,
            }
            for seg in segments
        ]


# =============================================================================
# Loaders
# =============================================================================

def load_hybrid_detector_output(path: str) -> list[VisualFrame]:
    """Load hybrid-face-detector.py JSON output."""
    with open(path) as f:
        data = json.load(f)

    frames = []
    for entry in data.get("timeline", []):
        vf = VisualFrame(
            time=entry.get("time", 0),
            faces=entry.get("faces", []),
        )
        frames.append(vf)
    return frames


def load_diarization(path: str) -> list[AudioSegment]:
    """Load PyAnnote/Deepgram diarization JSON."""
    with open(path) as f:
        data = json.load(f)

    segments = []
    for entry in data.get("segments", data.get("diarization", [])):
        seg = AudioSegment(
            speaker_id=entry.get("speaker", entry.get("speaker_id", "UNKNOWN")),
            start=entry.get("start", entry.get("start_sec", 0)),
            end=entry.get("end", entry.get("end_sec", 0)),
        )
        if seg.duration > 0.2:  # Filter out very short segments
            segments.append(seg)
    return segments


# =============================================================================
# CLI
# =============================================================================

def main():
    parser = argparse.ArgumentParser(
        description="GANYIQ Audio-Visual Speaker Matcher"
    )
    parser.add_argument("visual_json", help="hybrid-face-detector.py output JSON")
    parser.add_argument("audio_json", help="Diarization JSON")
    parser.add_argument("output_json", help="Output path")
    parser.add_argument("--time-tolerance", type=float, default=0.5)
    parser.add_argument("--prefer-visual", action="store_true", default=True)
    parser.add_argument("--prefer-audio", dest="prefer_visual", action="store_false")
    args = parser.parse_args()

    # Validate
    if not os.path.exists(args.visual_json):
        print(f"Error: {args.visual_json} not found", file=sys.stderr)
        sys.exit(1)
    if not os.path.exists(args.audio_json):
        print(f"Error: {args.audio_json} not found", file=sys.stderr)
        sys.exit(1)

    # Load
    print(f"[INFO] Loading visual: {args.visual_json}", file=sys.stderr)
    visual_frames = load_hybrid_detector_output(args.visual_json)
    print(f"[INFO] Loading audio: {args.audio_json}", file=sys.stderr)
    audio_segments = load_diarization(args.audio_json)

    print(
        f"[INFO] {len(visual_frames)} visual frames, {len(audio_segments)} audio segments",
        file=sys.stderr,
    )

    # Match
    matcher = AudioVisualMatcher(
        time_tolerance=args.time_tolerance,
        prefer_visual=args.prefer_visual,
    )
    timeline = matcher.match(audio_segments, visual_frames)

    # Output
    output = {
        "metadata": {
            "visual_frames": len(visual_frames),
            "audio_segments": len(audio_segments),
            "matched_segments": len(timeline),
            "method": "audio-visual-hybrid",
        },
        "timeline": timeline,
    }

    with open(args.output_json, "w") as f:
        json.dump(output, f, indent=2)

    print(f"[DONE] {len(timeline)} matched segments → {args.output_json}", file=sys.stderr)


if __name__ == "__main__":
    main()
