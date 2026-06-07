#!/usr/bin/env python3
"""
face-detect.py — OpenCV Haar Cascade face detector for GANYIQ worker.

Usage:
  python3 face-detect.py <video_path> <output_json_path> [sample_rate]

Detects faces in video at `sample_rate` fps (default: 1 fps).
Writes JSON array to output_json_path.

Output format:
  [
    {"time": 0.0, "cx": 640.0, "cy": 360.0, "w": 200.0, "h": 200.0, "face_count": 1},
    {"time": 1.0, "cx": 642.0, "cy": 358.0, "w": 198.0, "h": 198.0, "face_count": 1},
    ...
    {"time": 1.0, "cx": null, "cy": null, "w": 0, "h": 0, "face_count": 0},
    ...
  ]

Where cx, cy = center of the dominant (largest) face in pixels.
cx = null when no face detected.
"""

import json
import sys
import os

def main():
    if len(sys.argv) < 3:
        print("Usage: face-detect.py <video_path> <output_json_path> [sample_rate]", file=sys.stderr)
        sys.exit(1)

    video_path = sys.argv[1]
    output_path = sys.argv[2]
    sample_rate = float(sys.argv[3]) if len(sys.argv) > 3 else 1.0  # frames per second

    if not os.path.exists(video_path):
        print(f"Error: video not found: {video_path}", file=sys.stderr)
        sys.exit(1)

    # Try import OpenCV with helpful error
    try:
        import cv2
    except ImportError:
        print("ERROR: opencv-python not installed.", file=sys.stderr)
        print("Install with: pip install opencv-python", file=sys.stderr)
        sys.exit(2)

    # Load Haar cascade
    cascade_path = cv2.data.haarcascades + 'haarcascade_frontalface_default.xml'
    if not os.path.exists(cascade_path):
        # Fallback: bundled cascade in same directory
        local_cascade = os.path.join(os.path.dirname(__file__), 'haarcascade_frontalface_default.xml')
        if os.path.exists(local_cascade):
            cascade_path = local_cascade
        else:
            print(f"Error: Haar cascade not found at {cascade_path}", file=sys.stderr)
            sys.exit(3)

    face_cascade = cv2.CascadeClassifier(cascade_path)

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        print(f"Error: cannot open video: {video_path}", file=sys.stderr)
        sys.exit(4)

    fps = cap.get(cv2.CAP_PROP_FPS)
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    frame_interval = max(1, int(fps / sample_rate))
    results = []

    frame_idx = 0
    while True:
        ret, frame = cap.read()
        if not ret:
            break

        if frame_idx % frame_interval == 0:
            time_sec = frame_idx / fps
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)

            # Detect faces: scaleFactor=1.1, minNeighbors=5, minSize=(60,60)
            faces = face_cascade.detectMultiScale(
                gray,
                scaleFactor=1.1,
                minNeighbors=5,
                minSize=(60, 60),
            )

            if len(faces) > 0:
                # Pick the largest face (by area)
                largest = max(faces, key=lambda f: f[2] * f[3])
                x, y, w, h = largest
                cx = x + w / 2.0
                cy = y + h / 2.0
                results.append({
                    "time": round(time_sec, 2),
                    "cx": round(cx, 1),
                    "cy": round(cy, 1),
                    "w": int(w),
                    "h": int(h),
                    "face_count": len(faces),
                })
            else:
                results.append({
                    "time": round(time_sec, 2),
                    "cx": None,
                    "cy": None,
                    "w": 0,
                    "h": 0,
                    "face_count": 0,
                })

        frame_idx += 1

        # Progress indicator every 500 frames
        if frame_idx % 500 == 0:
            pct = int(frame_idx / total_frames * 100) if total_frames > 0 else 0
            print(f"[PROGRESS] {pct}% ({frame_idx}/{total_frames} frames)", file=sys.stderr)

    cap.release()

    with open(output_path, 'w') as f:
        json.dump(results, f)

    total_detected = sum(1 for r in results if r["cx"] is not None)
    print(f"[DONE] Processed {len(results)} samples, {total_detected} with faces", file=sys.stderr)


if __name__ == '__main__':
    main()
