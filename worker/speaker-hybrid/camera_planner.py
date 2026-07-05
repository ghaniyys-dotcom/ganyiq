#!/usr/bin/env python3
"""
camera_planner.py — GANYIQ Virtual Cameraman: Smooth Camera Trajectory Planning

Computes per-frame crop positions for each shot in the director's shot list,
producing smooth, cinematic camera motion instead of static per-shot crops.

Key features:
  - EMA (Exponential Moving Average) smoothing for natural pan/tilt
  - Ease-in-out transitions at shot boundaries (Hermite interpolation)
  - Rule-of-thirds framing for single-speaker close-ups
  - Dynamic bounding box for multi-speaker shots
  - ffmpeg zoompan expression generation

Usage:
    from camera_planner import CameraPlanner
    planner = CameraPlanner(frame_w=1920, frame_h=1080, out_w=720, out_h=1280)
    trajectory = planner.plan_shot(shot, face_timeline, fps=30)
    zoompan_expr = planner.to_zoompan_expr(trajectory, fps=30)
"""

import sys
import math
from dataclasses import dataclass, field


def log(msg: str):
    print(f"[CAMERA] {msg}", file=sys.stderr, flush=True)


@dataclass
class CropFrame:
    """Single frame's crop parameters."""
    time: float
    x: float
    y: float
    w: float
    h: float


@dataclass
class CameraTrajectory:
    """Sequence of crop frames for a single shot."""
    shot_index: int
    start_time: float
    end_time: float
    layout: str
    frames: list[CropFrame] = field(default_factory=list)
    # For split screen: separate trajectories for top/bottom
    top_frames: list[CropFrame] = field(default_factory=list)
    bottom_frames: list[CropFrame] = field(default_factory=list)


class CameraPlanner:
    """Computes smooth camera trajectories from face tracking data."""

    def __init__(
        self,
        frame_w: int = 1920,
        frame_h: int = 1080,
        out_w: int = 720,
        out_h: int = 1280,
        vertical: bool = True,
        ema_alpha: float = 0.12,
        transition_duration: float = 0.5,
    ):
        self.frame_w = frame_w
        self.frame_h = frame_h
        self.out_w = out_w
        self.out_h = out_h
        self.vertical = vertical
        self.ema_alpha = ema_alpha
        self.transition_duration = transition_duration

    # ── Public API ──────────────────────────────────────────────────────

    def plan_shot(
        self,
        shot: dict,
        face_data: dict | None,
        id_bridge: dict | None,
        fps: float = 30.0,
        prev_trajectory: CameraTrajectory | None = None,
    ) -> CameraTrajectory:
        """Plan camera trajectory for a single shot.

        Parameters
        ----------
        shot : dict
            Shot dict with start_time, end_time, layout, primary_target_id, secondary_target_id
        face_data : dict
            Full face detection data with 'timeline' key
        id_bridge : dict
            ID bridge mapping (from pipeline._build_id_bridge)
        fps : float
            Video frame rate
        prev_trajectory : CameraTrajectory
            Previous shot's trajectory (for smooth transitions)

        Returns
        -------
        CameraTrajectory
        """
        layout = shot.get("layout", "fullscreen")
        start = float(shot.get("start_time", 0))
        end = float(shot.get("end_time", start + 1))
        primary_id = shot.get("primary_target_id")
        secondary_id = shot.get("secondary_target_id")

        trajectory = CameraTrajectory(
            shot_index=shot.get("_index", 0),
            start_time=start,
            end_time=end,
            layout=layout,
        )

        if layout == "split_screen":
            trajectory = self._plan_split(
                trajectory, face_data, id_bridge,
                primary_id, secondary_id, fps, prev_trajectory,
            )
        elif layout == "two_shot_wide":
            trajectory = self._plan_two_shot(
                trajectory, face_data, id_bridge,
                primary_id, secondary_id, fps, prev_trajectory,
            )
        else:
            # fullscreen, close_up, wide_shot
            trajectory = self._plan_single(
                trajectory, face_data, id_bridge,
                primary_id, fps, prev_trajectory,
            )

        return trajectory

    def plan_all_shots(
        self,
        shot_list: list[dict],
        face_data: dict | None,
        id_bridge: dict | None,
        fps: float = 30.0,
    ) -> list[CameraTrajectory]:
        """Plan trajectories for all shots in the shot list."""
        trajectories = []
        prev = None
        for i, shot in enumerate(shot_list):
            shot["_index"] = i
            traj = self.plan_shot(shot, face_data, id_bridge, fps, prev)
            trajectories.append(traj)
            prev = traj
        return trajectories

    # ── Trajectory planning ────────────────────────────────────────────

    def _plan_single(
        self,
        trajectory: CameraTrajectory,
        face_data: dict | None,
        id_bridge: dict | None,
        target_id: str | None,
        fps: float,
        prev_trajectory: CameraTrajectory | None,
    ) -> CameraTrajectory:
        """Plan trajectory for fullscreen/close-up single-speaker shot."""
        start = trajectory.start_time
        end = trajectory.end_time
        duration = end - start
        num_frames = max(1, int(duration * fps))

        # Collect per-frame face positions for the target
        face_positions = self._collect_face_positions(
            face_data, id_bridge, target_id, start, end, fps,
        )

        # Default crop: vertical strip centered
        if self.vertical:
            crop_w = self.frame_h * 9 / 16
            crop_h = float(self.frame_h)
        else:
            crop_w = float(self.frame_w)
            crop_h = float(self.frame_h)

        # Get starting position from previous trajectory for smooth transition
        prev_x = (self.frame_w - crop_w) / 2
        prev_y = 0.0
        if prev_trajectory and prev_trajectory.frames:
            last = prev_trajectory.frames[-1]
            prev_x = last.x
            prev_y = last.y

        # EMA state
        smooth_x = prev_x
        smooth_y = prev_y

        for i in range(num_frames):
            t = start + i / fps
            progress = i / max(num_frames - 1, 1)

            # Get target face position at this time
            bbox = self._interpolate_face(face_positions, t)

            if bbox:
                # Target crop center on face, with rule-of-thirds offset
                target_x = max(0.0, min(bbox["cx"] - crop_w / 2, self.frame_w - crop_w))
                target_y = max(0.0, min(bbox["cy"] - crop_h * 0.35, self.frame_h - crop_h))
            else:
                # No face data — center crop
                target_x = (self.frame_w - crop_w) / 2
                target_y = 0.0

            # Apply EMA smoothing
            smooth_x = self.ema_alpha * target_x + (1 - self.ema_alpha) * smooth_x
            smooth_y = self.ema_alpha * target_y + (1 - self.ema_alpha) * smooth_y

            # Apply ease-in-out for first few frames (shot transition)
            if i < int(self.transition_duration * fps) and prev_trajectory:
                ease_t = i / max(int(self.transition_duration * fps), 1)
                ease_factor = self._hermite_ease(ease_t)
                smooth_x = prev_x + (smooth_x - prev_x) * ease_factor
                smooth_y = prev_y + (smooth_y - prev_y) * ease_factor

            # Clamp to frame bounds
            smooth_x = max(0.0, min(smooth_x, self.frame_w - crop_w))
            smooth_y = max(0.0, min(smooth_y, self.frame_h - crop_h))

            trajectory.frames.append(CropFrame(
                time=round(t, 3),
                x=round(smooth_x, 1),
                y=round(smooth_y, 1),
                w=round(crop_w, 1),
                h=round(crop_h, 1),
            ))

        return trajectory

    def _plan_split(
        self,
        trajectory: CameraTrajectory,
        face_data: dict | None,
        id_bridge: dict | None,
        primary_id: str | None,
        secondary_id: str | None,
        fps: float,
        prev_trajectory: CameraTrajectory | None,
    ) -> CameraTrajectory:
        """Plan trajectory for split-screen (top/bottom) shot."""
        start = trajectory.start_time
        end = trajectory.end_time
        duration = end - start
        num_frames = max(1, int(duration * fps))

        # Collect face positions for both speakers
        primary_positions = self._collect_face_positions(
            face_data, id_bridge, primary_id, start, end, fps,
        )
        secondary_positions = self._collect_face_positions(
            face_data, id_bridge, secondary_id, start, end, fps,
        )

        # Split screen zoom factor
        zoom_factor = 1.6
        crop_h = self.frame_h / zoom_factor
        crop_w = self.out_w * crop_h / (self.out_h // 2)
        if crop_w >= self.frame_w * 0.98:
            crop_w = float(self.frame_w)
            crop_h = crop_w * (self.out_h // 2) / self.out_w

        # EMA state for each panel
        smooth_top_x = (self.frame_w - crop_w) / 2
        smooth_top_y = (self.frame_h - crop_h) / 2
        smooth_bot_x = smooth_top_x
        smooth_bot_y = smooth_top_y

        for i in range(num_frames):
            t = start + i / fps

            # Top panel: primary speaker
            bbox_top = self._interpolate_face(primary_positions, t)
            if bbox_top:
                target_top_x = max(0.0, min(bbox_top["cx"] - crop_w / 2, self.frame_w - crop_w))
                target_top_y = max(0.0, min(bbox_top["cy"] - crop_h * 0.35, self.frame_h - crop_h))
            else:
                target_top_x = (self.frame_w - crop_w) / 2
                target_top_y = (self.frame_h - crop_h) / 2

            # Bottom panel: secondary speaker
            bbox_bot = self._interpolate_face(secondary_positions, t)
            if bbox_bot:
                target_bot_x = max(0.0, min(bbox_bot["cx"] - crop_w / 2, self.frame_w - crop_w))
                target_bot_y = max(0.0, min(bbox_bot["cy"] - crop_h * 0.35, self.frame_h - crop_h))
            else:
                target_bot_x = (self.frame_w - crop_w) / 2
                target_bot_y = (self.frame_h - crop_h) / 2

            # Apply EMA
            smooth_top_x = self.ema_alpha * target_top_x + (1 - self.ema_alpha) * smooth_top_x
            smooth_top_y = self.ema_alpha * target_top_y + (1 - self.ema_alpha) * smooth_top_y
            smooth_bot_x = self.ema_alpha * target_bot_x + (1 - self.ema_alpha) * smooth_bot_x
            smooth_bot_y = self.ema_alpha * target_bot_y + (1 - self.ema_alpha) * smooth_bot_y

            # Clamp
            smooth_top_x = max(0.0, min(smooth_top_x, self.frame_w - crop_w))
            smooth_top_y = max(0.0, min(smooth_top_y, self.frame_h - crop_h))
            smooth_bot_x = max(0.0, min(smooth_bot_x, self.frame_w - crop_w))
            smooth_bot_y = max(0.0, min(smooth_bot_y, self.frame_h - crop_h))

            trajectory.top_frames.append(CropFrame(
                time=round(t, 3), x=round(smooth_top_x, 1), y=round(smooth_top_y, 1),
                w=round(crop_w, 1), h=round(crop_h, 1),
            ))
            trajectory.bottom_frames.append(CropFrame(
                time=round(t, 3), x=round(smooth_bot_x, 1), y=round(smooth_bot_y, 1),
                w=round(crop_w, 1), h=round(crop_h, 1),
            ))

        return trajectory

    def _plan_two_shot(
        self,
        trajectory: CameraTrajectory,
        face_data: dict | None,
        id_bridge: dict | None,
        primary_id: str | None,
        secondary_id: str | None,
        fps: float,
        prev_trajectory: CameraTrajectory | None,
    ) -> CameraTrajectory:
        """Plan trajectory for two-shot wide (both speakers in one frame)."""
        start = trajectory.start_time
        end = trajectory.end_time
        num_frames = max(1, int((end - start) * fps))

        primary_positions = self._collect_face_positions(
            face_data, id_bridge, primary_id, start, end, fps,
        )
        secondary_positions = self._collect_face_positions(
            face_data, id_bridge, secondary_id, start, end, fps,
        )

        prev_x = (self.frame_w - self.frame_h * 9 / 16) / 2 if self.vertical else 0.0
        prev_y = 0.0
        smooth_x = prev_x
        smooth_y = prev_y

        for i in range(num_frames):
            t = start + i / fps

            bbox1 = self._interpolate_face(primary_positions, t)
            bbox2 = self._interpolate_face(secondary_positions, t)

            if bbox1 and bbox2:
                # Compute bounding box spanning both speakers
                min_x = min(bbox1["cx"] - bbox1["w"] / 2, bbox2["cx"] - bbox2["w"] / 2)
                max_x = max(bbox1["cx"] + bbox1["w"] / 2, bbox2["cx"] + bbox2["w"] / 2)
                target_w = (max_x - min_x) + 160.0
                target_h = target_w * 16 / 9
                if target_h > self.frame_h:
                    target_h = float(self.frame_h)
                    target_w = target_h * 9 / 16

                mid_cx = (min_x + max_x) / 2
                target_x = max(0.0, min(mid_cx - target_w / 2, self.frame_w - target_w))
                mid_cy = (bbox1["cy"] + bbox2["cy"]) / 2
                target_y = max(0.0, min(mid_cy - target_h * 0.35, self.frame_h - target_h))
                crop_w = target_w
                crop_h = target_h
            elif bbox1 or bbox2:
                bbox = bbox1 or bbox2
                if self.vertical:
                    crop_w = self.frame_h * 9 / 16
                    crop_h = float(self.frame_h)
                else:
                    crop_w = float(self.frame_w)
                    crop_h = float(self.frame_h)
                target_x = max(0.0, min(bbox["cx"] - crop_w / 2, self.frame_w - crop_w))
                target_y = max(0.0, min(bbox["cy"] - crop_h * 0.35, self.frame_h - crop_h))
            else:
                if self.vertical:
                    crop_w = self.frame_h * 9 / 16
                    crop_h = float(self.frame_h)
                else:
                    crop_w = float(self.frame_w)
                    crop_h = float(self.frame_h)
                target_x = (self.frame_w - crop_w) / 2
                target_y = 0.0

            # Apply EMA
            smooth_x = self.ema_alpha * target_x + (1 - self.ema_alpha) * smooth_x
            smooth_y = self.ema_alpha * target_y + (1 - self.ema_alpha) * smooth_y
            smooth_x = max(0.0, min(smooth_x, self.frame_w - crop_w))
            smooth_y = max(0.0, min(smooth_y, self.frame_h - crop_h))

            trajectory.frames.append(CropFrame(
                time=round(t, 3),
                x=round(smooth_x, 1), y=round(smooth_y, 1),
                w=round(crop_w, 1), h=round(crop_h, 1),
            ))

        return trajectory

    # ── Face data helpers ──────────────────────────────────────────────

    def _collect_face_positions(
        self,
        face_data: dict | None,
        id_bridge: dict | None,
        target_id: str | None,
        start: float,
        end: float,
        fps: float,
    ) -> list[dict]:
        """Collect all face positions for a target within a time range.

        Returns list of {time, cx, cy, w, h} sorted by time.
        """
        if not face_data or not target_id:
            return []

        positions = []
        canonical_id = None
        if id_bridge:
            canonical_id = id_bridge.get(str(target_id).upper())

        for entry in face_data.get("timeline", []):
            t = entry.get("time", 0)
            if not (start - 0.5 <= t <= end + 0.5):
                continue

            for face in entry.get("faces", []):
                cx = face.get("cx")
                cy = face.get("cy")
                w = face.get("w")
                h = face.get("h")
                if not (cx and cy and w and h):
                    continue

                # Check if this face matches the target
                matched = False

                if canonical_id and id_bridge:
                    face_sid = face.get("speaker_id", "")
                    face_pid = f"person_{face.get('person_id')}" if face.get("person_id") else None
                    face_tid = f"track_{face.get('track_id')}" if face.get("track_id") else None

                    face_canon = None
                    if face_sid:
                        face_canon = id_bridge.get(face_sid.upper())
                    elif face_pid:
                        face_canon = id_bridge.get(face_pid)
                    elif face_tid:
                        face_canon = id_bridge.get(face_tid)

                    if face_canon == canonical_id:
                        matched = True

                # Fallback: direct speaker_id match
                if not matched and face.get("speaker_id", "").upper() == str(target_id).upper():
                    matched = True

                if matched:
                    positions.append({
                        "time": t, "cx": float(cx), "cy": float(cy),
                        "w": float(w), "h": float(h),
                    })

        return sorted(positions, key=lambda p: p["time"])

    def _interpolate_face(self, positions: list[dict], time: float) -> dict | None:
        """Get interpolated face position at a specific time.

        Uses nearest-neighbor for simplicity (face positions are already
        smoothed by ByteTrack's Kalman filter).
        """
        if not positions:
            return None

        # Find nearest position
        best = None
        best_dist = float("inf")
        for pos in positions:
            dist = abs(pos["time"] - time)
            if dist < best_dist:
                best_dist = dist
                best = pos

        # Only use if within reasonable time range (2 seconds)
        if best and best_dist <= 2.0:
            return best
        return None

    # ── Math helpers ───────────────────────────────────────────────────

    @staticmethod
    def _hermite_ease(t: float) -> float:
        """Hermite interpolation for smooth ease-in-out.

        f(0) = 0, f(1) = 1, f'(0) = f'(1) = 0
        """
        t = max(0.0, min(1.0, t))
        return 3 * t * t - 2 * t * t * t

    # ── ffmpeg expression generation ──────────────────────────────────

    def to_crop_keyframes(self, trajectory: CameraTrajectory, fps: float) -> str:
        """Generate a simple static crop filter using the median position.

        This is used as a fallback when zoompan is not suitable (e.g., very
        short shots). Uses the median frame position for stability.
        """
        if not trajectory.frames:
            vw = self.frame_h * 9 / 16 if self.vertical else self.frame_w
            vx = (self.frame_w - vw) / 2 if self.vertical else 0
            return f"crop={vw:.0f}:{self.frame_h}:{vx:.0f}:0,scale={self.out_w}:{self.out_h}"

        # Use median position for stability
        xs = sorted(f.x for f in trajectory.frames)
        ys = sorted(f.y for f in trajectory.frames)
        median_x = xs[len(xs) // 2]
        median_y = ys[len(ys) // 2]
        crop_w = trajectory.frames[0].w
        crop_h = trajectory.frames[0].h

        return (
            f"crop={crop_w:.0f}:{crop_h:.0f}:{median_x:.0f}:{median_y:.0f},"
            f"scale={self.out_w}:{self.out_h}"
        )

    def to_smooth_crop_filter(self, trajectory: CameraTrajectory, fps: float) -> str:
        """Generate a zoompan-based smooth crop filter from trajectory.

        Uses ffmpeg's zoompan filter with lerp() for frame-by-frame
        smooth interpolation. The zoompan reads a single input frame
        at a time and pans across it, producing smooth camera motion.

        For shots < 1s, falls back to static median crop.
        """
        if not trajectory.frames or len(trajectory.frames) < 2:
            return self.to_crop_keyframes(trajectory, fps)

        # For very short shots, static crop is more stable
        duration = trajectory.end_time - trajectory.start_time
        if duration < 1.0:
            return self.to_crop_keyframes(trajectory, fps)

        first = trajectory.frames[0]
        crop_w = first.w
        crop_h = first.h

        # Calculate zoom level (zoompan zoom = output_size / crop_size)
        zoom_x = self.out_w / crop_w if crop_w > 0 else 1.0
        zoom_y = self.out_h / crop_h if crop_h > 0 else 1.0
        zoom = min(zoom_x, zoom_y)

        # Use the median target as the lerp destination
        # zoompan's lerp will smoothly move from current to target each frame
        xs = [f.x for f in trajectory.frames]
        ys = [f.y for f in trajectory.frames]
        start_x = xs[0]
        start_y = ys[0]
        # Use the trajectory's EMA-smoothed final position as target
        end_x = xs[-1]
        end_y = ys[-1]

        # Lerp speed (lower = smoother): 0.05 gives ~20 frame lag
        lerp_speed = 0.06

        # zoompan filter: z=zoom, x/y use lerp for smooth motion
        # 'd=1' = 1 output frame per input frame (no duration extension)
        zoompan = (
            f"zoompan="
            f"z={zoom:.4f}:"
            f"x='if(eq(on\\,1)\\,{start_x:.1f}\\,lerp(x\\,{end_x:.1f}\\,{lerp_speed}))':"
            f"y='if(eq(on\\,1)\\,{start_y:.1f}\\,lerp(y\\,{end_y:.1f}\\,{lerp_speed}))':"
            f"d=1:s={self.out_w}x{self.out_h}:fps={fps:.0f}"
        )

        return zoompan

    def to_split_filter(self, trajectory: CameraTrajectory, fps: float) -> str:
        """Generate filter_complex for smooth split-screen.

        Uses pre-computed EMA-smoothed positions for top and bottom panels.
        Falls back to median positions for stability.
        """
        half_h = self.out_h // 2

        if trajectory.top_frames and trajectory.bottom_frames:
            # Use median positions (already EMA-smoothed during planning)
            top_xs = sorted(f.x for f in trajectory.top_frames)
            top_ys = sorted(f.y for f in trajectory.top_frames)
            bot_xs = sorted(f.x for f in trajectory.bottom_frames)
            bot_ys = sorted(f.y for f in trajectory.bottom_frames)

            top_x = top_xs[len(top_xs) // 2]
            top_y = top_ys[len(top_ys) // 2]
            bot_x = bot_xs[len(bot_xs) // 2]
            bot_y = bot_ys[len(bot_ys) // 2]
            crop_w = trajectory.top_frames[0].w
            crop_h = trajectory.top_frames[0].h
        else:
            # Fallback: center crops
            crop_w = self.out_w * (self.frame_h / 1.6) / half_h
            crop_h = self.frame_h / 1.6
            if crop_w >= self.frame_w * 0.98:
                crop_w = float(self.frame_w)
                crop_h = crop_w * half_h / self.out_w
            top_x = (self.frame_w - crop_w) / 2
            top_y = (self.frame_h - crop_h) / 2
            bot_x = top_x
            bot_y = top_y

        top = f"[0:v]crop={crop_w:.1f}:{crop_h:.1f}:{top_x:.1f}:{top_y:.1f},scale={self.out_w}:{half_h}[top]"
        bottom = f"[0:v]crop={crop_w:.1f}:{crop_h:.1f}:{bot_x:.1f}:{bot_y:.1f},scale={self.out_w}:{half_h}[bottom]"

        return f"{top};{bottom};[top][bottom]vstack=inputs=2[v]"
