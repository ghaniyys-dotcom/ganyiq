"""
id_bridge.py — Face ID bridging utilities for GANYIQ pipeline.

Maps between track IDs, person IDs, and speaker IDs so the renderer
can consistently locate a speaker's face bounding box regardless of
which ID system the upstream modules produce.

Extracted verbatim from Pipeline class methods (Milestone 3 refactor).
"""
import json
import os

from core.logger import log


def load_face_data(result: dict) -> dict | None:
    """Read face data JSON from the path stored in *result*."""
    face_path = result.get("face_data_path")
    if face_path and os.path.exists(face_path):
        with open(face_path) as f:
            return json.load(f)
    return None


def build_id_bridge(face_data: dict) -> dict:
    """Create a mapping from any ID (track, person, speaker) to a canonical ID."""
    if not face_data or "timeline" not in face_data:
        return {}

    id_map = {}  # From any ID to a canonical ID
    person_to_canonical = {}  # Map person_id to a canonical ID

    for entry in face_data.get("timeline", []):
        for face in entry.get("faces", []):

            # Use speaker_id as the most reliable canonical ID if present
            canonical_id = face.get("speaker_id")

            # Fallback to person_id if no speaker_id
            if not canonical_id and face.get("person_id"):
                pid = face.get("person_id")
                if pid in person_to_canonical:
                    canonical_id = person_to_canonical[pid]
                else:
                    # Create a new canonical from person_id
                    canonical_id = f"person_{pid}"
                    person_to_canonical[pid] = canonical_id

            # Fallback to track_id if neither is present
            if not canonical_id and face.get("track_id"):
                canonical_id = f"track_{face.get('track_id')}"

            if canonical_id:
                # Map all available IDs for this face to the canonical ID
                if face.get("speaker_id"):
                    id_map[face.get("speaker_id").upper()] = canonical_id
                if face.get("person_id"):
                    pid = face.get("person_id")
                    id_map[f"person_{pid}"] = canonical_id
                    person_to_canonical[pid] = canonical_id
                if face.get("track_id"):
                    id_map[f"track_{face.get('track_id')}"] = canonical_id

    # Second pass to ensure all aliases point to the final canonical
    for alias, canon in id_map.items():
        if canon in id_map and id_map[canon] != canon:
            id_map[alias] = id_map[canon]

    return id_map


def get_speaker_bbox(face_data: dict, id_bridge: dict, target_id: str,
                     start: float, end: float,
                     frame_w: int, frame_h: int) -> dict | None:
    """Finds a target's face BBox using the ID bridge."""
    if not target_id or not face_data:
        return None

    canonical_id = id_bridge.get(target_id.upper())
    if not canonical_id:
        # Fallback for IDs that might not be in the bridge (e.g. old formats)
        canonical_id = target_id

    # 1. Direct search using canonical ID
    for entry in face_data.get("timeline", []):
        t = entry.get("time", 0)
        if not (start - 0.2 <= t <= end + 0.2):
            continue

        for face in entry.get("faces", []):
            # Check all possible IDs against the canonical ID
            face_sid = face.get("speaker_id")
            face_pid = f"person_{face.get('person_id')}" if face.get("person_id") else None
            face_tid = f"track_{face.get('track_id')}" if face.get("track_id") else None

            current_face_canon = None
            if face_sid:
                current_face_canon = id_bridge.get(face_sid.upper())
            elif face_pid:
                current_face_canon = id_bridge.get(face_pid)
            elif face_tid:
                current_face_canon = id_bridge.get(face_tid)

            if current_face_canon == canonical_id:
                cx, cy, w, h = face.get("cx"), face.get("cy"), face.get("w"), face.get("h")
                if cx and cy and w and h:
                    return {"cx": cx, "cy": cy, "w": w, "h": h}

    # 2. Fallback: search for the raw target_id case-insensitively
    target_upper = target_id.upper()
    for entry in face_data.get("timeline", []):
        t = entry.get("time", 0)
        if not (start - 0.2 <= t <= end + 0.2):
            continue
        for face in entry.get("faces", []):
            if face.get("speaker_id", "").upper() == target_upper:
                cx, cy, w, h = face.get("cx"), face.get("cy"), face.get("w"), face.get("h")
                if cx and cy and w and h:
                    log("PIPELINE", f"  [BBOX-FALLBACK-1] Found '{target_id}' via raw uppercase match.")
                    return {"cx": cx, "cy": cy, "w": w, "h": h}

    # 3. Last resort: use the best (largest) face in the shot range
    candidates = []
    for entry in face_data.get("timeline", []):
        t = entry.get("time", 0)
        if not (start - 0.2 <= t <= end + 0.2):
            continue
        for face in entry.get("faces", []):
            cx, cy, w, h = face.get("cx"), face.get("cy"), face.get("w"), face.get("h")
            if cx and cy and w and h and w >= 15 and h >= 15:
                candidates.append((w * h, cx, cy, w, h))

    if candidates:
        best = max(candidates, key=lambda x: x[0])
        log("PIPELINE", f"  [BBOX-FALLBACK-2] Target '{target_id}' not found — using largest face in shot.")
        return {"cx": best[1], "cy": best[2], "w": best[3], "h": best[4]}

    log("PIPELINE", f"  [BBOX-WARN] Target '{target_id}' not found in any cluster for {start:.1f}s-{end:.1f}s")
    return None
