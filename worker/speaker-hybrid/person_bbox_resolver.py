"""
person_bbox_resolver.py — Canonical Person → Track → Bbox Resolution

Sprint 3.1: Resolves PERSON_XXX canonical IDs to actual track bboxes.

Input: canonical_person_id, shot_start, shot_end, face_data, canonical_persons
Output: selected_track_id, bbox, resolution_method, confidence

Handles:
- Canonical person with multiple fragmented ByteTrack IDs
- Track visibility during shot interval
- Temporal ranking and selection
- Explicit failure reasons
"""

from typing import Dict, List, Optional, Tuple
from dataclasses import dataclass


@dataclass
class BboxResolution:
    """Result of canonical person bbox resolution."""
    success: bool
    track_id: Optional[int] = None
    bbox: Optional[Dict] = None  # {cx, cy, w, h}
    resolution_method: str = ""
    confidence: float = 0.0
    failure_reason: str = ""
    bbox_timeline: List[Dict] = None
    
    def __post_init__(self):
        if self.bbox_timeline is None:
            self.bbox_timeline = []


class PersonBboxResolver:
    """Resolves canonical PERSON_XXX IDs to track bboxes for rendering."""
    
    def __init__(self, max_bbox_age: float = 5.0):
        """
        Initialize resolver.
        
        Args:
            max_bbox_age: Maximum age (seconds) for bbox reuse
        """
        self.max_bbox_age = max_bbox_age
    
    def resolve(self,
                canonical_person_id: str,
                shot_start: float,
                shot_end: float,
                face_data: Dict,
                canonical_persons: Dict,
                track_to_person_map: Dict[str, str]) -> BboxResolution:
        """
        Resolve canonical person ID to track bbox for specific shot interval.
        
        Args:
            canonical_person_id: PERSON_XXX canonical ID
            shot_start: Shot start time (seconds)
            shot_end: Shot end time (seconds)
            face_data: Full face detection timeline
            canonical_persons: Canonical person registry statistics
            track_to_person_map: Track ID → canonical person ID mapping
        
        Returns:
            BboxResolution with success status and data/failure reason
        """
        
        # Validate input
        if not canonical_person_id or not canonical_person_id.startswith("PERSON_"):
            return BboxResolution(
                success=False,
                failure_reason=f"INVALID_PERSON_ID: {canonical_person_id}"
            )
        
        if not face_data or not canonical_persons or not track_to_person_map:
            return BboxResolution(
                success=False,
                failure_reason="MISSING_DATA: face_data, canonical_persons, or track_to_person_map unavailable"
            )
        
        # Find all track IDs belonging to this canonical person
        member_tracks = []
        for track_id_str, person_id in track_to_person_map.items():
            if person_id == canonical_person_id:
                try:
                    member_tracks.append(int(track_id_str))
                except (ValueError, TypeError):
                    continue
        
        if not member_tracks:
            return BboxResolution(
                success=False,
                failure_reason=f"NO_MEMBER_TRACKS: {canonical_person_id} has no associated track IDs"
            )
        
        # Collect all face observations for member tracks during shot interval
        candidates = []
        timeline = face_data.get("timeline", [])
        
        for entry in timeline:
            t = entry.get("time", 0.0)
            
            # Expand search window slightly for temporal continuity
            if not (shot_start - 0.5 <= t <= shot_end + 0.5):
                continue
            
            for face in entry.get("faces", []):
                track_id = face.get("track_id")
                
                if track_id not in member_tracks:
                    continue
                
                # Extract bbox
                cx = face.get("cx")
                cy = face.get("cy")
                w = face.get("w")
                h = face.get("h")
                
                if cx is None or cy is None or w is None or h is None:
                    continue
                
                # Check bbox validity
                if w < 40 or h < 40:
                    continue
                
                candidates.append({
                    'track_id': track_id,
                    'time': t,
                    'bbox': {'cx': cx, 'cy': cy, 'w': w, 'h': h},
                    'confidence': face.get('confidence', 0.5),
                    'canonical_person_id': face.get('canonical_person_id'),
                })
        
        if not candidates:
            return BboxResolution(
                success=False,
                failure_reason=f"NO_VISIBLE_TRACK: {canonical_person_id} has no visible faces during shot [{shot_start:.1f}, {shot_end:.1f}]"
            )
        
        # Rank candidates by temporal overlap and quality
        shot_midpoint = (shot_start + shot_end) / 2.0
        shot_duration = shot_end - shot_start
        
        scored_candidates = []
        for cand in candidates:
            t = cand['time']
            
            # Temporal overlap score (higher = better)
            if shot_start <= t <= shot_end:
                temporal_score = 1.0
            else:
                # Penalize observations outside shot
                distance = min(abs(t - shot_start), abs(t - shot_end))
                temporal_score = max(0.0, 1.0 - (distance / shot_duration))
            
            # Distance to midpoint score (prefer center of shot)
            midpoint_distance = abs(t - shot_midpoint)
            midpoint_score = max(0.0, 1.0 - (midpoint_distance / (shot_duration / 2.0)))
            
            # Confidence score
            confidence_score = cand['confidence']
            
            # Face size score (larger = more confident detection)
            area = cand['bbox']['w'] * cand['bbox']['h']
            size_score = min(1.0, area / 10000.0)  # Normalize to reasonable range
            
            # Combined score
            total_score = (
                temporal_score * 0.5 +
                midpoint_score * 0.2 +
                confidence_score * 0.2 +
                size_score * 0.1
            )
            
            scored_candidates.append({
                **cand,
                'score': total_score,
                'temporal_score': temporal_score,
                'midpoint_score': midpoint_score,
            })
        
        # Sort by score (highest first)
        scored_candidates.sort(key=lambda x: x['score'], reverse=True)
        
        # Select best candidate
        best = scored_candidates[0]
        
        # Check bbox age relative to shot start
        bbox_age = shot_start - best['time']
        if bbox_age > self.max_bbox_age:
            return BboxResolution(
                success=False,
                failure_reason=f"BBOX_STALE: best bbox is {bbox_age:.1f}s old (max={self.max_bbox_age})"
            )
        
        # Success
        return BboxResolution(
            success=True,
            track_id=best['track_id'],
            bbox=best['bbox'],
            resolution_method="temporal_overlap_ranking",
            confidence=best['score'],
            bbox_timeline=[c['bbox'] for c in scored_candidates[:5]]  # Top 5 for debugging
        )
    
    def resolve_legacy_track(self,
                            track_id_str: str,
                            shot_start: float,
                            shot_end: float,
                            face_data: Dict) -> BboxResolution:
        """
        Legacy fallback: resolve TRACK_X or track_X directly from face_data.
        
        Used for backward compatibility with non-canonical IDs.
        """
        
        # Parse track ID
        if track_id_str.upper().startswith("TRACK_"):
            try:
                track_id = int(track_id_str.split("_")[1])
            except (ValueError, IndexError):
                return BboxResolution(
                    success=False,
                    failure_reason=f"INVALID_LEGACY_ID: cannot parse {track_id_str}"
                )
        else:
            return BboxResolution(
                success=False,
                failure_reason=f"NOT_LEGACY_TRACK: {track_id_str}"
            )
        
        # Search for track in face_data
        timeline = face_data.get("timeline", [])
        
        for entry in timeline:
            t = entry.get("time", 0.0)
            
            if not (shot_start - 0.5 <= t <= shot_end + 0.5):
                continue
            
            for face in entry.get("faces", []):
                if face.get("track_id") == track_id:
                    cx = face.get("cx")
                    cy = face.get("cy")
                    w = face.get("w")
                    h = face.get("h")
                    
                    if cx is not None and cy is not None and w and h:
                        bbox_age = shot_start - t
                        if bbox_age > self.max_bbox_age:
                            continue
                        
                        return BboxResolution(
                            success=True,
                            track_id=track_id,
                            bbox={'cx': cx, 'cy': cy, 'w': w, 'h': h},
                            resolution_method="legacy_track_direct",
                            confidence=0.8,
                        )
        
        return BboxResolution(
            success=False,
            failure_reason=f"LEGACY_TRACK_NOT_FOUND: {track_id_str} not visible during shot"
        )
