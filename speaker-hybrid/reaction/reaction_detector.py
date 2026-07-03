#!/usr/bin/env python3
"""
reaction-detector.py — GANYIQ Reaction Detection

Analyzes facial landmarks from the Hybrid Face Detector to detect:
  - Speaking (lip movement)
  - Smiling (mouth curvature)
  - Surprise (eyebrow + mouth opening)
  - Blinking (eye closure)
  - Nodding (head vertical oscillation)

Input: JSON output from hybrid-face-detector.py
Output: JSON with per-frame + summary reactions
"""

import json
import sys
import os
import argparse
from collections import defaultdict


# =============================================================================
# Reaction Detection Functions
# =============================================================================


def detect_lip_movement(face, prev_face=None):
    """
    Detect speaking activity from lip landmarks.
    Uses YOLOv8 5-point landmarks (lm = left mouth, rm = right mouth).
    Returns lip openness value (0-1+).
    """
    landmarks = face.get("landmarks", {})
    if not landmarks or "lm" not in landmarks or "rm" not in landmarks:
        return 0.0

    lm = landmarks["lm"]  # [x, y] left mouth corner
    rm = landmarks["rm"]  # [x, y] right mouth corner
    n = landmarks.get("n", [0, 0])  # nose

    # Mouth width
    mouth_width = ((rm[0] - lm[0]) ** 2 + (rm[1] - lm[1]) ** 2) ** 0.5
    if mouth_width < 1:
        return 0.0

    # Lip separation (approximate using nose-to-mouth ratio)
    # When speaking, lips separate → mouth height increases
    # We approximate by using nose-to-chin distance vs mouth width
    mouth_center_y = (lm[1] + rm[1]) / 2
    nose_y = n[1]
    lip_separation = abs(mouth_center_y - nose_y) / max(mouth_width, 1)

    # Normalize: typical range 0.1-0.5 for closed, 0.5-1.5+ for speaking
    openness = min(lip_separation * 3, 2.0)

    # If we have prior frame, check temporal change
    if prev_face:
        prev_lm = prev_face.get("landmarks", {})
        if prev_lm and "lm" in prev_lm:
            prev_mouth_center_y = (prev_lm["lm"][1] + prev_lm["rm"][1]) / 2
            prev_lip_sep = abs(prev_mouth_center_y - prev_lm.get("n", [0, 0])[1]) / max(mouth_width, 1)
            delta = abs(lip_separation - prev_lip_sep)
            openness += min(delta * 5, 0.5)  # Movement bonus

    return round(openness, 3)


def detect_smile(landmarks):
    """
    Detect smile from mouth curvature.
    Smile = mouth corners raised relative to nose.
    """
    if not landmarks or "lm" not in landmarks or "rm" not in landmarks:
        return 0.0

    lm = landmarks["lm"]
    rm = landmarks["rm"]
    n = landmarks.get("n", [0, 0])

    # Mouth corner height relative to nose
    left_raise = n[1] - lm[1]  # positive = raised
    right_raise = n[1] - rm[1]

    avg_raise = (left_raise + right_raise) / 2
    mouth_width = ((rm[0] - lm[0]) ** 2 + (rm[1] - lm[1]) ** 2) ** 0.5
    normalized_raise = avg_raise / max(mouth_width, 1)

    # Smile intensity: > 0.15 = smiling
    smile = max(0, min(normalized_raise * 5, 1.0))
    return round(smile, 3)


def detect_eye_closure(landmarks):
    """
    Detect eye blink from eye landmarks.
    Uses YOLO landmarks: le (left eye), re (right eye).
    Returns eye openness (0 = fully closed, 1 = fully open).
    """
    if not landmarks or "le" not in landmarks or "re" not in landmarks:
        return 1.0

    le = landmarks["le"]
    re = landmarks["re"]
    n = landmarks.get("n", [0, 0])

    # Eye aspect ratio (EAR)
    left_eye_vert = abs(n[0] - le[0]) + abs(n[0] - re[0])
    if left_eye_vert < 1:
        return 1.0

    # Distance from eyes to nose as normalization
    eye_spacing = ((re[0] - le[0]) ** 2 + (re[1] - le[1]) ** 2) ** 0.5
    ear = left_eye_vert / max(eye_spacing, 1)

    # Normalize: typically 0.15-0.35
    openness = min(max((ear - 0.1) * 4, 0), 1.0)
    return round(1.0 - openness, 3)  # 1 = closed, 0 = open


def detect_head_movement(current_face, prev_face):
    """
    Detect nodding (head up/down oscillation).
    Uses change in nose y-position.
    Returns movement magnitude.
    """
    if not prev_face or not current_face:
        return 0.0

    curr_n = current_face.get("landmarks", {}).get("n", [0, 0])
    prev_n = prev_face.get("landmarks", {}).get("n", [0, 0])

    if curr_n == [0, 0] or prev_n == [0, 0]:
        return 0.0

    dy = curr_n[1] - prev_n[1]
    face_height = current_face.get("h", 100)
    normalized = abs(dy) / max(face_height, 1)
    return round(normalized, 4)


def detect_surprise(face, landmarks):
    """
    Detect surprise: raised eyebrows + open mouth.
    Approximation using face geometry changes.
    """
    mouth_open = detect_lip_movement(face)
    eye_closure = detect_eye_closure(landmarks)
    eyes_wide = 1.0 - eye_closure  # 1 = wide open

    # Surprise = wide eyes + open mouth
    surprise = (eyes_wide * 0.5 + min(mouth_open * 2, 1) * 0.5)
    return round(min(surprise, 1.0), 3)


# =============================================================================
# Reaction Analysis
# =============================================================================


def analyze_reactions(visual_data, fps=1.0):
    """
    Analyze reactions from hybrid face detector output.
    Processes timeline frames and produces reaction timeline.
    """
    timeline = visual_data.get("timeline", [])
    if not timeline:
        return {"reactions": [], "summary": {}}

    reactions = []
    prev_faces = {}  # track_id → previous face state

    for entry in timeline:
        time_sec = entry["time"]
        faces = entry.get("faces", [])

        frame_reactions = []
        for face in faces:
            track_id = face.get("track_id", -1)
            prev_face = prev_faces.get(track_id)

            landmarks = face.get("landmarks", {})
            lip = detect_lip_movement(face, prev_face)
            smile = detect_smile(landmarks)
            eye = detect_eye_closure(landmarks)
            head = detect_head_movement(face, prev_face)
            surprise = detect_surprise(face, landmarks)

            # Determine primary reaction
            primary = "none"
            if lip > 0.4:
                primary = "speaking"
            elif surprise > 0.6:
                primary = "surprise"
            elif smile > 0.5:
                primary = "smile"
            elif head > 0.08:
                primary = "nod"
            elif eye > 0.7:
                primary = "blink"

            frame_reactions.append({
                "speaker": face.get("speaker_id", "unknown"),
                "track_id": track_id,
                "time": time_sec,
                "reaction": primary,
                "scores": {
                    "lip_movement": lip,
                    "smile": smile,
                    "eye_closure": eye,
                    "head_movement": head,
                    "surprise": surprise,
                },
                "face": {
                    "cx": face.get("cx", 0),
                    "cy": face.get("cy", 0),
                    "w": face.get("w", 0),
                    "h": face.get("h", 0),
                },
            })

            prev_faces[track_id] = face

        reactions.extend(frame_reactions)

    # Build summary
    per_speaker = defaultdict(list)
    for r in reactions:
        per_speaker[r["speaker"]].append(r)

    summary = {}
    for speaker, rlist in per_speaker.items():
        reaction_counts = defaultdict(int)
        for r in rlist:
            reaction_counts[r["reaction"]] += 1
        total = len(rlist)
        summary[speaker] = {
            "total_frames": total,
            "speaking_pct": round(reaction_counts.get("speaking", 0) / max(total, 1) * 100, 1),
            "smile_pct": round(reaction_counts.get("smile", 0) / max(total, 1) * 100, 1),
            "surprise_pct": round(reaction_counts.get("surprise", 0) / max(total, 1) * 100, 1),
            "nod_pct": round(reaction_counts.get("nod", 0) / max(total, 1) * 100, 1),
            "neutral_pct": round(reaction_counts.get("none", 0) / max(total, 1) * 100, 1),
        }

    return {
        "reactions": reactions,
        "summary": summary,
        "metadata": {
            "total_frames_analyzed": len(timeline),
            "total_reactions": len(reactions),
            "speakers_analyzed": list(summary.keys()),
        },
    }


# =============================================================================
# CLI
# =============================================================================


def main():
    parser = argparse.ArgumentParser(
        description="GANYIQ Reaction Detection from Hybrid Face Detector output"
    )
    parser.add_argument("visual_data_path", help="JSON output from hybrid-face-detector.py")
    parser.add_argument("output_path", help="Path to output JSON")
    args = parser.parse_args()

    if not os.path.exists(args.visual_data_path):
        print(f"Error: visual data not found: {args.visual_data_path}", file=sys.stderr)
        sys.exit(1)

    with open(args.visual_data_path) as f:
        visual_data = json.load(f)

    print(f"[INFO] Analyzing {len(visual_data.get('timeline', []))} frames...", file=sys.stderr)
    result = analyze_reactions(visual_data)

    with open(args.output_path, "w") as f:
        json.dump(result, f, indent=2)

    summary = result["summary"]
    for speaker, stats in summary.items():
        print(
            f"  {speaker}: speaking={stats['speaking_pct']}%, "
            f"smile={stats['smile_pct']}%, "
            f"surprise={stats['surprise_pct']}%, "
            f"nod={stats['nod_pct']}%",
            file=sys.stderr,
        )
    print(f"[DONE] Saved to {args.output_path}", file=sys.stderr)


if __name__ == "__main__":
    main()
