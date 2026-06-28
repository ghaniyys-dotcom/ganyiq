#!/usr/bin/env python3
"""
hybrid-face-detector.py — GANYIQ Hybrid Face Detector
Combines YOLOv8-face + MediaPipe Face Mesh for robust speaker tracking.

Usage:
  python3 hybrid-face-detector.py <video_path> <output_json_path> [options]

Output:
  JSON with per-frame face detections + landmarks + speaker IDs

Pipeline:
  1. YOLOv8-face → accurate face bounding boxes + 5 landmarks
  2. MediaPipe Face Mesh → 468-point face mesh + lip/eye tracking
  3. Face embedding extraction → speaker clustering
  4. Frame-to-frame tracking → consistent speaker IDs
"""

import json
import math
import sys
import os
import argparse
import urllib.request
from pathlib import Path

# =============================================================================
# YOLOv8-face (from face-detect-v2.py)
# =============================================================================

YOLOV8_FACE_URL = (
    "https://github.com/akanametov/yolo-face/releases/download/1.0.0/"
    "yolov10n-face.onnx"
)
MODEL_FILENAME = "yolov8n-face.onnx"

# MediaPipe model paths
MP_FACE_MODEL = "face_landmarker.task"


def download_model(model_dir: str, url: str, filename: str, min_size=1_000_000) -> str:
    """Download model file if not present."""
    model_path = os.path.join(model_dir, filename)
    if os.path.exists(model_path) and os.path.getsize(model_path) > min_size:
        print(f"[INFO] Model found: {model_path}", file=sys.stderr)
        return model_path
    print(f"[INFO] Downloading {filename}...", file=sys.stderr)
    try:
        urllib.request.urlretrieve(url, model_path)
        return model_path
    except Exception as e:
        print(f"[WARN] Download failed: {e}", file=sys.stderr)
        return ""


def load_yolo_session(model_path: str):
    """Load YOLOv8-face ONNX model. Prefers CUDA if available."""
    try:
        import onnxruntime
        providers = []
        # Try CUDA first
        try:
            if "CUDAExecutionProvider" in onnxruntime.get_available_providers():
                providers.append("CUDAExecutionProvider")
                print("[INFO] Using CUDA for ONNX inference", file=sys.stderr)
        except Exception:
            pass
        providers.append("CPUExecutionProvider")  # fallback
        session = onnxruntime.InferenceSession(
            model_path, providers=providers
        )
        input_name = session.get_inputs()[0].name
        print(
            f"[INFO] YOLO loaded: input={input_name}, "
            f"shape={session.get_inputs()[0].shape}",
            file=sys.stderr,
        )
        return session, input_name
    except Exception as e:
        print(f"[WARN] YOLO load failed: {e}", file=sys.stderr)
        return None, None


def yolo_detect_faces(session, input_name, frame, conf_threshold=0.25):
    """
    Run YOLO face ONNX inference on a frame.
    Auto-detects output format: YOLOv8 [84, N] or YOLOv10 [N, 6].
    Returns list of {cx, cy, w, h, confidence, landmarks}.
    """
    import cv2
    import numpy as np

    orig_h, orig_w = frame.shape[:2]
    input_w, input_h = 640, 640

    # Resize + pad to 640x640
    scale = min(input_w / orig_w, input_h / orig_h)
    new_w = int(orig_w * scale)
    new_h = int(orig_h * scale)
    resized = cv2.resize(frame, (new_w, new_h))

    dw = input_w - new_w
    dh = input_h - new_h
    padded = cv2.copyMakeBorder(
        resized, 0, dh, 0, dw, cv2.BORDER_CONSTANT, value=(114, 114, 114)
    )

    # Normalize → NCHW
    blob = cv2.dnn.blobFromImage(
        padded, 1.0 / 255.0, (input_w, input_h), swapRB=True, crop=False
    )

    # Inference
    outputs = session.run(None, {input_name: blob})
    raw = outputs[0][0]  # shape varies by model version

    # Detect format based on shape
    # YOLOv8: [84, 8400]  - 4bbox+1conf+10landmarks+69classes
    # YOLOv10: [300, 6]   - x1,y1,x2,y2,conf,class
    is_v10 = raw.shape[-1] == 6

    faces = []
    img_h, img_w = padded.shape[:2]

    if is_v10:
        # ── YOLOv10 format: [300, 6] ──
        # Coordinates are absolute pixel values (0-640) on 640x640 input
        # Padding is ONLY at bottom/right (BORDER_CONSTANT), NOT symmetric,
        # so dw/2 and dh/2 offsets are WRONG. Correct: divide by scale.
        if raw.shape[0] == 6 and raw.shape[1] > 6:
            raw = raw.T  # ensure (N, 6)
        for pred in raw:
            x1, y1, x2, y2, confidence, cls_id = pred
            confidence = float(confidence)
            if confidence < conf_threshold:
                continue
            # Convert xyxy → cxcywh in padded 640x640 space
            cx = (float(x1) + float(x2)) / 2
            cy = (float(y1) + float(y2)) / 2
            w = float(x2) - float(x1)
            h = float(y2) - float(y1)
            # Map from padded 640x640 → original frame
            # (coords are absolute 0-640 pixels, padding only right/bottom)
            cx = cx / scale
            cy = cy / scale
            w = w / scale
            h = h / scale
            # Clamp
            cx = max(0, min(orig_w, cx))
            cy = max(0, min(orig_h, cy))
            w = max(10, min(orig_w, w))
            h = max(10, min(orig_h, h))
            faces.append({
                "cx": round(cx, 1),
                "cy": round(cy, 1),
                "w": int(round(w)),
                "h": int(round(h)),
                "confidence": round(confidence, 4),
                "landmarks": {},  # YOLOv10 model has no face landmarks
            })
    else:
        # ── YOLOv8-face format: [84, 8400] ──
        for pred_idx in range(raw.shape[1]):
            pred = raw[:, pred_idx]
            confidence = float(pred[4])
            if confidence < conf_threshold:
                continue

            cx, cy, w, h = float(pred[0]), float(pred[1]), float(pred[2]), float(pred[3])
            cx *= img_w
            cy *= img_h
            w *= img_w
            h *= img_h

            # Undo padding
            cx = (cx - dw / 2) / scale
            cy = (cy - dh / 2) / scale
            w = w / scale
            h = h / scale

            cx = max(0, min(orig_w, cx))
            cy = max(0, min(orig_h, cy))
            w = max(10, min(orig_w, w))
            h = max(10, min(orig_h, h))

            # Landmarks: left_eye, right_eye, nose, left_mouth, right_mouth
            landmark_names = ["le", "re", "n", "lm", "rm"]
            landmarks = {}
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


# =============================================================================
# MediaPipe Face Mesh Integration
# =============================================================================

def load_mediapipe():
    """Initialize MediaPipe Face Landmarker."""
    try:
        import mediapipe as mp
        from mediapipe.tasks import python
        from mediapipe.tasks.python import vision

        model_dir = os.path.join(os.path.dirname(__file__), "models")
        os.makedirs(model_dir, exist_ok=True)
        model_path = os.path.join(model_dir, MP_FACE_MODEL)

        # Auto-download if missing
        if not os.path.exists(model_path) or os.path.getsize(model_path) < 100_000:
            mp_url = (
                "https://storage.googleapis.com/mediapipe-models/"
                "face_landmarker/face_landmarker/float16/1/face_landmarker.task"
            )
            print(f"[INFO] Downloading MediaPipe model ({MP_FACE_MODEL})...", file=sys.stderr)
            try:
                urllib.request.urlretrieve(mp_url, model_path)
                print(f"[INFO] MediaPipe model saved to {model_path}", file=sys.stderr)
            except Exception as e:
                print(f"[WARN] MediaPipe model download failed: {e}", file=sys.stderr)
                return None

        if not os.path.exists(model_path):
            print("[WARN] MediaPipe model not found, skipping landmarks", file=sys.stderr)
            return None

        options = vision.FaceLandmarkerOptions(
            base_options=python.BaseOptions(model_asset_path=model_path),
            running_mode=vision.RunningMode.VIDEO,
            output_face_blendshapes=True,
            result_callback=None,
        )
        landmarker = vision.FaceLandmarker.create_from_options(options)
        print("[INFO] MediaPipe Face Landmarker loaded", file=sys.stderr)
        return landmarker
    except ImportError:
        print("[WARN] mediapipe not installed, skipping landmarks", file=sys.stderr)
        return None
    except Exception as e:
        print(f"[WARN] MediaPipe init failed: {e}", file=sys.stderr)
        return None


def extract_mp_faces(landmarker, frame, timestamp_ms):
    """Extract MediaPipe face detections + landmarks from a frame.

    Returns (face_list, landmarks_list):
      - face_list: [{cx, cy, w, h, confidence}] for each detected face
      - landmarks_list: [468-point mesh] for each detected face
    """
    if landmarker is None:
        return [], []

    import mediapipe as mp
    from mediapipe.tasks.python import vision

    mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=frame)
    detection_result = landmarker.detect_for_video(mp_image, timestamp_ms)

    faces = []
    landmarks_list = []
    frame_w = float(frame.shape[1])
    frame_h = float(frame.shape[0])

    for face_landmarks in detection_result.face_landmarks:
        # Compute bounding box from landmark extremas
        xs = [lm.x * frame_w for lm in face_landmarks]
        ys = [lm.y * frame_h for lm in face_landmarks]
        x_min, x_max = min(xs), max(xs)
        y_min, y_max = min(ys), max(ys)
        cx = round((x_min + x_max) / 2, 1)
        cy = round((y_min + y_max) / 2, 1)
        w = int(round(x_max - x_min))
        h = int(round(y_max - y_min))

        # Skip very small detections (noise)
        if w < 20 or h < 20:
            continue

        faces.append({
            "cx": cx,
            "cy": cy,
            "w": w,
            "h": h,
            "confidence": 0.5,  # MediaPipe doesn't expose score via Landmarker
            "lip_motion": 0.0,  # computed below
        })

        # Store landmarks
        points = [[lm.x, lm.y, lm.z] for lm in face_landmarks]
        landmarks_list.append(points)

        # Compute lip motion from inner upper/lower lip landmarks (indices 13/14)
        if len(points) >= 15:
            upper = points[13]
            lower = points[14]
            lip_dist = math.sqrt(
                (upper[0] - lower[0]) ** 2 +
                (upper[1] - lower[1]) ** 2
            )
            # Normalize by face height for scale invariance
            faces[-1]["lip_motion"] = round(lip_dist / max(h, 1), 6)

    return faces, landmarks_list


def face_iou(a: dict, b: dict) -> float:
    """IoU between two face dicts with cx, cy, w, h."""
    ax1 = a["cx"] - a["w"] / 2
    ay1 = a["cy"] - a["h"] / 2
    ax2 = a["cx"] + a["w"] / 2
    ay2 = a["cy"] + a["h"] / 2
    bx1 = b["cx"] - b["w"] / 2
    by1 = b["cy"] - b["h"] / 2
    bx2 = b["cx"] + b["w"] / 2
    by2 = b["cy"] + b["h"] / 2

    ix1 = max(ax1, bx1)
    iy1 = max(ay1, by1)
    ix2 = min(ax2, bx2)
    iy2 = min(ay2, by2)
    inter = max(0, ix2 - ix1) * max(0, iy2 - iy1)
    union = (ax2 - ax1) * (ay2 - ay1) + (bx2 - bx1) * (by2 - by1) - inter
    return inter / union if union > 0 else 0.0


# =============================================================================
# Face Embedding + Tracking → ByteTrack with Kalman filter
# =============================================================================

# Import ByteTrack from the parent directory (GANYIQ root)
try:
    import sys as _sys
    _sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    from tracker import ByteTrack
    _sys.path.pop(0)
    HAS_BYTE_TRACK = True
except ImportError:
    HAS_BYTE_TRACK = False


# =============================================================================
# Speaker Clustering
# =============================================================================

class SpeakerClusterer:
    """Cluster face appearances into speakers using spatial + temporal features."""

    def __init__(self, iou_threshold=0.25):
        self.speakers = {}    # speaker_id → list of detections
        self.next_speaker = 0
        self.iou_threshold = iou_threshold

    def assign(self, face):
        """Assign a face detection to a speaker based on track_id and position."""
        track_id = face.get("track_id", -1)

        if track_id >= 0 and track_id in self.speakers:
            self.speakers[track_id].append(face)
            return f"speaker_{track_id}"

        # Create new speaker
        tid = track_id if track_id >= 0 else self.next_speaker
        self.speakers[tid] = [face]
        if track_id < 0:
            self.next_speaker += 1
        return f"speaker_{tid}"

    def get_results(self):
        """Return all clustered speakers."""
        results = []
        for sid, detections in self.speakers.items():
            results.append({
                "speaker_id": f"speaker_{sid}",
                "total_detections": len(detections),
                "first_seen": detections[0].get("time", 0),
                "last_seen": detections[-1].get("time", 0),
            })
        return results


# =============================================================================
# Main Pipeline
# =============================================================================

def process_video(
    video_path: str,
    output_path: str,
    sample_rate: float = 3.0,
    conf_threshold: float = 0.4,
    start_time: float | None = None,
    end_time: float | None = None,
    enable_mediapipe: bool = True,
):
    """
    Main hybrid face detection pipeline:
    1. Initialize YOLOv8-face + MediaPipe
    2. Process each frame → face detections + landmarks
    3. Track faces across frames
    4. Cluster into speakers
    5. Output structured JSON
    """
    import cv2
    import numpy as np

    if not os.path.exists(video_path):
        print(f"Error: video not found: {video_path}", file=sys.stderr)
        sys.exit(1)

    # Load YOLO
    model_dir = os.path.dirname(os.path.abspath(__file__))
    yolo_path = download_model(model_dir, YOLOV8_FACE_URL, MODEL_FILENAME)
    session, input_name = load_yolo_session(yolo_path) if yolo_path else (None, None)

    use_yolo = session is not None
    print(f"[INFO] Using YOLO: {use_yolo}", file=sys.stderr)

    # Load MediaPipe
    mp_landmarker = None
    if enable_mediapipe:
        try:
            mp_landmarker = load_mediapipe()
        except Exception as e:
            print(f"[WARN] MediaPipe unavailable: {e}", file=sys.stderr)

    # Open video
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        print(f"Error: cannot open video: {video_path}", file=sys.stderr)
        sys.exit(4)

    fps = cap.get(cv2.CAP_PROP_FPS)
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    duration = total_frames / fps if fps > 0 else 0

    print(f"[INFO] Video: {total_frames} frames, {fps:.2f} fps, {duration:.1f}s", file=sys.stderr)

    # Time range
    if start_time is not None and end_time is not None:
        start_frame = int(max(0, start_time - 10) * fps)
        end_frame = min(total_frames, int((end_time + 5) * fps))
    else:
        start_frame = 0
        end_frame = total_frames

    if start_frame > 0:
        cap.set(cv2.CAP_PROP_POS_FRAMES, start_frame)

    frame_interval = max(1, int(fps / sample_rate))
    if HAS_BYTE_TRACK:
        tracker = ByteTrack(conf_threshold=conf_threshold, max_lost=25)
        print(f"[INFO] Using ByteTrack (Kalman + Hungarian) tracker", file=sys.stderr)
    else:
        from tracker import ByteTrack as _BT
        tracker = _BT(conf_threshold=conf_threshold, max_lost=25)
    clusterer = SpeakerClusterer()
    results = []
    frame_idx = start_frame

    while frame_idx < end_frame:
        ret, frame = cap.read()
        if not ret:
            break

        if (frame_idx - start_frame) % frame_interval == 0:
            time_sec = frame_idx / fps

            # Step 1: YOLOv8-face detection
            yolo_faces = []
            if use_yolo:
                yolo_faces = yolo_detect_faces(
                    session, input_name, frame, conf_threshold
                )

            # Step 2: MediaPipe face detection + merge with YOLO
            all_faces = list(yolo_faces)
            mp_landmarks_dict = {}  # _mp_key → list of face data with lip_motion precomputed
            if mp_landmarker:
                mp_faces, mp_landmarks_list = extract_mp_faces(
                    mp_landmarker, frame, int(time_sec * 1000)
                )

                # Precompute lip_motion from MediaPipe 468-point landmarks
                for idx, (mf, ml) in enumerate(zip(mp_faces, mp_landmarks_list)):
                    lip_open = 0.0
                    if ml and len(ml) > 14:
                        upper = ml[13]   # upper inner lip
                        lower = ml[14]   # lower inner lip
                        if len(upper) >= 2 and len(lower) >= 2:
                            dx = lower[0] - upper[0]
                            dy = lower[1] - upper[1]
                            lip_open = math.sqrt(dx*dx + dy*dy)
                    mf["lip_motion"] = round(lip_open, 4)

                    # Check overlap with YOLO faces
                    overlap_idx = -1
                    for yfi, yf in enumerate(all_faces):
                        if face_iou(mf, yf) > 0.5:
                            overlap_idx = yfi
                            break

                    if overlap_idx >= 0:
                        # Attach lip_motion to the overlapping YOLO face
                        all_faces[overlap_idx]["lip_motion"] = mf["lip_motion"]
                    else:
                        # No YOLO overlap → add as MediaPipe-only face
                        mf_key = f"mp_{idx}"
                        mp_landmarks_dict[mf_key] = ml
                        mf["_mp_key"] = mf_key
                        mf["landmarks"] = ml  # store 468-point mesh
                        all_faces.append(mf)

            # Step 3: Tracking
            if HAS_BYTE_TRACK:
                tracked_faces = tracker.update(all_faces)
            else:
                # Fallback: direct ByteTrack import with same call
                from tracker import ByteTrack as _BT
                _fallback_tracker = _BT(conf_threshold=conf_threshold, max_lost=25)
                tracked_faces = _fallback_tracker.update(all_faces)

            # Step 4: Speaker assignment + landmark attachment
            speaker_assignments = []
            for face in tracked_faces:
                # ByteTrack returns 'id' — map to 'track_id' for clusterer
                track_id = face.get("track_id", face.get("id", -1))
                face["track_id"] = track_id
                speaker_id = clusterer.assign(face)
                # Attach MediaPipe landmarks if available
                mp_key = face.get("_mp_key", "")
                landmarks = mp_landmarks_dict.get(mp_key, face.get("landmarks", {}))
                speaker_assignments.append({
                    "cx": face["cx"],
                    "cy": face["cy"],
                    "w": face["w"],
                    "h": face["h"],
                    "confidence": face["confidence"],
                    "track_id": face.get("track_id", -1),
                    "speaker_id": speaker_id,
                    "lip_motion": face.get("lip_motion", 0.0),
                    "landmarks": landmarks,
                })

            results.append({
                "time": round(time_sec, 2),
                "face_count": len(tracked_faces),
                "faces": speaker_assignments,
                "detector": "yolov8-face" if use_yolo else "none",
            })

        frame_idx += 1

        # Progress
        total_to_process = end_frame - start_frame
        if total_to_process > 0 and (frame_idx - start_frame) % 300 == 0:
            pct = int((frame_idx - start_frame) / total_to_process * 100)
            print(f"[PROGRESS] {pct}%", file=sys.stderr)

    cap.release()

    # Build output
    speakers = clusterer.get_results()
    output = {
        "metadata": {
            "video_path": video_path,
            "duration": round(duration, 2),
            "total_frames": total_frames,
            "processed_frames": len(results),
            "detector": "hybrid-yolo-mediapipe" if mp_landmarker else "yolov8-face",
            "total_speakers": len(speakers),
        },
        "speakers": speakers,
        "timeline": results,
    }

    with open(output_path, "w") as f:
        json.dump(output, f, indent=2, default=str)

    print(
        f"[DONE] {len(results)} frames, {len(speakers)} speakers logged",
        file=sys.stderr,
    )


# =============================================================================
# CLI
# =============================================================================

def main():
    parser = argparse.ArgumentParser(
        description="GANYIQ Hybrid Face Detector (YOLOv8-face + MediaPipe)"
    )
    parser.add_argument("video_path", help="Path to video file")
    parser.add_argument("output_path", help="Path to output JSON")
    parser.add_argument(
        "sample_rate", nargs="?", type=float, default=1.0,
        help="Frames per second to sample (default: 1.0)"
    )
    parser.add_argument("--start-time", type=float, default=None)
    parser.add_argument("--end-time", type=float, default=None)
    parser.add_argument("--conf-threshold", type=float, default=0.25)
    parser.add_argument("--no-mediapipe", action="store_true",
                        help="Skip MediaPipe landmark extraction")
    args = parser.parse_args()

    process_video(
        video_path=args.video_path,
        output_path=args.output_path,
        sample_rate=args.sample_rate,
        conf_threshold=args.conf_threshold,
        start_time=args.start_time,
        end_time=args.end_time,
        enable_mediapipe=not args.no_mediapipe,
    )


if __name__ == "__main__":
    main()
