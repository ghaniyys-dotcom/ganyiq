# Sprint 2: Render Contract Enforcement

**Branch:** `sprint2-render-contract`  
**Started:** 2026-07-16  
**Status:** TASKS 1-4 COMPLETE, Task 5 pending

---

## Objective

Make renderer faithfully execute Director's layout decisions.
- No silent downgrades
- Split-screen must render when Director requests it
- Every downgrade must be logged with reason

---

## Completed Tasks

### ✅ Task 1: Trace Every Shot

**Implementation:**
- Added `[RENDER-CONTRACT]` structured logging (12 log points)
- Log requested_layout, executed_layout, bbox availability
- Track primary/secondary target presence
- Log filter type selected for each shot

**Evidence:**
```python
Line 422: [RENDER-CONTRACT] Shot execution logging
Line 428: [RENDER-CONTRACT] DOWNGRADE | split_screen downgrades
Line 437: [RENDER-CONTRACT] DOWNGRADE | two_shot_wide downgrades  
Line 450: [RENDER-CONTRACT] DOWNGRADE | bbox overlap downgrades
Line 483: [RENDER-CONTRACT] EXECUTE | final layout execution
Line 300: [RENDER-CONTRACT] BUILD_SPLIT_FILTER | filter generation
```

**Commits:**
- `3477ff02` test: add render contract telemetry for Sprint 2

---

### ✅ Task 2: Implement Explicit Layout Execution

**Implementation:**
- Hierarchical fallback for split_screen:
  - Both targets valid → execute build_split_filter()
  - Only primary valid → fullscreen primary
  - Only secondary valid → fullscreen secondary
  - Neither valid → largest face fallback
  
- Hierarchical fallback for two_shot_wide:
  - Both targets valid → execute build_two_shot_filter()
  - Only primary valid → fullscreen primary
  - Only secondary valid → fullscreen secondary
  - Neither valid → largest face fallback

**Evidence:**
```python
Lines 428-435: split_screen hierarchical fallback
Lines 437-447: two_shot_wide hierarchical fallback
```

**Commits:**
- `b2ecd50f` fix: implement explicit hierarchical layout fallback

---

### ✅ Task 3: Verify build_split_filter() Execution

**Implementation:**
- Added logging to `_build_split_filter()` entry point
- Logs bbox availability and output dimensions
- Traces complete execution path: Director → Renderer → build_split_filter() → FFmpeg

**Evidence:**
```python
Line 300: log(f"[RENDER-CONTRACT] BUILD_SPLIT_FILTER | top_bbox={bool(bbox_top)} | bottom_bbox={bool(bbox_bottom)} | output={out_w}x{out_h}")
```

**Commits:**
- `3a8b640a` test: trace build_split_filter execution path
- `2240a061` fix: remove stray docstring quotes in build_split_filter

---

### ✅ Task 4: Render Validation Script

**Implementation:**
- Created `sprint2_render_metrics.py` (200 lines)
- Parses RENDER-CONTRACT logs
- Measures:
  - Director requested split_screen count
  - Renderer executed split_screen count
  - Layout downgrades (count + reasons)
  - Layout mismatch count
  - build_split_filter() call count

**Usage:**
```bash
python3 sprint2_render_metrics.py /path/to/pipeline.log
```

**Output:**
- Split-screen success rate
- Downgrade reasons breakdown
- Execution path verification
- Sprint 2 acceptance criteria validation

**Commits:**
- `11ddc112` test: add Sprint 2 render contract metrics script

---

## Pending: Task 5 - Visual Verification

**Requirements:**
1. Run one real benchmark clip render
2. Extract representative frames:
   - One split_screen shot
   - One fullscreen shot
   - One fallback shot
3. Visually confirm split-screen is actually rendered
4. Do NOT rely only on logs

**Blockers:**
- Need source video for test render
- Need to run instrumented pipeline
- Need to extract frames from output

**Next Steps:**
1. Find or download test video
2. Run render with instrumented pipeline
3. Analyze logs with sprint2_render_metrics.py
4. Extract frames with ffmpeg
5. Visual inspection

---

## Sprint 2 Acceptance Criteria

### Criterion 1: Director → Renderer
- [ ] Director requested split_screen
- [ ] Renderer executed split_screen
- [ ] Video contains split_screen frames

### Criterion 2: No Silent Downgrades
- [ ] All downgrades logged with reason
- [ ] Downgrade count matches mismatch count

### Criterion 3: Execution Path Verified
- [ ] build_split_filter() called when split_screen executed
- [ ] FFmpeg receives split filter_complex

---

## Code Changes Summary

**Files Modified:**
- `worker/speaker-hybrid/pipeline.py`: +35 lines (telemetry + fallback)

**Files Added:**
- `worker/speaker-hybrid/sprint2_render_metrics.py`: 200 lines (new)

**Commits:** 6 total
- 3 implementation commits
- 2 test/instrumentation commits
- 1 bugfix commit

**All changes <300 lines per operation - protocol compliant.**

---

## Known Issues

**Issue 1: Syntax Error (RESOLVED)**
- Stray docstring quotes in build_split_filter
- Fixed in commit `2240a061`
- Syntax verified OK

---

## Next Actions

1. ✅ Complete Tasks 1-4
2. ⏭️ Find test video for benchmark
3. ⏭️ Run instrumented render
4. ⏭️ Collect and analyze metrics
5. ⏭️ Visual frame verification
6. ⏭️ Report Sprint 2 completion with evidence

---

**Status:** Ready for benchmark testing (Task 5)
