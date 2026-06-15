# GANYIQ STABILIZATION SPRINT — FINAL VERIFICATION

**Date:** 2026-06-22  
**Branch:** `main`  
**Commit:** `1029907` — fix: concat dimension mismatch  
**Methodology:** Fresh audit — every claim verified against actual code on disk, no assumptions

---

## VERIFICATION RESULTS (TOP 10 FIXES)

### Fix #1 — execSync blocking render path
**STATUS: 🔴 STILL UNRESOLVED (P0)**

| File | Line | Statement | Duration |
|------|------|-----------|----------|
| `clip-renderer.ts` | 15 | `import { execSync }` | N/A |
| `clip-renderer.ts` | 438 | `execSync(ffmpegCmd, ...timeout: 120_000)` | 2 min |
| `clip-renderer.ts` | 633 | `execSync(cmd, ...timeout: 120_000)` | 2 min each segment |
| `clip-renderer.ts` | 663 | `execSync(concatCmd, ...timeout: 120_000)` | 2 min |
| `clip-renderer.ts` | 1348 | `execSync(cmd, ...timeout: 300_000)` | **5 min** |
| `index.ts` | 254 | `execSync(mkdir ...)` | low |
| `index.ts` | 262 | `execSync(yt-dlp ...)` | 5 min |
| `face-tracker.ts` | 248,252,262 | `execSync(python --version)` | 5s each |
| `memory-profiler.ts` | 45,59,82,100,111 | `execSync(wmic/free/ps)` | 5-8s each |

**Root cause:** `execSync` blocks the entire Node.js event loop. The main render path (`clip-renderer.ts`) has **zero** async execution — it's 100% synchronous. Every ffmpeg call blocks the process.

**Worst offender:** Line 1348 — `execSync(cmd, { ...EXEC_OPTS, timeout: 300_000 })` — the giant filter graph render. This is a **5-minute blocking call** that freezes Node completely.

**Evidence:** The `renderVerticalSplit()` function builds a filter graph, writes it to disk (filter script), then runs execSync. The entire time, no heartbeat, no polling, no event processing.

---

### Fix #2 — Giant FFmpeg filter graph
**STATUS: 🟡 PARTIALLY RESOLVED (simplified mode exists, but architecture unchanged)**

**Current state:**
- `renderVerticalSplit()` at line 858-1375 builds filter graph dynamically
- `filterParts[]` array can hold 20-50+ filter nodes
- Support for: xfade, zoompan, overlay, PiP, hero_reaction (60/40), split_4 (2x2 grid), vstack, pad, unsharp, ass subtitles
- Lines 894-898: simplified mode strips xfade, zoompan, slide-in overlays when `LAYOUT_TRANSITIONS=0`
- Line 1331: On Windows, uses `filter_complex_script` because cmd.exe has 8191 char limit

**Simplified mode reduces:** xfade nodes, zoompan expressions, PiP overlays  
**Simplified mode does NOT fix:** Single-pass architecture, memory pressure, blocking execSync

**Node count estimation (10 segments):**
- Simplified, single-face: ~10 trim + 10 crop+scale + 10 concat = ~30 nodes
- Full mode, with PiP/hero_reaction/xfade: ~50-80 nodes depending on layouts

**Blocking duration on LAPTOP-GANY (i3, 8GB):** Estimated 60-300 seconds for a 5-min clip with 10 segments in full mode.

---

### Fix #3 — Decision engine dual path
**STATUS: ✅ ALREADY RESOLVED**

- Single `DecisionEngine` class at line 512
- Single `process()` method at line 544
- No legacy/deprecated paths found
- `EmaCameraSmoother`, `ReactionScheduler`, `SpeakerActivityTracker`, `PeakMomentDetector`, `CutSuppressionTracker` all consolidated

**Verified:** Phase A commit `0f7af23` already cleaned this up.

---

### Fix #4 — Silent failure handling
**STATUS: ✅ MOSTLY RESOLVED (acceptable)**

**Intentional silent failures (non-critical):**
- `index.ts:435` — `.catch(() => {})` for fail-report (non-critical)
- `clip-renderer.ts:200,561,673` — cleanup file deletion (acceptable)
- `index.ts:372` — cleanup after yt-dlp failure (acceptable)

**Proper error handling (critical paths):**
- `index.ts:420-436` — renderClip error caught, reported to API
- `clip-renderer.ts:1347-1365` — ffmpeg stderr saved, last 100 lines logged
- `index.ts:580-584` — main loop catches all exceptions

---

### Fix #5 — Hardcoded FPS
**STATUS: ⚪ INTENTIONAL (not a bug)**

`fps=30000/1001` appears **12 times** across `clip-renderer.ts`. This is NTSC standard 29.97fps. It's a deliberate choice for YouTube Shorts/TikTok compatibility.

**Not a fix target** during stabilization — changing FPS would introduce new bugs.

---

### Fix #6 — Subprocess chain weight
**STATUS: 🟡 STILL ACTIVE (but by design)**

Current chain for each job:
1. `execSync(yt-dlp ...)` — audio download (index.ts:262) → blocks 30-300s
2. `readFileSync` + HTTP POST — Deepgram transcript (async) 
3. `execAsync(python face-detect-v2.py ...)` — face detection (async! 10 min timeout)
4. `execAsync(python tracker.py ...)` — tracking (async!)
5. `execAsync` — speaker detection (async!)
6. `execSync(ffmpeg ...)` — RENDER (blocking, 120-300s)

Steps 3-5 are properly async (use `execAsync`). The bottleneck is steps 1 and 6 which use `execSync`.

**Key insight:** Only the ffmpeg render and yt-dlp steps block. The Python pipeline (face detect, tracking, diarization) already uses async properly.

---

### Fix #7 — Headless mode crash mask
**STATUS: ⚪ LOW PRIORITY**

- Windows worker that GANYIQ uses doesn't need headless mode
- Python scripts don't require display (OpenCV reads from file, not webcam)
- NVENC detection uses `execSync` with grep — could fail but catch blocks handle it

---

### Fix #8 — Face tracking identity fragmentation
**STATUS: 🟡 PARTIALLY RESOLVED (minor config bug exists)**

**Good:**
- ByteTrack with Kalman filter implemented (tracker.py)
- `max_lost=20` — keeps identity for ~20 frames (~0.67s at 30fps) after lost
- `conf_threshold=0.15` — low threshold accepts borderline detections
- `IDENTITY_TIMEOUT_FRAMES=10` in face-tracker.ts — forgets ID after 10s absence
- `DOMINANT_SWITCH_RATIO=1.2` — requires 20% dominance to switch camera
- `MIN_HOLD_FRAMES=1` — hold timer for camera stability

**Config mismatch (found during audit):**
- `tracker.py:110` — ByteTrack constructor: `max_lost: int = 20`
- `tracker.py:273` — CLI arg: `--max-lost` **default=25**
- So when run standalone via CLI, max_lost=25, but when imported as module, max_lost=20. This is inconsistent but low impact.

---

### Fix #9 — Worker heartbeat masking
**STATUS: 🔴 STILL UNRESOLVED (P0 CRITICAL)**

**Current code:**
```typescript
// index.ts:576
setInterval(() => sendHeartbeat(env), 60_000);

// index.ts:579-587
while (true) {
    await pollAndProcessJob(env);  // this calls renderClip → execSync
    await sleep(env.POLL_INTERVAL_MS);
}
```

**The problem:**
1. `setInterval` fires every 60s — but ONLY when event loop is free
2. `renderClip()` → `renderVerticalSplit()` → `execSync(cmd, ...timeout: 300_000)` blocks Node.js for up to **5 minutes**
3. During those 5 minutes, `setInterval` **CANNOT FIRE** — it's queued in the blocked event loop
4. Backend marks worker as OFFLINE after ~5-15 minutes of missed heartbeats

**HeartbeatFn parameter:** The `heartbeatFn` callback IS passed to `renderClip` (line 419), and IS called before the giant filter graph (line 437), and every 10 segments in the track render loop (line 632). BUT — the heartbeats happen **BEFORE** the blocking call, not during.

**Proof:** Line 437: `if (heartbeatFn) await heartbeatFn();` followed immediately by line 438: `execSync(ffmpegCmd, ...)`. The heartbeat runs, then 5 minutes of silence.

---

### Fix #10 — OOM during render
**STATUS: 🟡 PARTIALLY RESOLVED**

**Already fixed:**
- ASS subtitle rendering moved to POST-xfade (line 1313-1318) — now 1 ass instance instead of N per segment
- This was the OOM root cause (per-segment ass filter created frame buffers that accumulated)

**Still vulnerable:**
- No `-max_muxing_queue_size` limit set in ffmpeg commands
- Giant filter graph with 50+ nodes still puts pressure on ffmpeg's internal buffer management
- 5-minute render at 1080x1920 with complex filters can consume 2-4GB RAM
- No `-threads` limit — ffmpeg will spawn threads aggressively

---

## ADDITIONAL FINDINGS (not in original TOP 10)

### Config mismatch: ByteTrack defaults
- `tracker.py:110`: constructor `max_lost=20` 
- `tracker.py:273`: CLI arg `--max-lost default=25`
- Who wins? When run as module, the CLI default doesn't apply. When run standalone, CLI wins. This is inconsistent.

### Dead code inventory

| File | Lines | Status | Notes |
|------|-------|--------|-------|
| `visual-reaction-detector.py` | ~700 | 🟢 SAFE TO DISABLE | Feature OFF by default |
| `reaction-detector.py` | ~600 | 🟢 SAFE TO DISABLE | Feature OFF by default |
| `face-detect.py` (V1) | ~150 | 🟡 KEEP AS FALLBACK | Still referenced line 197 |
| `emphasis-engine.ts` | 432 | ✅ ACTIVELY USED | Imported by subtitle-renderer |
| `setup.ps1` | varies | 🟢 SAFE TO REMOVE | One-time install script |
| `legacy/` directory | ~30 files | 🟢 SAFE TO ARCHIVE | Audit docs, not runtime |
| `participant-registry.ts` | ~150 | ✅ ACTIVELY USED | Imported by speaker-detector |
| `memory-profiler.ts` | ~120 | 🟢 SAFE TO DISABLE | Debugging utility, log noise |

### Silent perf issue: `readFileSync` for upload
- `clip-renderer.ts:492`: `readFileSync(outputPath)` reads the entire output MP4 into RAM before uploading
- For a 50MB clip, this adds 50MB to Node's heap
- Could use streaming upload instead

---

## SUMMARY: TRULY UNRESOLVED FIXES

| Rank | Fix | Status | Impact | Effort |
|------|-----|--------|--------|--------|
| 1 | `execSync` blocking render path | 🔴 UNRESOLVED | PC FREEZE | Medium |
| 2 | Heartbeat masked by execSync | 🔴 UNRESOLVED | WORKER OFFLINE | Small |
| 3 | Giant filter graph (single-pass) | 🟡 Partial | OOM, SLOW | Large |
| 4 | OOM no memory limits | 🟡 Partial | RANDOM CRASH | Small |
| 5 | Subprocess chain weight | 🟡 Partial | HIGH CPU | Medium |
| 6 | Face tracking config mismatch | 🟡 Minor | WRONG IDS | Trivial |
| 7 | readFileSync entire output | 🟡 Minor | HIGH RAM | Small |

**Already resolved by Phase A:**
- Decision engine dual path ✅
- Silent failure handling ✅
- Main face tracking identity ✅
- Feature flags sane defaults ✅

**True P0 (still blocking):** execSync + giant filter graph + heartbeat masking = **PC freezes + worker goes offline**

Let me know if you want me to proceed with the actual fix implementation. The verified priority order is:
1. 🔥 execSync → execAsync in render path (fixes heartbeat + freeze)
2. 🔥 Segment-by-segment rendering (fixes OOM + filter graph)
3. 🔥 Memory limits + streaming upload (fixes RAM spikes)
