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

# Load .env.local for Deepgram key and other env vars
_env_local = Path(__file__).resolve().parent.parent / ".env.local"
if _env_local.exists():
    with open(_env_local) as _f:
        for _line in _f:
            _line = _line.strip()
            if _line and not _line.startswith("#") and "=" in _line:
                _k, _v = _line.split("=", 1)
                os.environ.setdefault(_k.strip(), _v.strip())

# Force parent directory into sys.path to resolve sibling modules
_PROJECT_ROOT = str(Path(__file__).resolve().parent.parent)
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)

# director.py is in the same folder as pipeline.py, so add that dir to path
_SELF_DIR = str(Path(__file__).resolve().parent)
if _SELF_DIR not in sys.path:
    sys.path.insert(0, _SELF_DIR)

from director import DirectorAI

print("--- PIPELINE SCRIPT STARTED ---", file=sys.stderr) # DEBUG


def log(msg: str):
    print(f"[PIPELINE] {msg}", file=sys.stderr, flush=True)

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
    # loc can be directory or full path to binary
    full = os.path.join(loc, exe + ('.exe' if sys.platform == 'win32' else ''))
    if not os.path.isfile(full):
        full = loc if loc.endswith(exe) else os.path.join(loc, exe)
    cmd[0] = full
    return cmd

def run_cmd(cmd: list[str], desc: str = "", timeout: int = 600) -> str:
    """Run a shell command and return stdout."""
    cmd = _resolve_ffmpeg(cmd)
    if desc:
        log(desc)
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    for line in result.stderr.splitlines():
        log(f"  | {line}")
    if result.returncode != 0:
        log(f"ERROR: {desc or ' '.join(cmd)}")
        raise RuntimeError(f"Command failed: {desc or ' '.join(cmd)[:100]}")
    return result.stdout

class CameraSmoother:
    """Exponential moving average for smooth camera pan (FASE 13)."""
    def __init__(self, alpha=0.2):
        self.alpha = alpha
        self.reset()
    def reset(self):
        self._cx = None
        self._cy = None
    def smooth(self, cx, cy):
        if self._cx is None:
            self._cx, self._cy = cx, cy
        else:
            self._cx = self._cx * (1 - self.alpha) + cx * self.alpha
            self._cy = self._cy * (1 - self.alpha) + cy * self.alpha
        return self._cx, self._cy


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

    def run(self):
        """Execute the full pipeline."""
        t_start = time.time()
        
        # Steps 1, 2, 3 are the same
        log(f"Extracting audio to {self.audio_path}")
        run_cmd(["ffmpeg", "-y", "-i", str(self.video_path), "-vn", "-ar", "16000", "-ac", "1", str(self.audio_path)], "Extracting audio...")

        log("Running diarization...")
        diarize_script = Path(__file__).resolve().parent.parent / "diarize.py"
        run_cmd([sys.executable, str(diarize_script), str(self.audio_path), str(self.diarization_path)], "Running diarization...")
        
        log("Running speaker identification...")
        speaker_id_script = Path(__file__).parent / "identification" / "speaker_identifier.py"
        run_cmd([sys.executable, str(speaker_id_script), "--video", str(self.video_path), "--diarization", str(self.diarization_path), "--output", str(self.result_path)], "Running face detection + AVM...")

        with open(self.result_path) as f:
            result = json.load(f)

        log(f"Analysis complete: {len(result.get('speakers', []))} speakers, {len(result.get('split_plan', {}).get('scenes', []))} scenes")

        # Step 4: Render from shot list
        log("Rendering output video...")
        self._render_from_shot_list(result)

        # Cleanup
        face_data_path = result.get("face_data_path")
        if face_data_path and os.path.exists(face_data_path):
            os.remove(face_data_path)
        for f in [self.audio_path, self.diarization_path]:
            if f.exists(): f.unlink()

        t_elapsed = time.time() - t_start
        log(f"Pipeline complete in {t_elapsed:.1f}s → {self.output_path}")

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

    def _load_face_data(self, result: dict) -> dict | None:
        face_path = result.get("face_data_path")
        if face_path and os.path.exists(face_path):
            with open(face_path) as f: return json.load(f)
        return None

    def _build_id_bridge(self, face_data: dict) -> dict:
        """Create a mapping from any ID (track, person, speaker) to a canonical ID."""
        if not face_data or "timeline" not in face_data:
            return {}
            
        id_map = {} # From any ID to a canonical ID
        person_to_canonical = {} # Map person_id to a canonical ID

        for entry in face_data.get("timeline", []):
            for face in entry.get("faces", []):
                
                # Use speaker_id as the most reliable canonical ID if present
                canonical_id = face.get("speaker_id")
                
                # Fallback to person_id if no speaker_id
                if not canonical_id and face.get("person_id"):
                    pid = face.get("person_id")
                    if pid in person_to_canonical:
                        canonical_id = person_to_canonical[pid]
                    else:
                        # Create a new canonical from person_id
                        canonical_id = f"person_{pid}"
                        person_to_canonical[pid] = canonical_id
                
                # Fallback to track_id if neither is present
                if not canonical_id and face.get("track_id"):
                    canonical_id = f"track_{face.get('track_id')}"

                if canonical_id:
                    # Map all available IDs for this face to the canonical ID
                    if face.get("speaker_id"):
                        id_map[face.get("speaker_id").upper()] = canonical_id
                    if face.get("person_id"):
                        pid = face.get("person_id")
                        id_map[f"person_{pid}"] = canonical_id
                        person_to_canonical[pid] = canonical_id  # Ensure ANY later face with same person_id bridges here
                    if face.get("track_id"):
                        id_map[f"track_{face.get('track_id')}"] = canonical_id
        
        # Second pass to ensure all aliases point to the final canonical
        for alias, canon in id_map.items():
            if canon in id_map and id_map[canon] != canon:
                id_map[alias] = id_map[canon]

        return id_map

    def _get_speaker_bbox(self, face_data: dict, id_bridge: dict, target_id: str, start: float, end: float, frame_w: int, frame_h: int) -> dict | None:
        """Finds a target's face BBox using the ID bridge."""
        if not target_id or not face_data: return None
        
        canonical_id = id_bridge.get(target_id.upper())
        if not canonical_id:
            # Fallback for IDs that might not be in the bridge (e.g. old formats)
            canonical_id = target_id

        # 1. Direct search using canonical ID
        for entry in face_data.get("timeline", []):
            t = entry.get("time", 0)
            if not (start - 0.2 <= t <= end + 0.2): continue
            
            for face in entry.get("faces", []):
                # Check all possible IDs against the canonical ID
                face_sid = face.get("speaker_id")
                face_pid = f"person_{face.get('person_id')}" if face.get("person_id") else None
                face_tid = f"track_{face.get('track_id')}" if face.get("track_id") else None
                
                current_face_canon = None
                if face_sid: current_face_canon = id_bridge.get(face_sid.upper())
                elif face_pid: current_face_canon = id_bridge.get(face_pid)
                elif face_tid: current_face_canon = id_bridge.get(face_tid)

                if current_face_canon == canonical_id:
                    cx, cy, w, h = face.get("cx"), face.get("cy"), face.get("w"), face.get("h")
                    if cx and cy and w and h:
                        return {"cx": cx, "cy": cy, "w": w, "h": h}

        # 2. Fallback: search for the raw target_id case-insensitively
        target_upper = target_id.upper()
        for entry in face_data.get("timeline", []):
            t = entry.get("time", 0)
            if not (start - 0.2 <= t <= end + 0.2): continue
            for face in entry.get("faces", []):
                if face.get("speaker_id", "").upper() == target_upper:
                    cx, cy, w, h = face.get("cx"), face.get("cy"), face.get("w"), face.get("h")
                    if cx and cy and w and h:
                        log(f"  [BBOX-FALLBACK-1] Found '{target_id}' via raw uppercase match.")
                        return {"cx": cx, "cy": cy, "w": w, "h": h}

        # 3. Last resort: use the best (largest) face in the shot range
        candidates = []
        for entry in face_data.get("timeline", []):
            t = entry.get("time", 0)
            if not (start - 0.2 <= t <= end + 0.2): continue
            for face in entry.get("faces", []):
                cx, cy, w, h = face.get("cx"), face.get("cy"), face.get("w"), face.get("h")
                if cx and cy and w and h and w >= 15 and h >= 15:
                    candidates.append((w * h, cx, cy, w, h))
        
        if candidates:
            best = max(candidates, key=lambda x: x[0])
            log(f"  [BBOX-FALLBACK-2] Target '{target_id}' not found — using largest face in shot.")
            return {"cx": best[1], "cy": best[2], "w": best[3], "h": best[4]}
        
        log(f"  [BBOX-WARN] Target '{target_id}' not found in any cluster for {start:.1f}s-{end:.1f}s")
        return None



    def _build_crop_filter(self, bbox, frame_w, frame_h, out_w, out_h, vertical, layout):
        """Build ffmpeg crop filter: vertical=9:16 strip, landscape=head-and-shoulders."""
        _fscale = f"scale={out_w}:{out_h}:flags=lanczos,unsharp=3:3:0.5:3:3:0.0"
        if not bbox:
            vx = (frame_w - frame_h * 9 / 16) / 2 if vertical else 0
            return f"crop={frame_h*9/16:.0f}:{frame_h}:{vx:.0f}:0,{_fscale}" if vertical else _fscale
        if vertical:
            vw = frame_h * 9 / 16
            vx = max(0.0, min(bbox["cx"] - vw / 2, frame_w - vw))
            vy = max(0.0, min(bbox["cy"] - frame_h * 0.35, frame_h - frame_h * 0.15))
            return f"crop={vw:.0f}:{frame_h}:{vx:.0f}:0,{_fscale}"
        cw = min(frame_w, max(100, bbox["w"] * 4))
        ch = min(frame_h, max(100, bbox["h"] * 4))
        cx = max(0.0, min(bbox["cx"] - cw / 2, frame_w - cw))
        cy = max(0.0, min(bbox["cy"] - ch * 0.35, frame_h - ch))
        return f"crop={cw:.0f}:{ch:.0f}:{cx:.0f}:{cy:.0f},{_fscale}"

    @staticmethod
    def _build_split_filter(bbox_top, bbox_bottom, frame_w, frame_h, out_w, out_h):
        """Build filter_complex for split-screen vertical (9:16).
        Top half: crop around primary speaker → scale to 720x640
        Bottom half: crop around secondary speaker → scale to 720x640
        vstack → 720x1280
        """
        half_h = out_h // 2            # 640
        zoom_factor = 1.6
        crop_h = frame_h / zoom_factor
        crop_w = out_w * crop_h / half_h
        if crop_w >= frame_w * 0.98:
            crop_w = float(frame_w)
            crop_h = crop_w * half_h / out_w
        # Top
        if bbox_top:
            vx = max(0.0, min(bbox_top["cx"] - crop_w / 2, frame_w - crop_w))
            vy = max(0.0, min(bbox_top["cy"] - crop_h * 0.35, frame_h - crop_h))
        else:
            vx = (frame_w - crop_w) / 2
            vy = (frame_h - crop_h) / 2
        top = f"[0:v]crop={crop_w:.1f}:{crop_h:.1f}:{vx:.1f}:{vy:.1f},scale={out_w}:{half_h}[top]"
        # Bottom
        if bbox_bottom:
            vx_bot = max(0.0, min(bbox_bottom["cx"] - crop_w / 2, frame_w - crop_w))
            vy_bot = max(0.0, min(bbox_bottom["cy"] - crop_h * 0.35, frame_h - crop_h))
            bottom = f"[0:v]crop={crop_w:.1f}:{crop_h:.1f}:{vx_bot:.1f}:{vy_bot:.1f},scale={out_w}:{half_h}[bottom]"
        else:
            pad_h = half_h - int(out_w * 9 / 16)
            if pad_h > 0:
                top_pad = pad_h // 2
                bottom = f"[0:v]scale={out_w}:-1,pad={out_w}:{half_h}:(ow-iw)/2:{top_pad}:black[bottom]"
            else:
                bottom = f"[0:v]scale={out_w}:{half_h}[bottom]"
        return f"{top};{bottom};[top][bottom]vstack=inputs=2[v]"

    def _build_debug_overlay(self, bbox, bbox_secondary, crop_x, crop_y, crop_w, crop_h, frame_w, frame_h, scene_num, layout, speaker_id):
        # ... (same as before)
        return ""
    @staticmethod
    def _build_two_shot_filter(bbox_primary, bbox_secondary, frame_w, frame_h, out_w, out_h):
        """Build ffmpeg crop filter for two_shot_wide (9:16 aspect ratio).
        Frames both speakers in a single wide vertical shot by calculating
        a bounding box that spans both speakers.
        """
        _fscale = f"scale={out_w}:{out_h}:flags=lanczos,unsharp=3:3:0.5:3:3:0.0"
        if not bbox_primary and not bbox_secondary:
            vx = (frame_w - frame_h * 9 / 16) / 2
            return f"crop={frame_h*9/16:.0f}:{frame_h}:{vx:.0f}:0,{_fscale}"
            
        bbox1 = bbox_primary or bbox_secondary
        bbox2 = bbox_secondary or bbox_primary
        
        min_x = min(bbox1["cx"] - bbox1["w"]/2, bbox2["cx"] - bbox2["w"]/2)
        max_x = max(bbox1["cx"] + bbox1["w"]/2, bbox2["cx"] + bbox2["w"]/2)
        
        target_w = (max_x - min_x) + 160.0
        target_h = target_w * 16 / 9
        
        if target_h > frame_h:
            target_h = float(frame_h)
            target_w = target_h * 9 / 16
        
        mid_cx = (min_x + max_x) / 2
        vx = max(0.0, min(mid_cx - target_w / 2, frame_w - target_w))
        
        mid_cy = (bbox1["cy"] + bbox2["cy"]) / 2
        vy = max(0.0, min(mid_cy - target_h * 0.35, frame_h - target_h))
        
        return f"crop={target_w:.0f}:{target_h:.0f}:{vx:.0f}:{vy:.0f},{_fscale}"

    def _render_from_shot_list(self, result: dict):
        """Renders video from a DirectorAI shot list."""
        shot_list = result.get("split_plan", {}).get("scenes", [])
        if not shot_list:
            log("No shots to render, copying input.")
            run_cmd(["ffmpeg", "-y", "-i", str(self.video_path), "-c", "copy", str(self.output_path)], "Copying video...")
            return

        probe = run_cmd(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", str(self.video_path)])
        dims = probe.strip().split(',')
        frame_w, frame_h = (int(dims[0]), int(dims[1])) if len(dims) == 2 else (1280, 720)
        out_w, out_h = (1080, 1920) if self.vertical else (frame_w, frame_h)
        log(f"Output: {out_w}x{out_h}")

        face_data = self._load_face_data(result)
        id_bridge = self._build_id_bridge(face_data)
        
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

            bbox_primary = self._get_speaker_bbox(face_data, id_bridge, primary_id, start, start + dur, frame_w, frame_h) if face_data and primary_id else None
            bbox_secondary = self._get_speaker_bbox(face_data, id_bridge, secondary_id, start, start + dur, frame_w, frame_h) if face_data and secondary_id else None
            
            # Anti-Nyangsang Safety Net
            if layout == 'split_screen' and not (bbox_primary and bbox_secondary):
                layout = 'fullscreen'
                log(f"  [RENDER-WARN] Shot {i+1} fallback to fullscreen (missing target)")
            
            if layout == 'two_shot_wide' and not (bbox_primary and bbox_secondary):
                layout = 'fullscreen'
                log(f"  [RENDER-WARN] Shot {i+1} fallback to fullscreen (missing target for two-shot)")

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
                    log(f"  [RENDER-WARN] Shot {i+1} fallback to fullscreen (bbox overlap {_inter/_min_area:.0%})")

            vf = ""
            if self.vertical:
                if layout == 'split_screen':
                    vf = self._build_split_filter(bbox_primary, bbox_secondary, frame_w, frame_h, out_w, out_h)
                elif layout == 'two_shot_wide':
                    vf = self._build_two_shot_filter(bbox_primary, bbox_secondary, frame_w, frame_h, out_w, out_h)
                else:
                    bbox_to_track = bbox_primary or bbox_secondary
                    vf = self._build_crop_filter(bbox_to_track, frame_w, frame_h, out_w, out_h, self.vertical, "fullscreen")
            else:
                bbox_to_track = bbox_primary or bbox_secondary
                vf = self._build_crop_filter(bbox_to_track, frame_w, frame_h, out_w, out_h, self.vertical)

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

def main():
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
