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
import platform
from pathlib import Path


def log(msg: str):
    print(f"[PIPELINE] {msg}", file=sys.stderr, flush=True)


def run_cmd(cmd: list[str], desc: str = "", timeout: int = 600) -> str:
    """Run a shell command and return stdout."""
    if desc:
        log(desc)
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    
    # Always print stderr (for diagnostics and progress logs)
    for line in result.stderr.splitlines():
        log(f"  | {line}")
    
    if result.returncode != 0:
        log(f"ERROR: {desc or ' '.join(cmd)}")
        raise RuntimeError(f"Command failed: {desc or ' '.join(cmd)[:100]}")
    return result.stdout


class Pipeline:
    """End-to-end GANYIQ Speaker Hybrid Pipeline."""

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

        # Windows: explicit fontfile for ffmpeg drawtext (no fontconfig)
        self.debug_fontfile = ""
        if debug_mode and platform.system() == "Windows":
            for cand in ["C:/Windows/Fonts/arial.ttf",
                         "C:/Windows/Fonts/segoeui.ttf",
                         "C:/Windows/Fonts/calibri.ttf"]:
                if os.path.exists(cand):
                    self.debug_fontfile = cand
                    break
        # Temp files
        self.audio_path = self.work_dir / "audio.wav"
        self.diarization_path = self.work_dir / "diarization.json"
        self.face_data_path = self.work_dir / "face_data.json"
        self.result_path = self.work_dir / "analysis_result.json"
        self.debug_log_path = self.work_dir / "debug.log" if debug_mode else None

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

        asd_info = result.get('asd', {})
        if asd_info:
            log(f"Tracker: {asd_info.get('tracker', '?')} | "
                f"ASD: {asd_info.get('active_frames', 0)}/"
                f"{asd_info.get('total_frames', 0)} frames lip-active")

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
        """Find speaker's face via CLUSTER selection — NOT naive averaging.

        ASD often assigns the same speaker_id to MULTIPLE physical faces
        (false-positive lip motion on listeners). Averaging across those
        produces a cx pointing at empty space between people.

        Instead: run face clustering on [start,end], pick the LARGEST
        cluster that contains this speaker_id.  This gives the actual
        position of the main person.

        Falls back to best face (largest × most central) if no match.
        """
        clusters = self._get_face_clusters(face_data, start, end,
                                           frame_w=frame_w, merge_dist=150)
        if clusters:
            sid = str(speaker_id) if speaker_id else None
            # Pick largest cluster containing target speaker_id
            for c in clusters:
                c_sids = set(c.get("speaker_ids", {}).keys())
                if sid in c_sids:
                    log(f"  [SPEAKER_BBOX] cluster cx={c['cx']:.0f} "
                        f"count={c['count']} sids={list(c['speaker_ids'].keys())}")
                    return {"cx": c["cx"], "cy": c["cy"],
                            "w": c["w"], "h": c["h"]}

        # Fallback: best face in range (largest × most central)
        candidates = []
        for entry in face_data.get("timeline", []):
            t = entry.get("time", 0)
            if t < start - 0.2 or t > end + 0.2:
                continue
            for face in entry.get("faces", []):
                cx, cy = face.get("cx", 0), face.get("cy", 0)
                w, h = face.get("w", 0), face.get("h", 0)
                if cx <= 5 or cy <= 5 or cx >= frame_w - 5 or cy >= frame_h - 5:
                    continue
                if w < 15 or h < 15:
                    continue
                dist = abs(cx - frame_w/2) + abs(cy - frame_h/2)
                score = (w * h) / max(dist, 1)
                candidates.append((score, cx, cy, w, h))

        if not candidates:
            return None
        best = max(candidates, key=lambda x: x[0])
        return {"cx": best[1], "cy": best[2], "w": best[3], "h": best[4]}

    def _get_face_clusters(self, face_data: dict,
                           start: float, end: float,
                           frame_w: int = 1280,
                           merge_dist: float = 150) -> list[dict]:
        """Find DISTINCT face positions in [start, end] range.

        1. Bin all face detections by horizontal position (50px bins).
        2. MERGE bins that are <merge_dist px apart (same person at diff angle).
        3. Sort by detection count (most frequent first).

        Returns list of {cx, cy, w, h, count, speaker_ids}.
        """
        from collections import defaultdict, Counter
        import math

        # ── Step 1: bin by horizontal position (50px) ──
        raw_bins: dict[int, list[dict]] = defaultdict(list)
        bin_sids: dict[int, Counter] = defaultdict(Counter)

        for entry in face_data.get("timeline", []):
            t = entry.get("time", 0)
            if t < start - 0.2 or t > end + 0.2:
                continue
            for face in entry.get("faces", []):
                cx = face.get("cx", 0)
                cy = face.get("cy", 0)
                w = face.get("w", 0)
                h = face.get("h", 0)
                if cx <= 10 or cy <= 10 or cx >= frame_w - 10:
                    continue
                if w < 15 or h < 15:
                    continue
                key = round(cx / 50) * 50
                raw_bins[key].append(face)
                sid = face.get("speaker_id", "?")
                bin_sids[key][sid] += 1

        if not raw_bins:
            return []

        # ── Step 2: convert bins to cluster objects ──
        clusters = []
        for key, faces in raw_bins.items():
            n = len(faces)
            clusters.append({
                "cx": sum(f["cx"] for f in faces) / n,
                "cy": sum(f["cy"] for f in faces) / n,
                "w":  sum(f["w"] for f in faces) / n,
                "h":  sum(f["h"] for f in faces) / n,
                "count": n,
                "speaker_ids": dict(bin_sids[key].most_common(3)),
            })

        # Sort by count descending for deterministic merge
        clusters.sort(key=lambda c: c["count"], reverse=True)

        # ── Step 3: MERGE clusters <merge_dist px apart ──
        #   - same dominant speaker_id → always merge (same person, diff angle)
        #   - BOTH unlabeled (no speaker_id) → merge by spatial (likely same person,
        #     AVM didn't label)
        #   - DIFFERENT dominant speaker_ids → NEVER merge (different people)
        merged = []
        for c in clusters:
            c_top_sid = next(iter(c["speaker_ids"]), None)
            found = False
            for m in merged:
                m_top_sid = next(iter(m["speaker_ids"]), None)
                both_unlabeled = (c_top_sid is None and m_top_sid is None)
                same_person = (both_unlabeled or
                              (c_top_sid and m_top_sid and c_top_sid == m_top_sid))
                if same_person and abs(m["cx"] - c["cx"]) < merge_dist:
                    # Merge into existing cluster (weighted average)
                    total = m["count"] + c["count"]
                    m["cx"] = (m["cx"] * m["count"] + c["cx"] * c["count"]) / total
                    m["cy"] = (m["cy"] * m["count"] + c["cy"] * c["count"]) / total
                    m["w"] = (m["w"] * m["count"] + c["w"] * c["count"]) / total
                    m["h"] = (m["h"] * m["count"] + c["h"] * c["count"]) / total
                    m["count"] = total
                    # Merge speaker_ids
                    merged_sids = dict(m["speaker_ids"])
                    for sid, cnt in c["speaker_ids"].items():
                        merged_sids[sid] = merged_sids.get(sid, 0) + cnt
                    m["speaker_ids"] = dict(
                        sorted(merged_sids.items(), key=lambda x: x[1], reverse=True)[:3]
                    )
                    found = True
                    break
            if not found:
                merged.append(dict(c))

        merged.sort(key=lambda c: c["count"], reverse=True)
        return merged

    @staticmethod
    def _sanitize_bbox(bbox: dict | None, frame_w: int, frame_h: int,
                       mode: str = "single") -> dict | None:
        """Apply sanity checks to prevent edge-screen lock.
        For single-shot: nudge centroid toward center if at edge (<15% or >85%).
        """
        if not bbox:
            return None
        
        cx, cy = bbox["cx"], bbox["cy"]
        w, h = bbox["w"], bbox["h"]
        
        left_edge = frame_w * 0.15
        right_edge = frame_w * 0.85
        top_edge = frame_h * 0.15
        bottom_edge = frame_h * 0.85
        
        if mode == "single":
            if cx < left_edge:
                cx = left_edge + w / 2
            elif cx > right_edge:
                cx = right_edge - w / 2
            
            if cy < top_edge:
                cy = top_edge + h / 2
            elif cy > bottom_edge:
                cy = bottom_edge - h / 2
        
        # Final bounds clamp
        cx = max(w / 2, min(cx, frame_w - w / 2))
        cy = max(h / 2, min(cy, frame_h - h / 2))
        
        return {"cx": cx, "cy": cy, "w": w, "h": h}

    @staticmethod
    def _build_debug_overlay(bbox: dict | None, bbox_secondary: dict | None,
                             crop_x: float, crop_y: float, crop_w: float, crop_h: float,
                             frame_w: int, frame_h: int,
                             scene_num: int, layout: str, speaker_id: str = "",
                             fontfile: str = "") -> str:
        """Build ffmpeg drawbox/drawtext overlay for debug visualization.
        On Windows, pass fontfile='C\\:/Windows/Fonts/arial.ttf' to avoid
        Fontconfig error.
        """
        # Inject :fontfile= if provided (Windows compatibility)
        ff_arg = f":fontfile='{fontfile}'" if fontfile else ""
        overlays = []
        
        # YELLOW: Crop window
        overlays.append(
            f"drawbox=x={crop_x:.0f}:y={crop_y:.0f}:w={crop_w:.0f}:h={crop_h:.0f}:"
            f"color=yellow@0.5:t=4"
        )
        
        if bbox:
            cx, cy = bbox["cx"], bbox["cy"]
            w_b, h_b = bbox["w"], bbox["h"]
            
            # GREEN: Face bbox
            bx = cx - w_b / 2
            by = cy - h_b / 2
            overlays.append(
                f"drawbox=x={bx:.0f}:y={by:.0f}:w={w_b:.0f}:h={h_b:.0f}:"
                f"color=green@0.7:t=3"
            )
            
            # RED: Centroid crosshair
            r = 8
            for dx, dy in [(-r, 0), (r, 0), (0, -r), (0, r)]:
                overlays.append(
                    f"drawbox=x={cx+dx-2:.0f}:y={cy+dy-2:.0f}:w=4:h=4:color=red:t=fill"
                )
        
        if bbox_secondary:
            cx2, cy2 = bbox_secondary["cx"], bbox_secondary["cy"]
            w2, h2 = bbox_secondary["w"], bbox_secondary["h"]
            overlays.append(
                f"drawbox=x={cx2-w2/2:.0f}:y={cy2-h2/2:.0f}:w={w2:.0f}:h={h2:.0f}:"
                f"color=cyan@0.7:t=3"
            )
            for dx, dy in [(-r, 0), (r, 0), (0, -r), (0, r)]:
                overlays.append(
                    f"drawbox=x={cx2+dx-2:.0f}:y={cy2+dy-2:.0f}:w=4:h=4:color=cyan:t=fill"
                )
        
        # Text overlay
        text_y = 30
        scene_text = f"Scene {scene_num} | {layout}"
        overlays.append(
            f"drawtext=text='{scene_text}':x=20:y={text_y}{ff_arg}:"
            f"fontsize=24:fontcolor=white:box=1:boxcolor=black@0.7"
        )
        if speaker_id:
            text_y += 35
            sp_text = f"Speaker {speaker_id}".replace(":", "\\:")
            overlays.append(
                f"drawtext=text='{sp_text}':x=20:y={text_y}{ff_arg}:"
                f"fontsize=20:fontcolor=yellow:box=1:boxcolor=black@0.7"
            )
        if bbox:
            text_y += 35
            tgt_text = f"Target cx={int(bbox['cx'])} cy={int(bbox['cy'])}".replace(":", "\\:")
            overlays.append(
                f"drawtext=text='{tgt_text}':x=20:y={text_y}{ff_arg}:"
                f"fontsize=18:fontcolor=green:box=1:boxcolor=black@0.7"
            )
        
        return ",".join(overlays)

    def _get_secondary_bbox(self, face_data: dict,
                            start: float, end: float,
                            primary_bbox: dict | None,
                            frame_w: int = 1280) -> dict | None:
        """Find the SECOND most prominent face position in [start, end] range.

        Strategy:
        1. Try to find a face with a DIFFERENT speaker_id than the primary
           (most reliable — requires AVM to have mapped tracks correctly).
           No cx-distance threshold — if speaker_id differs, they're different
           people regardless of how close they sit.
        2. Fallback: spatial clustering, pick cluster FARTHEST from primary
           with minimum distance ≥50px.
        3. Last resort: second largest cluster.
        """
        clusters = self._get_face_clusters(face_data, start, end, frame_w)
        if not clusters:
            return None

        # ── Step 1: try different speaker_id (NO cx threshold) ──
        if primary_bbox:
            primary_sid = None
            primary_cx = primary_bbox.get("cx", 0)

            # Find which speaker_id is at primary's position
            for c in clusters:
                if abs(c["cx"] - primary_cx) < 50:
                    primary_sid = next(iter(c["speaker_ids"]), None)
                    break

            if primary_sid:
                # Find a cluster dominated by a DIFFERENT speaker_id
                # AND far enough from primary (≥200px) to be truly different person
                for c in clusters:
                    c_sids = set(c["speaker_ids"].keys())
                    if primary_sid not in c_sids and abs(c["cx"] - primary_cx) >= 200:
                        return {"cx": c["cx"], "cy": c["cy"],
                                "w": c["w"], "h": c["h"]}

        # ── Step 2: pick cluster FARTHEST from primary (≥200px, count >= 10) ──
        if primary_bbox:
            primary_cx = primary_bbox["cx"]
            best = None
            best_dist = 0
            for c in clusters:
                dist = abs(c["cx"] - primary_cx)
                count = c.get("count", 0)
                if dist >= 200 and count >= 10 and dist > best_dist:
                    best_dist = dist
                    best = c
            if best:
                log(f"  [SECONDARY-STEP2] cluster cx={best['cx']:.0f} dist={best_dist:.0f} count={best['count']}")
                return {"cx": best["cx"], "cy": best["cy"],
                        "w": best["w"], "h": best["h"]}

        # ── Step 3: second largest cluster (count >= 10) ──
        if len(clusters) >= 2:
            sorted_clusters = sorted(clusters, key=lambda c: c.get("count", 0), reverse=True)
            second = sorted_clusters[1]
            if second.get("count", 0) >= 10:
                log(f"  [SECONDARY-STEP3] 2nd cluster cx={second['cx']:.0f} count={second['count']}")
                return {"cx": second["cx"], "cy": second["cy"],
                        "w": second["w"], "h": second["h"]}

        return None

    @staticmethod
    def _build_crop_filter(bbox: dict | None, frame_w: int, frame_h: int,
                           out_w: int, out_h: int,
                           vertical: bool = False, layout: str = "fullscreen") -> str:
        """
        Build ffmpeg filter string.

        vertical mode (9:16 output 720x1280):
          fullscreen → crop 9:16 strip around speaker's face (tight zoom)
          others     → scale full frame to fit 720x1280 with letterbox (wide view)

        landscape: head-and-shoulders crop, scale to out.
        """
        if vertical:
            if layout == "fullscreen":
                # Tight zoom: crop 9:16 strip centered on face
                vw = frame_h * 9 / 16   # 405px for 720p
                vh = float(frame_h)      # 720
                if bbox:
                    vx = bbox["cx"] - vw / 2
                else:
                    vx = (frame_w - vw) / 2
                vx = max(0.0, min(vx, frame_w - vw))
                if vw >= frame_w * 0.98:
                    return f"scale={out_w}:{out_h}"
                return f"crop={vw:.1f}:{vh:.1f}:{vx:.1f}:0,scale={out_w}:{out_h}"
            else:
                # Wide view: fit full 16:9 frame into 9:16 output with letterbox
                pad_h = out_h - int(out_w * 9 / 16)
                if pad_h > 0:
                    top_pad = pad_h // 2
                    return (f"scale={out_w}:-1," +
                           f"pad={out_w}:{out_h}:(ow-iw)/2:{top_pad}:black")
                return f"scale={out_w}:{out_h}"

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

    @staticmethod
    def _build_split_filter(bbox_top: dict | None, bbox_bottom: dict | None,
                            frame_w: int, frame_h: int,
                            out_w: int, out_h: int) -> str:
        """Build filter_complex for split-screen vertical (9:16).

        Each half is 720x640 (9:8). Crop a matching 9:8 region from source
        so scaling to each half is UNIFORM — no distortion, no pillarbox.

        405px 9:16 → 360x640 + pillarbox = black bars. Instead, crop wider:
        crop_w = out_w * frame_h / half_h  (810px for 720p → 720x640 uniform)

        Top half:   crop around primary speaker → scale to 720x640
        Bottom half: crop around secondary speaker / reactor → scale to 720x640
        vstack → 720x1280

        If bbox_bottom is None, fall back to full frame letterboxed.
        """
        half_h = out_h // 2            # 640
        zoom_factor = 1.6              # Zoom factor for tight crop of individual speaker

        # Crop height and width for uniform scaling: crop_w / crop_h = out_w / half_h
        crop_h = frame_h / zoom_factor
        crop_w = out_w * crop_h / half_h

        if crop_w >= frame_w * 0.98:
            crop_w = float(frame_w)
            crop_h = crop_w * half_h / out_w

        # Top: crop around primary face (x and y) → scale to 720x640
        # YOLO person bbox cy = chest centroid, not face. Bias crop upward
        # so 65% is above cy (face) and 35% below (chest/shoulders).
        if bbox_top:
            vx = max(0.0, min(bbox_top["cx"] - crop_w / 2, frame_w - crop_w))
            vy = max(0.0, min(bbox_top["cy"] - crop_h * 0.65, frame_h - crop_h))
        else:
            vx = (frame_w - crop_w) / 2
            vy = (frame_h - crop_h) / 2
        top = f"[0:v]crop={crop_w:.1f}:{crop_h:.1f}:{vx:.1f}:{vy:.1f},scale={out_w}:{half_h}[top]"

        # Bottom: crop around secondary face (x and y) → scale to 720x640
        if bbox_bottom:
            vx_bot = max(0.0, min(bbox_bottom["cx"] - crop_w / 2, frame_w - crop_w))
            vy_bot = max(0.0, min(bbox_bottom["cy"] - crop_h * 0.65, frame_h - crop_h))
            bottom = (f"[0:v]crop={crop_w:.1f}:{crop_h:.1f}:{vx_bot:.1f}:{vy_bot:.1f},"
                      f"scale={out_w}:{half_h}[bottom]")
        else:
            pad_h = half_h - int(out_w * 9 / 16)
            if pad_h > 0:
                top_pad = pad_h // 2
                bottom = (f"[0:v]scale={out_w}:-1,"
                          f"pad={out_w}:{half_h}:(ow-iw)/2:{top_pad}:black[bottom]")
            else:
                bottom = f"[0:v]scale={out_w}:{half_h}[bottom]"

        return f"{top};{bottom};[top][bottom]vstack=inputs=2[v]"
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
            bbox_primary = None
            bbox_secondary = None

            is_split = self.vertical and layout != "fullscreen"

            if face_data:
                clusters = self._get_face_clusters(
                    face_data, start, start + dur, frame_w=frame_w)
                # Split requires: ≥2 clusters, ≥200px apart, AND
                # both clusters carry a dominant speaker_id (unlabeled =
                # AVM didn't map, can't trust it's 2 distinct people).
                has_multiple_faces = False
                if clusters and len(clusters) >= 2 \
                        and abs(clusters[0]["cx"] - clusters[1]["cx"]) >= 200:
                    c0_sid = next(iter(clusters[0]["speaker_ids"]), None)
                    c1_sid = next(iter(clusters[1]["speaker_ids"]), None)
                    has_multiple_faces = bool(c0_sid and c1_sid)

                # Force split when multiple distinct faces visible
                if self.vertical and has_multiple_faces and not is_split:
                    is_split = True
                    layout = "split_screen"
                    log(f"  Force split {start:.1f}s-{start+dur:.1f}s: "
                        f"{len(clusters)} face clusters ≥200px apart "
                        f"(sids={list(clusters[0]['speaker_ids'].keys())} vs "
                        f"{list(clusters[1]['speaker_ids'].keys())})")

                if is_split:
                    bbox_primary = self._get_speaker_bbox(
                        face_data, target_sid or "",
                        start, start + dur,
                        frame_w=frame_w, frame_h=frame_h)

                    secondary_sid = scene.get("secondary_speaker")
                    if secondary_sid and secondary_sid != target_sid:
                        bbox_secondary = self._get_speaker_bbox(
                            face_data, secondary_sid,
                            start, start + dur,
                            frame_w=frame_w, frame_h=frame_h)
                        if (bbox_primary and bbox_secondary
                                and abs(bbox_primary["cx"] - bbox_secondary["cx"]) < 200):
                            bbox_secondary = None

                    # Always log clusters for vertical output
                    if clusters or self.vertical:
                        if not clusters:
                            clusters = self._get_face_clusters(
                                face_data, start, start + dur, frame_w=frame_w)
                        if clusters:
                            c_desc = "; ".join(
                                f"cx={c['cx']:.0f}({c['count']}x,"
                                f"sids={list(c['speaker_ids'].keys())})"
                                for c in clusters[:4]
                            )
                            log(f"  Face clusters in {start:.1f}s-{start+dur:.1f}s: "
                                f"{len(clusters)} clusters → {c_desc}")

                    if bbox_secondary is None:
                        bbox_secondary = self._get_secondary_bbox(
                            face_data, start, start + dur,
                            bbox_primary, frame_w=frame_w)

                    if (bbox_primary and bbox_secondary
                            and abs(bbox_primary["cx"] - bbox_secondary["cx"]) < 200):
                        log(f"  Split cancelled: both crops at same position "
                            f"(cx={bbox_primary['cx']:.0f} vs {bbox_secondary['cx']:.0f})"
                            f" — falling back to fullscreen")
                        is_split = False
                        bbox = self._sanitize_bbox(bbox_primary, frame_w, frame_h, "single")
                else:
                    bbox = self._sanitize_bbox(
                        self._get_speaker_bbox(
                            face_data, target_sid or "",
                            start, start + dur,
                            frame_w=frame_w, frame_h=frame_h),
                        frame_w, frame_h, "single")

                if is_split:
                    # Sanitize both bboxes
                    bbox_primary = self._sanitize_bbox(bbox_primary, frame_w, frame_h, "single")
                    bbox_secondary = self._sanitize_bbox(bbox_secondary, frame_w, frame_h, "split")

                    # ── ACTUAL SPLIT ──
                    vf = self._build_split_filter(
                        bbox_primary, bbox_secondary,
                        frame_w, frame_h, out_w, out_h)
                    
                    # Debug mode: inject visual overlay
                    if self.debug_mode and bbox_primary:
                        crop_w_split = frame_h * 9 / 16
                        vx_primary = max(0.0, min(bbox_primary["cx"] - crop_w_split / 2, frame_w - crop_w_split))
                        debug_ov = self._build_debug_overlay(
                            bbox_primary, bbox_secondary,
                            vx_primary, 0, crop_w_split, frame_h,
                            frame_w, frame_h, i + 1, layout, target_sid or "unknown",
                            fontfile=self.debug_fontfile
                        )
                        vf = f"[0:v]{debug_ov}[debug];[debug]{vf[5:]}"
                    
                    desc = "split"
                    if bbox_primary:
                        desc += f" primary=cx{bbox_primary['cx']:.0f}"
                    if bbox_secondary:
                        desc += f" secondary=cx{bbox_secondary['cx']:.0f}"
                    log(f"    Scene {i+1}: {layout} ({desc}) {start:.1f}s-{start+dur:.1f}s")
                    run_cmd([
                        "ffmpeg", "-y", "-ss", f"{start:.2f}",
                        "-i", str(self.video_path),
                        "-t", f"{dur:.2f}",
                        "-filter_complex", vf,
                        "-map", "[v]",
                        "-map", "0:a?",
                        "-c:v", "libx264", "-preset", "fast", "-crf", "22",
                        "-c:a", "aac",
                        str(seg_out)
                    ], f"  Scene {i+1}/{len(scenes)}: {layout} {start:.1f}s-{start+dur:.1f}s")
                else:
                    # ── Fullscreen: single tight crop to face ──
                    if bbox:
                        vf = self._build_crop_filter(
                            bbox, frame_w, frame_h, out_w, out_h,
                            vertical=self.vertical, layout=layout)
                        desc = f"crop to cx={bbox['cx']:.0f} cy={bbox['cy']:.0f}"
                        
                        # Debug overlay
                        if self.debug_mode:
                            if self.vertical and layout == "fullscreen":
                                cw = frame_h * 9 / 16
                                cx = max(0.0, min(bbox["cx"] - cw / 2, frame_w - cw))
                                cy_debug = 0
                                ch = frame_h
                            else:
                                cw = min(bbox["w"] * 5.0, frame_w)
                                ch = min(bbox["h"] * 4.0, frame_h)
                                cx = max(0.0, bbox["cx"] - cw / 2)
                                cy_debug = max(0.0, bbox["cy"] - ch * 0.275)
                            debug_ov = self._build_debug_overlay(
                                bbox, None, cx, cy_debug, cw, ch,
                                frame_w, frame_h, i + 1, layout, target_sid or "unknown",
                                fontfile=self.debug_fontfile
                            )
                            vf = f"{debug_ov},{vf}"
                    else:
                        vf = self._build_crop_filter(
                            None, frame_w, frame_h, out_w, out_h,
                            vertical=self.vertical, layout=layout)
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

            else:
                # ── Fullscreen (no face_data — center crop) ──
                if bbox:
                    vf = self._build_crop_filter(
                        bbox, frame_w, frame_h, out_w, out_h,
                        vertical=self.vertical, layout=layout)
                    desc = f"crop to cx={bbox['cx']:.0f} cy={bbox['cy']:.0f}"
                    
                    if self.debug_mode:
                        cw = frame_h * 9 / 16 if self.vertical else min(bbox["w"] * 5.0, frame_w)
                        ch = frame_h if self.vertical else min(bbox["h"] * 4.0, frame_h)
                        cx_debug = max(0.0, min(bbox["cx"] - cw / 2, frame_w - cw))
                        cy_debug = 0 if self.vertical else max(0.0, bbox["cy"] - ch * 0.275)
                        debug_ov = self._build_debug_overlay(
                            bbox, None, cx_debug, cy_debug, cw, ch,
                            frame_w, frame_h, i + 1, layout, target_sid or "unknown",
                            fontfile=self.debug_fontfile
                        )
                        vf = f"{debug_ov},{vf}"
                else:
                    vf = self._build_crop_filter(
                        None, frame_w, frame_h, out_w, out_h,
                        vertical=self.vertical, layout=layout)
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
            concat_file.write_text("\n".join(concat_lines) + "\n")
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
    parser.add_argument("--debug", action="store_true",
                        help="Enable debug visualization overlay + debug.log")
    args = parser.parse_args()

    if not os.path.exists(args.video):
        print(f"Error: video not found: {args.video}")
        sys.exit(1)

    pipeline = Pipeline(args.video, args.output, args.work_dir,
                        vertical=args.vertical, debug_mode=args.debug)
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
