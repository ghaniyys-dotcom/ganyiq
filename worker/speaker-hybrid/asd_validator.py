"""
asd_validator.py — Active Speaker Detection validation and status enforcement.

Sprint 3 Task 3: Enforces honest ASD status reporting.

If lip motion is zero for all observations, ASD = UNAVAILABLE.
No active speaker fabrication allowed.

Status levels:
- VALID: Reliable lip motion data, ASD results trustworthy
- LOW_SIGNAL: Sparse or noisy lip motion, low confidence
- UNAVAILABLE: No lip motion data, cannot determine active speaker
"""

from typing import Dict, List, Tuple
from enum import Enum


class ASDStatus(Enum):
    """Active speaker detection data quality status."""
    VALID = "VALID"
    LOW_SIGNAL = "LOW_SIGNAL"
    UNAVAILABLE = "UNAVAILABLE"


class ASDValidator:
    """Validates ASD input data quality and enforces honest status."""
    
    def __init__(self, 
                 min_nonzero_ratio: float = 0.05,
                 min_variance_threshold: float = 0.0001):
        """
        Initialize validator.
        
        Args:
            min_nonzero_ratio: Minimum fraction of nonzero lip_motion values for VALID
            min_variance_threshold: Minimum variance in lip_motion for VALID
        """
        self.min_nonzero_ratio = min_nonzero_ratio
        self.min_variance_threshold = min_variance_threshold
    
    def validate_lip_motion_data(self, visual_data: Dict) -> Tuple[ASDStatus, Dict]:
        """
        Analyze lip_motion data quality from visual timeline.
        
        Returns:
            (status, diagnostics) where diagnostics contains:
                - total_observations
                - nonzero_count
                - nonzero_ratio
                - variance
                - max_value
                - reasoning
        """
        timeline = visual_data.get("timeline", [])
        
        if not timeline:
            return ASDStatus.UNAVAILABLE, {
                "total_observations": 0,
                "nonzero_count": 0,
                "nonzero_ratio": 0.0,
                "variance": 0.0,
                "max_value": 0.0,
                "reasoning": "No timeline data",
            }
        
        # Collect all lip_motion values
        lip_motion_values = []
        
        for entry in timeline:
            faces = entry.get("faces", [])
            for face in faces:
                lip_motion = face.get("lip_motion", 0.0)
                lip_motion_values.append(lip_motion)
        
        if not lip_motion_values:
            return ASDStatus.UNAVAILABLE, {
                "total_observations": 0,
                "nonzero_count": 0,
                "nonzero_ratio": 0.0,
                "variance": 0.0,
                "max_value": 0.0,
                "reasoning": "No face observations",
            }
        
        total = len(lip_motion_values)
        nonzero = sum(1 for v in lip_motion_values if abs(v) > 1e-9)
        nonzero_ratio = nonzero / total
        max_value = max(lip_motion_values)
        
        # Calculate variance
        mean = sum(lip_motion_values) / total
        variance = sum((v - mean) ** 2 for v in lip_motion_values) / total
        
        diagnostics = {
            "total_observations": total,
            "nonzero_count": nonzero,
            "nonzero_ratio": round(nonzero_ratio, 4),
            "variance": round(variance, 6),
            "max_value": round(max_value, 6),
            "mean": round(mean, 6),
        }
        
        # Determine status
        if nonzero == 0:
            diagnostics["reasoning"] = "All lip_motion values are zero"
            return ASDStatus.UNAVAILABLE, diagnostics
        
        if nonzero_ratio < self.min_nonzero_ratio:
            diagnostics["reasoning"] = (
                f"Only {nonzero}/{total} ({nonzero_ratio:.1%}) nonzero - too sparse"
            )
            return ASDStatus.LOW_SIGNAL, diagnostics
        
        if variance < self.min_variance_threshold:
            diagnostics["reasoning"] = (
                f"Variance {variance:.6f} below threshold - lip motion too uniform"
            )
            return ASDStatus.LOW_SIGNAL, diagnostics
        
        diagnostics["reasoning"] = "Sufficient lip motion data quality"
        return ASDStatus.VALID, diagnostics
    
    def filter_asd_timeline(self, asd_timeline: List[Dict], 
                           asd_status: ASDStatus) -> List[Dict]:
        """
        Filter ASD timeline based on status.
        
        - UNAVAILABLE: Return empty list (no active speakers)
        - LOW_SIGNAL: Keep only high-confidence active speakers
        - VALID: Keep all
        """
        if asd_status == ASDStatus.UNAVAILABLE:
            return []
        
        if asd_status == ASDStatus.LOW_SIGNAL:
            # Only keep entries with strong signals (top 20% energy)
            if not asd_timeline:
                return []
            
            energies = [e.get("max_lip_energy", 0.0) for e in asd_timeline]
            if not energies or max(energies) == 0:
                return []
            
            threshold = max(energies) * 0.8
            filtered = [
                entry for entry in asd_timeline
                if entry.get("max_lip_energy", 0.0) >= threshold
            ]
            return filtered
        
        # VALID: return as-is
        return asd_timeline
    
    def enforce_honest_active_speaker(self, 
                                     matched_timeline: List[Dict],
                                     asd_status: ASDStatus) -> List[Dict]:
        """
        Enforce honest active speaker reporting in matched timeline.
        
        - UNAVAILABLE: Clear all active_speaker markers
        - LOW_SIGNAL: Mark with low confidence flag
        - VALID: Keep as-is
        """
        if asd_status == ASDStatus.UNAVAILABLE:
            # Clear all active speaker assignments
            for entry in matched_timeline:
                entry["active_speaker_status"] = "unavailable"
                # Don't remove visual_speakers, but mark them as unverified
                for face in entry.get("faces", []):
                    if "is_active_speaker" in face:
                        face["is_active_speaker"] = False
                        face["active_speaker_confidence"] = 0.0
        
        elif asd_status == ASDStatus.LOW_SIGNAL:
            # Mark with low confidence
            for entry in matched_timeline:
                entry["active_speaker_status"] = "low_confidence"
                for face in entry.get("faces", []):
                    if face.get("is_active_speaker", False):
                        # Keep the assignment but mark confidence as low
                        face["active_speaker_confidence"] = min(
                            face.get("active_speaker_confidence", 0.5), 
                            0.5
                        )
        
        else:  # VALID
            for entry in matched_timeline:
                entry["active_speaker_status"] = "valid"
        
        return matched_timeline
    
    def generate_asd_report(self, asd_status: ASDStatus, 
                           diagnostics: Dict,
                           asd_timeline: List[Dict]) -> Dict:
        """Generate comprehensive ASD validation report."""
        
        active_speaker_frames = 0
        total_frames = len(asd_timeline)
        
        for entry in asd_timeline:
            if entry.get("active_track_id", -1) >= 0:
                active_speaker_frames += 1
        
        coverage_pct = (
            round(active_speaker_frames / total_frames * 100, 1)
            if total_frames > 0 else 0.0
        )
        
        return {
            "status": asd_status.value,
            "diagnostics": diagnostics,
            "timeline_stats": {
                "total_frames": total_frames,
                "active_speaker_frames": active_speaker_frames,
                "coverage_pct": coverage_pct,
            },
            "validation": {
                "is_valid": asd_status == ASDStatus.VALID,
                "is_low_signal": asd_status == ASDStatus.LOW_SIGNAL,
                "is_unavailable": asd_status == ASDStatus.UNAVAILABLE,
            },
        }
