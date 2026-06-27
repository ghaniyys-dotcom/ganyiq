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
        face_data_path = result.get("face_data_path")
        if face_data_path and os.path.exists(face_data_path):
            os.remove(face_data_path)
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

    # ── Face data helpers for layout rendering ──────────────────────

    def _load_face_data(self, result: dict) -> dict | None:
        """Load face detection data for crop coordinates."""
        face_path = result.get("face_data_path")
        if face_path and os.path.exists(face_path):
            with open(face_path) as f:
                return json.load(f)
        return None

    def _get_speaker_bbox(self, face_data: dict, speaker_id: str,
                          start: float, end: float) -> dict | None:
        """Average face bounding box for a speaker in [start, end] range.
        Returns {cx, cy, w, h} or None if speaker not found."""
        boxes = []
        for entry in face_data.get("timeline", []):
            t = entry.get("time", 0)
            if t < start - 0.2 or t > end + 0.2:
                continue
            for face in entry.get("faces", []):
                if face.get("speaker_id") == speaker_id:
                    boxes.append(face)

        if not boxes:
            return None
        return {
            "cx": sum(b["cx"] for b in boxes) / len(boxes),
            "cy": sum(b["cy"] for b in boxes) / len(boxes),
            "w":  sum(b["w"] for b in boxes) / len(boxes),
            "h":  sum(b["h"] for b in boxes) / len(boxes),
        }

    @staticmethod
    def _build_crop_filter(bbox: dict, frame_w: int, frame_h: int,
                           out_w: int, out_h: int) -> str:
        """Build ffmpeg crop+scale filter string for a face bounding box.
        Expands to head-and-shoulders framing, clamped to frame."""
        if not bbox:
            return f"scale={out_w}:{out_h}"

        # Raw expansion (before clamping)
        cw = bbox["w"] * 2.2
        ch = bbox["h"] * 3.2

        # If the raw expanded region already covers most of the frame,
        # the face is large enough — just scale instead of crop
        if cw >= frame_w * 0.85 and ch >= frame_h * 0.85:
            return f"scale={out_w}:{out_h}"

        # Clamp to frame dimensions
        cw = min(cw, frame_w)
        ch = min(ch, frame_h)
        cx = bbox["cx"] - cw / 2
        cy = bbox["cy"] - ch * 0.35  # shift up for headroom

        # Clamp position to stay within frame
        cx = max(0.0, cx)
        cy = max(0.0, cy)
        if cw < frame_w:
            cx = min(cx, frame_w - cw)
        if ch < frame_h:
            cy = min(cy, frame_h - ch)

        return f"crop={cw:.0f}:{ch:.0f}:{cx:.0f}:{cy:.0f},scale={out_w}:{out_h}"

    def _render(self, result: dict):
        """Render output video with per-layout ffmpeg filter complex."""
        scenes = result.get("split_plan", {}).get("scenes", [])
        if not scenes:
            log("No scenes to render — copying input")
            run_cmd([
                "ffmpeg", "-y", "-i", str(self.video_path),
                "-c", "copy", str(self.output_path)
            ], "Copying input video...")
            return

        # Detect frame size
        probe = subprocess.run([
            "ffprobe", "-v", "error",
            "-select_streams", "v:0",
            "-show_entries", "stream=width,height",
            "-of", "csv=p=0",
            str(self.video_path)
        ], capture_output=True, text=True, timeout=30)
        dims = probe.stdout.strip().split(",")
        frame_w, frame_h = (int(dims[0]), int(dims[1])) if len(dims) == 2 else (1280, 720)

        face_data = self._load_face_data(result)
        if face_data:
            n_frames = len(face_data.get("timeline", []))
            n_speakers_face = len(set(
                f.get("speaker_id") for e in face_data.get("timeline", [])
                for f in e.get("faces", []) if f.get("speaker_id")
            ))
            log(f"Face data loaded: {n_frames} frames, {n_speakers_face} speaker IDs")
        else:
            log("Face data NOT available — all scenes will be full frame")

        concat_lines = []
        segment_files = []

        for i, scene in enumerate(scenes):
            seg_out = self.work_dir / f"seg_{i:04d}.mp4"
            segment_files.append(seg_out)

            start = max(0.0, scene["start_sec"])
            dur = min(scene["end_sec"] - start, 60.0)
            layout = scene["layout"]
            speakers = scene.get("speakers_visible", [])
            primary = scene.get("primary_speaker")

            # ─── Build filter complex ────────────────────────────────────────

            if layout == "fullscreen":
                bbox = None
                if face_data and primary:
                    bbox = self._get_speaker_bbox(face_data, primary, start, start + dur)
                if bbox:
                    log(f"    Scene {i+1}: fullscreen crop to {primary} "
                        f"(bbox: cx={bbox['cx']:.0f} cy={bbox['cy']:.0f} "
                        f"w={bbox['w']:.0f} h={bbox['h']:.0f})")
                    vf = self._build_crop_filter(bbox, frame_w, frame_h, frame_w, frame_h)
                    run_cmd([
                        "ffmpeg", "-y", "-ss", f"{start:.2f}",
                        "-i", str(self.video_path),
                        "-t", f"{dur:.2f}",
                        "-vf", vf,
                        "-c:v", "libx264", "-preset", "fast", "-crf", "22",
                        "-c:a", "aac",
                        str(seg_out)
                    ], f"  Scene {i+1}/{len(scenes)}: fullscreen (crop→{primary}) {start:.1f}s-{start+dur:.1f}s")
                else:
                    run_cmd([
                        "ffmpeg", "-y", "-ss", f"{start:.2f}",
                        "-i", str(self.video_path),
                        "-t", f"{dur:.2f}",
                        "-c:v", "libx264", "-preset", "fast", "-crf", "22",
                        "-c:a", "aac",
                        str(seg_out)
                    ], f"  Scene {i+1}/{len(scenes)}: fullscreen (no face) {start:.1f}s-{start+dur:.1f}s")

            elif layout == "split_screen":
                if face_data and speakers:
                    # Build hstack from cropped per-speaker columns
                    filters = []
                    input_ref = "0:v"
                    n = min(len(speakers), 3)
                    col_w = frame_w // n
                    col_h = frame_h

                    for j, sid in enumerate(speakers[:n]):
                        bbox = self._get_speaker_bbox(face_data, sid, start, start + dur)
                        if bbox:
                            log(f"    Scene {i+1}: col{j} → {sid} "
                                f"(cx={bbox['cx']:.0f} cy={bbox['cy']:.0f} "
                                f"w={bbox['w']:.0f} h={bbox['h']:.0f})")
                            crop_filter = self._build_crop_filter(bbox, frame_w, frame_h, col_w, col_h)
                            filters.append(f"[{input_ref}]{crop_filter}[col{j}];")

                    if len(filters) >= 2:
                        # Use hstack to combine columns
                        cols_str = "".join(f"[col{j}]" for j in range(len(filters)))
                        vf = "".join(filters) + f"{cols_str}hstack=inputs={len(filters)},format=yuv420p"
                    elif len(filters) == 1:
                        # Single valid face — just crop to that speaker
                        vf = filters[0].replace(f"[{input_ref}]", "").replace(f";[col0]", "")
                        vf = vf.replace(";", "").replace(",format=yuv420p", "")
                    else:
                        vf = f"scale={frame_w}:{frame_h}"

                    run_cmd([
                        "ffmpeg", "-y", "-ss", f"{start:.2f}",
                        "-i", str(self.video_path),
                        "-t", f"{dur:.2f}",
                        "-filter_complex", vf,
                        "-c:v", "libx264", "-preset", "fast", "-crf", "22",
                        "-c:a", "aac",
                        str(seg_out)
                    ], f"  Scene {i+1}/{len(scenes)}: split_screen ({n} cols) {start:.1f}s-{start+dur:.1f}s")
                else:
                    run_cmd([
                        "ffmpeg", "-y", "-ss", f"{start:.2f}",
                        "-i", str(self.video_path),
                        "-t", f"{dur:.2f}",
                        "-c:v", "libx264", "-preset", "fast", "-crf", "22",
                        "-c:a", "aac",
                        str(seg_out)
                    ], f"  Scene {i+1}/{len(scenes)}: split_screen (no face) {start:.1f}s-{start+dur:.1f}s")

            elif layout in ("pip", "side_by_side"):
                if face_data and len(speakers) >= 2:
                    # side_by_side = 2 columns
                    bbox0 = self._get_speaker_bbox(face_data, speakers[0], start, start + dur)
                    bbox1 = self._get_speaker_bbox(face_data, speakers[1], start, start + dur)
                    col_w, col_h = frame_w // 2, frame_h
                    f0 = self._build_crop_filter(bbox0 or {}, frame_w, frame_h, col_w, col_h)
                    f1 = self._build_crop_filter(bbox1 or {}, frame_w, frame_h, col_w, col_h)

                    # If both are no-face fallbacks (scale only), skip filter_complex
                    if "scale" in f0 and "scale" in f1 and "crop" not in f0 and "crop" not in f1:
                        vf = f"scale={frame_w}:{frame_h}"
                    else:
                        vf = f"[0:v]{f0}[l];[0:v]{f1}[r];[l][r]hstack=inputs=2,format=yuv420p"

                    run_cmd([
                        "ffmpeg", "-y", "-ss", f"{start:.2f}",
                        "-i", str(self.video_path),
                        "-t", f"{dur:.2f}",
                        "-filter_complex", vf,
                        "-c:v", "libx264", "-preset", "fast", "-crf", "22",
                        "-c:a", "aac",
                        str(seg_out)
                    ], f"  Scene {i+1}/{len(scenes)}: {layout} {start:.1f}s-{start+dur:.1f}s")
                else:
                    # Fallback to fullframe
                    run_cmd([
                        "ffmpeg", "-y", "-ss", f"{start:.2f}",
                        "-i", str(self.video_path),
                        "-t", f"{dur:.2f}",
                        "-c:v", "libx264", "-preset", "fast", "-crf", "22",
                        "-c:a", "aac",
                        str(seg_out)
                    ], f"  Scene {i+1}/{len(scenes)}: {layout} (fallback) {start:.1f}s-{start+dur:.1f}s")

            concat_lines.append(f"file '{seg_out.as_posix()}'")

        # ─── Concat all segments ────────────────────────────────────────────────
        if len(segment_files) == 1:
            seg = segment_files[0]
            seg.rename(self.output_path)
            log(f"1 scene — copied directly to output")
        else:
            concat_file = self.work_dir / "concat.txt"
            concat_file.write_text("\n".join(concat_lines))
            log(f"Concatenating {len(segment_files)} segments...")
            run_cmd([
                "ffmpeg", "-y", "-f", "concat", "-safe", "0",
                "-i", str(concat_file),
                "-c", "copy",
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
