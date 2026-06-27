#!/usr/bin/env python3
"""
pipeline.py — GANYIQ Speaker Hybrid Full Pipeline

One-command solution:
  python pipeline.py --video input.mp4 --output final.mp4
  python pipeline.py --video input.mp4 --output final.mp4 --vertical  # 9:16 shorts

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

    def __init__(self, video_path: str, output_path: str,
                 work_dir: str | None = None, vertical: bool = False):
        self.video_path = Path(video_path).resolve()
        self.output_path = Path(output_path).resolve()
        self.work_dir = Path(work_dir or tempfile.mkdtemp(prefix="ganyiq_")).resolve()
        self.work_dir.mkdir(parents=True, exist_ok=True)
        self.vertical = vertical

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
            sys.path.insert(0, str(Path.cwd()))
            from diarize import main as run_diarization
        except ImportError:
            run_cmd([
                sys.executable, "diarize.py",
                str(self.audio_path), str(self.diarization_path)
            ], "Running diarization (subprocess)...")
        else:
            run_cmd([
                sys.executable, "diarize.py",
                str(self.audio_path), str(self.diarization_path)
            ], "Running diarization...")

        with open(self.diarization_path) as f:
            diar_data = json.load(f)
        n_speakers = diar_data.get("metadata", {}).get("num_speakers", 0)
        n_segments = len(diar_data.get("segments", []))
        log(f"Diarization: {n_speakers} speakers, {n_segments} segments")

        # ─────────────────────────────────────
        # Step 3: Speaker Identifier
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

        # Cleanup
        face_data_path = result.get("face_data_path")
        if face_data_path and os.path.exists(face_data_path):
            os.remove(face_data_path)
        for f in [self.audio_path, self.diarization_path, self.face_data_path]:
            if f.exists():
                f.unlink()

        t_elapsed = time.time() - t_start
        log(f"Pipeline complete in {t_elapsed:.1f}s → {self.output_path}")

        scenes = result.get("split_plan", {}).get("scenes", [])
        layout_icons = {"fullscreen": "⬜", "split_screen": "⬛",
                        "pip": "🔄", "side_by_side": "⬜⬜"}
        print(f"\n{'='*50}", file=sys.stderr)
        print(f"SPLIT PLAN — {len(scenes)} scenes", file=sys.stderr)
        print(f"{'='*50}", file=sys.stderr)
        for s in scenes:
            icon = layout_icons.get(s["layout"], "❓")
            print(f"  {icon} {s['start_sec']:6.1f}s-{s['end_sec']:6.1f}s  "
                  f"{s['layout']:15s} [{s['confidence']:.2f}]", file=sys.stderr)
        print(f"{'='*50}\n", file=sys.stderr)
        return result

    # ── Face data helpers ───────────────────────────────────────────

    def _load_face_data(self, result: dict) -> dict | None:
        face_path = result.get("face_data_path")
        if face_path and os.path.exists(face_path):
            with open(face_path) as f:
                return json.load(f)
        return None

    def _get_speaker_bbox(self, face_data: dict, speaker_id: str,
                          start: float, end: float,
                          frame_w: int = 1280, frame_h: int = 720) -> dict | None:
        """Average face bounding box for a speaker in [start, end] range.
        Returns {cx, cy, w, h} or None if no valid face found.
        Filters false-positive detections at frame edges.
        Falls back to best face in range if speaker_id not found."""
        boxes = []
        for entry in face_data.get("timeline", []):
            t = entry.get("time", 0)
            if t < start - 0.2 or t > end + 0.2:
                continue
            for face in entry.get("faces", []):
                if face.get("speaker_id") == speaker_id:
                    cx, cy = face.get("cx", 0), face.get("cy", 0)
                    if cx <= 10 or cy <= 10 or cx >= frame_w - 10 or cy >= frame_h - 10:
                        continue  # false positive at edge
                    boxes.append(face)

        if boxes:
            return {
                "cx": sum(b["cx"] for b in boxes) / len(boxes),
                "cy": sum(b["cy"] for b in boxes) / len(boxes),
                "w":  sum(b["w"] for b in boxes) / len(boxes),
                "h":  sum(b["h"] for b in boxes) / len(boxes),
            }

        # Fallback: best face in range (largest × most central)
        candidates = []
        for entry in face_data.get("timeline", []):
            t = entry.get("time", 0)
            if t < start - 0.2 or t > end + 0.2:
                continue
            for face in entry.get("faces", []):
                cx, cy = face.get("cx", 0), face.get("cy", 0)
                w, h = face.get("w", 0), face.get("h", 0)
                if cx <= 10 or cy <= 10 or cx >= frame_w - 10 or cy >= frame_h - 10:
                    continue
                if w < 30 or h < 30:
                    continue  # too small = noise
                dist = abs(cx - frame_w/2) + abs(cy - frame_h/2)
                score = (w * h) / max(dist, 1)
                candidates.append((score, cx, cy, w, h))

        if not candidates:
            return None
        best = max(candidates, key=lambda x: x[0])
        return {"cx": best[1], "cy": best[2], "w": best[3], "h": best[4]}

    @staticmethod
    def _build_crop_filter(bbox: dict | None, frame_w: int, frame_h: int,
                           out_w: int, out_h: int,
                           vertical: bool = False) -> str:
        """Build ffmpeg filter string.

        vertical: 9:16 strip centered on speaker's face, scale to out.
        landscape: head-and-shoulders crop (5x/4x expansion), scale to out.
        """
        if vertical:
            vw = frame_h * 9 / 16   # 405px for 720p input
            vh = float(frame_h)
            if bbox:
                vx = bbox["cx"] - vw / 2
            else:
                vx = (frame_w - vw) / 2  # center crop
            vx = max(0.0, min(vx, frame_w - vw))
            if vw >= frame_w * 0.98:
                return f"scale={out_w}:{out_h}"
            return f"crop={vw:.1f}:{vh:.1f}:{vx:.1f}:0,scale={out_w}:{out_h}"

        # ── Landscape: head-and-shoulders ──
        if not bbox:
            return f"scale={out_w}:{out_h}"
        cw = bbox["w"] * 5.0
        ch = bbox["h"] * 4.0
        if cw >= frame_w * 0.85 and ch >= frame_h * 0.85:
            return f"scale={out_w}:{out_h}"
        cw = min(cw, frame_w)
        ch = min(ch, frame_h)
        cx = bbox["cx"] - cw / 2
        cy = bbox["cy"] - ch * 0.275
        cx = max(0.0, cx)
        cy = max(0.0, cy)
        if cw < frame_w:
            cx = min(cx, frame_w - cw)
        if ch < frame_h:
            cy = min(cy, frame_h - ch)
        return f"crop={cw:.0f}:{ch:.0f}:{cx:.0f}:{cy:.0f},scale={out_w}:{out_h}"

    # ── Render ──────────────────────────────────────────────────────

    def _render(self, result: dict):
        """Render output video. In vertical mode produces 9:16 shorts."""
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

        out_w, out_h = (720, 1280) if self.vertical else (frame_w, frame_h)
        aspect = "9:16" if self.vertical else "16:9"
        log(f"Output: {out_w}x{out_h} ({aspect})")

        face_data = self._load_face_data(result)
        if face_data:
            n_frames = len(face_data.get("timeline", []))
            n_speakers_face = len(set(
                f.get("speaker_id") for e in face_data.get("timeline", [])
                for f in e.get("faces", []) if f.get("speaker_id")
            ))
            log(f"Face data loaded: {n_frames} frames, {n_speakers_face} speaker IDs")

            # Debug: sample first 3 frames to see face structure
            sample = face_data.get("timeline", [])[:3]
            for ei, entry in enumerate(sample):
                faces = entry.get("faces", [])
                for fi, face in enumerate(faces[:2]):
                    log(f"  face[{ei}][{fi}]: cx={face.get('cx')} cy={face.get('cy')} "
                        f"w={face.get('w')} h={face.get('h')} "
                        f"sid={face.get('speaker_id')} "
                        f"tid={face.get('track_id')}")
        else:
            log("Face data NOT available — all scenes will be center crop")

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

            # Target speaker: primary (if set) or first visible
            target_sid = primary or (speakers[0] if speakers else None)

            bbox = None
            if face_data:
                bbox = self._get_speaker_bbox(
                    face_data, target_sid or "",
                    start, start + dur,
                    frame_w=frame_w, frame_h=frame_h)

            if bbox:
                vf = self._build_crop_filter(
                    bbox, frame_w, frame_h, out_w, out_h, vertical=self.vertical)
                desc = f"crop to cx={bbox['cx']:.0f} cy={bbox['cy']:.0f}"
            else:
                vf = self._build_crop_filter(
                    None, frame_w, frame_h, out_w, out_h, vertical=self.vertical)
                desc = "center crop"

            log(f"    Scene {i+1}: {layout} ({desc}) {start:.1f}s-{start+dur:.1f}s")

            run_cmd([
                "ffmpeg", "-y", "-ss", f"{start:.2f}",
                "-i", str(self.video_path),
                "-t", f"{dur:.2f}",
                "-vf", vf,
                "-c:v", "libx264", "-preset", "fast", "-crf", "22",
                "-c:a", "aac",
                str(seg_out)
            ], f"  Scene {i+1}/{len(scenes)}: {layout} {start:.1f}s-{start+dur:.1f}s")

            concat_lines.append(f"file '{seg_out.as_posix()}'")

        # ─── Concat ─────────────────────────────────────────────────
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
    parser.add_argument("--output", "-o", default="output.mp4",
                        help="Output video path")
    parser.add_argument("--work-dir", help="Working directory (auto temp)")
    parser.add_argument("--vertical", "-v", action="store_true",
                        help="Output 9:16 vertical (shorts format)")
    args = parser.parse_args()

    if not os.path.exists(args.video):
        print(f"Error: video not found: {args.video}")
        sys.exit(1)

    pipeline = Pipeline(args.video, args.output, args.work_dir,
                        vertical=args.vertical)
    try:
        result = pipeline.run()
        print(json.dumps({
            "status": "success",
            "output": str(pipeline.output_path),
            "speakers": len(result.get("speakers", [])),
            "scenes": len(result.get("split_plan", {}).get("scenes", [])),
            "vertical": args.vertical,
        }, indent=2))
    except Exception as e:
        print(json.dumps({"status": "error", "message": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
