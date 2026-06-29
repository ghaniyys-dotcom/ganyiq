#!/usr/bin/env python3
"""
debug_asd.py - Diagnostic script untuk debug ASD pipeline

Cek:
1. Apakah face_data.json punya field lip_motion?
2. Berapa nilai lip_motion? (0 semua = broken)
3. Apakah _raw_cy ada? (untuk YOLO fallback)
4. Variance calculation dari ASD
5. Track IDs dan speaker IDs

Usage:
  python debug_asd.py <path_to_face_data.json>
"""

import json
import sys
from collections import defaultdict

def main():
    if len(sys.argv) < 2:
        print("Usage: python debug_asd.py <face_data.json>")
        sys.exit(1)
    
    face_json = sys.argv[1]
    
    print("="*60)
    print("ASD DIAGNOSTIC REPORT")
    print("="*60)
    
    with open(face_json) as f:
        data = json.load(f)
    
    timeline = data.get("timeline", [])
    print(f"\n[1] BASIC INFO")
    print(f"  Total frames: {len(timeline)}")
    
    # Collect all faces
    all_faces = []
    track_ids = set()
    speaker_ids = set()
    
    for entry in timeline:
        for face in entry.get("faces", []):
            all_faces.append(face)
            track_ids.add(face.get("track_id", -1))
            speaker_ids.add(face.get("speaker_id", "?"))
    
    print(f"  Total face detections: {len(all_faces)}")
    print(f"  Unique track IDs: {len(track_ids)} → {sorted(track_ids)}")
    print(f"  Unique speaker IDs: {len(speaker_ids)} → {sorted(speaker_ids)}")
    
    # Check lip_motion field presence
    print(f"\n[2] LIP_MOTION FIELD CHECK")
    faces_with_lip = sum(1 for f in all_faces if "lip_motion" in f)
    faces_nonzero_lip = sum(1 for f in all_faces if f.get("lip_motion", 0) != 0)
    
    print(f"  Faces with 'lip_motion' field: {faces_with_lip}/{len(all_faces)}")
    print(f"  Faces with NON-ZERO lip_motion: {faces_nonzero_lip}/{len(all_faces)}")
    
    if faces_nonzero_lip == 0:
        print(f"  ❌ ALL lip_motion values are ZERO → ASD will return 0 active frames")
    else:
        print(f"  ✓ Some faces have non-zero lip_motion")
    
    # Sample lip_motion values
    sample_lips = [f.get("lip_motion", 0) for f in all_faces[:20]]
    print(f"  Sample lip_motion (first 20): {sample_lips}")
    
    # Check _raw_cy field (for YOLO fallback)
    print(f"\n[3] _RAW_CY FIELD CHECK (YOLO fallback)")
    faces_with_raw_cy = sum(1 for f in all_faces if "_raw_cy" in f)
    faces_nonzero_raw_cy = sum(1 for f in all_faces if f.get("_raw_cy", 0) != 0)
    
    print(f"  Faces with '_raw_cy' field: {faces_with_raw_cy}/{len(all_faces)}")
    print(f"  Faces with NON-ZERO _raw_cy: {faces_nonzero_raw_cy}/{len(all_faces)}")
    
    # Compute variance per track (same logic as asd.py)
    print(f"\n[4] ASD VARIANCE CALCULATION (window=0.5s, fps=10)")
    
    raw = defaultdict(list)
    for entry in timeline:
        t = entry.get("time", 0)
        for face in entry.get("faces", []):
            tid = face.get("track_id", -1)
            lm = face.get("lip_motion", 0.0)
            raw[tid].append((t, lm))
    
    window_sec = 0.5
    threshold = 0.02
    
    # Sample variance at 3 different times
    sample_times = []
    if len(timeline) > 0:
        sample_times.append(timeline[len(timeline)//4].get("time", 0))
        sample_times.append(timeline[len(timeline)//2].get("time", 0))
        sample_times.append(timeline[len(timeline)*3//4].get("time", 0))
    
    for sample_t in sample_times:
        track_variances = {}
        for tid, vals in raw.items():
            window_vals = [v for ft, v in vals if sample_t - window_sec <= ft <= sample_t]
            if len(window_vals) < 3:
                track_variances[tid] = 0.0
                continue
            mean = sum(window_vals) / len(window_vals)
            var = sum((v - mean) ** 2 for v in window_vals) / len(window_vals)
            track_variances[tid] = var
        
        max_tid = max(track_variances, key=track_variances.get, default=-1)
        max_var = track_variances.get(max_tid, 0.0)
        
        print(f"  Time {sample_t:.1f}s:")
        print(f"    Track variances: {dict(track_variances)}")
        print(f"    Max variance: {max_var:.6f} (track {max_tid})")
        print(f"    Above threshold ({threshold})? {max_var >= threshold}")
    
    # Count active frames
    active_frames = 0
    for entry in timeline:
        t = entry.get("time", 0)
        track_energies = {}
        for tid, vals in raw.items():
            window_vals = [v for ft, v in vals if t - window_sec <= ft <= t]
            if len(window_vals) < 3:
                track_energies[tid] = 0.0
                continue
            mean = sum(window_vals) / len(window_vals)
            var = sum((v - mean) ** 2 for v in window_vals) / len(window_vals)
            track_energies[tid] = var
        
        max_energy = max(track_energies.values()) if track_energies else 0.0
        if max_energy >= threshold:
            active_frames += 1
    
    print(f"\n[5] ASD RESULT")
    print(f"  Active frames: {active_frames}/{len(timeline)}")
    print(f"  Percentage: {100*active_frames/len(timeline):.1f}%" if len(timeline) > 0 else "  Percentage: N/A")
    
    if active_frames == 0:
        print(f"\n❌ PROBLEM: 0 active frames detected")
        print(f"   Possible causes:")
        print(f"   1. lip_motion all ZERO → MediaPipe not working + YOLO fallback not working")
        print(f"   2. Variance below threshold ({threshold}) → signal too weak or threshold too high")
        print(f"   3. ByteTrack dropped lip_motion field → check tracker.py")
    else:
        print(f"\n✓ ASD working: {active_frames} frames with active speaker")
    
    print("="*60)

if __name__ == "__main__":
    main()
