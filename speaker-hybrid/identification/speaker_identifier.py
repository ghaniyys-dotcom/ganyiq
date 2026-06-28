#!/usr/bin/env python3
"""
speaker-identifier.py — GANYIQ Speaker Hybrid Module Orchestrator

THE CENTRAL CONDUCTOR that runs the full pipeline:
  1. Face Detection + Tracking    (hybrid-face-detector.py)
  2. Audio-Visual Matching        (audio-visual-matcher.py)
  3. Reaction Detection           (reaction-detector.py)
  4. Split Decision               (split-decision-engine.py)

Usage:
  # Full pipeline (auto)
  python speaker-identifier.py --video sample.mp4 --output result.json

  # With existing face data (skip detection)
  python speaker-identifier.py --video sample.mp4 --faces face_data.json --output result.json

  # With audio diarization (from PyAnnote / Deepgram)
  python speaker-identifier.py --video sample.mp4 --diarization audio.json --output result.json

  # Visual-only (skip AVM if no audio)
  python speaker-identifier.py --video sample.mp4 --visual-only --output result.json
"""

import argparse
import json
import os
import sys
import time
from pathlib import Path

# ── Add project root to sys.path so sibling packages resolve ──
_PROJECT_ROOT = str(Path(__file__).resolve().parent.parent)
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)

# Now we can import using absolute module names
from hybrid_face_detector import process_video as run_face_detection
from identification.audio_visual_matcher import AudioVisualMatcher, AudioSegment, VisualFrame
from reaction.reaction_detector import analyze_reactions
from split.split_decision_engine import SplitDecisionEngine
from asd import compute_lip_energy


# =============================================================================
# Orchestrator
# =============================================================================

class SpeakerIdentifier:
    """
    Full pipeline orchestrator for the GANYIQ Speaker Hybrid Module.
    
    Coordinates:
      - Face detection (YOLOv8-face + MediaPipe)
      - Audio-Visual matching (if diarization provided)
      - Reaction analysis (facial expressions)
      - Split/layout decisions
    """

    def __init__(
        self,
        face_sample_rate: float = 10.0,
        avm_time_tolerance: float = 0.5,
        avm_min_overlap: float = 0.3,
        split_reaction_weight: float = 0.3,
        verbose: bool = True,
    ):
        self.face_sample_rate = face_sample_rate
        self.avm_time_tolerance = avm_time_tolerance
        self.avm_min_overlap = avm_min_overlap
        self.split_reaction_weight = split_reaction_weight
        self.verbose = verbose

    def log(self, msg: str):
        if self.verbose:
            print(f"[SpeakerIdentifier] {msg}", file=sys.stderr)

    # ── Public API ──────────────────────────────────────────────

    def process_video(
        self,
        video_path: str,
        diarization_path: str | None = None,
        face_data_path: str | None = None,
        visual_only: bool = False,
        output_path: str | None = None,
    ) -> dict:
        """
        Run the full speaker identification pipeline.

        Parameters
        ----------
        video_path : str
            Path to input video file.
        diarization_path : str, optional
            Path to audio diarization JSON (PyAnnote/Deepgram format).
        face_data_path : str, optional
            Path to pre-existing face detection JSON (skip step 1).
        visual_only : bool
            If True, skip audio-visual matching (no diarization needed).
        output_path : str, optional
            Path to write final result JSON.

        Returns
        -------
        dict — Full pipeline result with:
            - metadata (timing, durations)
            - speakers (identified speaker list)
            - timeline (unified visual + audio speaker segments)
            - reactions (per-frame + summary)
            - split_plan (scene-by-scene layout decisions)
        """
        t_start = time.time()

        # ──────────────────────────────────────────
        # STEP 1: Face Detection + Tracking
        # ──────────────────────────────────────────
        if face_data_path and os.path.exists(face_data_path):
            self.log(f"Loading pre-existing face data from {face_data_path}")
            with open(face_data_path) as f:
                visual_data = json.load(f)
        else:
            self.log("Running hybrid face detection...")
            temp_face_path = output_path + ".faces.tmp.json" if output_path else f"{video_path}.faces.json"

            try:
                run_face_detection(
                    video_path=video_path,
                    output_path=temp_face_path,
                    sample_rate=self.face_sample_rate,
                    conf_threshold=0.2,
                )
            except SystemExit as e:
                return self._error(f"Face detection failed (exit {e.code})", "detection_failure")
            except Exception as e:
                return self._error(f"Face detection error: {e}", "detection_error")

            if not os.path.exists(temp_face_path):
                return self._error("Face detection produced no output", "detection_empty")

            with open(temp_face_path) as f:
                visual_data = json.load(f)

        self.log(f"Face detection complete: {len(visual_data.get('timeline', []))} frames")

        # ──────────────────────────────────────────
        # STEP 2: Audio-Visual Matching
        # ──────────────────────────────────────────
        matched_timeline = None

        if visual_only or not diarization_path:
            self.log("Visual-only mode — skipping audio-visual matching")
            matched_timeline = self._face_timeline_to_speaker_timeline(visual_data)
        else:
            self.log("Loading audio diarization...")
            try:
                with open(diarization_path) as f:
                    diarization_raw = json.load(f)
            except (FileNotFoundError, json.JSONDecodeError) as e:
                return self._error(f"Cannot load diarization file: {e}", "diarization_error")

            self.log("Running audio-visual matching...")

            # Parse audio segments
            audio_segments_raw = diarization_raw.get("segments", diarization_raw.get("speakers", []))
            audio_segments: list[AudioSegment] = []
            if isinstance(audio_segments_raw, list) and len(audio_segments_raw) > 0:
                for seg in audio_segments_raw:
                    sid = str(seg.get("speaker", seg.get("speaker_id", seg.get("label", "unknown"))))
                    start = float(seg.get("start", seg.get("start_time", 0)))
                    end = float(seg.get("end", seg.get("end_time", start + 1)))
                    audio_segments.append(AudioSegment(speaker_id=sid, start=start, end=end))
                self.log(f"Parsed {len(audio_segments)} audio segments")
            else:
                self.log("No valid audio segments — falling back to visual-only")
                matched_timeline = self._face_timeline_to_speaker_timeline(visual_data)

            if not matched_timeline and audio_segments:
                visual_frames = self._build_visual_frames(visual_data)
                if not visual_frames:
                    self.log("No visual frames — using visual-only fallback")
                    matched_timeline = self._face_timeline_to_speaker_timeline(visual_data)
                else:
                    matcher = AudioVisualMatcher(
                        time_tolerance=self.avm_time_tolerance,
                        min_overlap=self.avm_min_overlap,
                    )

                    # ── Run Active Speaker Detection (lip-motion ASD) ──
                    self.log("Running active speaker detection (lip motion)...")
                    asd_timeline = compute_lip_energy(
                        temp_face_path, window_sec=0.5,
                        min_lip_threshold=0.02, fps=self.face_sample_rate,
                    )
                    asd_active = sum(
                        1 for e in asd_timeline if e["active_track_id"] >= 0
                    )
                    self.log(f"ASD: {asd_active}/{len(asd_timeline)} frames have active speaker")

                    matched_timeline = matcher.match(audio_segments, visual_frames)

                    # ── Build audio→visual speaker mapping (with ASD boost) ──
                    self.log("Building audio-visual speaker mapping (ASD boosted)...")
                    audio_visual_map = matcher.build_audio_visual_map(
                        audio_segments, visual_frames, asd_timeline=asd_timeline,
                    )
                    if audio_visual_map:
                        n_audio = len(set(audio_visual_map.values()))
                        self.log(
                            f"Mapped {len(audio_visual_map)} visual tracks "
                            f"to {n_audio} audio speakers"
                        )

                        # Remap face data in-place so downstream render uses
                        # stable audio speaker IDs, not fragmented track IDs
                        for entry in visual_data.get("timeline", []):
                            for face in entry.get("faces", []):
                                tid = str(face.get("track_id", -1))
                                if tid in audio_visual_map:
                                    face["speaker_id"] = audio_visual_map[tid]

                        # Remap matched_timeline visual_speakers
                        # speaker_X → extract track_id → map to audio speaker
                        def _remap_sid(sid: str) -> str:
                            if sid.startswith("speaker_"):
                                tid = sid.split("_", 1)[1]
                                return audio_visual_map.get(tid, sid)
                            return sid

                        for entry in matched_timeline:
                            old_visual = entry.get("visual_speakers", [])
                            new_visual = sorted(set(
                                _remap_sid(vs) for vs in old_visual
                            ))
                            # Strip any remaining unmapped visual-only IDs
                            # (their track had no audio overlap → noise)
                            new_visual = [
                                s for s in new_visual
                                if not s.startswith("speaker_")
                            ] or new_visual  # keep at least something
                            entry["visual_speakers"] = list(new_visual)
                            entry["matched_speakers"] = list(new_visual)

                        # WRITE remapped face data back to file
                        self.log("Writing remapped face data to disk...")
                        with open(temp_face_path, "w") as _f:
                            json.dump(visual_data, _f, indent=2, default=str)
                        self.log("Face data updated with audio speaker IDs")

        speaker_list = self._extract_speakers(matched_timeline)

        # ──────────────────────────────────────────
        # STEP 3: Reaction Detection
        # ──────────────────────────────────────────
        self.log("Analyzing facial reactions...")
        try:
            reaction_result = analyze_reactions(visual_data, fps=self.face_sample_rate)
            if reaction_result is None:
                reaction_result = {"reactions": [], "summary": {}}
        except Exception as e:
            self.log(f"Warning: reaction detection error: {e}")
            reaction_result = {"reactions": [], "summary": {}}

        self.log(f"Reactions detected: {len(reaction_result.get('reactions', []))}")

        # ──────────────────────────────────────────
        # STEP 4: Split Decision
        # ──────────────────────────────────────────
        self.log("Running split decision engine...")
        engine = SplitDecisionEngine(reaction_weight=self.split_reaction_weight)
        video_dur = visual_data.get("duration") or (matched_timeline[-1].get("end", 0) if matched_timeline else 0)

        result = engine.decide(
            speakers=speaker_list or [],
            reactions=reaction_result.get("reactions", []),
            video_duration=float(video_dur) if video_dur else None,
        )

        split_plan = {
            "scenes": [s.__dict__ if hasattr(s, '__dict__') else s for s in result.scenes],
            "total_duration_sec": round(result.total_duration_sec, 2),
            "layout_distribution": result.layout_distribution,
            "split_count": result.split_count,
            "warnings": result.warnings,
        }

        self.log(f"Split plan: {result.split_count} non-fullscreen segments")

        # ──────────────────────────────────────────
        # ASSEMBLE RESULT
        # ──────────────────────────────────────────
        t_elapsed = round(time.time() - t_start, 2)

        final_result = {
            "pipeline": "speaker-hybrid-v1",
            "elapsed_sec": t_elapsed,
            "video": {
                "path": video_path,
                "duration_sec": video_dur,
            },
            "speakers": speaker_list or [],
            "matched_timeline": matched_timeline or [],
            "reactions": {
                "per_frame": reaction_result.get("reactions", []),
                "summary": reaction_result.get("summary", {}),
            },
            "split_plan": split_plan,
            'face_data_summary': {
                'total_frames': len(visual_data.get('timeline', [])),
                'total_faces': sum(
                    len(frame.get('faces', []))
                    for frame in visual_data.get('timeline', [])
                ),
            },
            'asd': {
                'tracker': 'bytetrack_kalman',
                'total_frames': len(asd_timeline) if 'asd_timeline' in dir() and asd_timeline else 0,
                'active_frames': sum(
                    1 for e in (asd_timeline if 'asd_timeline' in dir() and asd_timeline else [])
                    if e.get('active_track_id', -1) >= 0
                ),
            },
        }

        if output_path:
            # Keep face data path for downstream rendering
            face_data_path = output_path + ".faces.tmp.json"
            if os.path.exists(face_data_path):
                final_result["face_data_path"] = face_data_path
                self.log(f"Face data preserved for rendering: {face_data_path}")
            else:
                final_result["face_data_path"] = None

            with open(output_path, "w") as f:
                json.dump(final_result, f, indent=2, default=str)
            self.log(f"Result written to {output_path}")

        return final_result

    def _error(self, msg: str, err_type: str) -> dict:
        self.log(f"ERROR: {msg}")
        return {"error": msg, "error_type": err_type}

    # ── Internal helpers ────────────────────────────────────────

    def _face_timeline_to_speaker_timeline(self, visual_data: dict) -> list[dict]:
        """Convert raw face timeline into unified speaker timeline segments."""
        timeline = visual_data.get("timeline", [])
        if not timeline:
            return []

        segments = []
        current = None

        for entry in timeline:
            t = entry.get("time", 0)
            faces = entry.get("faces", [])
            active_speakers = sorted(set(
                str(f.get("speaker_id", f.get("track_id", "unknown")))
                for f in faces
            ))

            speaker_key = ",".join(active_speakers) if active_speakers else "none"

            if current is None:
                current = {"start": t, "end": t, "audio_speaker": None,
                           "visual_speakers": active_speakers,
                           "speaker_key": speaker_key, "n_visual": len(active_speakers)}
            elif current["speaker_key"] != speaker_key:
                current["end"] = t
                current["duration"] = round(current["end"] - current["start"], 2)
                segments.append(current)
                current = {"start": t, "end": t, "audio_speaker": None,
                           "visual_speakers": active_speakers,
                           "speaker_key": speaker_key, "n_visual": len(active_speakers)}
            else:
                current["end"] = t

        if current and current not in segments:
            current["duration"] = round(current["end"] - current["start"], 2)
            segments.append(current)

        for seg in segments:
            if seg["visual_speakers"]:
                seg["primary_speaker"] = seg["visual_speakers"][0]
                if seg["n_visual"] == 1:
                    seg["audio_speaker"] = seg["visual_speakers"][0]

        return segments

    def _build_visual_frames(self, visual_data: dict) -> list:
        timeline = visual_data.get("timeline", [])
        return [VisualFrame(float(e["time"]), e.get("faces", [])) for e in timeline if e]

    def _extract_speakers(self, timeline: list[dict] | None) -> list[dict]:
        """Extract speaker identities, filtering false positives (< 3s)."""
        if not timeline:
            return []

        seen: dict[str, dict] = {}
        for entry in timeline:
            for sid in entry.get("visual_speakers", []):
                if sid not in seen:
                    seen[sid] = {"speaker_id": sid, "name": f"Speaker {sid}",
                                 "segments": [], "total_speaking": 0.0}
                seen[sid]["segments"].append({"start": entry.get("start", 0), "end": entry.get("end", 0)})

        for sid, sp in seen.items():
            merged = []
            for seg in sorted(sp["segments"], key=lambda x: x["start"]):
                if merged and seg["start"] <= merged[-1]["end"] + 0.5:
                    merged[-1]["end"] = max(merged[-1]["end"], seg["end"])
                else:
                    merged.append(dict(seg))
            sp["segments"] = merged
            sp["total_speaking"] = round(sum(s["end"] - s["start"] for s in merged), 2)

        # Filter: remove speakers visible < 3 seconds (false positives)
        filtered = [s for s in seen.values() if s["total_speaking"] >= 3.0]
        removed = len(seen) - len(filtered)
        if removed > 0:
            self.log(f"Filtered {removed} false positive speakers (< 3s)")
        return filtered


# =============================================================================
# CLI
# =============================================================================

def main():
    parser = argparse.ArgumentParser(
        description="GANYIQ Speaker Hybrid Module — Full Pipeline Orchestrator"
    )
    parser.add_argument("--video", required=True, help="Path to input video file")
    parser.add_argument("--output", "-o", help="Path to output JSON result")
    parser.add_argument("--diarization", help="Path to audio diarization JSON (PyAnnote/Deepgram)")
    parser.add_argument("--faces", help="Path to pre-existing face detection JSON (skip detection)")
    parser.add_argument("--visual-only", action="store_true", help="Skip audio-visual matching")
    parser.add_argument("--sample-rate", type=float, default=10.0, help="Face detection sample rate (fps)")
    parser.add_argument("--split-weight", type=float, default=0.3, help="Reaction weight for split decisions")
    parser.add_argument("--quiet", action="store_true", help="Suppress progress logs")

    args = parser.parse_args()

    if not os.path.exists(args.video):
        print(json.dumps({"error": f"Video not found: {args.video}"}))
        sys.exit(1)

    identifier = SpeakerIdentifier(
        face_sample_rate=args.sample_rate,
        split_reaction_weight=args.split_weight,
        verbose=not args.quiet,
    )

    result = identifier.process_video(
        video_path=args.video,
        diarization_path=args.diarization,
        face_data_path=args.faces,
        visual_only=args.visual_only,
        output_path=args.output,
    )

    if args.output:
        print(f"Done. Result: {args.output}")
    else:
        print(json.dumps(result, indent=2, default=str))


if __name__ == "__main__":
    main()
