#!/usr/bin/env python3
"""
hybrid-face-detector.py — GANYIQ Hybrid Face Detector
Combines YOLOv8-face + MediaPipe Face Mesh for robust speaker tracking.
"""

import json
import math
import sys
import os
import argparse
import urllib.request
from pathlib import Path

# ... (YOLOv8-face functions are the same) ...
YOLOV8_FACE_URL = (
    "https://github.com/akanametov/yolo-face/releases/download/1.0.0/"
    "yolov10n-face.onnx"
)
MODEL_FILENAME = "yolov8n-face.onnx"
MP_FACE_MODEL = "face_landmarker.task"

def download_model(model_dir: str, url: str, filename: str, min_size=1_000_000) -> str:
    model_path = os.path.join(model_dir, filename)
    if os.path.exists(model_path) and os.path.getsize(model_path) > min_size:
        return model_path
    print(f"[INFO] Downloading {filename}...", file=sys.stderr)
    try:
        urllib.request.urlretrieve(url, model_path)
        return model_path
    except Exception as e:
        print(f"[WARN] Download failed: {e}", file=sys.stderr)
        return ""

def load_yolo_session(model_path: str):
    try:
        import onnxruntime
        providers = ["CUDAExecutionProvider", "CPUExecutionProvider"]
        session = onnxruntime.InferenceSession(model_path, providers=providers)
        return session, session.get_inputs()[0].name
    except Exception as e:
        print(f"[WARN] YOLO load failed: {e}", file=sys.stderr)
        return None, None

def yolo_detect_faces(session, input_name, frame, conf_threshold=0.25):
    import cv2
    import numpy as np
    # ... (same implementation as before)
    orig_h, orig_w = frame.shape[:2]
    input_w, input_h = 640, 640
    scale = min(input_w / orig_w, input_h / orig_h)
    new_w, new_h = int(orig_w * scale), int(orig_h * scale)
    resized = cv2.resize(frame, (new_w, new_h))
    dw, dh = input_w - new_w, input_h - new_h
    padded = cv2.copyMakeBorder(resized, 0, dh, 0, dw, cv2.BORDER_CONSTANT, value=(114, 114, 114))
    blob = cv2.dnn.blobFromImage(padded, 1.0 / 255.0, (input_w, input_h), swapRB=True, crop=False)
    outputs = session.run(None, {input_name: blob})
    raw = outputs[0][0]
    faces = []
    # ... (the rest of yolo_detect_faces logic)
    return faces
# ...

def load_mediapipe(mode='VIDEO'):
    try:
        import mediapipe as mp
        from mediapipe.tasks import python
        from mediapipe.tasks.python import vision

        model_dir = os.path.join(os.path.dirname(__file__), "models")
        os.makedirs(model_dir, exist_ok=True)
        model_path = os.path.join(model_dir, MP_FACE_MODEL)

        if not os.path.exists(model_path) or os.path.getsize(model_path) < 100_000:
            mp_url = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task"
            print(f"[INFO] Downloading MediaPipe model...", file=sys.stderr)
            urllib.request.urlretrieve(mp_url, model_path)

        running_mode = vision.RunningMode.VIDEO if mode == 'VIDEO' else vision.RunningMode.IMAGE
        options = vision.FaceLandmarkerOptions(
            base_options=python.BaseOptions(model_asset_path=model_path),
            running_mode=running_mode,
        )
        landmarker = vision.FaceLandmarker.create_from_options(options)
        print(f"[INFO] MediaPipe Landmarker loaded (mode: {mode})", file=sys.stderr)
        return landmarker
    except Exception as e:
        print(f"[WARN] MediaPipe init failed (mode: {mode}): {e}", file=sys.stderr)
        return None

def is_real_face(validator_landmarker, frame, bbox: dict):
    """Validate if a bbox contains a real face using MediaPipe landmarks."""
    if not validator_landmarker: return True # Cannot validate, assume true
    import mediapipe as mp
    import cv2

    x1 = int(bbox['cx'] - bbox['w'] / 2)
    y1 = int(bbox['cy'] - bbox['h'] / 2)
    x2 = int(bbox['cx'] + bbox['w'] / 2)
    y2 = int(bbox['cy'] + bbox['h'] / 2)
    
    face_crop = frame[max(0, y1):min(frame.shape[0], y2), max(0, x1):min(frame.shape[1], x2)]
    if face_crop.size == 0: return False
        
    rgb_crop = cv2.cvtColor(face_crop, cv2.COLOR_BGR2RGB)
    mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb_crop)
    
    detection_result = validator_landmarker.detect(mp_image)
    
    return detection_result is not None and len(detection_result.face_landmarks) > 0

# ... (other helper functions like extract_mp_faces, face_iou, etc.)

def process_video(
    video_path: str,
    output_path: str,
    sample_rate: float = 3.0,
    conf_threshold: float = 0.4,
    # ... other args
):
    import cv2
    import numpy as np

    # ... (video open logic)

    # --- Load Models ---
    model_dir = os.path.dirname(os.path.abspath(__file__))
    yolo_path = download_model(model_dir, YOLOV8_FACE_URL, MODEL_FILENAME)
    yolo_session, input_name = load_yolo_session(yolo_path) if yolo_path else (None, None)
    
    # VIDEO landmarker for main processing
    mp_video_landmarker = load_mediapipe(mode='VIDEO')
    # IMAGE landmarker for validation
    mp_image_landmarker = load_mediapipe(mode='IMAGE')
    
    # ... (tracker, clusterer setup)

    while frame_idx < end_frame:
        ret, frame = cap.read()
        if not ret: break

        if (frame_idx - start_frame) % frame_interval == 0:
            time_sec = frame_idx / fps

            yolo_faces = yolo_detect_faces(yolo_session, input_name, frame, conf_threshold) if yolo_session else []
            
            # --- VALIDATION GATE ---
            validated_faces = [
                face for face in yolo_faces 
                if is_real_face(mp_image_landmarker, frame, face)
            ]
            
            if len(yolo_faces) > len(validated_faces):
                print(f"[DEBUG] Rejected {len(yolo_faces) - len(validated_faces)} false positives at t={time_sec:.1f}s", file=sys.stderr)

            # --- From now on, use `validated_faces` ---
            all_faces = list(validated_faces)

            # ... (the rest of the processing loop uses `all_faces`) ...
            # Merge with mediapipe main detector, track, etc.
            # ...
    
    # ... (write results)

# ... (main entrypoint)
