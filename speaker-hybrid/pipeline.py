#!/usr/bin/env python3
"""
pipeline.py — GANYIQ Speaker Hybrid Full Pipeline

One-command solution:
  python pipeline.py --video input.mp4 --output final.mp4
  python pipeline.py --video input.mp4 --output final.mp4 --vertical  # 9:16 shorts
"""

import argparse
import json
import os
import subprocess
import sys
import tempfile
import time
import platform
from pathlib import Path

from core.logger import log
from core.render_utils import CameraSmoother, build_crop_filter, build_split_filter, build_two_shot_filter
from core.id_bridge import load_face_data, build_id_bridge, get_speaker_bbox
from utils.env_utils import load_env_vars
from config import audio as AUDIO, render as RENDER

# Load .env.local
load_env_vars(Path(__file__).resolve().parent.parent / ".env.local")

# Force parent directory into sys.path to resolve sibling modules
_PROJECT_ROOT = str(Path(__file__).resolve().parent.parent)
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)

# director.py is in the same folder as pipeline.py, so add that dir to path
_SELF_DIR = str(Path(__file__).resolve().parent)
if _SELF_DIR not in sys.path:
    sys.path.insert(0, _SELF_DIR)

from director import DirectorAI

log("PIPELINE", "Script started")


def _resolve_ffmpeg(cmd: list[str]) -> list[str]:
    """Replace bare 'ffmpeg'/'ffprobe' with full path from FFMPEG_LOCATION env."""
    if not cmd:
        return cmd
    loc = os.environ.get('FFMPEG_LOCATION', '').strip()
    if not loc:
        return cmd
    exe = cmd[0]
    if exe not in ('ffmpeg', 'ffprobe'):
        return cmd
    full = os.path.join(loc, exe + ('.exe' if sys.platform == 'win32' else ''))
    if not os.path.isfile(full):
        full = loc if loc.endswith(exe) else os.path.join(loc, exe)
    cmd[0] = full
    return cmd


def run_cmd(cmd: list[str], desc: str = "", timeout: int = 600) -> str:
    """Run a shell command and return stdout."""
    cmd = _resolve_ffmpeg(cmd)
    if desc:
        log("PIPELINE", desc)
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    for line in result.stderr.splitlines():
        log("PIPELINE", f"  | {line}")
    if result.returncode != 0:
        log("PIPELINE", f"ERROR: {desc or ' '.join(cmd)}")
        raise RuntimeError(f"Command failed: {desc or ' '.join(cmd)[:100]}")
    return result.stdout

class Pipeline:
    """Pipeline for orchestrating face detection and video rendering."""
    def __init__(self, video_path: str, output_path: str,
                 work_dir: str | None = None, vertical: bool = False,
                 debug_mode: bool = False):
        self.video_path = Path(video_path).resolve()
        self.output_path = Path(output_path).resolve()
        self.work_dir = Path(work_dir or tempfile.mkdtemp(prefix="ganyiq_")).resolve()
        self.work_dir.mkdir(parents=True, exist_ok=True)
        self.vertical = vertical
        self.debug_mode = debug_mode
        self.debug_log_path = self.work_dir / "debug.log" if debug_mode else None
        self.debug_fontfile = ""
        if debug_mode and platform.system() == "Windows":
            for cand in ["C:/Windows/Fonts/arial.ttf", "C:/Windows/Fonts/segoeui.ttf", "C:/Windows/Fonts/calibri.ttf"]:
                if os.path.exists(cand):
                    self.debug_fontfile = cand
                    break
        self.audio_path = self.work_dir / "audio.wav"
        self.diarization_path = self.work_dir / "diarization.json"
        self.result_path = self.work_dir / "analysis_result.json"
        self.cam = CameraSmoother(alpha=0.2)

    def run(self) -> dict:
        """Execute the full pipeline."""
        t_start = time.time()
        
        # Steps 1, 2, 3 are the same
        log("PIPELINE", f"Extracting audio to {self.audio_path}")
        run_cmd(["ffmpeg", "-y", "-i", str(self.video_path), "-vn",
                 "-ar", str(AUDIO.SAMPLE_RATE), "-ac", str(AUDIO.CHANNELS),
                 str(self.audio_path)], "Extracting audio...")

        log("PIPELINE", "Running diarization...")
        diarize_script = Path(__file__).resolve().parent.parent / "diarize.py"
        run_cmd([sys.executable, str(diarize_script), str(self.audio_path), str(self.diarization_path)], "Running diarization...")
        
        log("PIPELINE", "Running speaker identification...")
        speaker_id_script = Path(__file__).parent / "identification" / "speaker_identifier.py"
        run_cmd([sys.executable, str(speaker_id_script), "--video", str(self.video_path), "--diarization", str(self.diarization_path), "--output", str(self.result_path)], "Running face detection + AVM...")

        with open(self.result_path) as f:
            result = json.load(f)

        log("PIPELINE", f"Analysis complete: {len(result.get('speakers', []))} speakers, {len(result.get('split_plan', {}).get('scenes', []))} scenes")

        # Step 4: Render from shot list
        log("PIPELINE", "Rendering output video...")
        self._render_from_shot_list(result)

        # Cleanup
        face_data_path = result.get("face_data_path")
        if face_data_path and os.path.exists(face_data_path):
            os.remove(face_data_path)
        for f in [self.audio_path, self.diarization_path]:
            if f.exists(): f.unlink()

        t_elapsed = time.time() - t_start
        log("PIPELINE", f"Pipeline complete in {t_elapsed:.1f}s → {self.output_path}")

        # Print final plan
        scenes = result.get("split_plan", {}).get("scenes", [])
        print(f"\n{'='*50}", file=sys.stderr)
        print(f"DIRECTOR'S CUT — {len(scenes)} shots", file=sys.stderr)
        print(f"{'='*50}", file=sys.stderr)
        for s in scenes:
            layout = s['layout']
            icon = "⬛" if layout == 'split_screen' else "⬜"
            primary = s['primary_target_id']
            secondary = s['secondary_target_id']
            targets = f"P:{primary}" + (f" S:{secondary}" if secondary else "")
            print(f"  {icon} {s['start_time']:6.1f}s-{s['end_time']:6.1f}s  {layout:15s} ({targets})", file=sys.stderr)
        print(f"{'='*50}\n", file=sys.stderr)

        return result

    def _build_debug_overlay(self, bbox, bbox_secondary, crop_x, crop_y, crop_w, crop_h, frame_w, frame_h, scene_num, layout, speaker_id) -> str:
        # ... (same as before)
        return ""

    def _render_from_shot_list(self, result: dict) -> None:
        """Renders video from a DirectorAI shot list."""
        shot_list = result.get("split_plan", {}).get("scenes", [])
        if not shot_list:
            log("PIPELINE", "No shots to render, copying input.")
            run_cmd(["ffmpeg", "-y", "-i", str(self.video_path), "-c", "copy", str(self.output_path)], "Copying video...")
            return

        probe = run_cmd(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", str(self.video_path)])
        dims = probe.strip().split(',')
        frame_w, frame_h = (int(dims[0]), int(dims[1])) if len(dims) == 2 else (1280, 720)
        out_w, out_h = (1080, 1920) if self.vertical else (frame_w, frame_h)
        log("PIPELINE", f"Output: {out_w}x{out_h}")

        face_data = load_face_data(result)
        id_bridge = build_id_bridge(face_data)
        
        segment_files = []
        for i, shot in enumerate(shot_list):
            seg_out = self.work_dir / f"seg_{i:04d}.mp4"
            segment_files.append(str(seg_out))

            start = float(shot['start_time'])
            dur = float(shot['end_time']) - start
            if dur <= 0.1: continue

            layout = shot['layout']
            primary_id = shot['primary_target_id']
            secondary_id = shot['secondary_target_id']

            bbox_primary = get_speaker_bbox(face_data, id_bridge, primary_id, start, start + dur, frame_w, frame_h) if face_data and primary_id else None
            bbox_secondary = get_speaker_bbox(face_data, id_bridge, secondary_id, start, start + dur, frame_w, frame_h) if face_data and secondary_id else None
            
            # Anti-Nyangsang Safety Net
            if layout == 'split_screen' and not (bbox_primary and bbox_secondary):
                layout = 'fullscreen'
                log("PIPELINE", f"  [RENDER-WARN] Shot {i+1} fallback to fullscreen (missing target)")

            if layout == 'two_shot_wide' and not (bbox_primary and bbox_secondary):
                layout = 'fullscreen'
                log("PIPELINE", f"  [RENDER-WARN] Shot {i+1} fallback to fullscreen (missing target for two-shot)")

            # FASE-19: Overlap safety — if both bboxes overlap >60%, skip split
            if layout == 'split_screen' and bbox_primary and bbox_secondary:
                _a = bbox_primary; _b = bbox_secondary
                _ax1, _ax2 = _a['cx'] - _a['w']/2, _a['cx'] + _a['w']/2
                _ay1, _ay2 = _a['cy'] - _a['h']/2, _a['cy'] + _a['h']/2
                _bx1, _bx2 = _b['cx'] - _b['w']/2, _b['cx'] + _b['w']/2
                _by1, _by2 = _b['cy'] - _b['h']/2, _b['cy'] + _b['h']/2
                _ix1 = max(_ax1, _bx1); _ix2 = min(_ax2, _bx2)
                _iy1 = max(_ay1, _by1); _iy2 = min(_ay2, _by2)
                _inter = max(0.0, _ix2 - _ix1) * max(0.0, _iy2 - _iy1)
                _min_area = min(_a['w'] * _a['h'], _b['w'] * _b['h'])
                if _min_area > 0 and (_inter / _min_area) > 0.6:
                    layout = 'fullscreen'
                    log("PIPELINE", f"  [RENDER-WARN] Shot {i+1} fallback to fullscreen (bbox overlap {_inter/_min_area:.0%})")

            vf = ""
            if self.vertical:
                if layout == 'split_screen':
                    vf = build_split_filter(bbox_primary, bbox_secondary, frame_w, frame_h, out_w, out_h)
                elif layout == 'two_shot_wide':
                    vf = build_two_shot_filter(bbox_primary, bbox_secondary, frame_w, frame_h, out_w, out_h)
                else:
                    bbox_to_track = bbox_primary or bbox_secondary
                    vf = build_crop_filter(bbox_to_track, frame_w, frame_h, out_w, out_h, self.vertical, "fullscreen")
            else:
                bbox_to_track = bbox_primary or bbox_secondary
                vf = build_crop_filter(bbox_to_track, frame_w, frame_h, out_w, out_h, self.vertical)

            debug_ov = ""
            if self.debug_mode:
                # ... debug overlay logic
                pass
            
            cmd = ["ffmpeg", "-y", "-ss", str(start), "-i", str(self.video_path), "-t", str(dur), "-sws_flags", "lanczos"]
            # Split screen → filter_complex (need [v] output mapping)
            if layout == 'split_screen':
                cmd += ["-filter_complex", vf,
                        "-map", "[v]", "-map", "0:a",
                        "-c:v", "libx264", "-preset", "medium", "-crf", "18"]
            else:
                cmd += ["-vf", vf,
                        "-c:v", "libx264", "-preset", "medium", "-crf", "18",
                        "-map", "0:v", "-map", "0:a"]
            cmd += ["-c:a", "aac", "-b:a", "128k",
                    "-avoid_negative_ts", "make_zero",
                    str(seg_out)]
            
            run_cmd(cmd, f"  Scene {i+1}/{len(shot_list)}: {layout} {start:.1f}s-{start+dur:.1f}s")

        # Concatenate segments (each has embedded audio, mapped directly)
        concat_path = self.work_dir / "concat.txt"
        with open(concat_path, "w") as f:
            for seg_file in segment_files:
                # Use forward slashes in concat file for ffmpeg compat
                norm = str(seg_file).replace("\\", "/")
                f.write(f"file '{norm}'\n")
        
        final_cmd = [
            "ffmpeg", "-y",
            "-f", "concat", "-safe", "0",
            "-i", str(concat_path),
            "-c", "copy",
            "-movflags", "+faststart",
            str(self.output_path)
        ]
        run_cmd(final_cmd, "Merging segments into final video...")

def main() -> None:
    parser = argparse.ArgumentParser(description="GANYIQ Speaker Hybrid Pipeline")
    parser.add_argument("--video", required=True, help="Path to input video")
    parser.add_argument("--output", required=True, help="Path to output video")
    parser.add_argument("--work-dir", help="Working directory for temp files")
    parser.add_argument("--vertical", action="store_true", help="Output 9:16 vertical video")
    parser.add_argument("--debug", action="store_true", help="Enable debug mode overlays")
    args = parser.parse_args()
    pipeline = Pipeline(
        video_path=args.video,
        output_path=args.output,
        work_dir=args.work_dir,
        vertical=args.vertical,
        debug_mode=args.debug,
    )
    pipeline.run()

if __name__ == "__main__":
    main()
