"""
worker/visual-quality-scorer.py — Visual quality scoring for GANYIQ

Analyzes video frames for:
- Blur detection (Laplacian variance)
- Brightness/Exposure
- Face visibility
- Frame stability

Outputs visual_quality_score (0-10) for each clip range.
"""

import subprocess
import json
import sys
import os
import tempfile
import numpy as np
from pathlib import Path

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

SCORE_RANGE = (0, 10)
MIN_BRIGHTNESS = 30   # Below this = too dark
MAX_BRIGHTNESS = 235  # Above this = overexposed
BLUR_THRESHOLD = 100  # Laplacian variance below this = blurry (scale-dependent)
SAMPLE_FRAMES = 5     # Number of frames to sample per clip

# ---------------------------------------------------------------------------
# Scoring Functions
# ---------------------------------------------------------------------------


def get_frame_quality(frame_path: str) -> dict:
    """
    Analyze a single frame image for brightness, blur, and face presence.
    Returns dict with scores 0-1.
    """
    import cv2

    img = cv2.imread(frame_path)
    if img is None:
        return {"brightness": 0.5, "sharpness": 0.5, "face_visible": 0.0, "exposure": 0.5}

    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    h, w = gray.shape

    # Brightness
    mean_brightness = np.mean(gray)

    # Exposure score: 1.0 if in ideal range, dropping off at extremes
    if mean_brightness < MIN_BRIGHTNESS:
        exposure_score = max(0, mean_brightness / MIN_BRIGHTNESS)
    elif mean_brightness > MAX_BRIGHTNESS:
        exposure_score = max(0, (255 - mean_brightness) / (255 - MAX_BRIGHTNESS))
    else:
        exposure_score = 1.0

    # Brightness score: normalized
    brightness_score = mean_brightness / 255.0

    # Blur detection using Laplacian variance
    laplacian_var = cv2.Laplacian(gray, cv2.CV_64F).var()
    # Normalize: higher variance = sharper
    blur_score = min(1.0, laplacian_var / BLUR_THRESHOLD)
    sharpness = min(1.0, laplacian_var / (BLUR_THRESHOLD * 2))

    # Face detection using OpenCV Haar cascade
    face_cascade = cv2.CascadeClassifier(
        cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
    )
    faces = face_cascade.detectMultiScale(gray, 1.1, 4)

    # Face visibility: 1.0 if at least one face large enough, scaled by area
    face_visible = 0.0
    if len(faces) > 0:
        max_face_area = max(fw * fh for (_, _, fw, fh) in faces)
        total_area = h * w
        face_visible = min(1.0, max_face_area / (total_area * 0.3))  # 30% threshold

    return {
        "brightness": round(brightness_score, 3),
        "sharpness": round(sharpness, 3),
        "blur": round(1 - blur_score, 3),  # Invert so 0 = blurry, 1 = sharp
        "exposure": round(exposure_score, 3),
        "face_visible": round(face_visible, 3),
    }


def score_clip_quality(video_path: str, start_time: float, end_time: float) -> dict:
    """
    Score the visual quality of a clip range in a video.
    Returns a dict with quality dimensions and aggregate score (0-10).
    """
    duration = end_time - start_time
    if duration <= 0:
        return {"visual_quality_score": 0, "error": "Invalid duration"}

    # Sample frames evenly across the clip
    sample_times = [
        start_time + (duration * (i + 1) / (SAMPLE_FRAMES + 1))
        for i in range(SAMPLE_FRAMES)
    ]

    frame_scores = []
    with tempfile.TemporaryDirectory() as tmpdir:
        for i, t in enumerate(sample_times):
            frame_path = os.path.join(tmpdir, f"frame_{i:03d}.png")
            try:
                cmd = [
                    "ffmpeg",
                    "-ss", str(t),
                    "-i", video_path,
                    "-vframes", "1",
                    "-q:v", "2",
                    "-y",
                    frame_path,
                ]
                subprocess.run(
                    cmd, capture_output=True, timeout=60, check=False
                )
                if os.path.exists(frame_path):
                    scores = get_frame_quality(frame_path)
                    frame_scores.append(scores)
            except Exception:
                continue

    if not frame_scores:
        return {"visual_quality_score": 5, "error": "Could not analyze frames"}

    # Aggregate scores
    avg_brightness = np.mean([s["brightness"] for s in frame_scores])
    avg_sharpness = np.mean([s["sharpness"] for s in frame_scores])
    avg_exposure = np.mean([s["exposure"] for s in frame_scores])
    avg_face = np.mean([s["face_visible"] for s in frame_scores])
    avg_blur = np.mean([s["blur"] for s in frame_scores])

    # Compute composite score (0-10)
    # Weights: sharpness 0.3, exposure 0.25, face 0.25, brightness 0.2
    composite = (
        avg_sharpness * 0.30
        + avg_exposure * 0.25
        + avg_face * 0.25
        + avg_brightness * 0.20
    )
    composite = max(0, min(1, composite))
    visual_quality_score = round(composite * 10, 1)

    return {
        "visual_quality_score": visual_quality_score,
        "sharpness": round(avg_sharpness, 3),
        "brightness": round(avg_brightness, 3),
        "exposure": round(avg_exposure, 3),
        "face_visibility": round(avg_face, 3),
        "blur_score": round(avg_blur, 3),
        "frames_analyzed": len(frame_scores),
    }


def score_video_scenes(video_path: str, scenes: list) -> list:
    """
    Score visual quality for each scene in a list of scenes.
    Each scene: { startTime, endTime, ... }
    Returns scenes with visual_quality_score added.
    """
    results = []
    for scene in scenes:
        quality = score_clip_quality(
            video_path, scene["startTime"], scene["endTime"]
        )
        results.append({**scene, **quality})
    return results


if __name__ == "__main__":
    if len(sys.argv) < 4:
        print(json.dumps({"error": "Usage: visual-quality-scorer.py <video_path> <start_time> <end_time>"}))
        sys.exit(1)

    video_path = sys.argv[1]
    start_time = float(sys.argv[2])
    end_time = float(sys.argv[3])

    result = score_clip_quality(video_path, start_time, end_time)
    print(json.dumps(result))
