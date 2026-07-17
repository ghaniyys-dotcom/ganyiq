# OpusClip Gap Report — Runtime Truth Audit

**Date:** 2026-06-20
**Method:** Only runtime verification (DB records, actual execution, ffmpeg, OpenCV)
**No simulations, no grep-based PASS claims.**

---

## SECTION 1 — Verified Working Features

| Feature | Status | Evidence |
|---------|--------|----------|
| **Transcript generation** | **VERIFIED_WORKING** | 1,127 moments in DB with transcript_excerpt. 2 completed analyses on June 18. |
| **Moment extraction** | **VERIFIED_WORKING** | 1,127 moments across ~115 analyses. All have start_time, end_time, transcript_excerpt. |
| **Ranking API (query)** | **VERIFIED_WORKING** | `app/api/ranking/route.ts` orders by `final_score DESC NULLS LAST`. Query compiles and runs. |
| **DB migrations** | **VERIFIED_WORKING** | All 11 migrations applied. Checked via `_migrations` table. |
| **Clip rendering (basic)** | **VERIFIED_WORKING** | `ffmpeg -i test_out.mp4 -ss 0 -t 2 -c copy` produces valid 440KB MP4. |
| **OpenCV availability** | **VERIFIED_WORKING** | Python OpenCV 4.13.0 installed. Blur/brightness computation confirmed on real video. |

---

## SECTION 2 — Implemented But NOT Executed (No Runtime Data)

These features have code that compiles and IS wired into the pipeline, but **zero analyses have run since the code/migration was added**. No database rows exist.

| Feature | Code Location | DB Reality | Root Cause |
|---------|--------------|------------|------------|
| **final_score on moments** | `lib/analyzer.ts:519-522` | 0/1127 rows populated | Migration 010 applied June 20. Last analysis: June 18. Code never executed post-migration. |
| **information_gain** | `lib/analyzer.ts:517` | 0/1127 rows populated | Same — no analysis run after code change. |
| **attention_capture** | `lib/analyzer.ts:518` | 0/1127 rows populated | Same |
| **harm** | `lib/analyzer.ts:519` | 0/1127 rows populated | Same |
| **viral_score** | `lib/analyzer.ts:532` | 0/1127 rows populated | Same |
| **hook_strength** | `lib/analyzer.ts:534` | 0/1127 rows populated | Same |
| **surprise_level** | `lib/analyzer.ts:535` | 0/1127 rows populated | Same |
| **novelty_score** | `lib/analyzer.ts:536` | 0/1127 rows populated | Same |
| **emotional_intensity** | `lib/analyzer.ts:537` | 0/1127 rows populated | Same |
| **audience_relevance** | `lib/analyzer.ts:538` | 0/1127 rows populated | Same |
| **visual_quality_score** | `lib/analyze-pipeline.ts:199` | 0/1127 rows populated | Code passes `(m as any).visual_quality_score ?? null` — no computation ever sets this. |

**Verdict:** These cannot be called "working." They are **code-complete but execution-zero**. A single new analysis would populate them, but until then they are unimplemented in practice.

---

## SECTION 3 — Implemented But NOT Integrated (Never Called)

These features have working code that compiles, but the pipeline **never calls them**. No imports, no function calls.

| Feature | Files | Integration Status |
|---------|-------|--------------------|
| **Scene detection** | `lib/scene-detector.ts` (61 lines) — ffmpeg-based scene detection | **ZERO imports** anywhere in lib/. `detectScenesFromVideo()` never called. |
| **Visual quality scorer** | `worker/visual-quality-scorer.py` (187 lines) — OpenCV blur/brightness/face detection | **ZERO imports** in pipeline. Standalone script never invoked. |
| **B-roll engine** | `worker/broll-engine.ts` (288 lines) | **ZERO imports** in pipeline. No code generates b-roll overlays. |
| **Viral moment detector (worker)** | `worker/viral-moment-detector.ts` | Different copy from `lib/viral-moment-detector.ts`. Not imported by worker/index.ts. |

**Runtime Verification:**
- **Scene detection on test_out.mp4:** ✅ ffmpeg detects 3 scene boundaries (at 1.0s, 1.08s, 3.0s)
- **But SCENES table: 0 rows** — detected scenes are never stored
- **But MOMENT extraction ignores scenes** — no scene_id, scene_start, scene_end in any moment query

---

## SECTION 4 — Missing Features (No Runtime Exists)

| Feature | Status | Notes |
|---------|--------|-------|
| **Scene-aware clipping** | **MISSING** | No code adjusts moment boundaries based on scene cuts. Candidate extraction ignores scenes. |
| **B-roll insertion in renders** | **MISSING** | No rendered output contains b-roll. `broll_candidates` table: 0 rows. |
| **Podcast mode auto-detection** | **MISSING** | No runtime podcast detection on any analysis. Speaker count based layout exists in decision-engine but unverified on any real video. |
| **Emotion classification (DB)** | **MISSING** | No emotion columns on moments table. Not part of any migration. |
| **Active-word subtitle rendering** | **MISSING** | ASS karaoke tags (\K) exist in subtitle-templates.ts, but **0 rendered clips verified** with active-word highlighting. Cannot confirm it works. |

---

## SECTION 5 — Worker Deployment Requirements

| Worker Variant | Has New Files? | Regeneration Needed? |
|----------------|----------------|---------------------|
| **worker/** (VPS-side) | ✅ Has all: scene-detector.ts, viral-moment-detector.ts, broll-engine.ts | No immediate need |
| **worker-package/** (PC-GANY) | ❌ MISSING: scene-detector.ts, viral-moment-detector.ts, broll-engine.ts | **YES — Must regenerate** |

**Worker runtime audit:**
- Worker `index.ts` does NOT reference `final_score` or `viral_score` directly
- Clip selection is server-side (via ranking API — orders by `final_score DESC`)
- Worker receives clip_params with `final_score`, `viral_score` etc. from the API
- But `clip-renderer.ts` uses `renderMode` and `startTime`/`endTime` from params — **final_score is passed but not consumed** by the renderer

**Blockers for end-to-end test:**
- GANYIQ production server on port 3003 may conflict with other services
- PC-GANY worker machine not connected; VPS can render basic clips via ffmpeg

---

## SECTION 6 — Top 10 Highest ROI Features Remaining

Ranked by impact on OpusClip parity, with runtime-verified status:

| Rank | Feature | Current Status | Impact |
|------|---------|---------------|--------|
| 1 | **Run ONE real analysis post-migration** | IMPLEMENTED_NOT_EXECUTED | Verifies all evaluator + viral scores in DB |
| 2 | **Wire scene detection into pipeline** | NOT_INTEGRATED | Scene boundaries in DB → scene-aware clipping |
| 3 | **Wire visual quality scoring into pipeline** | NOT_INTEGRATED | VQ score in DB → filter blurry/overexposed clips |
| 4 | **Regenerate worker-package** | MISSING_FILES | PC-GANY gets new features |
| 5 | **Wire B-roll insertion into renderer** | MISSING | B-roll enhances podcast/interview clips |
| 6 | **Active-word subtitle render test** | UNVERIFIED | Verify \K tags work on real rendered clip |
| 7 | **Camera switching E2E test** | UNVERIFIED | Run decision-engine on real face-track output |
| 8 | **Podcast mode auto-detection** | MISSING | Auto-detect interview/podcast/panel from speaker count |
| 9 | **Emotion classification integration** | MISSING | Classify speaker emotion per frame |
| 10 | **Disable worthClippingScore in ranking** | PARTIAL | V3 ranking uses final_score primary but falls back to worthClippingScore |

---

## SECTION 7 — Real OpusClip Parity Estimate

Based on **runtime-verified** data only:

| Subsystem | Current | OpusClip | Gap |
|-----------|---------|----------|-----|
| **Ranking** | 0% runtime | 100% | All 1,127 moments have NULL final_score. Query orders by NULLS LAST = falls back to worthClippingScore. **Not using evaluator at all in production.** |
| **Moment Selection** | 50% | 100% | Candidate extraction works. But scenes/visual quality not used for selection. |
| **Scene Intelligence** | 0% | 100% | 3 scenes detectable via ffmpeg on test video. ZERO integration. |
| **Multi-Speaker** | 0% runtime verified | 100% | Code exists for camera switching. **No real video has ever been processed through it.** |
| **Subtitle Quality** | 0% runtime verified | 100% | ASS templates exist. **No rendered output verified** with active-word/karaoke. |
| **Rendering Quality** | Basic cuts only | Full pipeline | ffmpeg works on VPS. Camera switching/layouts require PC-GANY machine. |
| **Podcast Handling** | 0% runtime | 100% | No real podcast video processed through decision-engine. |

**Overall OpusClip Parity (runtime-verified): <5%**

**Key Insight:** The codebase is **ahead of its runtime**. Many features compile, look good in grep, but have never executed through a real video pipeline. The single highest-impact action is: **run one real analysis** to populate the evaluator and viral scores, then re-verify from there.

---

## Appendix — Runtime Evidence Log

```
video test:     /root/GANYIQ/test_out.mp4 (1080×1920, 5s, H.264+AAC)
ffmpeg render:  /tmp/render_test.mp4 (440KB, 2s cut — VERIFIED_WORKING)
scene detect:   3 boundaries at 1.0s, 1.08s, 3.0s — VERIFIED_WORKING
OpenCV blur:    Frame 0: blur=32.09, brightness=81.85 — VERIFIED_WORKING
DB moments:     1,127 total — VERIFIED
DB final_score: 0/1,127 populated — VERIFIED
DB viral_score: 0/1,127 populated — VERIFIED
DB scenes:      0 rows — VERIFIED
DB broll:       0 rows — VERIFIED
migrations:     11/11 applied — VERIFIED
API ranking:    ORDER BY final_score DESC NULLS LAST — VERIFIED
worker-pkg:     missing 3 files — VERIFIED
```
