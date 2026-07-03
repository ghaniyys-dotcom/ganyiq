#!/usr/bin/env python3
"""
visual-reaction-detector.py — Visual reaction detection from face landmarks for GANYIQ V3.

NOTE:
  The production pipeline runs visual reaction detection in-memory within
  speaker-detector.ts (detectVisualReactions() function) for efficiency —
  no Python subprocess needed since landmarks are already in memory.
  
  This script exists as a STANDALONE DEBUGGING & VALIDATION UTILITY.
  Use it to inspect visual features offline for tuning thresholds:
    python3 visual-reaction-detector.py tracked_faces.json output.json

Detects non-verbal visual reactions using face landmarks from YOLOv8-face:
  - MAR (Mouth Aspect Ratio): mouth opening amount (laugh, surprise, talking)
  - Smile: mouth corner elevation + width increase
  - Surprise: high MAR + widened inter-eye distance + head tilt back
  - Head nod: rhythmic vertical oscillation of nose relative to eye line
  - Head shake: rhythmic horizontal oscillation of nose relative to face center
  - Head tilt: sustained head angle change (curiosity, confusion)

This complements the audio reaction detector (reaction-detector.py) by detecting
SILENT reactions — people laughing without sound, gasping off-mic, eye widening,
smiling, nodding in agreement, or shaking their head in disbelief.

Input: tracked_faces.json (from ByteTrack tracker) with YOLOv8-face landmark format.
  Each frame entry has:
    time: float
    face_count: int
    faces: [{ id, cx, cy, w, h, confidence, landmarks: { le, re, n, lm, rm } }]

Output JSON format (same structure as reaction-detector.py):
  {
    "source": "visual",
    "analysis_window_hz": <frame_rate>,
    "events": [
      { "time": 12.5, "event_type": "smile", "confidence": 0.78, "duration": 1.2, "end_time": 13.7, "face_id": 2 }
    ],
    "time_series": {
      "times": [...],
      "mar": [...],
      "smile_score": [...],
      "head_nod_score": [...],
      "head_shake_score": [...],
      "surprise_score": [...],
      "event_labels": [...]
    }
  }

Event labels:
  0 = normal
  1 = smile              (mouth corners raised, wider mouth)
  2 = laugh_visual       (high MAR, jaw dropped)
  3 = surprise_visual    (high MAR + wide eyes + head tilt)
  4 = head_nod           (rhythmic vertical oscillation)
  5 = head_shake         (rhythmic horizontal oscillation)
  -1 = no_face           (no face visible)
"""

import json
import sys
import os
import argparse
import math
from collections import deque
from typing import List, Dict, Any, Optional, Tuple


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

EVENT_NORMAL = 0
EVENT_SMILE = 1
EVENT_LAUGH_VISUAL = 2
EVENT_SURPRISE_VISUAL = 3
EVENT_HEAD_NOD = 4
EVENT_HEAD_SHAKE = 5
EVENT_NO_FACE = -1

EVENT_NAMES = {
    EVENT_NORMAL: 'normal',
    EVENT_SMILE: 'smile',
    EVENT_LAUGH_VISUAL: 'laugh_visual',
    EVENT_SURPRISE_VISUAL: 'surprise_visual',
    EVENT_HEAD_NOD: 'head_nod',
    EVENT_HEAD_SHAKE: 'head_shake',
    EVENT_NO_FACE: 'no_face',
}

# MAR thresholds
MAR_CLOSED = 0.35          # below this = mouth closed
MAR_OPEN = 0.55            # above this = mouth clearly open
MAR_LAUGH = 0.70           # above this = jaw dropped (laughing)

# Smile detection
SMILE_WIDTH_RATIO = 1.12   # mouth must be 12% wider than sliding average
SMILE_RAISE_MIN = 0.015    # minimum mouth corner elevation relative to face height

# Surprise detection
SURPRISE_MULTIPLIER = 1.15 # inter-eye distance must be 15% above baseline
MAR_SURPRISE_MIN = 0.50    # minimum MAR for surprise

# Head movement
NOD_WINDOW = 12            # frames for nod detection (~0.5s at 24fps)
SHAKE_WINDOW = 10          # frames for shake detection
NOD_AMPLITUDE_MIN = 0.02   # minimum oscillation amplitude (relative to inter-eye distance)
SHAKE_AMPLITUDE_MIN = 0.02
OSCILLATION_FRAMES_MIN = 4 # minimum frames in an oscillation half-cycle

# Temporal smoothing
EMA_SMOOTHING_ALPHA = 0.15
BASELINE_ADAPT_RATE = 0.01 # how fast baseline adapts to slow changes


# ---------------------------------------------------------------------------
# Geometry helpers
# ---------------------------------------------------------------------------

def distance(a: List[float], b: List[float]) -> float:
    """Euclidean distance between two 2D points."""
    return math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2)


def midpoint(a: List[float], b: List[float]) -> Tuple[float, float]:
    """Midpoint of two 2D points."""
    return ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)


def angle_between(a: List[float], b: List[float]) -> float:
    """Angle of the line from a to b in radians."""
    return math.atan2(b[1] - a[1], b[0] - a[0])


# ---------------------------------------------------------------------------
# Per-frame feature computation
# ---------------------------------------------------------------------------

def compute_face_features(
    landmarks: Dict[str, List[float]],
) -> Dict[str, float]:
    """
    Compute visual features from a single face's landmarks.

    Returns dict with:
      - mouth_width: horizontal distance between mouth corners
      - mouth_height: vertical distance from nose to mouth center
      - mar: mouth_height / mouth_width (Mouth Aspect Ratio)
      - inter_eye_dist: distance between eye centers
      - nose_to_eye_line: vertical distance from nose to eye midline
      - mouth_corner_elevation: how raised mouth corners are relative to eye line
      - head_angle: angle of the eye line (head roll)
    """
    le = landmarks.get('le', [0, 0])
    re = landmarks.get('re', [0, 0])
    n = landmarks.get('n', [0, 0])
    lm = landmarks.get('lm', [0, 0])
    rm = landmarks.get('rm', [0, 0])

    # Mouth dimensions
    mouth_width = distance(lm, rm)
    mouth_center_y = (lm[1] + rm[1]) / 2
    mouth_height = abs(mouth_center_y - n[1])

    # MAR = mouth_height / mouth_width
    mar = mouth_height / max(mouth_width, 1.0)

    # Inter-eye distance
    inter_eye_dist = distance(le, re)

    # Eye line midpoint
    eye_mid_x = (le[0] + re[0]) / 2
    eye_mid_y = (le[1] + re[1]) / 2

    # Nose offset from eye line midpoint
    nose_offset_x = n[0] - eye_mid_x
    nose_offset_y = n[1] - eye_mid_y

    # Mouth corner elevation: how raised are the mouth corners?
    # Positive = mouth corners are HIGHER (smaller y) relative to eye line
    mouth_corner_y = (lm[1] + rm[1]) / 2
    mouth_corner_elevation = eye_mid_y - mouth_corner_y

    # Eye line angle (head roll)
    head_angle = angle_between(le, re)

    # Face height estimate (inter-eye distance is ~1/3 of face height for frontal)
    face_height_estimate = inter_eye_dist * 3.0

    return {
        'mouth_width': mouth_width,
        'mouth_height': mouth_height,
        'mar': mar,
        'inter_eye_dist': inter_eye_dist,
        'nose_offset_x': nose_offset_x,
        'nose_offset_y': nose_offset_y,
        'mouth_corner_elevation': mouth_corner_elevation,
        'head_angle': head_angle,
        'face_height': face_height_estimate,
    }


# ---------------------------------------------------------------------------
# Baseline tracker for adaptive thresholds
# ---------------------------------------------------------------------------

class BaselineTracker:
    """
    Tracks a running baseline and detects deviations from it.

    Uses EMA smoothing for the baseline and monitors the current value
    against the baseline with an adaptive threshold.
    """

    def __init__(self, alpha: float = BASELINE_ADAPT_RATE):
        self.baseline = None
        self.alpha = alpha
        self.current_std = None

    def update(self, value: float) -> float:
        """Update and return deviation from baseline (positive = above baseline)."""
        if self.baseline is None:
            self.baseline = value
            return 0.0

        deviation = value - self.baseline
        self.baseline = self.baseline + self.alpha * (value - self.baseline)

        if self.current_std is None:
            self.current_std = abs(deviation) * 1.5
        else:
            self.current_std = 0.9 * self.current_std + 0.1 * abs(deviation)

        return deviation


# ---------------------------------------------------------------------------
# Oscillation detector for head nods and shakes
# ---------------------------------------------------------------------------

class OscillationDetector:
    """
    Detects rhythmic oscillations in a signal (for head nod/shake detection).

    Tracks zero-crossings and measures period and amplitude.
    When consistent oscillations are found, raises a detection event.
    """

    def __init__(self, window_size: int, amplitude_min: float):
        self.buffer: deque = deque(maxlen=window_size)
        self.window_size = window_size
        self.amplitude_min = amplitude_min
        self.last_zc: Optional[float] = None  # time of last zero crossing
        self.zc_sign: int = 0  # sign after last zero crossing (+1 or -1)
        self.zc_times: List[float] = []  # recent zero crossing times
        self.oscillation_active = False
        self.oscillation_score = 0.0

    def push(self, value: float, time: float) -> float:
        """
        Push a new (value, time) pair. Returns oscillation score (0-1).
        Higher score = stronger rhythmic oscillation.
        """
        self.buffer.append((value, time))

        if len(self.buffer) < self.window_size // 2:
            return 0.0

        # Check for zero crossing
        if len(self.buffer) >= 2:
            prev_val = self.buffer[-2][0]
            curr_val = self.buffer[-1][0]

            # Detect zero crossing
            if prev_val * curr_val < 0:
                current_sign = 1 if curr_val > 0 else -1
                if self.zc_sign != 0 and current_sign != self.zc_sign:
                    # Valid crossing (alternating)
                    zc_time = self._interpolate_zc(prev_val, curr_val, self.buffer[-2][1], time)
                    if self.last_zc is not None:
                        period = zc_time - self.last_zc
                        self.zc_times.append(period)
                        if len(self.zc_times) > 5:
                            self.zc_times.pop(0)

                    self.last_zc = zc_time
                self.zc_sign = current_sign

        # Compute oscillation score
        if len(self.zc_times) >= 2:
            avg_period = sum(self.zc_times) / len(self.zc_times)
            period_consistency = 1.0 - min(1.0, np_std(self.zc_times) / max(avg_period, 0.01))
            amplitude = self._measure_amplitude()

            if amplitude >= self.amplitude_min and avg_period < 2.0:  # < 2 second period
                self.oscillation_score = min(1.0, (amplitude / self.amplitude_min) * 0.5 + period_consistency * 0.5)
                self.oscillation_active = self.oscillation_score > 0.4
            else:
                self.oscillation_score *= 0.9  # decay
                if self.oscillation_score < 0.1:
                    self.oscillation_active = False

        return self.oscillation_score

    def _interpolate_zc(self, a_val: float, b_val: float, a_time: float, b_time: float) -> float:
        """Linearly interpolate zero crossing time."""
        if abs(b_val - a_val) < 1e-10:
            return (a_time + b_time) / 2
        t = -a_val / (b_val - a_val)
        return a_time + t * (b_time - a_time)

    def _measure_amplitude(self) -> float:
        """Measure peak-to-peak amplitude in the buffer."""
        if len(self.buffer) < 3:
            return 0.0
        values = [v for v, _ in self.buffer]
        return max(values) - min(values)

    def reset(self):
        self.buffer.clear()
        self.last_zc = None
        self.zc_sign = 0
        self.zc_times.clear()
        self.oscillation_active = False
        self.oscillation_score = 0.0


def np_std(values: List[float]) -> float:
    """Simple std computation without numpy dependency."""
    if len(values) < 2:
        return 0.0
    mean = sum(values) / len(values)
    variance = sum((v - mean) ** 2 for v in values) / len(values)
    return math.sqrt(variance)


# ---------------------------------------------------------------------------
# Main detection function
# ---------------------------------------------------------------------------

def detect_visual_events(
    tracked_data: List[Dict],
) -> Tuple[List[Dict], Dict]:
    """
    Analyze tracked face data and detect visual reactions.

    Args:
        tracked_data: List of frame entries from tracked_faces.json

    Returns:
        (events, time_series) tuple matching reaction-detector.py output format
    """
    if not tracked_data:
        return [], {}

    # Trackers for each face ID
    face_baselines: Dict[int, Dict[str, BaselineTracker]] = {}
    face_smooth_features: Dict[int, Dict[str, float]] = {}
    face_oscillators: Dict[int, Dict[str, OscillationDetector]] = {}
    face_smooth_mouth_width: Dict[int, float] = {}
    face_smooth_inter_eye: Dict[int, float] = {}

    # Collect baseline data first (first 30% of frames for calibration)
    calibration_frames = max(20, len(tracked_data) // 3)

    # Per-frame labels and features
    num_frames = len(tracked_data)
    times = []
    mar_values = []
    smile_scores = []
    nod_scores = []
    shake_scores = []
    surprise_scores = []
    frame_labels = []
    frame_confidences = []

    for fi, frame in enumerate(tracked_data):
        t = frame.get('time', fi)
        times.append(t)
        faces = frame.get('faces', [])

        if not faces:
            frame_labels.append(EVENT_NO_FACE)
            frame_confidences.append(1.0)
            mar_values.append(0.0)
            smile_scores.append(0.0)
            nod_scores.append(0.0)
            shake_scores.append(0.0)
            surprise_scores.append(0.0)
            continue

        # Process the face with highest confidence (primary subject)
        primary_face = max(faces, key=lambda f: f.get('confidence', 0))
        face_id = primary_face.get('id', -1)
        landmarks = primary_face.get('landmarks', {})

        if not landmarks or not all(k in landmarks for k in ['le', 're', 'n', 'lm', 'rm']):
            frame_labels.append(EVENT_NORMAL)
            frame_confidences.append(0.0)
            mar_values.append(0.0)
            smile_scores.append(0.0)
            nod_scores.append(0.0)
            shake_scores.append(0.0)
            surprise_scores.append(0.0)
            continue

        # Compute features
        features = compute_face_features(landmarks)

        # Initialize per-face trackers
        if face_id not in face_baselines:
            face_baselines[face_id] = {
                'mar': BaselineTracker(0.02),
                'mouth_width': BaselineTracker(0.02),
                'inter_eye': BaselineTracker(0.02),
                'mouth_elevation': BaselineTracker(0.02),
                'nose_offset_x': BaselineTracker(0.02),
                'nose_offset_y': BaselineTracker(0.02),
            }
            face_smooth_features[face_id] = {
                'mar_smooth': features['mar'],
                'smile_score_smooth': 0.0,
                'surprise_score_smooth': 0.0,
            }
            face_oscillators[face_id] = {
                'nod': OscillationDetector(NOD_WINDOW, NOD_AMPLITUDE_MIN),
                'shake': OscillationDetector(SHAKE_WINDOW, SHAKE_AMPLITUDE_MIN),
            }
            face_smooth_mouth_width[face_id] = features['mouth_width']
            face_smooth_inter_eye[face_id] = features['inter_eye_dist']

        bl = face_baselines[face_id]
        sf = face_smooth_features[face_id]

        # Update baselines
        mar_dev = bl['mar'].update(features['mar'])
        mw_dev = bl['mouth_width'].update(features['mouth_width'])
        ie_dev = bl['inter_eye'].update(features['inter_eye_dist'])
        me_dev = bl['mouth_elevation'].update(features['mouth_corner_elevation'])
        nox_dev = bl['nose_offset_x'].update(features['nose_offset_x'])
        noy_dev = bl['nose_offset_y'].update(features['nose_offset_y'])

        # --- Smile detection ---
        # Smile = mouth corners raised (positive elevation deviation) + mouth wider
        smile_mouth_raised = me_dev > SMILE_RAISE_MIN * features['face_height']
        smile_mouth_wider = features['mouth_width'] > face_smooth_mouth_width[face_id] * SMILE_WIDTH_RATIO
        smile_mar_ok = features['mar'] < MAR_OPEN  # mouth not too open

        smile_score = 0.0
        if smile_mouth_raised and smile_mouth_wider and smile_mar_ok:
            # Score based on how wide and raised
            width_ratio = features['mouth_width'] / max(face_smooth_mouth_width[face_id], 1.0)
            raise_amount = me_dev / max(features['face_height'], 1.0)
            smile_score = min(1.0, (width_ratio - 1.0) * 3.0 + raise_amount * 20.0)
        elif smile_mouth_raised and smile_mouth_wider:
            # Wide and raised, but mouth open — might be laughing
            smile_score = min(0.5, max(0, smile_score))

        # EMA smooth
        sf['smile_score_smooth'] = sf['smile_score_smooth'] + \
            EMA_SMOOTHING_ALPHA * (smile_score - sf['smile_score_smooth'])
        smile_scores.append(round(sf['smile_score_smooth'], 4))

        # --- MAR / Laugh detection ---
        mar_smooth = sf['mar_smooth'] + EMA_SMOOTHING_ALPHA * (features['mar'] - sf['mar_smooth'])
        sf['mar_smooth'] = mar_smooth
        mar_values.append(round(mar_smooth, 4))

        # --- Surprise detection ---
        # Surprise = high MAR + widened inter-eye distance + head may tilt back
        inter_eye_ratio = features['inter_eye_dist'] / max(face_smooth_inter_eye[face_id], 1.0)
        surprise_mar_ok = features['mar'] > MAR_SURPRISE_MIN
        surprise_eyes_wide = inter_eye_ratio > SURPRISE_MULTIPLIER
        # Head tilt back = nose moving up relative to eye line
        head_tilt_back = noy_dev > 0 and abs(noy_dev) > 0.01 * features['face_height']

        surprise_score = 0.0
        if surprise_mar_ok and (surprise_eyes_wide or head_tilt_back):
            surprise_score = (
                min(1.0, (features['mar'] - MAR_SURPRISE_MIN) * 2.0) * 0.4 +
                min(1.0, max(0, inter_eye_ratio - 1.0) * 5.0) * 0.3 +
                (1.0 if head_tilt_back else 0.0) * 0.3
            )

        sf['surprise_score_smooth'] = sf['surprise_score_smooth'] + \
            EMA_SMOOTHING_ALPHA * (surprise_score - sf['surprise_score_smooth'])
        surprise_scores.append(round(sf['surprise_score_smooth'], 4))

        # --- Head nod/shake detection ---
        # Nod: vertical oscillation of nose relative to eye line
        # Shake: horizontal oscillation of nose relative to face center
        nod_val = noy_dev / max(features['face_height'], 1.0)
        shake_val = nox_dev / max(features['inter_eye_dist'], 1.0)

        nod_osc = face_oscillators[face_id]['nod'].push(nod_val, t)
        shake_osc = face_oscillators[face_id]['shake'].push(shake_val, t)
        nod_scores.append(round(nod_osc, 4))
        shake_scores.append(round(shake_osc, 4))

        # --- Update smoothing baselines ---
        face_smooth_mouth_width[face_id] = face_smooth_mouth_width[face_id] + \
            EMA_SMOOTHING_ALPHA * (features['mouth_width'] - face_smooth_mouth_width[face_id])
        face_smooth_inter_eye[face_id] = face_smooth_inter_eye[face_id] + \
            EMA_SMOOTHING_ALPHA * (features['inter_eye_dist'] - face_smooth_inter_eye[face_id])

        # --- Classify frame ---
        is_calibrating = fi < calibration_frames
        if is_calibrating:
            frame_labels.append(EVENT_NORMAL)
            frame_confidences.append(0.0)
            continue

        # Determine event type from all signals
        events_with_scores = []

        # Laugh visual: very high MAR (jaw dropped)
        if features['mar'] > MAR_LAUGH or (mar_smooth > MAR_LAUGH and sf['smile_score_smooth'] > 0.3):
            laugh_conf = min(1.0, (features['mar'] - MAR_LAUGH) * 2.0 + sf['smile_score_smooth'] * 0.3)
            events_with_scores.append((EVENT_LAUGH_VISUAL, min(0.95, laugh_conf)))

        # Surprise: high MAR + wide eyes + head tilt
        if sf['surprise_score_smooth'] > 0.4:
            events_with_scores.append((EVENT_SURPRISE_VISUAL, sf['surprise_score_smooth']))

        # Smile: raised + wide mouth corners
        if sf['smile_score_smooth'] > 0.4 and features['mar'] < MAR_OPEN:
            events_with_scores.append((EVENT_SMILE, sf['smile_score_smooth']))

        # Head nod: strong rhythmic vertical oscillation
        if nod_osc > 0.5:
            events_with_scores.append((EVENT_HEAD_NOD, nod_osc))

        # Head shake: strong rhythmic horizontal oscillation
        if shake_osc > 0.5:
            events_with_scores.append((EVENT_HEAD_SHAKE, shake_osc))

        if events_with_scores:
            # Pick the highest scoring event
            best_event = max(events_with_scores, key=lambda x: x[1])
            frame_labels.append(best_event[0])
            frame_confidences.append(best_event[1])
        else:
            frame_labels.append(EVENT_NORMAL)
            frame_confidences.append(0.0)

    # ── Merge contiguous events ──
    events = merge_visual_events(
        frame_labels, frame_confidences,
        times, tracked_data,
    )

    # Build time_series
    time_series = {
        'times': [round(t, 2) for t in times],
        'mar': mar_values,
        'smile_score': smile_scores,
        'surprise_score': surprise_scores,
        'head_nod_score': nod_scores,
        'head_shake_score': shake_scores,
        'event_labels': frame_labels,
    }

    if events:
        type_counts = {}
        for evt in events:
            t = evt['event_type']
            type_counts[t] = type_counts.get(t, 0) + 1
        print(f"[INFO] Visual events: {json.dumps(type_counts)}", file=sys.stderr)

    print(f"[DONE] Visual: {len(events)} events, {num_frames} frames", file=sys.stderr)

    return events, time_series


def merge_visual_events(
    frame_labels: List[int],
    frame_confidences: List[float],
    times: List[float],
    tracked_data: List[Dict],
) -> List[Dict]:
    """
    Merge contiguous frames with the same event label into single events.
    """
    events = []
    min_event_duration = 0.3  # minimum event duration (300ms)
    max_gap_frames = 2        # allow small gaps within same event

    i = 0
    while i < len(frame_labels):
        current_label = frame_labels[i]

        # Skip normal and no_face
        if current_label == EVENT_NORMAL or current_label == EVENT_NO_FACE:
            i += 1
            continue

        # Start of event
        event_start = i
        event_end = i
        conf_sum = 0.0
        conf_count = 0
        face_ids = set()

        # Find end of event
        gap_count = 0
        j = i + 1
        while j < len(frame_labels):
            if frame_labels[j] == current_label:
                event_end = j
                conf_sum += frame_confidences[j]
                conf_count += 1
                gap_count = 0
                # Collect face IDs
                if j < len(tracked_data):
                    for face in tracked_data[j].get('faces', []):
                        face_ids.add(face.get('id', -1))
            elif frame_labels[j] == EVENT_NORMAL:
                gap_count += 1
                if gap_count > max_gap_frames:
                    break
            else:
                # Different event type — stop
                break
            j += 1

        duration = times[min(event_end + 1, len(times) - 1)] - times[event_start]
        if duration >= min_event_duration:
            avg_conf = conf_sum / max(conf_count, 1)
            avg_conf = min(0.95, max(0.1, avg_conf))

            event_type = EVENT_NAMES.get(current_label, 'normal')
            start_time = times[event_start]
            end_time = times[min(event_end, len(times) - 1)]

            events.append({
                'time': round(start_time, 2),
                'event_type': event_type,
                'confidence': round(avg_conf, 3),
                'duration': round(end_time - start_time, 2),
                'end_time': round(end_time, 2),
                'face_id': max(face_ids) if face_ids else None,
            })

        i = event_end + 1 if event_end > i else i + 1

    # Deduplicate overlapping events
    deduped = []
    for evt in events:
        if deduped and evt['event_type'] == deduped[-1]['event_type']:
            prev = deduped[-1]
            gap = evt['time'] - (prev['time'] + prev['duration'])
            if gap < 0.3 and evt.get('face_id') == prev.get('face_id'):
                prev['duration'] = evt['time'] + evt['duration'] - prev['time']
                prev['end_time'] = evt['end_time']
                prev['confidence'] = max(prev['confidence'], evt['confidence'])
                continue
        deduped.append(evt)

    return deduped


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description='Detect visual reactions from face landmarks (MAR, smile, surprise, head pose)'
    )
    parser.add_argument('input_json',
                        help='Path to tracked_faces.json with face landmarks')
    parser.add_argument('output_json',
                        help='Output visual events JSON')
    parser.add_argument('--fallback-path', type=str, default=None,
                        help='Alternative input path (for debugging)')

    args = parser.parse_args()

    input_path = args.input_json
    if not os.path.exists(input_path) and args.fallback_path:
        input_path = args.fallback_path

    if not os.path.exists(input_path):
        print(f"Error: input not found: {input_path}", file=sys.stderr)
        # Write empty output
        output = {
            'source': 'visual',
            'analysis_window_hz': 0,
            'events': [],
            'time_series': {},
        }
        with open(args.output_json, 'w') as f:
            json.dump(output, f)
        print(f"[INFO] No input found, wrote empty output", file=sys.stderr)
        sys.exit(0)

    with open(input_path, 'r') as f:
        try:
            tracked_data = json.load(f)
        except json.JSONDecodeError as e:
            print(f"Error: invalid JSON in {input_path}: {e}", file=sys.stderr)
            sys.exit(1)

    if not isinstance(tracked_data, list):
        print(f"Error: expected JSON array, got {type(tracked_data).__name__}", file=sys.stderr)
        sys.exit(1)

    print(f"[INFO] Analyzing {len(tracked_data)} frames from {input_path}", file=sys.stderr)

    events, time_series = detect_visual_events(tracked_data)

    # Estimate frame rate from time differences
    fps = 0
    if len(tracked_data) >= 2:
        time_diffs = []
        for k in range(1, len(tracked_data)):
            td = tracked_data[k].get('time', k) - tracked_data[k - 1].get('time', k - 1)
            if td > 0:
                time_diffs.append(td)
        if time_diffs:
            avg_diff = sum(time_diffs) / len(time_diffs)
            fps = round(1.0 / avg_diff, 1) if avg_diff > 0 else 1.0

    output = {
        'source': 'visual',
        'analysis_window_hz': fps,
        'events': events,
        'time_series': time_series,
    }

    with open(args.output_json, 'w') as f:
        json.dump(output, f)

    print(f"[DONE] {len(events)} visual events, {len(tracked_data)} frames @ ~{fps}fps",
          file=sys.stderr)


if __name__ == '__main__':
    main()
