#!/usr/bin/env python3
"""
asd.py — Active Speaker Detection for GANYIQ

Determines who is actively speaking in each video frame by
analyzing lip motion energy (variance of lip_open over a
sliding window).  Works alongside audio diarization: tracks
with high lip movement are the active speaker; tracks with
low lip movement are listeners.

Usage:
    python asd.py <face_data.json> [--window 0.5] [--threshold 0.02]
    Returns: active speaker timeline with {time, track_id, lip_energy}
"""

import json
import sys
import math
import argparse
from collections import defaultdict


def compute_lip_energy(
    face_data_path: str,
    window_sec: float = 0.5,
    min_lip_threshold: float = 0.02,
    fps: float = 10.0,
) -> list[dict]:
    """Compute per-track lip motion energy using rolling variance.

    For each face track, the lip_motion value over a rolling window
    of `window_sec` is used to compute the VARIANCE (how much the
    mouth moves).  High variance = active speaker.

    Returns list of {time, active_track_id, lip_energy, faces[]}
    sorted by time.
    """
    with open(face_data_path) as f:
        data = json.load(f)

    timeline = data.get("timeline", [])
    if not timeline:
        return []

    # Collect raw lip_motion values per track per time
    # track_id → list of (time, lip_motion)
    raw: dict[int, list[tuple[float, float]]] = defaultdict(list)
    raw_cy: dict[int, list[tuple[float, float]]] = defaultdict(list)

    for entry in timeline:
        t = entry.get("time", 0)
        for face in entry.get("faces", []):
            tid = face.get("track_id", -1)
            lm = face.get("lip_motion", 0.0)
            rcy = face.get("_raw_cy", 0.0)
            raw[tid].append((t, lm))
            raw_cy[tid].append((t, rcy))

    window_frames = max(3, int(window_sec * fps))

    # Build per-frame result
    result = []
    for entry in timeline:
        t = entry.get("time", 0)
        faces = entry.get("faces", [])

        # Compute rolling variance for each track at this time
        track_energies: dict[int, float] = {}
        for tid, vals in raw.items():
            # Get values within window_sec
            window_vals = [
                v for ft, v in vals
                if t - window_sec <= ft <= t
            ]
            # FALLBACK: If all lip_motion are zero, use _raw_cy variance instead
            if len(window_vals) >= 3 and all(v == 0.0 for v in window_vals):
                window_vals = [
                    v for ft, v in raw_cy.get(tid, [])
                    if t - window_sec <= ft <= t
                ]
            if len(window_vals) < 3:
                track_energies[tid] = 0.0
                continue
            mean = sum(window_vals) / len(window_vals)
            var = sum((v - mean) ** 2 for v in window_vals) / len(window_vals)
            track_energies[tid] = var

        # Determine active track (highest variance, above threshold)
        max_energy = 0.0
        active_tid = -1
        for tid, energy in track_energies.items():
            if energy > max_energy and energy >= min_lip_threshold:
                max_energy = energy
                active_tid = tid

        # Build per-face info with energy
        face_info = []
        for face in faces:
            tid = face.get("track_id", -1)
            sid = face.get("speaker_id", "?")
            face_info.append({
                "track_id": tid,
                "speaker_id": sid,
                "cx": face.get("cx", 0),
                "lip_motion": face.get("lip_motion", 0.0),
                "lip_energy": track_energies.get(tid, 0.0),
            })

        result.append({
            "time": t,
            "active_track_id": active_tid,
            "max_lip_energy": round(max_energy, 6),
            "faces": face_info,
        })

    return result


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="GANYIQ Active Speaker Detection (lip-motion ASD)"
    )
    parser.add_argument("face_json", help="Path to face detection JSON")
    parser.add_argument("--output", "-o", help="Output JSON path (default: stdout)")
    parser.add_argument("--window", type=float, default=0.5,
                        help="Rolling window in seconds (default: 0.5)")
    parser.add_argument("--threshold", type=float, default=0.02,
                        help="Minimum lip energy threshold (default: 0.02)")
    args = parser.parse_args()

    result = compute_lip_energy(
        face_data_path=args.face_json,
        window_sec=args.window,
        min_lip_threshold=args.threshold,
    )

    output = {
        "frames": len(result),
        "asd_timeline": result,
    }

    out_str = json.dumps(output, indent=2)
    if args.output:
        with open(args.output, "w") as f:
            f.write(out_str)
        print(f"[ASD] {len(result)} frames → {args.output}", file=sys.stderr)
    else:
        print(out_str)


if __name__ == "__main__":
    main()
