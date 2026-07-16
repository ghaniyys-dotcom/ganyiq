#!/usr/bin/env python3
"""
sprint3_validation.py — Sprint 3 E2E Validation Script

Tests Sprint 3 canonical identity implementation on benchmark videos.

Validates:
1. Canonical person registry (raw tracks → canonical persons)
2. ASD honesty (lip motion validation, no fabrication)
3. Reaction recognition (baseline-driven, not all blink)
4. Split-screen decisions (distinct canonical persons)

Usage:
  python sprint3_validation.py --video <path> --output <analysis_result.json>
"""

import argparse
import json
import sys
from pathlib import Path
from collections import defaultdict

def validate_sprint3(result_path: str) -> dict:
    """
    Validate Sprint 3 deliverables from analysis result.
    
    Returns validation report with pass/fail for each requirement.
    """
    
    with open(result_path) as f:
        result = json.load(f)
    
    report = {
        'sprint': 'Sprint 3: Canonical Person Registry + Speaker/Reaction Association',
        'video': result.get('video', {}).get('path', 'unknown'),
        'validations': {},
        'metrics': {},
        'pass': False,
    }
    
    # ========================================================================
    # VALIDATION 1: Canonical Person Registry
    # ========================================================================
    
    canonical_stats = result.get('canonical_persons', {})
    track_to_person = result.get('track_to_person_map', {})
    
    total_tracks = canonical_stats.get('total_track_ids', 0)
    total_persons = canonical_stats.get('total_canonical_persons', 0)
    
    report['metrics']['raw_track_ids'] = total_tracks
    report['metrics']['canonical_persons'] = total_persons
    report['metrics']['consolidation_ratio'] = (
        round(total_tracks / max(total_persons, 1), 2) if total_persons > 0 else 0
    )
    
    # Check 1.1: Track-to-person mapping exists
    validation_1_1 = len(track_to_person) > 0
    report['validations']['1.1_track_to_person_map_exists'] = {
        'pass': validation_1_1,
        'message': f'Track-to-person map: {len(track_to_person)} entries'
    }
    
    # Check 1.2: Canonical persons exist
    validation_1_2 = total_persons >= 1
    report['validations']['1.2_canonical_persons_exist'] = {
        'pass': validation_1_2,
        'message': f'Canonical persons: {total_persons}'
    }
    
    # Check 1.3: Consolidation occurred (tracks > persons)
    validation_1_3 = total_tracks > total_persons if total_persons > 0 else True
    report['validations']['1.3_tracklet_consolidation'] = {
        'pass': validation_1_3,
        'message': f'{total_tracks} tracks → {total_persons} persons (ratio: {report["metrics"]["consolidation_ratio"]})'
    }
    
    # ========================================================================
    # VALIDATION 2: ASD Honesty
    # ========================================================================
    
    asd_data = result.get('asd', {})
    asd_status = asd_data.get('status', 'UNKNOWN')
    asd_diagnostics = asd_data.get('diagnostics', {})
    
    report['metrics']['asd_status'] = asd_status
    report['metrics']['asd_nonzero_ratio'] = asd_diagnostics.get('nonzero_ratio', 0.0)
    report['metrics']['asd_total_observations'] = asd_diagnostics.get('total_observations', 0)
    
    # Check 2.1: ASD status is set
    validation_2_1 = asd_status in ['VALID', 'LOW_SIGNAL', 'UNAVAILABLE']
    report['validations']['2.1_asd_status_valid'] = {
        'pass': validation_2_1,
        'message': f'ASD status: {asd_status}'
    }
    
    # Check 2.2: If nonzero_ratio == 0, status must be UNAVAILABLE
    nonzero_ratio = asd_diagnostics.get('nonzero_ratio', 0.0)
    if nonzero_ratio == 0.0:
        validation_2_2 = asd_status == 'UNAVAILABLE'
        report['validations']['2.2_zero_lip_motion_unavailable'] = {
            'pass': validation_2_2,
            'message': f'Lip motion all zero → ASD={asd_status} (expected UNAVAILABLE)'
        }
    else:
        validation_2_2 = True
        report['validations']['2.2_zero_lip_motion_unavailable'] = {
            'pass': validation_2_2,
            'message': f'Lip motion nonzero ({nonzero_ratio:.1%}) → ASD={asd_status}'
        }
    
    # Check 2.3: Active speaker frames reasonable
    asd_total = asd_data.get('total_frames', 0)
    asd_active = asd_data.get('active_frames', 0)
    asd_coverage = asd_active / max(asd_total, 1) if asd_total > 0 else 0
    
    report['metrics']['asd_active_coverage'] = round(asd_coverage * 100, 1)
    
    # If ASD=UNAVAILABLE, active frames should be 0 or very low
    if asd_status == 'UNAVAILABLE':
        validation_2_3 = asd_active == 0 or asd_coverage < 0.05
        report['validations']['2.3_unavailable_no_active_speaker'] = {
            'pass': validation_2_3,
            'message': f'ASD UNAVAILABLE → active coverage {asd_coverage:.1%} (expected 0%)'
        }
    else:
        validation_2_3 = True
        report['validations']['2.3_unavailable_no_active_speaker'] = {
            'pass': validation_2_3,
            'message': f'ASD {asd_status} → active coverage {asd_coverage:.1%}'
        }
    
    # ========================================================================
    # VALIDATION 3: Reaction Recognition
    # ========================================================================
    
    reactions = result.get('reactions', {})
    reaction_summary = reactions.get('summary', {})
    
    # Aggregate reaction percentages across all speakers
    total_blink_pct = 0
    total_smile_pct = 0
    total_surprise_pct = 0
    total_speaking_pct = 0
    speaker_count = len(reaction_summary)
    
    for speaker_stats in reaction_summary.values():
        total_blink_pct += speaker_stats.get('blink_pct', 0)
        total_smile_pct += speaker_stats.get('smile_pct', 0)
        total_surprise_pct += speaker_stats.get('surprise_pct', 0)
        total_speaking_pct += speaker_stats.get('speaking_pct', 0)
    
    avg_blink = total_blink_pct / max(speaker_count, 1) if speaker_count > 0 else 0
    avg_smile = total_smile_pct / max(speaker_count, 1) if speaker_count > 0 else 0
    avg_surprise = total_surprise_pct / max(speaker_count, 1) if speaker_count > 0 else 0
    
    report['metrics']['reaction_blink_avg'] = round(avg_blink, 1)
    report['metrics']['reaction_smile_avg'] = round(avg_smile, 1)
    report['metrics']['reaction_surprise_avg'] = round(avg_surprise, 1)
    
    # Check 3.1: Reactions are not dominated by blink
    validation_3_1 = avg_blink < 90  # Allow up to 90% blink, but not 100%
    report['validations']['3.1_not_all_blink'] = {
        'pass': validation_3_1,
        'message': f'Blink: {avg_blink:.1f}%, Smile: {avg_smile:.1f}%, Surprise: {avg_surprise:.1f}%'
    }
    
    # Check 3.2: At least some meaningful reactions
    has_meaningful_reactions = avg_smile > 0 or avg_surprise > 0 or total_speaking_pct > 0
    validation_3_2 = has_meaningful_reactions or speaker_count == 0
    report['validations']['3.2_meaningful_reactions_exist'] = {
        'pass': validation_3_2,
        'message': f'Meaningful reactions detected' if has_meaningful_reactions else 'No meaningful reactions (may be valid)'
    }
    
    # ========================================================================
    # VALIDATION 4: Split-Screen Validation
    # ========================================================================
    
    split_plan = result.get('split_plan', {})
    scenes = split_plan.get('scenes', [])
    
    split_screens = [s for s in scenes if s.get('layout') == 'split_screen']
    
    report['metrics']['total_scenes'] = len(scenes)
    report['metrics']['split_screen_count'] = len(split_screens)
    
    # Check 4.1: Split screens have distinct targets
    same_person_splits = 0
    for scene in split_screens:
        primary = scene.get('primary_target', scene.get('speaker_id'))
        secondary = scene.get('secondary_target', scene.get('listener_id'))
        
        if primary and secondary and primary == secondary:
            same_person_splits += 1
    
    validation_4_1 = same_person_splits == 0
    report['validations']['4.1_split_distinct_persons'] = {
        'pass': validation_4_1,
        'message': f'Split screens: {len(split_screens)}, same-person violations: {same_person_splits}'
    }
    
    # ========================================================================
    # OVERALL PASS/FAIL
    # ========================================================================
    
    all_validations = [
        v['pass'] for v in report['validations'].values()
    ]
    
    report['pass'] = all(all_validations)
    report['passed_count'] = sum(all_validations)
    report['total_count'] = len(all_validations)
    
    return report


def print_report(report: dict):
    """Print validation report to console."""
    
    print("=" * 80)
    print(f"SPRINT 3 VALIDATION REPORT")
    print("=" * 80)
    print(f"Video: {report['video']}")
    print(f"Status: {'✅ PASS' if report['pass'] else '❌ FAIL'}")
    print(f"Passed: {report['passed_count']}/{report['total_count']} validations")
    print()
    
    print("METRICS:")
    print("-" * 80)
    for key, value in report['metrics'].items():
        print(f"  {key}: {value}")
    print()
    
    print("VALIDATIONS:")
    print("-" * 80)
    for key, validation in report['validations'].items():
        status = '✅' if validation['pass'] else '❌'
        print(f"  {status} {key}: {validation['message']}")
    print()
    
    print("=" * 80)


def main():
    parser = argparse.ArgumentParser(
        description="Sprint 3 E2E Validation"
    )
    parser.add_argument('--result', required=True,
                       help='Path to analysis_result.json')
    parser.add_argument('--output', help='Path to save validation report')
    
    args = parser.parse_args()
    
    if not Path(args.result).exists():
        print(f"Error: Result file not found: {args.result}", file=sys.stderr)
        sys.exit(1)
    
    report = validate_sprint3(args.result)
    print_report(report)
    
    if args.output:
        with open(args.output, 'w') as f:
            json.dump(report, f, indent=2)
        print(f"Report saved to {args.output}")
    
    sys.exit(0 if report['pass'] else 1)


if __name__ == '__main__':
    main()
