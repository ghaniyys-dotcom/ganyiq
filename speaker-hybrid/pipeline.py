#!/usr/bin/env python3
"""
pipeline.py — GANYIQ Speaker Hybrid Full Pipeline

One-command solution:
  python pipeline.py --video input.mp4 --output final.mp4

Does:
  1. Extract audio from video
  2. Speaker diarization (who speaks when)
  3. Face detection + tracking (YOLOv8 + MediaPipe)
  4. Audio-visual matching (link audio ↔ visual speakers)
  5. Reaction detection (expressions)
  6. Split decision (layout per scene)
  7. Render output video with dynamic layouts

Dependencies:
  pip install scipy scikit-learn opencv-python mediapipe onnxruntime
  ffmpeg must be in PATH
"""

import argparse
import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path


def log(msg: str):
    print(f"[PIPELINE] {msg}", file=sys.stderr, flush=True)


def run_cmd(cmd: list[str], desc: str = "", timeout: int = 600) -> str:
    """Run a shell command and return stdout."""
    if desc:
        log(desc)
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    if result.returncode != 0:
        log(f"ERROR: {desc or ' '.join(cmd)}")
        log(f"  stderr: {result.stderr[:500]}")
        raise RuntimeError(f"Command failed: {desc or ' '.join(cmd)[:100]}")
    return result.stdout


class Pipeline:
    """End-to-end GANYIQ Speaker Hybrid Pipeline."""

    def __init__(self, video_path: str, output_path: str, work_dir: str | None = None):
        self.video_path = Path(video_path).resolve()
        self.output_path = Path(output_path).resolve()
        self.work_dir = Path(work_dir or tempfile.mkdtemp(prefix="ganyiq_")).resolve()
        self.work_dir.mkdir(parents=True, exist_ok=True)

        # Temp files
        self.audio_path = self.work_dir / "audio.wav"
        self.diarization_path = self.work_dir / "diarization.json"
        self.face_data_path = self.work_dir / "face_data.json"
        self.result_path = self.work_dir / "analysis_result.json"

    def run(self):
        """Execute the full pipeline."""
        t_start = time.time()
        self.work_dir.mkdir(parents=True, exist_ok=True)

        # ─────────────────────────────────────
        # Step 1: Extract Audio
        # ─────────────────────────────────────
        log(f"Extracting audio to {self.audio_path}")
        run_cmd([
            "ffmpeg", "-y", "-i", str(self.video_path),
            "-vn", "-ar", "16000", "-ac", "1",
            str(self.audio_path)
        ], "Extracting audio...")

        # ─────────────────────────────────────
        # Step 2: Speaker Diarization
        # ─────────────────────────────────────
        log("Running diarization...")
        try:
            # Try importing diarize module directly for speed
            sys.path.insert(0, str(Path.cwd()))
            from diarize import main as run_diarization
        except ImportError:
            # Fall back to subprocess
            run_cmd([
                sys.executable, "diarize.py",
                str(self.audio_path), str(self.diarization_path)
            ], "Running diarization (subprocess)...")
        else:
            # Run diarization as a script call
            import argparse as ap
            diarize_args = ap.Namespace(
                audio=str(self.audio_path),
                output_json=str(self.diarization_path),
                hf_token=None,
                num_speakers=None,
                min_speakers=None,
                max_speakers=None,
            )
            try:
                from diarize import main as diarize_main
                # Can't easily call it since it uses argparse, so fallback to subprocess
                run_cmd([
                    sys.executable, "diarize.py",
                    str(self.audio_path), str(self.diarization_path)
                ], "Running diarization...")
            except:
                run_cmd([
                    sys.executable, "diarize.py",
                    str(self.audio_path), str(self.diarization_path)
                ], "Running diarization...")

        # Check if diarization produced useful segments
        with open(self.diarization_path) as f:
            diar_data = json.load(f)
        n_speakers = diar_data.get("metadata", {}).get("num_speakers", 0)
        n_segments = len(diar_data.get("segments", []))
        log(f"Diarization: {n_speakers} speakers, {n_segments} segments")

        # ─────────────────────────────────────
        # Step 3: Speaker Identifier (face + AVM + reaction + split)
        # ─────────────────────────────────────
        log("Running speaker identification...")
        speaker_id_script = Path(__file__).parent / "identification" / "speaker_identifier.py"
        if not speaker_id_script.exists():
            speaker_id_script = Path.cwd() / "speaker-hybrid" / "identification" / "speaker_identifier.py"
            if not speaker_id_script.exists():
                speaker_id_script = Path.cwd() / "identification" / "speaker_identifier.py"

        run_cmd([
            sys.executable, str(speaker_id_script),
            "--video", str(self.video_path),
            "--diarization", str(self.diarization_path),
            "--output", str(self.result_path),
        ], "Running face detection + AVM + reaction + split...")

        with open(self.result_path) as f:
            result = json.load(f)

        log(f"Analysis complete: {len(result.get('speakers', []))} speakers, "
            f"{len(result.get('split_plan', {}).get('scenes', []))} scenes")

        # ─────────────────────────────────────
        # Step 4: Render Output Video
        # ─────────────────────────────────────
        log("Rendering output video...")
        self._render(result)

        # Cleanup temp files
        for f in [self.audio_path, self.diarization_path, self.face_data_path]:
            if f.exists():
                f.unlink()

        t_elapsed = time.time() - t_start
        log(f"Pipeline complete in {t_elapsed:.1f}s → {self.output_path}")

        # Print scene summary to stderr
        scenes = result.get("split_plan", {}).get("scenes", [])
        print(f"\n{'='*50}", file=sys.stderr)
        print(f"SPLIT PLAN — {len(scenes)} scenes", file=sys.stderr)
        print(f"{'='*50}", file=sys.stderr)
        for s in scenes:
            layout_icon = {"fullscreen": "⬜", "split_screen": "⬛", "pip": "🔄", "side_by_side": "⬜⬜"}.get(s["layout"], "❓")
            print(f"  {layout_icon} {s['start_sec']:6.1f}s-{s['end_sec']:6.1f}s  {s['layout']:15s} [{s['confidence']:.2f}]", file=sys.stderr)
        print(f"{'='*50}\n", file=sys.stderr)

        return result

    def _render(self, result: dict):
        """Render the output video with dynamic layouts using ffmpeg."""
        scenes = result.get("split_plan", {}).get("scenes", [])
        if not scenes:
            log("No scenes to render — copying input")
            run_cmd([
                "ffmpeg", "-y", "-i", str(self.video_path),
                "-c", "copy", str(self.output_path)
            ], "Copying input video...")
            return

        # Build concat file and segment clips
        concat_lines = []
        segment_files = []

        for i, scene in enumerate(scenes):
            seg_out = self.work_dir / f"seg_{i:04d}.mp4"
            segment_files.append(seg_out)

            start = max(0, scene["start_sec"])
            end = min(scene["end_sec"], start + 60)  # cap at 60s segments
            layout = scene["layout"]

            if layout == "fullscreen":
                # When no speaker is specified, show full frame
                # When primary speaker exists, attempt to crop around them
                run_cmd([
                    "ffmpeg", "-y", "-ss", str(start),
                    "-i", str(self.video_path),
                    "-t", str(end - start),
                    "-c:v", "libx264", "-preset", "fast",
                    "-crf", "22",
                    "-c:a", "aac",
                    str(seg_out)
                ], f"  Scene {i+1}/{len(scenes)}: fullscreen {start:.1f}s-{end:.1f}s")

            elif layout == "split_screen":
                # Show full frame (already has all speakers)
                run_cmd([
                    "ffmpeg", "-y", "-ss", str(start),
                    "-i", str(self.video_path),
                    "-t", str(end - start),
                    "-c:v", "libx264", "-preset", "fast",
                    "-crf", "22",
                    "-c:a", "aac",
                    str(seg_out)
                ], f"  Scene {i+1}/{len(scenes)}: split_screen {start:.1f}s-{end:.1f}s")

            elif layout in ("pip", "side_by_side"):
                # Same as split_screen for now (layout refinement later)
                run_cmd([
                    "ffmpeg", "-y", "-ss", str(start),
                    "-i", str(self.video_path),
                    "-t", str(end - start),
                    "-c:v", "libx264", "-preset", "fast",
                    "-crf", "22",
                    "-c:a", "aac",
                    str(seg_out)
                ], f"  Scene {i+1}/{len(scenes)}: {layout} {start:.1f}s-{end:.1f}s")

            # Write to concat file
            concat_lines.append(f"file '{seg_out.name}'")

        # Concat all segments
        concat_file = self.work_dir / "concat.txt"
        concat_file.write_text("\n".join(concat_lines))

        log(f"Concatenating {len(segment_files)} segments...")
        run_cmd([
            "ffmpeg", "-y", "-f", "concat", "-safe", "0",
            "-i", str(concat_file),
            "-c:v", "libx264", "-preset", "fast",
            "-c:a", "aac",
            str(self.output_path)
        ], "Rendering final output...")


def main():
    parser = argparse.ArgumentParser(description="GANYIQ Speaker Hybrid Pipeline")
    parser.add_argument("--video", required=True, help="Input video path")
    parser.add_argument("--output", "-o", default="output.mp4", help="Output video path")
    parser.add_argument("--work-dir", help="Working directory (auto temp if not set)")
    args = parser.parse_args()

    if not os.path.exists(args.video):
        print(f"Error: video not found: {args.video}")
        sys.exit(1)

    pipeline = Pipeline(args.video, args.output, args.work_dir)
    try:
        result = pipeline.run()
        print(json.dumps({
            "status": "success",
            "output": str(pipeline.output_path),
            "speakers": len(result.get("speakers", [])),
            "scenes": len(result.get("split_plan", {}).get("scenes", [])),
        }, indent=2))
    except Exception as e:
        print(json.dumps({"status": "error", "message": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
