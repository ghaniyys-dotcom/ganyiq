#!/usr/bin/env python3
"""
face-detect-v2.py — YOLOv8-face ONNX face detector for GANYIQ worker V2.

V2 Changes:
  - Uses YOLOv8-face (ONNX) for accurate face detection with 5 landmarks
  - Returns confidence scores per face
  - Handles profile faces, tilted heads, occluded faces
  - Falls back to Haar Cascade if ONNX model unavailable

Usage:
  python3 face-detect-v2.py <video_path> <output_json_path> [sample_rate]
    [--start-time SEC] [--end-time SEC] [--model-path PATH]

Output format (V2):
  [
    {
      "time": 0.0,
      "face_count": 2,
      "faces": [
        {"cx": 320.0, "cy": 360.0, "w": 200, "h": 200, "confidence": 0.92,
         "landmarks": {"le": [280,340], "re": [360,340], "n": [320,380],
                       "lm": [300,400], "rm": [340,400]}},
        ...
      ]
    },
    ...
  ]
"""

import json
import sys
import os
import argparse
import urllib.request
import hashlib
from pathlib import Path


# Model info
YOLOV8_FACE_URL = "https://github.com/derronqi/yolov8-face/releases/download/v1.0/yolov8n-face.onnx"
MODEL_FILENAME = "yolov8n-face.onnx"
MODEL_SHA256 = ""  # Optional: set for verification


def download_model(model_dir: str) -> str:
    """Download YOLOv8-face ONNX model if not present."""
    model_path = os.path.join(model_dir, MODEL_FILENAME)

    if os.path.exists(model_path):
        file_size = os.path.getsize(model_path)
        if file_size > 1000000:  # > 1MB — looks valid
            print(f"[INFO] Model found at {model_path} ({file_size // 1024 // 1024} MB)", file=sys.stderr)
            return model_path
        else:
            print(f"[WARN] Model file too small ({file_size} bytes), re-downloading...", file=sys.stderr)

    print(f"[INFO] Downloading YOLOv8-face model ({YOLOV8_FACE_URL})...", file=sys.stderr)
    try:
        urllib.request.urlretrieve(YOLOV8_FACE_URL, model_path)
        file_size = os.path.getsize(model_path)
        print(f"[INFO] Downloaded {file_size // 1024 // 1024} MB", file=sys.stderr)
        return model_path
    except Exception as e:
        print(f"[WARN] Model download failed: {e}", file=sys.stderr)
        return ""


def load_onnx_model(model_path: str):
    """Load ONNX model and return session."""
    try:
        import onnxruntime
        session = onnxruntime.InferenceSession(
            model_path,
            providers=['CPUExecutionProvider']
        )
        input_name = session.get_inputs()[0].name
        input_shape = session.get_inputs()[0].shape
        print(f"[INFO] ONNX model loaded: input={input_name}, shape={input_shape}", file=sys.stderr)
        return session, input_name
    except Exception as e:
        print(f"[WARN] ONNX load failed: {e}", file=sys.stderr)
        return None, None


def yolo_detect_faces(session, input_name, frame, conf_threshold=0.15):
    """Run YOLOv8-face inference on a frame."""
    import cv2
    import numpy as np

    orig_h, orig_w = frame.shape[:2]
    input_w, input_h = 640, 640

    # Preprocess: resize + pad to 640x640
    scale = min(input_w / orig_w, input_h / orig_h)
    new_w = int(orig_w * scale)
    new_h = int(orig_h * scale)
    resized = cv2.resize(frame, (new_w, new_h))

    # Pad to square
    dw = input_w - new_w
    dh = input_h - new_h
    padded = cv2.copyMakeBorder(resized, 0, dh, 0, dw, cv2.BORDER_CONSTANT, value=(114, 114, 114))

    # Normalize + convert to NCHW
    blob = cv2.dnn.blobFromImage(padded, 1.0 / 255.0, (input_w, input_h),
                                  swapRB=True, crop=False)

    # Inference
    outputs = session.run(None, {input_name: blob})
    predictions = outputs[0][0]  # shape: [84, 8400] for YOLOv8-face

    # Decode predictions
    faces = []
    img_h, img_w = padded.shape[:2]

    for pred_idx in range(predictions.shape[1]):
        pred = predictions[:, pred_idx]

        # YOLOv8-face: [cx, cy, w, h, conf, ...landmarks]
        confidence = float(pred[4])
        if confidence < conf_threshold:
            continue

        cx, cy, w, h = pred[0], pred[1], pred[2], pred[3]

        # Scale back to padded image coordinates
        cx *= img_w
        cy *= img_h
        w *= img_w
        h *= img_h

        # Convert to original image coordinates (undo padding)
        cx = (cx - dw / 2) / scale
        cy = (cy - dh / 2) / scale
        w = w / scale
        h = h / scale

        # Clamp
        cx = max(0, min(orig_w, cx))
        cy = max(0, min(orig_h, cy))
        w = max(10, min(orig_w, w))
        h = max(10, min(orig_h, h))

        # Extract landmarks (indices 5-14: 5 landmarks * 2 coords)
        landmarks = {}
        landmark_names = ['le', 're', 'n', 'lm', 'rm']  # left_eye, right_eye, nose, left_mouth, right_mouth
        for i, name in enumerate(landmark_names):
            lx = (float(pred[5 + i * 2]) * img_w - dw / 2) / scale
            ly = (float(pred[5 + i * 2 + 1]) * img_h - dh / 2) / scale
            landmarks[name] = [round(lx, 1), round(ly, 1)]

        faces.append({
            "cx": round(cx, 1),
            "cy": round(cy, 1),
            "w": int(round(w)),
            "h": int(round(h)),
            "confidence": round(confidence, 4),
            "landmarks": landmarks,
        })

    return faces


def haar_detect_faces(frame):
    """Fallback: Haar Cascade face detection."""
    import cv2

    cascade_path = cv2.data.haarcascades + 'haarcascade_frontalface_default.xml'
    if not os.path.exists(cascade_path):
        local_cascade = os.path.join(os.path.dirname(__file__), 'haarcascade_frontalface_default.xml')
        if os.path.exists(local_cascade):
            cascade_path = local_cascade
        else:
            return []

    face_cascade = cv2.CascadeClassifier(cascade_path)
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    faces = face_cascade.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=5, minSize=(60, 60))

    results = []
    for (x, y, w, h) in faces:
        results.append({
            "cx": round(x + w / 2.0, 1),
            "cy": round(y + h / 2.0, 1),
            "w": int(w),
            "h": int(h),
            "confidence": round(0.5, 4),  # Haar has no confidence, use fixed low value
            "landmarks": {
                "le": [round(x + w * 0.3, 1), round(y + h * 0.35, 1)],
                "re": [round(x + w * 0.7, 1), round(y + h * 0.35, 1)],
                "n": [round(x + w * 0.5, 1), round(y + h * 0.55, 1)],
                "lm": [round(x + w * 0.35, 1), round(y + h * 0.7, 1)],
                "rm": [round(x + w * 0.65, 1), round(y + h * 0.7, 1)],
            },
        })
    return results


def main():
    parser = argparse.ArgumentParser(description='Detect faces in video (V2)')
    parser.add_argument('video_path', help='Path to video file')
    parser.add_argument('output_path', help='Path to output JSON')
    parser.add_argument('sample_rate', nargs='?', type=float, default=1.0,
                        help='Sample rate in fps (default: 1.0)')
    parser.add_argument('--start-time', type=float, default=None,
                        help='Start time in seconds')
    parser.add_argument('--end-time', type=float, default=None,
                        help='End time in seconds')
    parser.add_argument('--model-path', type=str, default=None,
                        help='Path to YOLOv8-face ONNX model')
    parser.add_argument('--no-yolo', action='store_true',
                        help='Skip YOLO, use Haar Cascade fallback')

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
        sys.exit(2)

    try:
        import numpy as np
    except ImportError:
        print("ERROR: numpy not installed.", file=sys.stderr)
        sys.exit(2)

    # Try YOLOv8-face, fall back to Haar
    use_yolo = not args.no_yolo
    session, input_name = None, None

    if use_yolo:
        model_path = args.model_path or os.path.join(os.path.dirname(__file__), MODEL_FILENAME)
        if not os.path.exists(model_path) or os.path.getsize(model_path) < 1000000:
            model_path = download_model(os.path.dirname(__file__))

        if model_path and os.path.exists(model_path):
            session, input_name = load_onnx_model(model_path)

        if session is None:
            use_yolo = False
            print("[INFO] Falling back to Haar Cascade detector", file=sys.stderr)

    if use_yolo:
        print("[INFO] Using YOLOv8-face ONNX detector", file=sys.stderr)
    else:
        print("[INFO] Using Haar Cascade detector (V1 fallback)", file=sys.stderr)

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        print(f"Error: cannot open video: {video_path}", file=sys.stderr)
        sys.exit(4)

    fps = cap.get(cv2.CAP_PROP_FPS)
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))

    # Calculate frame range
    if args.start_time is not None and args.end_time is not None:
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

            if use_yolo and session:
                faces = yolo_detect_faces(session, input_name, frame)
            else:
                faces = haar_detect_faces(frame)

            results.append({
                "time": round(time_sec, 2),
                "face_count": len(faces),
                "faces": faces,
                "detector": "yolov8-face" if use_yolo else "haar",
            })

        frame_idx += 1

        if total_to_process > 0 and (frame_idx - start_frame) % 200 == 0:
            pct = int((frame_idx - start_frame) / total_to_process * 100)
            print(f"[PROGRESS] {pct}% ({frame_idx - start_frame}/{total_to_process} frames)", file=sys.stderr)

    cap.release()

    with open(output_path, 'w') as f:
        json.dump(results, f)

    total_detected = sum(1 for r in results if r["face_count"] > 0)
    avg_conf = 0.0
    total_faces = sum(r["face_count"] for r in results)
    if total_faces > 0:
        sum_conf = sum(
            face["confidence"]
            for r in results
            for face in r["faces"]
        )
        avg_conf = sum_conf / total_faces

    print(f"[DONE] Processed {len(results)} samples, {total_detected} with faces, "
          f"avg confidence={avg_conf:.3f}, detector={results[0]['detector'] if results else 'none'}",
          file=sys.stderr)


if __name__ == '__main__':
    main()
