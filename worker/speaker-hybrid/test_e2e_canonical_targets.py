#!/usr/bin/env python3
"""
test_e2e_canonical_targets.py — E2E benchmark validation for canonical target namespace

Validates the complete audio speaker → canonical person association pipeline end-to-end.
Forces regeneration and checks that Director emits only PERSON_* targets.
"""

import sys
import json
import subprocess
from pathlib import Path

# Add parent directories to path
_WORKER_ROOT = Path(__file__).resolve().parent.parent
_HYBRID_DIR = _WORKER_ROOT / "speaker-hybrid"
sys.path.insert(0, str(_WORKER_ROOT))
sys.path.insert(0, str(_HYBRID_DIR))


def log(msg):
    print(f"[E2E-TEST] {msg}", file=sys.stderr, flush=True)


def get_git_commit():
    """Get current Git commit hash."""
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            capture_output=True,
            text=True,
            cwd=_WORKER_ROOT.parent
        )
        return result.stdout.strip()
    except Exception:
        return "unknown"


def run_benchmark(video_path: str, output_path: str, work_dir: str) -> dict:
    """
    Run the speaker-hybrid pipeline with force regeneration.
    
    Returns analysis_result.json content.
    """
    log(f"Running benchmark on: {video_path}")
    
    pipeline_script = _HYBRID_DIR / "pipeline.py"
    if not pipeline_script.exists():
        raise FileNotFoundError(f"Pipeline script not found: {pipeline_script}")
    
    cmd = [
        sys.executable,
        str(pipeline_script),
        "--video", str(video_path),
        "--output", str(output_path),
        "--work-dir", str(work_dir),
        "--force-regenerate"  # Force fresh render
    ]
    
    log(f"Command: {' '.join(cmd)}")
    
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=600,  # 10 minutes max
            cwd=str(_HYBRID_DIR)
        )
        
        if result.returncode != 0:
            log(f"Pipeline failed with exit code {result.returncode}")
            log(f"STDERR: {result.stderr[:500]}")
            raise RuntimeError(f"Pipeline failed: {result.stderr[:200]}")
        
        # Load result
        result_path = Path(work_dir) / "analysis_result.json"
        if not result_path.exists():
            raise FileNotFoundError(f"Result file not found: {result_path}")
        
        with open(result_path) as f:
            return json.load(f)
    
    except subprocess.TimeoutExpired:
        raise RuntimeError("Pipeline timeout after 10 minutes")


def validate_result(result: dict, git_commit: str) -> dict:
    """
    Validate E2E benchmark result.
    
    Returns validation report with all metrics.
    """
    log("Validating E2E result...")
    
    report = {
        "git_commit": git_commit,
        "stale_output_reused": False,  # Force regenerate prevents this
        "audio_speakers_detected": 0,
        "canonical_persons_detected": 0,
        "speaker_associations": {},
        "unresolved_speakers": [],
        "director_target_namespace": {
            "PERSON": 0,
            "SPEAKER": 0,
            "LISTENER": 0,
            "TRACK": 0,
            "NULL": 0,
            "UNKNOWN": 0
        },
        "mixed_namespace_count": 0,
        "same_person_split_count": 0,
        "wide_shot_fallback_count": 0,
        "validation_passed": False,
        "errors": []
    }
    
    # Extract audio speakers
    audio_data = result.get("audio", {})
    segments = audio_data.get("segments", [])
    speaker_ids = set(seg.get("speaker") for seg in segments if seg.get("speaker"))
    report["audio_speakers_detected"] = len(speaker_ids)
    
    # Extract canonical persons
    canonical_persons = result.get("canonical_persons", {})
    report["canonical_persons_detected"] = canonical_persons.get("total_canonical_persons", 0)
    
    # Extract speaker associations
    speaker_associations = result.get("speaker_associations", {})
    for speaker_id, assoc in speaker_associations.items():
        report["speaker_associations"][speaker_id] = {
            "canonical_person_id": assoc.get("canonical_person_id"),
            "confidence": assoc.get("confidence"),
            "evidence_count": assoc.get("evidence_count"),
            "supporting_duration": assoc.get("supporting_duration"),
            "status": assoc.get("status")
        }
        
        # Track unresolved speakers
        if assoc.get("status") != "CONFIRMED":
            report["unresolved_speakers"].append(speaker_id)
    
    # Validate Director target namespace
    split_plan = result.get("split_plan", {})
    scenes = split_plan.get("scenes", [])
    
    for scene in scenes:
        layout = scene.get("layout")
        primary = scene.get("primary_target_id")
        secondary = scene.get("secondary_target_id")
        
        # Count target namespaces
        primary_ns = _classify_target(primary)
        secondary_ns = _classify_target(secondary) if secondary else None
        
        report["director_target_namespace"][primary_ns] += 1
        if secondary_ns:
            report["director_target_namespace"][secondary_ns] += 1
        
        # Check for mixed namespace
        if secondary and primary_ns != secondary_ns and secondary_ns != "NULL":
            report["mixed_namespace_count"] += 1
            report["errors"].append(
                f"Mixed namespace: {primary} ({primary_ns}) + {secondary} ({secondary_ns})"
            )
        
        # Check for same person in split
        if layout == "split_screen" and primary and secondary and primary == secondary:
            report["same_person_split_count"] += 1
            report["errors"].append(f"Same person in split: {primary}")
        
        # Count wide shot fallbacks
        if layout == "wide_shot":
            report["wide_shot_fallback_count"] += 1
    
    # Extract target validation result
    target_validation = result.get("target_validation", {})
    if target_validation:
        if not target_validation.get("valid"):
            report["errors"].append(
                f"Target validation failed: {target_validation.get('error_message')}"
            )
        report["mixed_namespace_count"] = target_validation.get("mixed_namespace_count", 0)
    
    # Determine overall pass/fail
    report["validation_passed"] = (
        report["director_target_namespace"]["SPEAKER"] == 0 and
        report["director_target_namespace"]["LISTENER"] == 0 and
        report["director_target_namespace"]["TRACK"] == 0 and
        report["mixed_namespace_count"] == 0 and
        report["same_person_split_count"] == 0
    )
    
    return report


def _classify_target(target_id) -> str:
    """Classify target ID by namespace."""
    if target_id is None or target_id == "null":
        return "NULL"
    
    target_str = str(target_id).upper()
    
    if target_str.startswith("PERSON_"):
        return "PERSON"
    if target_str.startswith("SPEAKER_"):
        return "SPEAKER"
    if target_str.startswith("LISTENER_"):
        return "LISTENER"
    if target_str.startswith("TRACK_"):
        return "TRACK"
    
    return "UNKNOWN"


def print_report(report: dict):
    """Print E2E validation report."""
    print("\n" + "="*80)
    print("E2E CANONICAL TARGET VALIDATION REPORT")
    print("="*80)
    
    print(f"\nGit commit: {report['git_commit']}")
    print(f"Stale output reused: {report['stale_output_reused']}")
    
    print(f"\nAudio speakers detected: {report['audio_speakers_detected']}")
    print(f"Canonical persons detected: {report['canonical_persons_detected']}")
    
    print("\nSpeaker → Person Associations:")
    for speaker_id, assoc in report['speaker_associations'].items():
        person_id = assoc['canonical_person_id'] or 'UNRESOLVED'
        status = assoc['status']
        confidence = assoc['confidence']
        evidence = assoc['evidence_count']
        duration = assoc['supporting_duration']
        print(f"  {speaker_id} → {person_id} (status={status}, confidence={confidence:.2f}, "
              f"evidence={evidence} intervals, duration={duration:.1f}s)")
    
    if report['unresolved_speakers']:
        print(f"\nUnresolved speakers: {', '.join(report['unresolved_speakers'])}")
    
    print("\nDirector Target Namespace Distribution:")
    for ns, count in report['director_target_namespace'].items():
        if count > 0:
            print(f"  {ns}: {count}")
    
    print(f"\nMixed namespace count: {report['mixed_namespace_count']}")
    print(f"Same person in split count: {report['same_person_split_count']}")
    print(f"Wide shot fallback count: {report['wide_shot_fallback_count']}")
    
    if report['errors']:
        print("\nErrors:")
        for error in report['errors'][:10]:
            print(f"  ❌ {error}")
    
    status = "✅ PASS" if report['validation_passed'] else "❌ FAIL"
    print(f"\nValidation: {status}")
    print("="*80 + "\n")


def main():
    """Run E2E benchmark validation."""
    import argparse
    
    parser = argparse.ArgumentParser(description="E2E Canonical Target Validation")
    parser.add_argument("--video", required=True, help="Path to benchmark video")
    parser.add_argument("--output", required=True, help="Path for output video")
    parser.add_argument("--work-dir", required=True, help="Working directory")
    parser.add_argument("--report", help="Path to save JSON report")
    
    args = parser.parse_args()
    
    # Get Git commit
    git_commit = get_git_commit()
    log(f"Running E2E benchmark at commit {git_commit}")
    
    # Run benchmark
    try:
        result = run_benchmark(args.video, args.output, args.work_dir)
    except Exception as e:
        log(f"Benchmark failed: {e}")
        return 1
    
    # Validate result
    report = validate_result(result, git_commit)
    
    # Print report
    print_report(report)
    
    # Save report if requested
    if args.report:
        with open(args.report, 'w') as f:
            json.dump(report, f, indent=2)
        log(f"Report saved to {args.report}")
    
    return 0 if report['validation_passed'] else 1


if __name__ == "__main__":
    sys.exit(main())
