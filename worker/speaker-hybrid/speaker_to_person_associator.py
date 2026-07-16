#!/usr/bin/env python3
"""
speaker_to_person_associator.py — Audio Speaker → Canonical Person Association

Maps audio speaker IDs (SPEAKER_00, SPEAKER_01) to canonical visual person IDs
(PERSON_000, PERSON_001) using temporal evidence from diarization, ASD lip motion,
and visual presence.

Association is based on:
1. Temporal overlap between audio speech and visual presence
2. ASD lip motion evidence during speech intervals
3. Visibility coverage and consistency across multiple intervals
4. Temporal correlation strength

Does NOT use:
- Face size/position alone
- Detection duration alone
- Fabricated mappings when evidence is insufficient
"""

import sys
from typing import Dict, List, Optional, Tuple
from dataclasses import dataclass
from collections import defaultdict


@dataclass
class SpeakerAssociation:
    """Result of audio speaker → canonical person association."""
    audio_speaker_id: str  # e.g., SPEAKER_00
    canonical_person_id: Optional[str]  # e.g., PERSON_001 or None
    confidence: float  # 0.0 - 1.0
    evidence_count: int  # Number of supporting intervals
    supporting_duration: float  # Total seconds of evidence
    association_status: str  # CONFIRMED, AMBIGUOUS, UNRESOLVED, ASD_UNAVAILABLE
    failure_reason: Optional[str] = None


class SpeakerToPersonAssociator:
    """
    Associates audio speakers to canonical persons using temporal evidence.
    
    Algorithm:
    1. For each audio speaker, extract all speech intervals from diarization
    2. For each interval, find all visible canonical persons
    3. For each visible person, check ASD lip motion evidence
    4. Compute temporal correlation score based on:
       - Lip motion presence during speech
       - Visibility coverage
       - Consistency across intervals
    5. Select the person with strongest evidence
    6. Apply confidence thresholds and ambiguity detection
    """
    
    # Confidence thresholds
    CONFIRMED_THRESHOLD = 0.6  # High confidence association
    AMBIGUOUS_THRESHOLD = 0.3  # Multiple candidates with similar scores
    MIN_EVIDENCE_INTERVALS = 1  # Minimum speech intervals for confidence (changed from 2)
    MIN_SUPPORTING_DURATION = 2.0  # Minimum seconds of evidence
    
    # Temporal correlation parameters
    LIP_MOTION_WEIGHT = 0.7  # Weight for ASD lip motion evidence
    VISIBILITY_WEIGHT = 0.3  # Weight for simple visibility
    
    def __init__(self, log_fn=None):
        """
        Initialize associator.
        
        Parameters
        ----------
        log_fn : callable, optional
            Logging function (default: print to stderr)
        """
        self.log = log_fn or (lambda msg: print(f"[ASSOCIATOR] {msg}", file=sys.stderr, flush=True))
    
    def associate_speakers_to_persons(
        self,
        diarization_segments: List[Dict],
        face_timeline: List[Dict],
        asd_available: bool,
        canonical_persons: Dict,
        track_to_person_map: Dict[int, str]
    ) -> Dict[str, SpeakerAssociation]:
        """
        Associate all audio speakers to canonical persons.
        
        Parameters
        ----------
        diarization_segments : list of dict
            Audio diarization with speaker labels and time intervals.
            Format: [{"speaker": "SPEAKER_00", "start": 0.0, "end": 5.2}, ...]
        face_timeline : list of dict
            Visual face timeline with ASD evidence.
            Format: [{"time": 0.0, "faces": [{"track_id": 1, "canonical_person_id": "PERSON_000", 
                                               "is_active_speaker": True, ...}]}, ...]
        asd_available : bool
            Whether ASD lip motion data is available
        canonical_persons : dict
            Canonical person registry statistics
        track_to_person_map : dict
            Track ID → canonical person ID mapping
            
        Returns
        -------
        dict
            Mapping of audio_speaker_id → SpeakerAssociation
        """
        if not diarization_segments:
            self.log("No diarization segments provided")
            return {}
        
        if not asd_available:
            self.log("ASD unavailable - cannot perform reliable association")
            return self._create_unavailable_associations(diarization_segments)
        
        # Extract unique speaker IDs from diarization
        speaker_ids = sorted(set(seg["speaker"] for seg in diarization_segments))
        self.log(f"Associating {len(speaker_ids)} audio speakers to canonical persons")
        
        associations = {}
        for speaker_id in speaker_ids:
            association = self._associate_single_speaker(
                speaker_id,
                diarization_segments,
                face_timeline,
                canonical_persons,
                track_to_person_map
            )
            associations[speaker_id] = association
            
            self.log(
                f"  {speaker_id} → {association.canonical_person_id or 'UNRESOLVED'} "
                f"(status={association.association_status}, confidence={association.confidence:.2f}, "
                f"evidence={association.evidence_count} intervals, {association.supporting_duration:.1f}s)"
            )
        
        return associations
    
    def _create_unavailable_associations(
        self, 
        diarization_segments: List[Dict]
    ) -> Dict[str, SpeakerAssociation]:
        """Create ASD_UNAVAILABLE associations when lip motion data is missing."""
        speaker_ids = sorted(set(seg["speaker"] for seg in diarization_segments))
        associations = {}
        
        for speaker_id in speaker_ids:
            associations[speaker_id] = SpeakerAssociation(
                audio_speaker_id=speaker_id,
                canonical_person_id=None,
                confidence=0.0,
                evidence_count=0,
                supporting_duration=0.0,
                association_status="ASD_UNAVAILABLE",
                failure_reason="Lip motion data not available"
            )
        
        return associations
    
    def _associate_single_speaker(
        self,
        speaker_id: str,
        diarization_segments: List[Dict],
        face_timeline: List[Dict],
        canonical_persons: Dict,
        track_to_person_map: Dict[int, str]
    ) -> SpeakerAssociation:
        """
        Associate a single audio speaker to a canonical person.
        
        Algorithm:
        1. Extract all speech intervals for this speaker
        2. For each interval, find visible persons with ASD evidence
        3. Accumulate evidence per canonical person
        4. Select person with strongest temporal correlation
        5. Apply confidence thresholds and ambiguity detection
        """
        # Extract speech intervals for this speaker
        speech_intervals = [
            (seg["start"], seg["end"]) 
            for seg in diarization_segments 
            if seg["speaker"] == speaker_id
        ]
        
        if not speech_intervals:
            return SpeakerAssociation(
                audio_speaker_id=speaker_id,
                canonical_person_id=None,
                confidence=0.0,
                evidence_count=0,
                supporting_duration=0.0,
                association_status="UNRESOLVED",
                failure_reason="No speech intervals found"
            )
        
        # Accumulate evidence per canonical person
        evidence_per_person = defaultdict(lambda: {
            "lip_motion_frames": 0,
            "visible_frames": 0,
            "intervals_with_evidence": 0,
            "total_duration": 0.0
        })
        
        total_speech_duration = sum(end - start for start, end in speech_intervals)
        
        # Process each speech interval
        for interval_start, interval_end in speech_intervals:
            interval_duration = interval_end - interval_start
            
            # Find visible persons during this interval with ASD evidence
            interval_evidence = self._extract_interval_evidence(
                interval_start,
                interval_end,
                face_timeline
            )
            
            if not interval_evidence:
                continue
            
            # Accumulate evidence for each person
            for person_id, evidence in interval_evidence.items():
                ev = evidence_per_person[person_id]
                ev["lip_motion_frames"] += evidence["lip_motion_frames"]
                ev["visible_frames"] += evidence["visible_frames"]
                if evidence["lip_motion_frames"] > 0:
                    ev["intervals_with_evidence"] += 1
                ev["total_duration"] += interval_duration
        
        # No evidence found
        if not evidence_per_person:
            return SpeakerAssociation(
                audio_speaker_id=speaker_id,
                canonical_person_id=None,
                confidence=0.0,
                evidence_count=0,
                supporting_duration=0.0,
                association_status="UNRESOLVED",
                failure_reason="No visible persons with ASD evidence during speech"
            )
        
        # Compute correlation scores
        person_scores = []
        for person_id, evidence in evidence_per_person.items():
            score = self._compute_correlation_score(evidence)
            person_scores.append((person_id, score, evidence))
        
        # Sort by score descending
        person_scores.sort(key=lambda x: x[1], reverse=True)
        
        # Select best candidate
        best_person_id, best_score, best_evidence = person_scores[0]
        
        # Check for ambiguity (multiple candidates with similar scores)
        is_ambiguous = False
        if len(person_scores) > 1:
            second_best_score = person_scores[1][1]
            if second_best_score > self.AMBIGUOUS_THRESHOLD and (best_score - second_best_score) < 0.15:
                is_ambiguous = True
        
        # Determine association status
        if is_ambiguous:
            status = "AMBIGUOUS"
            failure_reason = f"Multiple candidates with similar scores (best={best_score:.2f})"
        elif best_score >= self.CONFIRMED_THRESHOLD and best_evidence["intervals_with_evidence"] >= self.MIN_EVIDENCE_INTERVALS:
            status = "CONFIRMED"
            failure_reason = None
        elif best_evidence["total_duration"] < self.MIN_SUPPORTING_DURATION:
            status = "UNRESOLVED"
            failure_reason = f"Insufficient evidence duration ({best_evidence['total_duration']:.1f}s < {self.MIN_SUPPORTING_DURATION}s)"
        else:
            status = "UNRESOLVED"
            failure_reason = f"Low confidence score ({best_score:.2f} < {self.CONFIRMED_THRESHOLD})"
        
        return SpeakerAssociation(
            audio_speaker_id=speaker_id,
            canonical_person_id=best_person_id if status == "CONFIRMED" else None,
            confidence=best_score,
            evidence_count=best_evidence["intervals_with_evidence"],
            supporting_duration=best_evidence["total_duration"],
            association_status=status,
            failure_reason=failure_reason
        )
    
    def _extract_interval_evidence(
        self,
        interval_start: float,
        interval_end: float,
        face_timeline: List[Dict]
    ) -> Dict[str, Dict]:
        """
        Extract evidence for all visible persons during a speech interval.
        
        Returns
        -------
        dict
            person_id → {"lip_motion_frames": int, "visible_frames": int}
        """
        evidence = defaultdict(lambda: {"lip_motion_frames": 0, "visible_frames": 0})
        
        for frame in face_timeline:
            t = frame.get("time", 0)
            if not (interval_start <= t <= interval_end):
                continue
            
            for face in frame.get("faces", []):
                person_id = face.get("canonical_person_id")
                if not person_id or not person_id.startswith("PERSON_"):
                    continue
                
                # Count visible frames
                evidence[person_id]["visible_frames"] += 1
                
                # Count lip motion frames
                if face.get("is_active_speaker", False):
                    evidence[person_id]["lip_motion_frames"] += 1
        
        return dict(evidence)
    
    def _compute_correlation_score(self, evidence: Dict) -> float:
        """
        Compute temporal correlation score from evidence.
        
        Score is weighted combination of:
        - Lip motion ratio (frames with lip motion / visible frames)
        - Visibility presence (has visible frames)
        
        Returns
        -------
        float
            Score between 0.0 and 1.0
        """
        visible_frames = evidence["visible_frames"]
        lip_motion_frames = evidence["lip_motion_frames"]
        
        if visible_frames == 0:
            return 0.0
        
        # Lip motion ratio
        lip_motion_ratio = lip_motion_frames / visible_frames
        
        # Weighted score
        score = (
            self.LIP_MOTION_WEIGHT * lip_motion_ratio +
            self.VISIBILITY_WEIGHT * 1.0  # Simple presence bonus
        )
        
        return min(score, 1.0)
