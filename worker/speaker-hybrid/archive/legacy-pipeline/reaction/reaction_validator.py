"""
reaction_validator.py — Honest reaction detection with baseline validation.

Sprint 3 Task 4: Fixes reaction recognition to avoid fabricating events.

Issues addressed:
- Reactions defaulting to "blink" when landmarks missing
- No person-specific baselines for relative changes
- No validation of landmark quality
- Treating normal face state as reaction events

Honest approach:
- Validate landmark data quality before computing reactions
- Use person-specific baselines for relative changes
- Only report reactions when delta exceeds threshold
- Return "none" when evidence insufficient
"""

from typing import Dict, List, Optional, Tuple
from collections import defaultdict
import math


class ReactionValidator:
    """Validates and filters reaction events with baseline enforcement."""
    
    def __init__(self,
                 min_landmark_count: int = 10,
                 baseline_window: int = 30,
                 smile_delta_threshold: float = 0.3,
                 surprise_delta_threshold: float = 0.4,
                 head_movement_threshold: float = 0.1):
        """
        Initialize reaction validator.
        
        Args:
            min_landmark_count: Minimum landmarks required for valid detection
            baseline_window: Number of frames for baseline calculation
            smile_delta_threshold: Minimum delta above baseline for smile
            surprise_delta_threshold: Minimum delta above baseline for surprise
            head_movement_threshold: Minimum head movement for nod detection
        """
        self.min_landmark_count = min_landmark_count
        self.baseline_window = baseline_window
        self.smile_delta_threshold = smile_delta_threshold
        self.surprise_delta_threshold = surprise_delta_threshold
        self.head_movement_threshold = head_movement_threshold
        
        # Person-specific baselines
        self.person_baselines: Dict[str, Dict] = defaultdict(lambda: {
            'smile_history': [],
            'surprise_history': [],
            'smile_baseline': 0.0,
            'surprise_baseline': 0.0,
        })
    
    def validate_landmarks(self, face: Dict) -> Tuple[bool, str]:
        """
        Validate landmark data quality.
        
        Returns:
            (is_valid, reason)
        """
        landmarks = face.get("landmarks", {})
        
        if not landmarks:
            return False, "no_landmarks"
        
        # Check if landmarks is a dict with coordinate data
        if isinstance(landmarks, dict):
            # Count non-empty landmark points
            point_count = 0
            for key, value in landmarks.items():
                if value is not None and (
                    isinstance(value, (list, tuple)) and len(value) >= 2
                ):
                    point_count += 1
            
            if point_count < self.min_landmark_count:
                return False, f"insufficient_landmarks_{point_count}"
        
        # Check for required facial features
        required_features = ['left_eye', 'right_eye', 'nose', 'mouth']
        missing = [f for f in required_features if f not in landmarks]
        
        if len(missing) > 1:
            return False, f"missing_features_{','.join(missing)}"
        
        return True, "valid"
    
    def update_baseline(self, person_id: str, smile_score: float, 
                       surprise_score: float):
        """Update rolling baseline for a person."""
        baseline = self.person_baselines[person_id]
        
        baseline['smile_history'].append(smile_score)
        baseline['surprise_history'].append(surprise_score)
        
        # Keep only recent history
        if len(baseline['smile_history']) > self.baseline_window:
            baseline['smile_history'] = baseline['smile_history'][-self.baseline_window:]
        if len(baseline['surprise_history']) > self.baseline_window:
            baseline['surprise_history'] = baseline['surprise_history'][-self.baseline_window:]
        
        # Compute baseline as median of recent history
        if len(baseline['smile_history']) >= 5:
            sorted_smile = sorted(baseline['smile_history'])
            baseline['smile_baseline'] = sorted_smile[len(sorted_smile) // 2]
        
        if len(baseline['surprise_history']) >= 5:
            sorted_surprise = sorted(baseline['surprise_history'])
            baseline['surprise_baseline'] = sorted_surprise[len(sorted_surprise) // 2]
    
    def compute_reaction_with_baseline(self, 
                                      person_id: str,
                                      smile_score: float,
                                      surprise_score: float,
                                      head_movement: float,
                                      lip_movement: float) -> Tuple[str, float, Dict]:
        """
        Compute reaction type using person-specific baseline.
        
        Returns:
            (reaction_type, confidence, evidence_dict)
        """
        baseline = self.person_baselines[person_id]
        
        smile_baseline = baseline['smile_baseline']
        surprise_baseline = baseline['surprise_baseline']
        
        smile_delta = smile_score - smile_baseline
        surprise_delta = surprise_score - surprise_baseline
        
        evidence = {
            'smile_score': round(smile_score, 3),
            'smile_baseline': round(smile_baseline, 3),
            'smile_delta': round(smile_delta, 3),
            'surprise_score': round(surprise_score, 3),
            'surprise_baseline': round(surprise_baseline, 3),
            'surprise_delta': round(surprise_delta, 3),
            'head_movement': round(head_movement, 3),
            'lip_movement': round(lip_movement, 3),
        }
        
        # Priority order: speaking > surprise > smile > nod > neutral
        # All require evidence above baseline
        
        if lip_movement > 0.4:
            return 'speaking', lip_movement, evidence
        
        if surprise_delta > self.surprise_delta_threshold:
            confidence = min(surprise_delta / self.surprise_delta_threshold, 1.0)
            return 'surprise', confidence, evidence
        
        if smile_delta > self.smile_delta_threshold:
            confidence = min(smile_delta / self.smile_delta_threshold, 1.0)
            return 'smile', confidence, evidence
        
        if head_movement > self.head_movement_threshold:
            confidence = min(head_movement / self.head_movement_threshold, 1.0)
            return 'nod', confidence, evidence
        
        # Default to neutral, not blink
        # Blink is not a meaningful reaction for camera selection
        return 'neutral', 0.0, evidence
    
    def validate_reaction_timeline(self, reactions: List[Dict]) -> Dict:
        """
        Validate and filter reaction timeline.
        
        Returns filtered reactions with quality metadata.
        """
        valid_reactions = []
        invalid_count = 0
        invalid_reasons = defaultdict(int)
        
        for reaction in reactions:
            # Skip "blink" reactions (not meaningful for camera work)
            if reaction.get('reaction') == 'blink':
                invalid_count += 1
                invalid_reasons['blink_filtered'] += 1
                continue
            
            # Skip reactions with very low confidence
            scores = reaction.get('scores', {})
            max_score = max(
                scores.get('smile', 0),
                scores.get('surprise', 0),
                scores.get('lip_movement', 0),
                scores.get('head_movement', 0),
            )
            
            if max_score < 0.1:
                invalid_count += 1
                invalid_reasons['low_confidence'] += 1
                continue
            
            valid_reactions.append(reaction)
        
        return {
            'reactions': valid_reactions,
            'validation': {
                'total_input': len(reactions),
                'valid_count': len(valid_reactions),
                'invalid_count': invalid_count,
                'invalid_reasons': dict(invalid_reasons),
            }
        }
    
    def generate_honest_summary(self, reactions: List[Dict]) -> Dict:
        """
        Generate reaction summary with honest reporting.
        
        Only counts validated, meaningful reactions.
        """
        if not reactions:
            return {
                'status': 'no_reactions',
                'total_frames': 0,
                'speaking_pct': 0.0,
                'smile_pct': 0.0,
                'surprise_pct': 0.0,
                'nod_pct': 0.0,
                'neutral_pct': 0.0,
                'blink_pct': 0.0,
            }
        
        per_speaker = defaultdict(list)
        for r in reactions:
            speaker = r.get('speaker', 'unknown')
            per_speaker[speaker].append(r)
        
        summary = {}
        for speaker, rlist in per_speaker.items():
            reaction_counts = defaultdict(int)
            for r in rlist:
                reaction_counts[r['reaction']] += 1
            
            total = len(rlist)
            summary[speaker] = {
                'total_frames': total,
                'speaking_pct': round(reaction_counts.get('speaking', 0) / max(total, 1) * 100, 1),
                'smile_pct': round(reaction_counts.get('smile', 0) / max(total, 1) * 100, 1),
                'surprise_pct': round(reaction_counts.get('surprise', 0) / max(total, 1) * 100, 1),
                'nod_pct': round(reaction_counts.get('nod', 0) / max(total, 1) * 100, 1),
                'neutral_pct': round(reaction_counts.get('neutral', 0) / max(total, 1) * 100, 1),
                'blink_pct': round(reaction_counts.get('blink', 0) / max(total, 1) * 100, 1),
            }
        
        return summary
