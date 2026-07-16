"""
canonical_person_registry.py — Persistent human identity layer for GANYIQ.

Solves the ByteTrack fragmentation problem: different track_ids can represent
the same physical person. This module builds a stable per-video registry of
canonical persons using face embeddings, temporal continuity, and spatial
constraints.

Sprint 3 deliverable.
"""

import numpy as np
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Set, Tuple


@dataclass
class CanonicalPerson:
    """Represents one physical person across multiple track_id fragments."""
    
    canonical_id: str  # PERSON_000, PERSON_001, etc.
    track_ids: Set[int] = field(default_factory=set)  # All ByteTrack IDs
    
    # Face embedding data
    face_embedding_centroid: Optional[np.ndarray] = None
    face_embeddings: List[np.ndarray] = field(default_factory=list)
    
    # Temporal data
    first_seen: float = float('inf')
    last_seen: float = 0.0
    visibility_duration: float = 0.0
    
    # Spatial data
    bbox_timeline: List[Dict] = field(default_factory=list)  # {time, cx, cy, w, h}
    
    # Identity associations
    current_track_id: Optional[int] = None  # Most recent active track
    audio_speaker_id: Optional[str] = None
    audio_match_confidence: float = 0.0
    
    # Active speaker data
    active_speaker_confidence: float = 0.0
    active_speaker_frames: int = 0
    
    # Reaction timeline
    reaction_events: List[Dict] = field(default_factory=list)
    
    def update_from_observation(self, track_id: int, time: float, bbox: Dict, 
                                embedding: Optional[np.ndarray] = None):
        """Update person data from a new face observation."""
        self.track_ids.add(track_id)
        self.current_track_id = track_id
        
        if time < self.first_seen:
            self.first_seen = time
        if time > self.last_seen:
            self.last_seen = time
        
        self.bbox_timeline.append({
            'time': time,
            'track_id': track_id,
            'cx': bbox.get('cx', 0),
            'cy': bbox.get('cy', 0),
            'w': bbox.get('w', 0),
            'h': bbox.get('h', 0),
        })
        
        if embedding is not None:
            self.face_embeddings.append(embedding)
            # Update centroid with running average
            if self.face_embedding_centroid is None:
                self.face_embedding_centroid = embedding.copy()
            else:
                # Exponential moving average
                alpha = 0.3
                self.face_embedding_centroid = (
                    (1 - alpha) * self.face_embedding_centroid + 
                    alpha * embedding
                )
    
    def get_median_position(self) -> Tuple[float, float]:
        """Get median bbox center position across all observations."""
        if not self.bbox_timeline:
            return (0.0, 0.0)
        
        cx_values = [b['cx'] for b in self.bbox_timeline]
        cy_values = [b['cy'] for b in self.bbox_timeline]
        
        cx_values.sort()
        cy_values.sort()
        
        mid = len(cx_values) // 2
        return (cx_values[mid], cy_values[mid])
    
    def get_spatial_trajectory_overlap(self, other: 'CanonicalPerson', 
                                       threshold: float = 50.0) -> float:
        """Calculate spatial overlap ratio with another person (0.0 to 1.0)."""
        if not self.bbox_timeline or not other.bbox_timeline:
            return 0.0
        
        # Sample positions at regular intervals
        my_positions = [(b['cx'], b['cy']) for b in self.bbox_timeline]
        other_positions = [(b['cx'], b['cy']) for b in other.bbox_timeline]
        
        overlap_count = 0
        total_checks = min(len(my_positions), len(other_positions))
        
        for i in range(total_checks):
            my_cx, my_cy = my_positions[i]
            other_cx, other_cy = other_positions[i]
            
            dist = np.sqrt((my_cx - other_cx)**2 + (my_cy - other_cy)**2)
            if dist < threshold:
                overlap_count += 1
        
        return overlap_count / max(total_checks, 1)
    
    def to_dict(self) -> Dict:
        """Export canonical person data."""
        return {
            'canonical_id': self.canonical_id,
            'track_ids': sorted(list(self.track_ids)),
            'first_seen': self.first_seen,
            'last_seen': self.last_seen,
            'visibility_duration': self.last_seen - self.first_seen,
            'total_observations': len(self.bbox_timeline),
            'median_position': self.get_median_position(),
            'audio_speaker_id': self.audio_speaker_id,
            'audio_match_confidence': self.audio_match_confidence,
            'active_speaker_frames': self.active_speaker_frames,
            'reaction_count': len(self.reaction_events),
        }


class CanonicalPersonRegistry:
    """Manages canonical person identities for a video analysis session."""
    
    def __init__(self, embedding_threshold: float = 0.50,
                 temporal_gap_threshold: float = 5.0,
                 spatial_distance_threshold: float = 100.0):
        """
        Initialize registry.
        
        Args:
            embedding_threshold: Max face embedding distance for same person
            temporal_gap_threshold: Max time gap (sec) for tracklet continuity
            spatial_distance_threshold: Max bbox center distance for same person
        """
        self.persons: Dict[str, CanonicalPerson] = {}  # canonical_id -> person
        self.track_to_person: Dict[int, str] = {}  # track_id -> canonical_id
        
        self.embedding_threshold = embedding_threshold
        self.temporal_gap_threshold = temporal_gap_threshold
        self.spatial_distance_threshold = spatial_distance_threshold
        
        self._next_person_id = 0
        self._merge_log: List[Dict] = []
        self._rejection_log: List[Dict] = []
    
    def _generate_person_id(self) -> str:
        """Generate next canonical person ID."""
        person_id = f"PERSON_{self._next_person_id:03d}"
        self._next_person_id += 1
        return person_id
    
    def register_observation(self, track_id: int, time: float, bbox: Dict,
                           embedding: Optional[np.ndarray] = None,
                           person_id: Optional[int] = None) -> str:
        """
        Register a face observation and return canonical person ID.
        
        Args:
            track_id: ByteTrack track ID
            time: Timestamp in seconds
            bbox: Bounding box dict with cx, cy, w, h
            embedding: Optional face embedding vector
            person_id: Optional existing person_id from FaceDB
        
        Returns:
            Canonical person ID (PERSON_XXX)
        """
        # Check if track already mapped
        if track_id in self.track_to_person:
            canonical_id = self.track_to_person[track_id]
            person = self.persons[canonical_id]
            person.update_from_observation(track_id, time, bbox, embedding)
            return canonical_id
        
        # Try to match to existing person
        matched_id = self._find_matching_person(track_id, time, bbox, embedding, person_id)
        
        if matched_id:
            person = self.persons[matched_id]
            person.update_from_observation(track_id, time, bbox, embedding)
            self.track_to_person[track_id] = matched_id
            return matched_id
        
        # Create new canonical person
        new_id = self._generate_person_id()
        new_person = CanonicalPerson(canonical_id=new_id)
        new_person.update_from_observation(track_id, time, bbox, embedding)
        
        self.persons[new_id] = new_person
        self.track_to_person[track_id] = new_id
        
        return new_id
    
    def _find_matching_person(self, track_id: int, time: float, bbox: Dict,
                             embedding: Optional[np.ndarray],
                             person_id: Optional[int]) -> Optional[str]:
        """Find best matching canonical person for this observation."""
        
        candidates = []
        
        for canonical_id, person in self.persons.items():
            score = 0.0
            reasons = []
            
            # Evidence 1: Face embedding similarity
            if embedding is not None and person.face_embedding_centroid is not None:
                emb_dist = float(np.linalg.norm(embedding - person.face_embedding_centroid))
                if emb_dist < self.embedding_threshold:
                    score += (self.embedding_threshold - emb_dist) * 10
                    reasons.append(f"embedding_dist={emb_dist:.3f}")
            
            # Evidence 2: Temporal continuity
            time_gap = time - person.last_seen
            if 0 < time_gap < self.temporal_gap_threshold:
                score += (self.temporal_gap_threshold - time_gap) * 2
                reasons.append(f"time_gap={time_gap:.1f}s")
            
            # Evidence 3: Spatial proximity
            if person.bbox_timeline:
                last_bbox = person.bbox_timeline[-1]
                cx_dist = abs(bbox.get('cx', 0) - last_bbox['cx'])
                cy_dist = abs(bbox.get('cy', 0) - last_bbox['cy'])
                spatial_dist = np.sqrt(cx_dist**2 + cy_dist**2)
                
                if spatial_dist < self.spatial_distance_threshold:
                    score += (self.spatial_distance_threshold - spatial_dist) * 0.5
                    reasons.append(f"spatial_dist={spatial_dist:.1f}px")
            
            if score > 0:
                candidates.append((canonical_id, score, reasons))
        
        if not candidates:
            return None
        
        # Return best match
        candidates.sort(key=lambda x: x[1], reverse=True)
        best_id, best_score, best_reasons = candidates[0]
        
        self._merge_log.append({
            'track_id': track_id,
            'matched_person': best_id,
            'score': best_score,
            'reasons': best_reasons,
            'time': time,
        })
        
        return best_id
    
    def validate_simultaneous_visibility(self, person_a: str, person_b: str,
                                        time_window: float = 0.1) -> bool:
        """
        Check if two persons were visible simultaneously.
        
        Returns True if they have overlapping visibility, False otherwise.
        Used to prevent merging tracklets that were both visible at once.
        """
        if person_a not in self.persons or person_b not in self.persons:
            return False
        
        timeline_a = self.persons[person_a].bbox_timeline
        timeline_b = self.persons[person_b].bbox_timeline
        
        if not timeline_a or not timeline_b:
            return False
        
        # Check for any temporal overlap
        for obs_a in timeline_a:
            time_a = obs_a['time']
            for obs_b in timeline_b:
                time_b = obs_b['time']
                if abs(time_a - time_b) < time_window:
                    return True
        
        return False
    
    def merge_persons(self, source_id: str, target_id: str, 
                     reason: str = "manual") -> bool:
        """
        Merge source person into target person.
        
        Only allowed if they were never visible simultaneously.
        """
        if source_id not in self.persons or target_id not in self.persons:
            return False
        
        # Safety check: prevent merging simultaneously visible persons
        if self.validate_simultaneous_visibility(source_id, target_id):
            self._rejection_log.append({
                'source': source_id,
                'target': target_id,
                'reason': 'simultaneous_visibility',
                'operation': 'merge_rejected',
            })
            return False
        
        source = self.persons[source_id]
        target = self.persons[target_id]
        
        # Merge all data
        target.track_ids.update(source.track_ids)
        target.bbox_timeline.extend(source.bbox_timeline)
        target.bbox_timeline.sort(key=lambda x: x['time'])
        target.face_embeddings.extend(source.face_embeddings)
        target.reaction_events.extend(source.reaction_events)
        
        # Update time bounds
        target.first_seen = min(target.first_seen, source.first_seen)
        target.last_seen = max(target.last_seen, source.last_seen)
        
        # Update embedding centroid
        if source.face_embedding_centroid is not None:
            if target.face_embedding_centroid is None:
                target.face_embedding_centroid = source.face_embedding_centroid
            else:
                # Average the centroids
                target.face_embedding_centroid = (
                    target.face_embedding_centroid + 
                    source.face_embedding_centroid
                ) / 2.0
        
        # Remap track_ids
        for track_id in source.track_ids:
            self.track_to_person[track_id] = target_id
        
        # Remove source
        del self.persons[source_id]
        
        self._merge_log.append({
            'source': source_id,
            'target': target_id,
            'reason': reason,
            'merged_tracks': len(source.track_ids),
        })
        
        return True
    
    def get_person_by_track(self, track_id: int) -> Optional[CanonicalPerson]:
        """Get canonical person object for a track_id."""
        canonical_id = self.track_to_person.get(track_id)
        if canonical_id:
            return self.persons.get(canonical_id)
        return None
    
    def get_statistics(self) -> Dict:
        """Get registry statistics."""
        total_tracks = len(self.track_to_person)
        total_persons = len(self.persons)
        
        tracklets_per_person = []
        observations_per_person = []
        
        for person in self.persons.values():
            tracklets_per_person.append(len(person.track_ids))
            observations_per_person.append(len(person.bbox_timeline))
        
        avg_tracklets = (
            sum(tracklets_per_person) / len(tracklets_per_person)
            if tracklets_per_person else 0
        )
        
        return {
            'total_canonical_persons': total_persons,
            'total_track_ids': total_tracks,
            'avg_tracklets_per_person': round(avg_tracklets, 2),
            'total_merges': len(self._merge_log),
            'total_rejections': len(self._rejection_log),
            'persons': [p.to_dict() for p in self.persons.values()],
        }
    
    def export_track_to_person_map(self) -> Dict[int, str]:
        """Export the track_id -> canonical_id mapping."""
        return dict(self.track_to_person)
    
    def validate_split_targets(self, primary_person: str, secondary_person: str,
                              shot_duration: float = 1.0) -> Dict:
        """
        Validate that two persons are suitable for split-screen rendering.
        
        Returns validation result with status and reasons.
        """
        result = {
            'valid': True,
            'reasons': [],
            'warnings': [],
        }
        
        if primary_person not in self.persons:
            result['valid'] = False
            result['reasons'].append(f'Primary person {primary_person} not found')
            return result
        
        if secondary_person not in self.persons:
            result['valid'] = False
            result['reasons'].append(f'Secondary person {secondary_person} not found')
            return result
        
        # Check 1: Same person
        if primary_person == secondary_person:
            result['valid'] = False
            result['reasons'].append('Primary and secondary are the same person')
            return result
        
        # Check 2: Simultaneous visibility
        if not self.validate_simultaneous_visibility(primary_person, secondary_person):
            result['valid'] = False
            result['reasons'].append('Persons not visible simultaneously')
            return result
        
        # Check 3: Spatial separation
        person_a = self.persons[primary_person]
        person_b = self.persons[secondary_person]
        
        spatial_overlap = person_a.get_spatial_trajectory_overlap(person_b)
        if spatial_overlap > 0.7:
            result['valid'] = False
            result['reasons'].append(
                f'High spatial trajectory overlap: {spatial_overlap:.2f}'
            )
            return result
        
        # Check 4: Sufficient visibility duration
        min_duration = shot_duration * 0.8
        duration_a = person_a.last_seen - person_a.first_seen
        duration_b = person_b.last_seen - person_b.first_seen
        
        if duration_a < min_duration:
            result['warnings'].append(
                f'{primary_person} visible for only {duration_a:.1f}s'
            )
        
        if duration_b < min_duration:
            result['warnings'].append(
                f'{secondary_person} visible for only {duration_b:.1f}s'
            )
        
        # Check 5: Median position distance
        pos_a = person_a.get_median_position()
        pos_b = person_b.get_median_position()
        
        distance = np.sqrt(
            (pos_a[0] - pos_b[0])**2 + 
            (pos_a[1] - pos_b[1])**2
        )
        
        if distance < 50:
            result['warnings'].append(
                f'Persons very close together: {distance:.1f}px median distance'
            )
        
        return result
