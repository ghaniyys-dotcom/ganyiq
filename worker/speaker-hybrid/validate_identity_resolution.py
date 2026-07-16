#!/usr/bin/env python3
"""
validate_identity_resolution.py - Sprint 1 Validation Script

Analyzes pipeline logs to measure identity resolution metrics.
Run after rendering a test clip with instrumented pipeline.
"""

import re
import sys
from pathlib import Path
from collections import Counter, defaultdict

def parse_log_file(log_path: Path) -> dict:
    """Parse structured logs from pipeline output."""
    
    metrics = {
        'bbox_success': Counter(),
        'bbox_failures': Counter(),
        'bbox_rejections': Counter(),
        'bbox_ages': [],
        'id_bridge_size': 0,
        'total_shots': 0,
        'shots_with_bbox': 0,
    }
    
    with open(log_path, 'r') as f:
        for line in f:
            # ID Bridge metrics
            if '[ID-BRIDGE] Built bridge' in line:
                match = re.search(r'with (\d+) mappings', line)
                if match:
                    metrics['id_bridge_size'] = int(match.group(1))
            
            # Bbox success patterns
            if '[BBOX-OK] EXACT_MATCH' in line:
                metrics['bbox_success']['exact_match'] += 1
                age_match = re.search(r'age=([\d.]+)s', line)
                if age_match:
                    metrics['bbox_ages'].append(float(age_match.group(1)))
            
            elif '[BBOX-OK] FALLBACK_RAW_MATCH' in line:
                metrics['bbox_success']['fallback_raw'] += 1
                age_match = re.search(r'age=([\d.]+)s', line)
                if age_match:
                    metrics['bbox_ages'].append(float(age_match.group(1)))
            
            elif '[BBOX-WARN] LARGEST_FACE_FALLBACK' in line:
                metrics['bbox_success']['largest_face'] += 1
            
            # Bbox failures
            elif '[BBOX-FAIL] NO_MATCH_FOUND' in line:
                metrics['bbox_failures']['no_match'] += 1
            
            elif '[BBOX-FAIL] NO_TARGET_OR_DATA' in line:
                metrics['bbox_failures']['no_data'] += 1
            
            # Bbox rejections
            elif '[BBOX-REJECT] BBOX_TOO_OLD' in line:
                metrics['bbox_rejections']['exact_too_old'] += 1
            
            elif '[BBOX-REJECT] FALLBACK_TOO_OLD' in line:
                metrics['bbox_rejections']['fallback_too_old'] += 1
            
            # ID Bridge warnings
            elif '[BBOX-WARN] ID_NOT_IN_BRIDGE' in line:
                metrics['bbox_failures']['id_not_in_bridge'] += 1
    
    return metrics

def calculate_summary(metrics: dict) -> dict:
    """Calculate summary statistics."""
    
    total_success = sum(metrics['bbox_success'].values())
    total_failures = sum(metrics['bbox_failures'].values())
    total_rejections = sum(metrics['bbox_rejections'].values())
    total_lookups = total_success + total_failures
    
    success_rate = (total_success / total_lookups * 100) if total_lookups > 0 else 0
    
    avg_age = sum(metrics['bbox_ages']) / len(metrics['bbox_ages']) if metrics['bbox_ages'] else 0
    max_age = max(metrics['bbox_ages']) if metrics['bbox_ages'] else 0
    
    return {
        'total_lookups': total_lookups,
        'total_success': total_success,
        'total_failures': total_failures,
        'total_rejections': total_rejections,
        'success_rate_pct': success_rate,
        'avg_bbox_age_sec': avg_age,
        'max_bbox_age_sec': max_age,
        'id_bridge_size': metrics['id_bridge_size'],
    }

def print_report(metrics: dict, summary: dict):
    """Print validation report."""
    
    print("=" * 60)
    print("SPRINT 1 IDENTITY RESOLUTION VALIDATION REPORT")
    print("=" * 60)
    print()
    
    print("OVERALL METRICS")
    print("-" * 60)
    print(f"Total bbox lookups:        {summary['total_lookups']}")
    print(f"Successful resolutions:    {summary['total_success']} ({summary['success_rate_pct']:.1f}%)")
    print(f"Failed resolutions:        {summary['total_failures']}")
    print(f"Rejected (too old):        {summary['total_rejections']}")
    print(f"ID bridge size:            {summary['id_bridge_size']} mappings")
    print()
    
    print("BBOX RESOLUTION METHODS")
    print("-" * 60)
    for method, count in metrics['bbox_success'].items():
        pct = (count / summary['total_success'] * 100) if summary['total_success'] > 0 else 0
        print(f"  {method:20s}  {count:4d} ({pct:5.1f}%)")
    print()
    
    print("FAILURE REASONS")
    print("-" * 60)
    for reason, count in metrics['bbox_failures'].items():
        print(f"  {reason:20s}  {count:4d}")
    print()
    
    print("REJECTIONS (STALE BBOX)")
    print("-" * 60)
    for reason, count in metrics['bbox_rejections'].items():
        print(f"  {reason:20s}  {count:4d}")
    print()
    
    print("BBOX AGE STATISTICS")
    print("-" * 60)
    print(f"Average bbox age:          {summary['avg_bbox_age_sec']:.2f}s")
    print(f"Maximum bbox age:          {summary['max_bbox_age_sec']:.2f}s")
    print()
    
    print("VALIDATION CRITERIA (Sprint 1 Success)")
    print("-" * 60)
    success_threshold = 90.0
    success_met = "✅" if summary['success_rate_pct'] >= success_threshold else "❌"
    print(f"{success_met} Bbox lookup success rate >={success_threshold}%  (actual: {summary['success_rate_pct']:.1f}%)")
    print()

def main():
    if len(sys.argv) < 2:
        print("Usage: python3 validate_identity_resolution.py <pipeline_log_file>")
        print()
        print("Example:")
        print("  python3 validate_identity_resolution.py /path/to/pipeline.log")
        sys.exit(1)
    
    log_path = Path(sys.argv[1])
    if not log_path.exists():
        print(f"Error: Log file not found: {log_path}")
        sys.exit(1)
    
    metrics = parse_log_file(log_path)
    summary = calculate_summary(metrics)
    print_report(metrics, summary)

if __name__ == '__main__':
    main()
