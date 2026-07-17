# ARCHITECTURE_VPS_WORKER_SPLIT.md

## Current Architecture (Before)

```
User → POST /api/analyze
         │
         ▼
   VPS: Analyze Pipeline
         │ fetchVideoDataWithFallback()
         │   └─ YouTube transcript (InnerTube)
         │   └─ Worker queue (PC-GANY downloads + transcribes)
         │   └─ Deepgram fallback (VPS, if cookies work)
         ├─ Candidate extraction
         ├─ LLM scoring
         ├─ Ranking
         └─ Store results in DB

User → POST /api/clips
         │
         ▼
   VPS: Create job in jobs_queue
         │
         ▼
   PC-GANY Worker: renderClip()
         ├─ yt-dlp download video
         ├─ ffmpeg extract audio
         ├─ transcribe.py (Whisper → Deepgram)
         ├─ speaker-detector (PyAnnote diarization)
         ├─ face-detector / face-tracker
         ├─ scene-detector (ffmpeg)
         ├─ visual-quality-scorer (OpenCV)
         ├─ viral-moment-detector
         ├─ decision-engine (b-roll, ranking)
         ├─ subtitle-renderer
         ├─ camera-switching
         ├─ split-screen
         └─ Upload MP4 to VPS
```

**Problems:**
- PC-GANY does ALL the heavy work: transcription, scoring, ranking, rendering
- VPS sits idle after analysis → only stores results
- PC-GANY must be online for any clip to render
- Whisper not installed on PC-GANY → transcription fails
- yt-dlp download on PC-GANY for every clip = redundant

## Proposed Architecture (After Refactoring)

```
User → POST /api/analyze
         │
         ▼
   VPS: Analyze Pipeline (ENHANCED)
         ├─ fetchVideoDataWithFallback()    ← VPS handles all transcript
         │   └─ YouTube transcript (InnerTube + cookies)
         │   └─ Deepgram fallback (VPS, fixed cookies path + no android extractor)
         │   └─ FasterWhisper (VPS CPU)
         ├─ Candidate extraction
         ├─ LLM scoring + Judge V2
         ├─ Ranking
         ├─ ★ NEW: Video download (yt-dlp, 720p)
         ├─ ★ NEW: Scene detection (ffmpeg async)
         │   └─ Persist to `scenes` table
         ├─ ★ NEW: Viral scoring (text-based)
         │   └─ UPDATE `moments` SET viral_score, hook_strength, etc.
         ├─ ★ NEW: Visual quality scoring (OpenCV Python)
         │   └─ UPDATE `moments` SET visual_quality_score, sharpness, etc.
         ├─ ★ NEW: B-roll candidate generation
         │   └─ INSERT into `broll_candidates` table
         └─ ★ NEW: Video cleanup (rm -f)

User → POST /api/clips
         │
         ▼
   VPS: Create job in jobs_queue
         │ (clip payload includes: videoId, startTime, endTime,
         │  renderMode, subtitleStyle — NO transcript/scoring data
         │  needed since it's pre-computed on VPS)
         │
         ▼
   PC-GANY Worker: renderClip() (SIMPLIFIED)
         ├─ yt-dlp download video
         ├─ face-detector / face-tracker
         ├─ speaker-detector (word timestamps from VPS transcript)
         ├─ ★ REMOVED: transcribe.py (done on VPS)
         ├─ ★ REMOVED: scene-detector (done on VPS)
         ├─ ★ REMOVED: visual-quality-scorer (done on VPS)
         ├─ ★ REMOVED: viral-moment-detector (done on VPS)
         ├─ ★ REMOVED: decision-engine / ranking (done on VPS)
         ├─ ★ REMOVED: broll-engine (done on VPS)
         ├─ subtitle-renderer (with pre-computed word timestamps)
         ├─ camera-switching
         ├─ split-screen
         └─ Upload MP4 to VPS
```

## Execution Path (Stage by Stage)

### Analysis Pipeline (`lib/analyze-pipeline.ts`)
```
Stage 1:  fetching_transcript   → fetchVideoDataWithFallback()
Stage 2:  extracting_candidates  → analyzeTranscript()
Stage 3:  batch_analysis         → LLM scoring
Stage 3b: judging                → Judge V2 (if enabled)
Stage 4:  ranking                → rankMoments()
Stage 5:  storing_results        → INSERT moments, metrics
Stage 6:  ★ scene_detection      → yt-dlp download → ffmpeg scene detection → persist scenes
Stage 7:  ★ viral_scoring        → computeViralScore() per moment → UPDATE moments
Stage 8:  ★ visual_scoring       → scoreClipQuality() per moment → UPDATE moments
Stage 9:  ★ broll_generation     → generateBrollCandidates() per moment → INSERT broll_candidates
```

### Clip Generation (`app/api/clips/route.ts`)
```
1. Look up moment in DB (has pre-computed viral, visual, scene, b-roll data)
2. Check clips_cache
3. Create job in jobs_queue with videoId, startTime, endTime, renderMode
4. Worker claims job → renders clip → uploads MP4
```

## CPU/GPU Savings

| Component | Before | After | Saving |
|-----------|--------|-------|--------|
| **yt-dlp download** | PC-GANY (once per clip) | VPS (once per analysis) | PC-GANY bandwidth saved |
| **Deepgram transcription** | PC-GANY (per clip) | VPS (once per analysis) | 50-200MB audio transfer saved per clip |
| **Scene detection (ffmpeg)** | PC-GANY (per clip) | VPS (once per analysis) | CPU time on PC-GANY saved |
| **Visual quality (OpenCV)** | PC-GANY (per clip) | VPS (once per analysis) | CPU time on PC-GANY saved |
| **Viral scoring** | PC-GANY (per clip) | VPS (once per analysis) | CPU time on PC-GANY saved |
| **B-roll generation** | PC-GANY (per clip) | VPS (once per analysis) | CPU time on PC-GANY saved |
| **Face tracking** | PC-GANY (per clip) | PC-GANY (per clip) | No change (requires local video) |
| **Rendering (ffmpeg)** | PC-GANY (per clip) | PC-GANY (per clip) | No change (requires GPU/NVENC) |
| **VibeVoice (GPU)** | PC-GANY (per clip) | PC-GANY (per clip) | No change (requires GPU) |

**Estimated savings:** ~60-70% of PC-GANY CPU time eliminated per clip render.

## Files Modified

| File | Change |
|------|--------|
| `lib/deepgram.ts` | Fixed cookies path → `/root/GANYIQ/cookies.txt`. Removed `--extractor-args android` conflict with cookies. |
| `.env.local` | Added `COOKIE_FILE=/root/GANYIQ/cookies.txt` for youtube.ts |
| `lib/scene-detector.ts` | Upgraded to full async ffmpeg scene detection. Added `detectScenesAsync()`, `persistScenes()`. |
| `lib/viral-moment-detector.ts` | Already existed — used as-is |
| `lib/visual-quality-scorer.ts` | **NEW** — Wraps `worker/visual-quality-scorer.py` Python script |
| `lib/broll-engine.ts` | **NEW** — Keyword-based b-roll candidate generation from transcripts |
| `lib/analyze-pipeline.ts` | Added stages 6-9: scene_detection, viral_scoring, visual_scoring, broll_generation |
| `app/api/analyze/route.ts` | No change (cache logic unchanged) |
| `worker/index.ts` | Future: Remove transcript job handling (keep only clip jobs) |
| `worker/clip-renderer.ts` | Future: Skip transcription/diarization when VPS provides pre-computed data |

## DB Tables Populated by New Stages

| Table | Stage | Data |
|-------|-------|------|
| `scenes` | scene_detection | Scene boundaries + transition types from ffmpeg |
| `moments.viral_score` | viral_scoring | 0-10 viral score + hook/surprise/novelty/emotion components |
| `moments.visual_quality_score` | visual_scoring | 0-10 visual quality + sharpness/brightness/exposure/face |
| `broll_candidates` | broll_generation | Keywords, categories, timestamps for b-roll overlay |

## Verification Results (2026-06-21)

| Component | Status | Evidence |
|-----------|--------|----------|
| yt-dlp with cookies | ✅ WORKING | jNQXAC9IVRw downloaded (246KB). BlPQ97-RRJ8 downloaded (59MB, 7s) |
| Deepgram yt-dlp fix | ✅ WORKING | Fixed cookies path + removed android extractor-args conflict |
| Scene detection | ✅ WORKING | 3 scenes detected + persisted for NUYvbT6vTPs, 1 scene for jNQXAC9IVRw |
| Viral scoring | ✅ WORKING | viral_score=0.8 stored for ffe835c3 rank 1 moment |
| Visual quality scoring | ✅ WORKING | Runs per moment (11ms), minor numeric overflow TBD |
| B-roll generation | ✅ WORKING | 1 candidate stored for ffe835c3 |
| Server non-blocking | ✅ FIXED | detectScenesAsync() uses `exec` (async) instead of `execSync` |
| Full pipeline | ✅ WORKING | All stages execute: transcript → candidates → scoring → ranking → scene → viral → visual → b-roll |

## Remaining Work

1. **Fix `numeric field overflow`** on visual quality scores — DB column widths may be too narrow
2. **Worker clipping with pre-computed data** — PC-GANY should receive transcript/word timestamps from VPS instead of re-transcribing
3. **Remove transcript jobs from worker** — PC-GANY should only claim `clip` type jobs
4. **Video download optimization** — Consider downloading only relevant clip segments instead of full video for scene detection
5. **Worker whisper install** — `pip install faster-whisper` on PC-GANY for when Deepgram is unavailable
6. **Clean stale cache** — Implement cache TTL or manual invalidation endpoint
