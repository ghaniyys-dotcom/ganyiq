# GANYIQ Canonical Data Contract

**Purpose:** Define the exact data format and identity namespace contract between pipeline stages.

**Goal:** Enforce that each stage owns ONE identity namespace and NO stage overwrites another's output.

---

## Pipeline Stage Order (Canonical)

```
1. Face Detection/Tracking    → raw detections, TRACK_* IDs
2. Canonical Identity Registry → PERSON_* IDs (canonical)
3. Audio Diarization          → SPEAKER_* IDs
4. ASD Validation             → quality gate (status only)
5. Audio-Visual Matching      → SPEAKER_* ↔ visual evidence
6. Speaker-to-Person Assoc    → SPEAKER_* → PERSON_* mapping (with status)
7. Reaction Detection         → reaction events
8. Reaction Validation        → filtered reaction events
9. Director Shot Planning     → PERSON_* targets OR wide_shot
10. Renderer (pipeline.py)    → PERSON_* → bbox resolution
```

---

## Stage 1: Face Detection & Tracking

**Module:** `hybrid_face_detector.py`  
**Output:** Face timeline JSON

**Contract:**

```json
{
  "timeline": [
    {
      "time": 0.0,
      "faces": [
        {
          "track_id": 0,          // ByteTrack visual track ID (required)
          "person_id": null,      // FaceDB identity (optional, may be null)
          "cx": 100, "cy": 200, "w": 80, "h": 120,
          "lip_motion": 0.0,      // Raw lip motion score (for ASD)
          "confidence": 0.95
        }
      ]
    }
  ],
  "duration": 60.0
}
```

**Identity Namespace:** `track_id` (visual tracking only)

**Constraints:**
- `track_id` MUST be unique within timeline
- `person_id` is OPTIONAL (FaceDB feature)
- NO `speaker_id` at this stage
- NO `canonical_person_id` at this stage (added by registry)

---

## Stage 2: Canonical Person Registry

**Module:** `canonical_person_registry.py`  
**Mutates:** Face timeline (adds `canonical_person_id`)

**Contract:**

Input: Face timeline from Stage 1  
Output: Face timeline WITH `canonical_person_id` added to each face

```json
{
  "timeline": [
    {
      "time": 0.0,
      "faces": [
        {
          "track_id": 0,
          "person_id": null,
          "canonical_person_id": "PERSON_001",  // ← ADDED BY REGISTRY
          "cx": 100, "cy": 200, "w": 80, "h": 120
        }
      ]
    }
  ]
}
```

**Identity Namespace:** `PERSON_*` (canonical identity)

**Constraints:**
- Registry MUST assign `canonical_person_id` to ALL faces with valid `track_id`
- Format: `PERSON_XXX` where XXX is zero-padded 3-digit integer
- Multiple `track_id` MAY map to same `PERSON_*` (identity consolidation)
- Registry MUST export `track_to_person_map` for downstream use

**Invariants:**
- Every `track_id` maps to exactly ONE `PERSON_*`
- `PERSON_*` IDs are stable across the entire video

---

## Stage 3: Audio Diarization

**Module:** `diarize.py`  
**Output:** Diarization JSON (separate file)

**Contract:**

```json
{
  "segments": [
    {
      "speaker": "SPEAKER_00",
      "start": 0.0,
      "end": 5.5
    },
    {
      "speaker": "SPEAKER_01",
      "start": 5.5,
      "end": 12.3
    }
  ]
}
```

**Identity Namespace:** `SPEAKER_*` (audio identity)

**Constraints:**
- Speaker IDs MUST follow format `SPEAKER_XX`
- Segments MUST NOT overlap
- Segments MUST be sorted by `start` time

**Isolation:**
- Audio diarization MUST NOT mutate visual face data
- Audio diarization MUST NOT assign `person_id` or `canonical_person_id`

---

## Stage 4: ASD Validation

**Module:** `asd_validator.py`  
**Output:** Status enum + diagnostics (does NOT mutate data)

**Contract:**

```python
# Validation result
status: ASDStatus  # VALID | LOW_SIGNAL | UNAVAILABLE
diagnostics: dict  # {total_observations, nonzero_ratio, reasoning}
```

**Identity Namespace:** NONE (validation only)

**Constraints:**
- ASD validator MUST NOT assign speaker IDs
- ASD validator MUST NOT modify face data
- ASD validator MUST return status + diagnostics ONLY
- Downstream stages MUST respect status when using lip_motion data

---

## Stage 5: Audio-Visual Matching

**Module:** `audio_visual_matcher.py`  
**Output:** Matched timeline (unified view)

**Contract:**

```json
{
  "matched_timeline": [
    {
      "time": 0.0,
      "speaker_id": "SPEAKER_00",     // Audio identity
      "track_id": 0,                   // Visual identity
      "canonical_person_id": "PERSON_001",  // Canonical identity (passthrough)
      "bbox": {"cx": 100, "cy": 200, "w": 80, "h": 120}
    }
  ]
}
```

**Identity Namespace:** Links `SPEAKER_*` ↔ visual observations

**Constraints:**
- AVM MUST NOT create new `PERSON_*` IDs
- AVM MUST preserve `canonical_person_id` from registry
- AVM MAY assign `speaker_id` to faces based on temporal overlap
- AVM MUST NOT overwrite registry's `canonical_person_id`

---

## Stage 6: Speaker-to-Person Association

**Module:** `speaker_to_person_associator.py`  
**Output:** Association map (separate from timeline)

**Contract:**

```json
{
  "speaker_associations": {
    "SPEAKER_00": {
      "canonical_person_id": "PERSON_001",
      "confidence": 0.85,
      "evidence_count": 12,
      "supporting_duration": 15.5,
      "status": "RESOLVED",          // RESOLVED | UNRESOLVED | AMBIGUOUS
      "failure_reason": null
    },
    "SPEAKER_01": {
      "canonical_person_id": null,
      "confidence": 0.0,
      "evidence_count": 0,
      "supporting_duration": 0.0,
      "status": "UNRESOLVED",
      "failure_reason": "insufficient_visual_evidence"
    }
  }
}
```

**Identity Namespace:** `SPEAKER_*` → `PERSON_*` mapping

**Constraints:**
- Associator MUST return explicit `status` for each speaker
- Associator MUST provide `failure_reason` when status != RESOLVED
- Associator MUST NOT mutate face timeline
- Associator output is ADVISORY only (does not override canonical registry)

**Critical Invariant:**
- If `status == "UNRESOLVED"`, downstream stages MUST NOT assume speaker → person mapping
- Director MUST handle UNRESOLVED speakers gracefully (fallback to visual-only)

---

## Stage 7: Reaction Detection

**Module:** `reaction/reaction_detector.py`  
**Output:** Reaction events list

**Contract:**

```json
{
  "reactions": [
    {
      "time": 5.5,
      "track_id": 0,
      "person_id": "PERSON_001",
      "reaction_type": "smile",
      "intensity": 0.75
    }
  ],
  "summary": {
    "smile": 5,
    "surprise": 2,
    "blink": 150
  }
}
```

**Identity Namespace:** References `track_id` and `person_id`

**Constraints:**
- Reaction detector MUST NOT create new identity IDs
- Reaction detector MUST reference existing `track_id` or `person_id`

---

## Stage 8: Reaction Validation

**Module:** `reaction/reaction_validator.py`  
**Status:** CURRENTLY DEAD CODE (instantiated but never called)

**Expected Contract (if enabled):**

Input: Raw reaction events  
Output: Filtered reaction events (remove false positives like blink spam)

**Current Issue:** ReactionValidator is instantiated but never invoked. Detector output goes directly to Director.

---

## Stage 9: Director Shot Planning

**Module:** `director.py`  
**Output:** Shot list with PERSON_* targets

**Contract:**

```json
{
  "scenes": [
    {
      "start_time": 0.0,
      "end_time": 5.5,
      "layout": "fullscreen",
      "primary_target_id": "PERSON_001",      // ← MUST use PERSON_*
      "secondary_target_id": null,
      "duration": 5.5
    },
    {
      "start_time": 5.5,
      "end_time": 12.0,
      "layout": "split_screen",
      "primary_target_id": "PERSON_001",
      "secondary_target_id": "PERSON_002",
      "duration": 6.5
    }
  ]
}
```

**Identity Namespace:** `PERSON_*` (canonical) OR `wide_shot`

**Constraints:**
- Director MUST output `PERSON_*` targets (canonical namespace)
- Director MUST NOT output `SPEAKER_*` targets
- Director MUST NOT output `TRACK_*` targets
- Director MAY output `wide_shot` when no person is available
- Director MUST handle UNRESOLVED speaker associations gracefully

---

## Stage 10: Renderer (Bbox Resolution)

**Module:** `pipeline.py._render_from_shot_list()` + `person_bbox_resolver.py`

**Input:** Shot list with `PERSON_*` targets  
**Output:** Rendered video

**Contract:**

Renderer MUST:
1. Accept `PERSON_*` targets from Director
2. Use `PersonBboxResolver` to map `PERSON_*` → bbox at each frame
3. Use registry's `track_to_person_map` for resolution
4. Fallback to `wide_shot` if `PERSON_*` not found in frame

Renderer MUST NOT:
- Accept `SPEAKER_*` targets directly
- Accept `TRACK_*` targets directly
- Bypass canonical registry mapping

---

## VIOLATIONS TO FIX

### 1. ASD Pathway Issue
**Current:** `asd.py compute_lip_energy()` runs even when `ASDValidator` returns `UNAVAILABLE`  
**Expected:** If status == UNAVAILABLE, downstream MUST NOT use lip_motion data  
**Fix:** Validate status before calling compute_lip_energy OR ensure validator filters effectively

### 2. Reaction Validator Not Used
**Current:** `ReactionValidator` instantiated but never invoked  
**Expected:** Validator should filter reaction_detector output OR be removed  
**Fix:** Remove dead ReactionValidator instantiation

### 3. ID Bridge Duplication
**Current:** `pipeline.py._build_id_bridge()` duplicates `core/id_bridge.py`  
**Expected:** Single source of truth for ID mapping  
**Fix:** Remove unused `core/id_bridge.py`

### 4. Legacy Split Decision Engine
**Current:** `split/split_decision_engine.py` exists but DirectorAI is used  
**Expected:** One shot planning module  
**Fix:** Remove unused SplitDecisionEngine

---

## ENFORCEMENT RULES

1. **Namespace Ownership:** Each stage owns ONE identity namespace
2. **No Overwrites:** Later stages MUST NOT overwrite earlier stage IDs
3. **Explicit Status:** Validators MUST return explicit status (not guess)
4. **Graceful Degradation:** Director MUST handle UNRESOLVED/UNAVAILABLE status
5. **Canonical Targets:** Renderer MUST accept only PERSON_* or wide_shot

**Next Step:** Implement these contracts in code with validation.
