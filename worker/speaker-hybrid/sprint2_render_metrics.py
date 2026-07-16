#!/usr/bin/env python3
"""
sprint2_render_metrics.py - Sprint 2 Render Contract Validation

Analyzes pipeline logs to measure render contract compliance.
Verifies Director → Renderer → FFmpeg execution path.
"""

import re
import sys
from pathlib import Path
from collections import Counter

def parse_render_contract_logs(log_path: Path) -> dict:
    """Parse RENDER-CONTRACT structured logs from pipeline output."""
    
    metrics = {
        'shots': [],
        'requested_layouts': Counter(),
        'executed_layouts': Counter(),
        'downgrades': [],
        'split_filter_calls': 0,
        'layout_mismatches': 0,
    }
    
    current_shot = None
    
    with open(log_path, 'r') as f:
        for line in f:
            # Shot execution start
            if '[RENDER-CONTRACT] Shot' in line and 'requested_layout=' in line:
                match = re.search(r'Shot (\d+)/(\d+) \| requested_layout=(\w+)', line)
                if match:
                    shot_num = int(match.group(1))
                    requested_layout = match.group(3)
                    
                    current_shot = {
                        'shot_num': shot_num,
                        'requested_layout': requested_layout,
                        'executed_layout': None,
                        'downgraded': False,
                        'downgrade_reason': None,
                    }
                    
                    metrics['requested_layouts'][requested_layout] += 1
            
            # Layout downgrades
            elif '[RENDER-CONTRACT] DOWNGRADE' in line and current_shot:
                match = re.search(r'(\w+) → (\w+) \| reason=(\w+)', line)
                if match:
                    from_layout = match.group(1)
                    to_layout = match.group(2)
                    reason = match.group(3)
                    
                    current_shot['downgraded'] = True
                    current_shot['downgrade_reason'] = reason
                    metrics['downgrades'].append({
                        'shot': current_shot['shot_num'],
                        'from': from_layout,
                        'to': to_layout,
                        'reason': reason,
                    })
            
            # Final executed layout
            elif '[RENDER-CONTRACT] EXECUTE' in line and current_shot:
                match = re.search(r'requested=(\w+) \| executed=(\w+) \| filter=(\w+)', line)
                if match:
                    requested = match.group(1)
                    executed = match.group(2)
                    filter_type = match.group(3)
                    
                    current_shot['executed_layout'] = executed
                    current_shot['filter_type'] = filter_type
                    
                    metrics['executed_layouts'][executed] += 1
                    
                    if requested != executed:
                        metrics['layout_mismatches'] += 1
                    
                    metrics['shots'].append(current_shot)
                    current_shot = None
            
            # build_split_filter calls
            elif '[RENDER-CONTRACT] BUILD_SPLIT_FILTER' in line:
                metrics['split_filter_calls'] += 1
    
    return metrics

def calculate_summary(metrics: dict) -> dict:
    """Calculate summary statistics."""
    
    total_shots = len(metrics['shots'])
    split_requested = metrics['requested_layouts']['split_screen']
    split_executed = metrics['executed_layouts']['split_screen']
    
    downgrade_count = len(metrics['downgrades'])
    mismatch_count = metrics['layout_mismatches']
    
    split_success_rate = (split_executed / split_requested * 100) if split_requested > 0 else 0
    
    return {
        'total_shots': total_shots,
        'split_requested': split_requested,
        'split_executed': split_executed,
        'split_success_rate_pct': split_success_rate,
        'downgrade_count': downgrade_count,
        'mismatch_count': mismatch_count,
        'split_filter_calls': metrics['split_filter_calls'],
    }

def print_report(metrics: dict, summary: dict):
    """Print Sprint 2 validation report."""
    
    print("=" * 60)
    print("SPRINT 2 RENDER CONTRACT VALIDATION REPORT")
    print("=" * 60)
    print()
    
    print("OVERALL METRICS")
    print("-" * 60)
    print(f"Total shots rendered:        {summary['total_shots']}")
    print(f"Layout mismatches:           {summary['mismatch_count']}")
    print(f"Downgrades triggered:        {summary['downgrade_count']}")
    print()
    
    print("SPLIT-SCREEN EXECUTION")
    print("-" * 60)
    print(f"Director requested:          {summary['split_requested']}")
    print(f"Renderer executed:           {summary['split_executed']}")
    print(f"Success rate:                {summary['split_success_rate_pct']:.1f}%")
    print(f"build_split_filter() calls:  {summary['split_filter_calls']}")
    print()
    
    print("REQUESTED LAYOUTS (Director)")
    print("-" * 60)
    for layout, count in metrics['requested_layouts'].items():
        pct = (count / summary['total_shots'] * 100) if summary['total_shots'] > 0 else 0
        print(f"  {layout:20s}  {count:3d} ({pct:5.1f}%)")
    print()
    
    print("EXECUTED LAYOUTS (Renderer)")
    print("-" * 60)
    for layout, count in metrics['executed_layouts'].items():
        pct = (count / summary['total_shots'] * 100) if summary['total_shots'] > 0 else 0
        print(f"  {layout:20s}  {count:3d} ({pct:5.1f}%)")
    print()
    
    print("DOWNGRADE REASONS")
    print("-" * 60)
    downgrade_reasons = Counter(d['reason'] for d in metrics['downgrades'])
    for reason, count in downgrade_reasons.items():
        print(f"  {reason:30s}  {count:3d}")
    print()
    
    print("SPRINT 2 ACCEPTANCE CRITERIA")
    print("-" * 60)
    
    # Criterion 1: Director requested split_screen → Renderer executed split_screen
    criterion1_met = summary['split_executed'] > 0 if summary['split_requested'] > 0 else True
    status1 = "✅" if criterion1_met else "❌"
    print(f"{status1} Split-screen execution verified (requested={summary['split_requested']}, executed={summary['split_executed']})")
    
    # Criterion 2: No silent downgrades
    criterion2_met = summary['downgrade_count'] == summary['mismatch_count']
    status2 = "✅" if criterion2_met else "❌"
    print(f"{status2} All downgrades logged (downgrades={summary['downgrade_count']}, mismatches={summary['mismatch_count']})")
    
    # Criterion 3: build_split_filter actually called
    criterion3_met = summary['split_filter_calls'] >= summary['split_executed']
    status3 = "✅" if criterion3_met else "❌"
    print(f"{status3} Split filter execution path verified (calls={summary['split_filter_calls']})")
    
    print()
    
    overall_pass = criterion1_met and criterion2_met and criterion3_met
    if overall_pass:
        print("✅ SPRINT 2 RENDER CONTRACT: SATISFIED")
    else:
        print("❌ SPRINT 2 RENDER CONTRACT: NOT SATISFIED - Continue debugging")
    print()

def main():
    if len(sys.argv) < 2:
        print("Usage: python3 sprint2_render_metrics.py <pipeline_log_file>")
        print()
        print("Example:")
        print("  python3 sprint2_render_metrics.py /path/to/pipeline.log")
        sys.exit(1)
    
    log_path = Path(sys.argv[1])
    if not log_path.exists():
        print(f"Error: Log file not found: {log_path}")
        sys.exit(1)
    
    metrics = parse_render_contract_logs(log_path)
    summary = calculate_summary(metrics)
    print_report(metrics, summary)

if __name__ == '__main__':
    main()
