#!/usr/bin/env python3
"""
face-detect.py — OpenCV Haar Cascade face detector for GANYIQ worker.
V2.4A: Returns ALL detected faces (not just the largest).

Usage:
  python3 face-detect.py <video_path> <output_json_path> [sample_rate]

Detects faces in video at `sample_rate` fps (default: 1 fps).
Writes JSON array to output_json_path.

Output format (V2.4A):
  [
    {"time": 0.0, "face_count": 2, "faces": [
      {"cx": 320.0, "cy": 360.0, "w": 200, "h": 200},
      {"cx": 960.0, "cy": 380.0, "w": 180, "h": 180}
    ]},
    {"time": 1.0, "face_count": 0, "faces": []},
    ...
  ]

Where cx, cy = center of each face in pixels.
faces is empty array when no face detected.
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
    sample_rate = float(sys.argv[3]) if len(sys.argv) > 3 else 1.0

    if not os.path.exists(video_path):
        print(f"Error: video not found: {video_path}", file=sys.stderr)
        sys.exit(1)

    try:
        import cv2
    except ImportError:
        print("ERROR: opencv-python not installed.", file=sys.stderr)
        print("Install with: pip install opencv-python", file=sys.stderr)
        sys.exit(2)

    # Load Haar cascade
    cascade_path = cv2.data.haarcascades + 'haarcascade_frontalface_default.xml'
    if not os.path.exists(cascade_path):
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

            # Detect all faces
            faces = face_cascade.detectMultiScale(
                gray,
                scaleFactor=1.1,
                minNeighbors=5,
                minSize=(60, 60),
            )

            # V2.4A: Save ALL faces (not just largest)
            all_faces = []
            if len(faces) > 0:
                for (x, y, w, h) in faces:
                    cx = x + w / 2.0
                    cy = y + h / 2.0
                    all_faces.append({
                        "cx": round(cx, 1),
                        "cy": round(cy, 1),
                        "w": int(w),
                        "h": int(h),
                    })

            results.append({
                "time": round(time_sec, 2),
                "face_count": len(all_faces),
                "faces": all_faces,
            })

        frame_idx += 1

        # Progress indicator every 500 frames
        if frame_idx % 500 == 0:
            pct = int(frame_idx / total_frames * 100) if total_frames > 0 else 0
            print(f"[PROGRESS] {pct}% ({frame_idx}/{total_frames} frames)", file=sys.stderr)

    cap.release()

    with open(output_path, 'w') as f:
        json.dump(results, f)

    total_detected = sum(1 for r in results if r["face_count"] > 0)
    print(f"[DONE] Processed {len(results)} samples, {total_detected} with faces detected", file=sys.stderr)


if __name__ == '__main__':
    main()
