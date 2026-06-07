#!/usr/bin/env python3
"""
face-detect.py — OpenCV Haar Cascade face detector for GANYIQ worker.
V2.4A: Returns ALL detected faces (not just the largest).
V2.4A-opt: Accept --start-time and --end-time for clip-range-only processing.

Usage:
  python3 face-detect.py <video_path> <output_json_path> [sample_rate] [--start-time SEC] [--end-time SEC]

Detects faces in video at `sample_rate` fps (default: 1 fps).
When --start-time and --end-time are given, only processes that window
(with 5s padding before start for identity establishment).

Output format (V2.4A):
  [
    {"time": 0.0, "face_count": 2, "faces": [
      {"cx": 320.0, "cy": 360.0, "w": 200, "h": 200},
      {"cx": 960.0, "cy": 380.0, "w": 180, "h": 180}
    ]},
    ...
  ]
"""

import json
import sys
import os
import argparse


def main():
    parser = argparse.ArgumentParser(description='Detect faces in video')
    parser.add_argument('video_path', help='Path to video file')
    parser.add_argument('output_path', help='Path to output JSON')
    parser.add_argument('sample_rate', nargs='?', type=float, default=1.0,
                        help='Sample rate in fps (default: 1.0)')
    parser.add_argument('--start-time', type=float, default=None,
                        help='Start time in seconds (clip range)')
    parser.add_argument('--end-time', type=float, default=None,
                        help='End time in seconds (clip range)')

    args = parser.parse_args()

    video_path = args.video_path
    output_path = args.output_path
    sample_rate = args.sample_rate

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

    # Calculate frame range
    if args.start_time is not None and args.end_time is not None:
        # Add 10s padding before start (for identity establishment) and 5s after
        process_start = max(0, args.start_time - 10)
        process_end = args.end_time + 5
        start_frame = int(process_start * fps)
        end_frame = min(total_frames, int(process_end * fps))
        print(f"[INFO] Clip range: {args.start_time}s-{args.end_time}s, "
              f"processing: {process_start:.0f}s-{process_end:.0f}s "
              f"(frames {start_frame}-{end_frame})", file=sys.stderr)
    else:
        start_frame = 0
        end_frame = total_frames
        print(f"[INFO] Full video: processing all {total_frames} frames", file=sys.stderr)

    # Seek to start frame
    if start_frame > 0:
        cap.set(cv2.CAP_PROP_POS_FRAMES, start_frame)

    frame_interval = max(1, int(fps / sample_rate))
    results = []
    frame_idx = start_frame
    total_to_process = end_frame - start_frame

    while frame_idx < end_frame:
        ret, frame = cap.read()
        if not ret:
            break

        if (frame_idx - start_frame) % frame_interval == 0:
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

        # Progress indicator
        if total_to_process > 0 and (frame_idx - start_frame) % 200 == 0:
            pct = int((frame_idx - start_frame) / total_to_process * 100)
            print(f"[PROGRESS] {pct}% ({frame_idx - start_frame}/{total_to_process} frames)", file=sys.stderr)

    cap.release()

    with open(output_path, 'w') as f:
        json.dump(results, f)

    total_detected = sum(1 for r in results if r["face_count"] > 0)
    print(f"[DONE] Processed {len(results)} samples, {total_detected} with faces detected", file=sys.stderr)


if __name__ == '__main__':
    main()
