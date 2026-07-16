"""
render_utils.py — Video rendering helpers for GANYIQ pipeline.

Contains:
  - CameraSmoother: exponential moving average for smooth camera pan
  - build_crop_filter(): ffmpeg crop filter for head-and-shoulders / vertical
  - build_split_filter(): ffmpeg filter_complex for split-screen vertical
  - build_two_shot_filter(): ffmpeg crop filter for two-shot framing

All functions produce ffmpeg filter strings with identical output to the
original Pipeline methods (extracted verbatim).
"""


class CameraSmoother:
    """Exponential moving average for smooth camera pan (FASE 13)."""

    def __init__(self, alpha: float = 0.2):
        self.alpha = alpha
        self.reset()

    def reset(self):
        self._cx = None
        self._cy = None

    def smooth(self, cx: float, cy: float) -> tuple[float, float]:
        if self._cx is None:
            self._cx, self._cy = cx, cy
        else:
            self._cx = self._cx * (1 - self.alpha) + cx * self.alpha
            self._cy = self._cy * (1 - self.alpha) + cy * self.alpha
        return self._cx, self._cy


def build_crop_filter(bbox, frame_w: int, frame_h: int,
                      out_w: int, out_h: int,
                      vertical: bool, layout: str = "") -> str:
    """Build ffmpeg crop filter: vertical=9:16 strip, landscape=head-and-shoulders.

    Signature matches the original Pipeline._build_crop_filter.
    """
    if not bbox:
        vx = (frame_w - frame_h * 9 / 16) / 2 if vertical else 0
        return f"crop={frame_h*9/16:.0f}:{frame_h}:{vx:.0f}:0,scale={out_w}:{out_h}" if vertical else f"scale={out_w}:{out_h}"
    if vertical:
        vw = frame_h * 9 / 16
        vx = max(0.0, min(bbox["cx"] - vw / 2, frame_w - vw))
        vy = max(0.0, min(bbox["cy"] - frame_h * 0.35, frame_h - frame_h * 0.15))
        return f"crop={vw:.0f}:{frame_h}:{vx:.0f}:0,scale={out_w}:{out_h}"
    cw = min(frame_w, max(100, bbox["w"] * 4))
    ch = min(frame_h, max(100, bbox["h"] * 4))
    cx = max(0.0, min(bbox["cx"] - cw / 2, frame_w - cw))
    cy = max(0.0, min(bbox["cy"] - ch * 0.35, frame_h - ch))
    return f"crop={cw:.0f}:{ch:.0f}:{cx:.0f}:{cy:.0f},scale={out_w}:{out_h}"


def build_split_filter(bbox_top, bbox_bottom,
                       frame_w: int, frame_h: int,
                       out_w: int, out_h: int) -> str:
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


def build_two_shot_filter(bbox_primary, bbox_secondary,
                          frame_w: int, frame_h: int,
                          out_w: int, out_h: int) -> str:
    """Build ffmpeg crop filter for two_shot_wide (9:16 aspect ratio).

    Frames both speakers in a single wide vertical shot by calculating
    a bounding box that spans both speakers.
    """
    if not bbox_primary and not bbox_secondary:
        vx = (frame_w - frame_h * 9 / 16) / 2
        return f"crop={frame_h*9/16:.0f}:{frame_h}:{vx:.0f}:0,scale={out_w}:{out_h}"

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

    return f"crop={target_w:.0f}:{target_h:.0f}:{vx:.0f}:{vy:.0f},scale={out_w}:{out_h}"
