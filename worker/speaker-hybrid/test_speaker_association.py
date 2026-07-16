#!/usr/bin/env python3
"""
test_speaker_association.py — Focused tests for audio speaker → canonical person association

Tests the SpeakerToPersonAssociator module to ensure correct association logic.
"""

import sys
from pathlib import Path

# Add parent directories to path
_WORKER_ROOT = Path(__file__).resolve().parent.parent
_HYBRID_DIR = _WORKER_ROOT / "speaker-hybrid"
sys.path.insert(0, str(_WORKER_ROOT))
sys.path.insert(0, str(_HYBRID_DIR))

from speaker_to_person_associator import SpeakerToPersonAssociator, SpeakerAssociation


def test_strongest_lip_correlation_maps_correctly():
    """Test 1: SPEAKER_00 with strongest valid temporal lip correlation maps to correct PERSON_*."""
    print("\n[TEST 1] Strongest lip correlation maps correctly")
    
    # Mock diarization: SPEAKER_00 speaks 0-5s
    diarization = [
        {"speaker": "SPEAKER_00", "start": 0.0, "end": 5.0}
    ]
    
    # Mock face timeline: Two persons visible, PERSON_000 has strong lip motion during speech
    face_timeline = []
    for t in range(0, 50):  # 5 seconds at 10 fps
        time_sec = t / 10.0
        face_timeline.append({
            "time": time_sec,
            "faces": [
                {
                    "canonical_person_id": "PERSON_000",
                    "track_id": 1,
                    "is_active_speaker": True  # Strong lip motion
                },
                {
                    "canonical_person_id": "PERSON_001",
                    "track_id": 2,
                    "is_active_speaker": False  # No lip motion
                }
            ]
        })
    
    associator = SpeakerToPersonAssociator()
    associations = associator.associate_speakers_to_persons(
        diarization_segments=diarization,
        face_timeline=face_timeline,
        asd_available=True,
        canonical_persons={},
        track_to_person_map={1: "PERSON_000", 2: "PERSON_001"}
    )
    
    assert "SPEAKER_00" in associations
    assoc = associations["SPEAKER_00"]
    assert assoc.canonical_person_id == "PERSON_000", f"Expected PERSON_000, got {assoc.canonical_person_id}"
    assert assoc.association_status == "CONFIRMED", f"Expected CONFIRMED, got {assoc.association_status}"
    assert assoc.confidence >= 0.6, f"Expected confidence >= 0.6, got {assoc.confidence}"
    
    print(f"  ✅ SPEAKER_00 → {assoc.canonical_person_id} (confidence={assoc.confidence:.2f}, status={assoc.association_status})")


def test_non_speaking_dominant_person_not_selected():
    """Test 2: Visually largest non-speaking person is not selected."""
    print("\n[TEST 2] Non-speaking dominant person not selected")
    
    # Mock diarization: SPEAKER_00 speaks 0-5s
    diarization = [
        {"speaker": "SPEAKER_00", "start": 0.0, "end": 5.0}
    ]
    
    # Mock face timeline: PERSON_001 is larger but has no lip motion, PERSON_000 has lip motion
    face_timeline = []
    for t in range(0, 50):  # 5 seconds at 10 fps
        time_sec = t / 10.0
        face_timeline.append({
            "time": time_sec,
            "faces": [
                {
                    "canonical_person_id": "PERSON_000",
                    "track_id": 1,
                    "is_active_speaker": True,  # Has lip motion
                    "w": 100, "h": 150  # Smaller face
                },
                {
                    "canonical_person_id": "PERSON_001",
                    "track_id": 2,
                    "is_active_speaker": False,  # No lip motion
                    "w": 200, "h": 300  # Larger face
                }
            ]
        })
    
    associator = SpeakerToPersonAssociator()
    associations = associator.associate_speakers_to_persons(
        diarization_segments=diarization,
        face_timeline=face_timeline,
        asd_available=True,
        canonical_persons={},
        track_to_person_map={1: "PERSON_000", 2: "PERSON_001"}
    )
    
    assert "SPEAKER_00" in associations
    assoc = associations["SPEAKER_00"]
    assert assoc.canonical_person_id == "PERSON_000", f"Expected PERSON_000 (speaking), got {assoc.canonical_person_id}"
    assert assoc.canonical_person_id != "PERSON_001", "Should not select larger non-speaking person"
    
    print(f"  ✅ Selected speaking PERSON_000, not larger non-speaking PERSON_001")


def test_insufficient_evidence_returns_unresolved():
    """Test 3: Insufficient evidence returns UNRESOLVED."""
    print("\n[TEST 3] Insufficient evidence returns UNRESOLVED")
    
    # Mock diarization: SPEAKER_00 speaks 0-1s (very short)
    diarization = [
        {"speaker": "SPEAKER_00", "start": 0.0, "end": 1.0}  # Only 1 second
    ]
    
    # Mock face timeline: No faces visible during speech (truly insufficient)
    face_timeline = [
        {
            "time": 0.0,
            "faces": []  # No faces visible
        },
        {
            "time": 0.5,
            "faces": []  # No faces visible
        },
        {
            "time": 1.0,
            "faces": []  # No faces visible
        }
    ]
    
    associator = SpeakerToPersonAssociator()
    associations = associator.associate_speakers_to_persons(
        diarization_segments=diarization,
        face_timeline=face_timeline,
        asd_available=True,
        canonical_persons={},
        track_to_person_map={1: "PERSON_000"}
    )
    
    assert "SPEAKER_00" in associations
    assoc = associations["SPEAKER_00"]
    assert assoc.canonical_person_id is None, f"Expected None, got {assoc.canonical_person_id}"
    assert assoc.association_status == "UNRESOLVED", f"Expected UNRESOLVED, got {assoc.association_status}"
    
    print(f"  ✅ Returned UNRESOLVED with insufficient evidence (status={assoc.association_status})")


def test_asd_unavailable_no_fabrication():
    """Test 4: ASD_UNAVAILABLE produces no fabricated association."""
    print("\n[TEST 4] ASD_UNAVAILABLE produces no fabricated association")
    
    # Mock diarization: SPEAKER_00 speaks 0-5s
    diarization = [
        {"speaker": "SPEAKER_00", "start": 0.0, "end": 5.0}
    ]
    
    # Mock face timeline with persons
    face_timeline = [
        {
            "time": 0.0,
            "faces": [
                {"canonical_person_id": "PERSON_000", "track_id": 1}
            ]
        }
    ]
    
    associator = SpeakerToPersonAssociator()
    associations = associator.associate_speakers_to_persons(
        diarization_segments=diarization,
        face_timeline=face_timeline,
        asd_available=False,  # ASD unavailable
        canonical_persons={},
        track_to_person_map={1: "PERSON_000"}
    )
    
    assert "SPEAKER_00" in associations
    assoc = associations["SPEAKER_00"]
    assert assoc.canonical_person_id is None, f"Expected None, got {assoc.canonical_person_id}"
    assert assoc.association_status == "ASD_UNAVAILABLE", f"Expected ASD_UNAVAILABLE, got {assoc.association_status}"
    assert assoc.confidence == 0.0, f"Expected confidence 0.0, got {assoc.confidence}"
    
    print(f"  ✅ No fabricated association when ASD unavailable (status={assoc.association_status})")


def run_all_tests():
    """Run all focused tests."""
    print("="*60)
    print("SPEAKER → PERSON ASSOCIATION TESTS")
    print("="*60)
    
    try:
        test_strongest_lip_correlation_maps_correctly()
        test_non_speaking_dominant_person_not_selected()
        test_insufficient_evidence_returns_unresolved()
        test_asd_unavailable_no_fabrication()
        
        print("\n" + "="*60)
        print("✅ ALL TESTS PASSED")
        print("="*60)
        return 0
    except AssertionError as e:
        print(f"\n❌ TEST FAILED: {e}")
        return 1
    except Exception as e:
        print(f"\n❌ TEST ERROR: {e}")
        import traceback
        traceback.print_exc()
        return 1


if __name__ == "__main__":
    sys.exit(run_all_tests())
