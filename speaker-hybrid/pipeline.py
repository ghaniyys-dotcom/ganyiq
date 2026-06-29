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
                    if cx <= 5 or cy <= 5 or cx >= frame_w - 5 or cy >= frame_h - 5:
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
                if cx <= 5 or cy <= 5 or cx >= frame_w - 5 or cy >= frame_h - 5:
                    continue  # false positive at edge
                if w < 15 or h < 15:
                    continue  # too small = noise
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

        # ── Step 3: MERGE clusters that are <merge_dist px apart AND same speaker_id ──
        # NEVER merge clusters that have DIFFERENT dominant speaker_ids — they're
        # different people even if sitting close together.
        merged = []
        for c in clusters:
            c_top_sid = next(iter(c["speaker_ids"]), None)
            # Find existing merged cluster within merge_dist AND same speaker
            found = False
            for m in merged:
                m_top_sid = next(iter(m["speaker_ids"]), None)
                same_person = (c_top_sid and m_top_sid and c_top_sid == m_top_sid)
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

        # ── Step 2: pick cluster FARTHEST from primary (≥200px) ──
        if primary_bbox:
            primary_cx = primary_bbox["cx"]
            best = None
            best_dist = 0
            for c in clusters:
                dist = abs(c["cx"] - primary_cx)
                if dist >= 200 and dist > best_dist:
                    best_dist = dist
                    best = c
            if best:
                return {"cx": best["cx"], "cy": best["cy"],
                        "w": best["w"], "h": best["h"]}

        # ── Step 3: second largest cluster ──
        if len(clusters) >= 2:
            c = clusters[1]
            return {"cx": c["cx"], "cy": c["cy"], "w": c["w"], "h": c["h"]}

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

        # Crop width for uniform scaling: crop_w / frame_h = out_w / half_h
        crop_w = out_w * frame_h / half_h   # 810px for 720p, 1215px for 1080p

        if crop_w >= frame_w * 0.98:
            crop_w = float(frame_w)

        # Top: crop wide strip around primary face → scale to 720x640
        if bbox_top:
            vx = max(0.0, min(bbox_top["cx"] - crop_w / 2, frame_w - crop_w))
        else:
            vx = (frame_w - crop_w) / 2
        top = f"[0:v]crop={crop_w:.1f}:{frame_h:.1f}:{vx:.1f}:0,scale={out_w}:{half_h}[top]"

        if bbox_bottom:
            vx_bot = max(0.0, min(bbox_bottom["cx"] - crop_w / 2, frame_w - crop_w))
            bottom = (f"[0:v]crop={crop_w:.1f}:{frame_h:.1f}:{vx_bot:.1f}:0,"
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
            if face_data:
                bbox = self._get_speaker_bbox(
                    face_data, target_sid or "",
                    start, start + dur,
                    frame_w=frame_w, frame_h=frame_h)

            is_split = self.vertical and layout != "fullscreen"

            if is_split:
                # ── Split screen: primary face top + secondary face bottom ──
                bbox_primary = None
                bbox_secondary = None
                if face_data:
                    bbox_primary = self._get_speaker_bbox(
                        face_data, target_sid or "",
                        start, start + dur,
                        frame_w=frame_w, frame_h=frame_h)
                    # Find second face: try explicit secondary_speaker first
                    secondary_sid = scene.get("secondary_speaker")
                    if secondary_sid and secondary_sid != target_sid:
                        bbox_secondary = self._get_speaker_bbox(
                            face_data, secondary_sid,
                            start, start + dur,
                            frame_w=frame_w, frame_h=frame_h)

                    # ALWAYS log face clusters for split scenes
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
                        # Fallback: spatial clustering
                        bbox_secondary = self._get_secondary_bbox(
                            face_data, start, start + dur,
                            bbox_primary, frame_w=frame_w)

                    # If secondary is essentially the same position, DON'T split
                    # (faces within 200px are too close for a meaningful split)
                    if (bbox_primary and bbox_secondary
                            and abs(bbox_primary["cx"] - bbox_secondary["cx"]) < 200):
                        log(f"  Split cancelled: both crops at same position "
                            f"(cx={bbox_primary['cx']:.0f} vs {bbox_secondary['cx']:.0f}, "
                            f"diff={abs(bbox_primary['cx'] - bbox_secondary['cx']):.0f}px)"
                            f" — falling back to fullscreen")
                        is_split = False
                        bbox = bbox_primary  # use primary face for fullscreen

                if is_split:
                    # ── ACTUAL SPLIT ──
                    vf = self._build_split_filter(
                        bbox_primary, bbox_secondary,
                        frame_w, frame_h, out_w, out_h)
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
                # ── Fullscreen (non-split scenes) ──
                if bbox:
                    vf = self._build_crop_filter(
                        bbox, frame_w, frame_h, out_w, out_h,
                        vertical=self.vertical, layout=layout)
                    desc = f"crop to cx={bbox['cx']:.0f} cy={bbox['cy']:.0f}"
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
