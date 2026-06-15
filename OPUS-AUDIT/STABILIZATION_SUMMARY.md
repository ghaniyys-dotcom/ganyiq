# GANYIQ Stabilization Summary

**From:** 5.7/10  
**Target:** 8.5/10  
**Approach:** Stabilize, NOT rewrite

---

## Current State (24-sheet dashboard in opus_audit_master.xlsx)

| Metric | Value |
|--------|-------|
| Total code | 11,812 lines (13 TS + 7 Python) |
| execSync calls | 39 across 6 files |
| CRITICAL blocking calls | 5 (ffmpeg render 5min, yt-dlp 5min, ffmpeg tracked 2min, ffmpeg landscape 2min, concat 2min) |
| Hardcoded fps | 12 locations |
| Silent failure points | 30+ |
| Test coverage | 0% |
| Duplicated execAsync | 3 copies |
| Decision engine paths | 2 (dual path) |
| Known P0 bugs remaining | 4 |

---

## If You Only Have 2 Weeks

Highest ROI in 14 days:

### Week 1: CRITICAL — execSync Migration + Subtitle Fix
| Day | Task | Impact | Files |
|-----|------|--------|-------|
| 1-2 | Convert ffmpeg renderVerticalSplit execSync → execAsync | **UNBLOCKS HEARTBEAT** — worker won't disconnect during 5min renders | clip-renderer.ts |
| 3-4 | Convert yt-dlp, ffprobe, ffmpegTracked, concat all to execAsync | **ALL renders async** | clip-renderer.ts, index.ts |
| 5 | Fix subtitle double-filter bug | **Subtitles always appear** | subtitle-renderer.ts |
| 6 | Add logging to all 30+ silent failure points | **Failures visible in logs** | face-tracker.ts, speaker-detector.ts, tracker.ts |
| 7 | Testing + deploy | **First stable candidate** | - |

**Week 1 Result:** Heartbeat works, subtitles always visible, all failures logged. Stability jumps from 5.7 to ~7.0.

### Week 2: HIGH — Segment-by-Segment Rendering
| Day | Task | Impact | Files |
|-----|------|--------|-------|
| 8-9 | Build segment-by-segment render function | **No more OOM**. Each segment max 200MB | clip-renderer.ts (new function) |
| 10-11 | Replace renderVerticalSplit with new function | **Giant filter graph eliminated** | clip-renderer.ts |
| 12 | Wire up with existing segment data | **Seamless upgrade** | clip-renderer.ts |
| 13 | Test with previously-freezing clips | **Verify fix** | - |
| 14 | Buffer + deploy | **Version 2.0 candidate** | - |

**Week 2 Result:** No OOM, no giant filter graph, no freezes. Stability ~7.5/10.

---

## If You Have 1 Month

### Week 3-4: STRUCTURAL IMPROVEMENTS
| Task | Impact | Effort |
|------|--------|--------|
| Drop legacy buildSplitSegments(), consolidate DecisionEngine | Single decision path, consistent output | ~150 lines |
| Extract shared execAsync + resolvePython to exec-utils.ts | Remove duplication, consistent error handling | ~30 lines |
| Replace hardcoded fps=30000/1001 with sourceFps | 20-60% less ffmpeg work | ~30 lines |
| Add timeline alignment validation before ffmpeg | Catch errors before expensive render | ~30 lines |
| Remove visual-reaction-detector.py dead code | -739 lines, -300MB potential | ~50 lines |

**1 Month Result:** Clean architecture, single decision path, optimized rendering. Stability ~8.0/10.

---

## If You Have 2 Months

### Month 2: TEST + POLISH
| Task | Impact | Effort |
|------|--------|--------|
| Set up vitest + write 20 core tests | Regressions stop reaching production | ~100 lines test, ~200 lines infra |
| Set up pytest + write 10 Python tests | Python pipeline verified | ~100 lines |
| Add linter (biome or eslint) | Code quality enforced | ~30 lines config |
| CI/CD pipeline (GitHub Actions) | Automated test on push | ~50 lines YAML |
| Performance benchmark suite | Know when things regress | ~100 lines |

**2 Month Result:** Tested, linted, CI/CD pipeline. Stability 8.5/10 ✅

---

## Timeline Visualization

```
Week 1     |████████████|  execSync async + subtitle fix
           |            |  → 7.0/10
Week 2     |████████████|  Segment-by-segment render
           |            |  → 7.5/10
Week 3-4   |████████████|  Consolidation + optimizations
           |            |  → 8.0/10
Month 2    |████████████|  Tests + CI/CD + polish
           |            |  → 8.5/10 ✅
```

## Top 10 Fixes by ROI

| Rank | Fix | ROI | Time |
|------|-----|-----|------|
| 1 | Segment-by-segment rendering | 9/10 | Week 2 |
| 2 | execSync → execAsync | 8/10 | Week 1 |
| 3 | Drop legacy decision path | 7/10 | Week 3 |
| 4 | Add tests | 7/10 | Month 2 |
| 5 | Fix silent failures | 7/10 | Week 1 |
| 6 | Shared execAsync module | 6/10 | Week 3 |
| 7 | Replace hardcoded fps | 6/10 | Week 3 |
| 8 | Subtitle double-filter fix | 7/10 | Week 1 |
| 9 | Timeline validation | 6/10 | Week 3 |
| 10 | Remove dead visual-reaction | 5/10 | Week 4 |

**Key insight:** The first 2 fixes (segment rendering + async migration) deliver ~60% of total stability improvement. Everything after is incremental.

---

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| execAsync introduces race conditions | Medium | High | Add job lock/mutex per render |
| Segment-by-segment concat has different quality | Low | Medium | Side-by-side comparison test |
| DecisionEngine consolidation breaks existing clips | Low | High | Keep old code path as fallback during transition |
| Tests flaky on Windows | Medium | Low | Isolate platform-specific tests |
| yt-dlp changes API (frequent) | High | Medium | Add yt-dlp version pinning |
