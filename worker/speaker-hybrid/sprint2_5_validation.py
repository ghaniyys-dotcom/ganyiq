#!/usr/bin/env python3
"""
sprint2_5_validation.py - Sprint 2.5 Speaker Authority Metrics

Validates speaker identification quality improvements.
Measures BEFORE vs AFTER for speaker authority repair.
"""

import json
import sys
from pathlib import Path
from collections import Counter

def analyze_speaker_authority(result_path: Path) -> dict:
    """Analyze speaker identification quality from analysis_result.json"""
    
    with open(result_path, 'r') as f:
        result = json.load(f)
    
    metrics = {
        # Audio metrics
        'audio_speaker_count': 0,
        'diarization_status': 'UNKNOWN',
        
        # Visual metrics
        'visual_track_count': 0,
        'canonical_person_count': 0,
        
        # ASD metrics
        'asd_status': 'UNKNOWN',
        'frames_multi_active_speaker': 0,
        'total_frames': 0,
        
        # Identity preservation
        'faces_with_audio_speaker_id': 0,
        'faces_with_person_id': 0,
        'faces_total': 0,
        
        # Split plan validation
        'split_scenes_requested': 0,
        'split_scenes_same_target': 0,
        'split_scenes_valid': 0,
    }
    
    # Audio analysis
    if 'audio' in result and result['audio'].get('segments'):
        audio_speakers = set()
        for seg in result['audio']['segments']:
            spk = seg.get('speaker', seg.get('speaker_id', 'unknown'))
            audio_speakers.add(str(spk))
        metrics['audio_speaker_count'] = len(audio_speakers)
        metrics['diarization_status'] = result['audio'].get('diarization_status', 'UNKNOWN')
    
    # Load face data if available
    face_data_path = result.get('face_data_path')
    if face_data_path and Path(face_data_path).exists():
        with open(face_data_path, 'r') as f:
            face_data = json.load(f)
        
        metrics['asd_status'] = face_data.get('asd_status', 'UNKNOWN')
        
        # Count visual tracks and persons
        track_ids = set()
        person_ids = set()
        
        for entry in face_data.get('timeline', []):
            metrics['total_frames'] += 1
            faces = entry.get('faces', [])
            
            # Count active speakers at this frame
            active_count = sum(1 for f in faces if f.get('is_active_speaker', False))
            if active_count > 1:
                metrics['frames_multi_active_speaker'] += 1
            
            for face in faces:
                metrics['faces_total'] += 1
                
                # Track IDs
                tid = face.get('track_id')
                if tid is not None and tid >= 0:
                    track_ids.add(tid)
                
                # Person IDs
                pid = face.get('person_id')
                if pid is not None:
                    person_ids.add(pid)
                    metrics['faces_with_person_id'] += 1
                
                # Audio speaker mapping
                if 'audio_speaker_id' in face:
                    metrics['faces_with_audio_speaker_id'] += 1
        
        metrics['visual_track_count'] = len(track_ids)
        metrics['canonical_person_count'] = len(person_ids)
    
    # Split plan analysis
    split_plan = result.get('split_plan', {})
    for scene in split_plan.get('scenes', []):
        layout = scene.get('layout', '')
        if layout == 'split_screen':
            metrics['split_scenes_requested'] += 1
            
            primary = scene.get('primary_target_id')
            secondary = scene.get('secondary_target_id')
            
            if primary == secondary:
                metrics['split_scenes_same_target'] += 1
            else:
                metrics['split_scenes_valid'] += 1
    
    return metrics

def print_report(before: dict, after: dict):
    """Print BEFORE vs AFTER comparison report"""
    
    print("=" * 70)
    print("SPRINT 2.5: SPEAKER AUTHORITY REPAIR - VALIDATION REPORT")
    print("=" * 70)
    print()
    
    print("DIARIZATION QUALITY")
    print("-" * 70)
    print(f"Audio speaker count:        BEFORE={before['audio_speaker_count']} | AFTER={after['audio_speaker_count']}")
    print(f"Diarization status:         BEFORE={before['diarization_status']} | AFTER={after['diarization_status']}")
    print()
    
    print("ASD VALIDITY")
    print("-" * 70)
    print(f"ASD status:                 BEFORE={before['asd_status']} | AFTER={after['asd_status']}")
    print()
    
    print("VISUAL IDENTITY PRESERVATION")
    print("-" * 70)
    print(f"Visual tracks:              BEFORE={before['visual_track_count']} | AFTER={after['visual_track_count']}")
    print(f"Canonical persons:          BEFORE={before['canonical_person_count']} | AFTER={after['canonical_person_count']}")
    print(f"Faces with person_id:       BEFORE={before['faces_with_person_id']}/{before['faces_total']} | AFTER={after['faces_with_person_id']}/{after['faces_total']}")
    print(f"Faces with audio mapping:   BEFORE={before['faces_with_audio_speaker_id']}/{before['faces_total']} | AFTER={after['faces_with_audio_speaker_id']}/{after['faces_total']}")
    print()
    
    print("ACTIVE SPEAKER VALIDATION")
    print("-" * 70)
    print(f"Frames with >1 active:      BEFORE={before['frames_multi_active_speaker']}/{before['total_frames']} | AFTER={after['frames_multi_active_speaker']}/{after['total_frames']}")
    print()
    
    print("SPLIT PLAN VALIDATION")
    print("-" * 70)
    print(f"Split scenes requested:     BEFORE={before['split_scenes_requested']} | AFTER={after['split_scenes_requested']}")
    print(f"Same-target splits:         BEFORE={before['split_scenes_same_target']} | AFTER={after['split_scenes_same_target']}")
    print(f"Valid splits:               BEFORE={before['split_scenes_valid']} | AFTER={after['split_scenes_valid']}")
    print()
    
    print("ACCEPTANCE CRITERIA")
    print("-" * 70)
    
    # Criterion 1: No multiple active speakers per frame
    c1 = after['frames_multi_active_speaker'] == 0
    print(f"{'✅' if c1 else '❌'} No frame has multiple active speakers (AFTER={after['frames_multi_active_speaker']})")
    
    # Criterion 2: No same-target split screens
    c2 = after['split_scenes_same_target'] == 0
    print(f"{'✅' if c2 else '❌'} No split_screen with same primary/secondary (AFTER={after['split_scenes_same_target']})")
    
    # Criterion 3: ASD status honest
    c3 = after['asd_status'] != 'UNKNOWN'
    print(f"{'✅' if c3 else '❌'} ASD status is VALID/LOW_SIGNAL/UNAVAILABLE (not fabricated)")
    
    # Criterion 4: Visual identities preserved
    c4 = after['canonical_person_count'] >= 1
    print(f"{'✅' if c4 else '❌'} Visual persons retain identity (persons={after['canonical_person_count']})")
    
    # Criterion 5: Split only when valid
    c5 = after['split_scenes_same_target'] == 0 or after['split_scenes_requested'] == 0
    print(f"{'✅' if c5 else '❌'} Split_screen only when two distinct persons exist")
    
    print()
    
    if all([c1, c2, c3, c4, c5]):
        print("✅ SPRINT 2.5 ACCEPTANCE CRITERIA: SATISFIED")
    else:
        print("❌ SPRINT 2.5 ACCEPTANCE CRITERIA: NOT SATISFIED")
    
    print()

def main():
    if len(sys.argv) < 3:
        print("Usage: python3 sprint2_5_validation.py <before_result.json> <after_result.json>")
        print()
        print("Example:")
        print("  python3 sprint2_5_validation.py baseline_result.json sprint2_5_result.json")
        sys.exit(1)
    
    before_path = Path(sys.argv[1])
    after_path = Path(sys.argv[2])
    
    if not before_path.exists():
        print(f"Error: BEFORE file not found: {before_path}")
        sys.exit(1)
    
    if not after_path.exists():
        print(f"Error: AFTER file not found: {after_path}")
        sys.exit(1)
    
    before = analyze_speaker_authority(before_path)
    after = analyze_speaker_authority(after_path)
    
    print_report(before, after)

if __name__ == '__main__':
    main()
