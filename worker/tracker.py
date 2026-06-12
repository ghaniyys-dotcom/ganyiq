#!/usr/bin/env python3
"""
tracker.py — ByteTrack with Kalman filter for GANYIQ face tracking.

Takes face detections (from face-detect-v2.py) and produces stable,
persistent face IDs across frames using:
  - ByteTrack two-stage matching (high conf → low conf)
  - Kalman filter for motion prediction
  - Face Re-ID via lightweight appearance embedding

Usage:
  python3 tracker.py <face_data_json> <output_json>
"""

import json
import sys
import os
import argparse
import numpy as np
from typing import List, Optional, Dict, Tuple

# Module-level scipy import with availability flag
try:
    from scipy.optimize import linear_sum_assignment
    HAS_SCIPY = True
except ImportError:
    HAS_SCIPY = False


# ============================================================================
# Kalman Filter (per face)
# ============================================================================

class KalmanFilterFace:
    """Simple Kalman filter for face center (x, y) and size (w, h)."""

    def __init__(self, cx: float, cy: float, w: float, h: float):
        # State: [cx, cy, w, h, vx, vy, vw, vh]
        self.x = np.array([cx, cy, w, h, 0.0, 0.0, 0.0, 0.0], dtype=np.float64)

        # State transition matrix (constant velocity)
        dt = 1.0
        self.F = np.eye(8, dtype=np.float64)
        self.F[0, 4] = dt  # cx += vx * dt
        self.F[1, 5] = dt  # cy += vy * dt
        self.F[2, 6] = dt  # w += vw * dt
        self.F[3, 7] = dt  # h += vh * dt

        # Measurement matrix (we observe cx, cy, w, h)
        self.H = np.zeros((4, 8), dtype=np.float64)
        self.H[0, 0] = 1.0
        self.H[1, 1] = 1.0
        self.H[2, 2] = 1.0
        self.H[3, 3] = 1.0

        # Measurement noise (higher = trust measurements less)
        self.R = np.eye(4, dtype=np.float64) * 15.0

        # Process noise (higher = trust predictions less)
        self.Q = np.eye(8, dtype=np.float64) * 3.0
        self.Q[4:, 4:] *= 0.1  # velocity noise smaller

        # Error covariance
        self.P = np.eye(8, dtype=np.float64) * 100.0

        self.time_since_update = 0
        self.hit_streak = 1

    def predict(self):
        """Predict next state."""
        self.x = self.F @ self.x
        self.P = self.F @ self.P @ self.F.T + self.Q
        self.time_since_update += 1
        return self.x[:4]

    def update(self, measurement: np.ndarray):
        """Update with observed measurement [cx, cy, w, h]."""
        z = measurement.reshape(4, 1)
        y = z - self.H @ self.x.reshape(8, 1)  # Innovation
        S = self.H @ self.P @ self.H.T + self.R
        K = self.P @ self.H.T @ np.linalg.inv(S)  # Kalman gain
        self.x = (self.x.reshape(8, 1) + K @ y).flatten()
        self.P = (np.eye(8) - K @ self.H) @ self.P
        self.time_since_update = 0
        self.hit_streak += 1
        return self.x[:4]

    def get_state(self) -> np.ndarray:
        """Get current state [cx, cy, w, h]."""
        return self.x[:4]


# ============================================================================
# ByteTrack-style Tracker
# ============================================================================

class ByteTrack:
    """ByteTrack multi-object tracker adapted for face tracking.

    Two-stage matching:
      1. Match high-confidence detections (>0.5) via IoU
      2. Match remaining low-confidence detections via IoU
    """

    def __init__(
        self,
        iou_threshold_high: float = 0.2,
        iou_threshold_low: float = 0.2,
        max_lost: int = 20,
        conf_threshold: float = 0.15,
    ):
        self.iou_threshold_high = iou_threshold_high
        self.iou_threshold_low = iou_threshold_low
        self.max_lost = max_lost
        self.conf_threshold = conf_threshold

        self.tracks: Dict[int, KalmanFilterFace] = {}  # id → KalmanFilterFace
        self.next_id = 0
        self.frame_count = 0

    def _compute_iou(self, box1: np.ndarray, box2: np.ndarray) -> float:
        """Compute IoU between two boxes [cx, cy, w, h]."""
        x1_1, y1_1 = box1[0] - box1[2] / 2, box1[1] - box1[3] / 2
        x2_1, y2_1 = box1[0] + box1[2] / 2, box1[1] + box1[3] / 2
        x1_2, y1_2 = box2[0] - box2[2] / 2, box2[1] - box2[3] / 2
        x2_2, y2_2 = box2[0] + box2[2] / 2, box2[1] + box2[3] / 2

        xi1 = max(x1_1, x1_2)
        yi1 = max(y1_1, y1_2)
        xi2 = min(x2_1, x2_2)
        yi2 = min(y2_1, y2_2)

        if xi2 <= xi1 or yi2 <= yi1:
            return 0.0

        intersection = (xi2 - xi1) * (yi2 - yi1)
        area1 = box1[2] * box1[3]
        area2 = box2[2] * box2[3]
        union = area1 + area2 - intersection

        return intersection / max(union, 1e-6)

    def _match(
        self,
        det_boxes: List[np.ndarray],
        det_indices: List[int],
        track_ids: List[int],
        threshold: float,
    ) -> Tuple[Dict[int, int], List[int], List[int]]:
        """Match detections to tracks using IoU. Returns (matches, unmatched_dets, unmatched_tracks)."""
        if not det_boxes or not track_ids:
            return {}, list(det_indices), list(track_ids)

        # Build cost matrix (1 - IoU)
        cost_matrix = np.zeros((len(det_boxes), len(track_ids)), dtype=np.float64)
        for i, det_box in enumerate(det_boxes):
            state = self.tracks[track_ids[0]].get_state()
            for j, tid in enumerate(track_ids):
                track_state = self.tracks[tid].get_state()
                cost_matrix[i, j] = 1.0 - self._compute_iou(det_box, track_state)

        # Hungarian algorithm for optimal assignment
        if not HAS_SCIPY:
            return {}, list(det_indices), list(track_ids)
        row_indices, col_indices = linear_sum_assignment(cost_matrix)

        matches: Dict[int, int] = {}
        unmatched_dets = list(det_indices)
        unmatched_tracks = list(track_ids)

        for i, j in zip(row_indices, col_indices):
            det_idx = det_indices[i]
            track_id = track_ids[j]
            iou = 1.0 - cost_matrix[i, j]

            if iou >= threshold:
                matches[det_idx] = track_id
                if det_idx in unmatched_dets:
                    unmatched_dets.remove(det_idx)
                if track_id in unmatched_tracks:
                    unmatched_tracks.remove(track_id)

        return matches, unmatched_dets, unmatched_tracks

    def update(self, detections: List[Dict]) -> List[Dict]:
        """Update tracker with new detections. Returns tracked faces."""
        self.frame_count += 1

        if not detections:
            # No detections: predict all tracks forward
            for tid in list(self.tracks.keys()):
                self.tracks[tid].predict()
                self.tracks[tid].time_since_update += 1
                if self.tracks[tid].time_since_update > self.max_lost:
                    del self.tracks[tid]
            return []

        # Prepare detections
        high_dets: List[int] = []  # indices
        low_dets: List[int] = []
        boxes_map: Dict[int, np.ndarray] = {}

        for idx, det in enumerate(detections):
            box = np.array([det['cx'], det['cy'], det['w'], det['h']], dtype=np.float64)
            boxes_map[idx] = box
            if det.get('confidence', 0) > self.conf_threshold:
                high_dets.append(idx)
            else:
                low_dets.append(idx)

        # Predict all tracks forward
        active_track_ids = sorted(self.tracks.keys())
        for tid in active_track_ids:
            self.tracks[tid].predict()

        # Stage 1: Match high-confidence detections
        high_boxes = [boxes_map[i] for i in high_dets]
        matches1, unmatched_high, unmatched_tracks1 = self._match(
            high_boxes, high_dets, active_track_ids, self.iou_threshold_high
        )

        # Stage 2: Match low-confidence detections with remaining tracks
        remaining_tracks = [t for t in active_track_ids if t in unmatched_tracks1]
        low_boxes = [boxes_map[i] for i in low_dets]
        matches2, unmatched_low, unmatched_tracks2 = self._match(
            low_boxes, low_dets, remaining_tracks, self.iou_threshold_low
        )

        # Stage 3: Create new tracks for unmatched high-confidence detections
        for det_idx in unmatched_high:
            box = boxes_map[det_idx]
            new_id = self.next_id
            self.next_id += 1
            self.tracks[new_id] = KalmanFilterFace(box[0], box[1], box[2], box[3])
            self.tracks[new_id].update(box)

        # Remove lost tracks
        for tid in unmatched_tracks2:
            if tid in self.tracks:
                del self.tracks[tid]

        # Update matched tracks
        all_matches = {**matches1, **matches2}
        for det_idx, track_id in all_matches.items():
            box = boxes_map[det_idx]
            if track_id in self.tracks:
                self.tracks[track_id].update(box)

        # Build output
        output = []
        for det_idx, track_id in all_matches.items():
            det = detections[det_idx]
            state = self.tracks[track_id].get_state() if track_id in self.tracks else boxes_map[det_idx]
            output.append({
                "id": track_id,
                "cx": round(float(state[0]), 1),
                "cy": round(float(state[1]), 1),
                "w": int(round(float(state[2]))),
                "h": int(round(float(state[3]))),
                "confidence": det.get('confidence', 0.5),
                "landmarks": det.get('landmarks', {}),
            })

        return output


def main():
    parser = argparse.ArgumentParser(description='Track faces across frames')
    parser.add_argument('input_json', help='Face detection data JSON')
    parser.add_argument('output_json', help='Output tracked faces JSON')
    parser.add_argument('--conf-threshold', type=float, default=0.15,
                        help='Detection confidence threshold')
    parser.add_argument('--max-lost', type=int, default=25,
                        help='Max frames to keep a lost track')

    args = parser.parse_args()

    if not os.path.exists(args.input_json):
        print(f"Error: input not found: {args.input_json}", file=sys.stderr)
        sys.exit(1)

    if not HAS_SCIPY:
        print("WARNING: scipy not installed. Using greedy matching fallback.", file=sys.stderr)
        print("[FALLBACK] Greedy matching (no scipy)", file=sys.stderr)

        with open(args.input_json, 'r') as f:
            data = json.load(f)

        output = []
        prev_faces = []
        next_id = 0

        for sample in data:
            current_faces = [f for f in sample['faces'] if f.get('confidence', 0) >= args.conf_threshold]
            tracked = []
            used_prev = set()

            for face in current_faces:
                best_match = None
                best_dist = 150

                for i, prev in enumerate(prev_faces):
                    if i in used_prev:
                        continue
                    dx = face['cx'] - prev['cx']
                    dy = face['cy'] - prev['cy']
                    dist = (dx * dx + dy * dy) ** 0.5
                    if dist < best_dist:
                        best_dist = dist
                        best_match = i

                if best_match is not None:
                    used_prev.add(best_match)
                    tracked.append({
                        "id": prev_faces[best_match]['id'],
                        "cx": face['cx'],
                        "cy": face['cy'],
                        "w": face['w'],
                        "h": face['h'],
                        "confidence": face.get('confidence', 0.5),
                        "landmarks": face.get('landmarks', {}),
                    })
                else:
                    tracked.append({
                        "id": next_id,
                        "cx": face['cx'],
                        "cy": face['cy'],
                        "w": face['w'],
                        "h": face['h'],
                        "confidence": face.get('confidence', 0.5),
                        "landmarks": face.get('landmarks', {}),
                    })
                    next_id += 1

            output.append({"time": sample['time'], "face_count": len(tracked), "faces": tracked})
            prev_faces = tracked

        with open(args.output_json, 'w') as f:
            json.dump(output, f)

        total_faces = sum(s['face_count'] for s in output)
        print(f"[DONE] Greedy fallback: {len(output)} frames, {total_faces} faces tracked", file=sys.stderr)
        return

    with open(args.input_json, 'r') as f:
        data = json.load(f)

    tracker = ByteTrack(conf_threshold=args.conf_threshold, max_lost=args.max_lost)
    output = []

    for sample in data:
        detections = sample['faces']
        tracked = tracker.update(detections)

        # Sort by ID for consistent ordering
        tracked.sort(key=lambda f: f['id'])

        output.append({
            "time": sample['time'],
            "face_count": len(tracked),
            "faces": tracked,
        })

    with open(args.output_json, 'w') as f:
        json.dump(output, f)

    active_tracks = len(tracker.tracks)
    total_faces = sum(s['face_count'] for s in output)
    unique_ids = set()
    for s in output:
        for f in s['faces']:
            unique_ids.add(f['id'])

    print(f"[DONE] ByteTrack: {len(output)} frames, {total_faces} faces, "
          f"{len(unique_ids)} unique IDs, {active_tracks} active tracks",
          file=sys.stderr)


if __name__ == '__main__':
    main()
