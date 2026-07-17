# Worker Gap Report — Runtime Audit

**Date:** 2026-06-20
**Method:** File-by-file comparison, content diff, runtime path tracing

---

## 1. Directory Comparison

| Metric | worker/ (VPS) | worker-package/ (PC-GANY) |
|--------|---------------|--------------------------|
| Total files | 26 | 22 |
| Identical files | — | 20 (all same-named files are md5-identical) |
| Missing files | — | **5 files absent** |

## 2. Missing Files in worker-package/

| File | Size | Purpose | Critical? |
|------|------|---------|-----------|
| **scene-detector.ts** | 9,506 B | FFmpeg-based scene boundary detection | ✅ Required for scene-aware clipping |
| **viral-moment-detector.ts** | 8,185 B | Transcript-based viral score computation | ✅ Required for viral_score |
| **broll-engine.ts** | 7,921 B | B-roll footage insertion | 🔶 Low priority (b-roll not integrated) |
| **visual-quality-scorer.py** | 6,260 B | OpenCV-based blur/brightness/face scoring | ✅ Required for visual_quality_score |
| **fasterwhisper-transcribe.py** | 5,077 B | Local CPU transcription fallback | 🔶 Low priority (Deepgram is primary) |

## 3. Runtime Path Trace

```
VPS API (app/api/clips/route.ts)
  │
  │  clip_params includes:
  │    final_score, viral_score,
  │    information_gain, attention_capture, harm
  │
  ▼
jobs_queue (PostgreSQL)
  │
  │  clip_params preserved as JSONB
  │
  ▼
worker polls: GET /api/workers/jobs/poll
  │
  │  clip_params returned in response (line 93)
  │
  ▼
worker/index.ts → renderClip()
  │
  │  clip-renderer.ts IGNORES:
  │    final_score       ❌ (0 references)
  │    viral_score       ❌ (0 references)
  │    information_gain  ❌
  │    attention_capture ❌
  │    harm              ❌
  │
  │  clip-renderer.ts ONLY uses:
  │    videoId       ✅ (to download video)
  │    startTime     ✅ (ffmpeg -ss)
  │    endTime       ✅ (ffmpeg -to)
  │    renderMode    ✅ (landscape/vertical)
  │    subtitleStyle ✅
  │
  ▼
Rendered MP4 → uploaded back to VPS
```

## 4. Score Usage Audit

| Score | Sent by VPS? | Received by worker? | Used by render? |
|-------|-------------|--------------------|-----------------|
| `final_score` | ✅ (clip_params) | ✅ (in poll response) | ❌ Never read |
| `viral_score` | ✅ (clip_params) | ✅ (in poll response) | ❌ Never read |
| `information_gain` | ✅ (clip_params) | ✅ (in poll response) | ❌ Never read |
| `attention_capture` | ✅ (clip_params) | ✅ (in poll response) | ❌ Never read |
| `harm` | ✅ (clip_params) | ✅ (in poll response) | ❌ Never read |
| `worthClippingScore` | ❌ Never sent | ❌ Never received | ✅ (internal only) |

## 5. Package.json Identity

```
worker/package.json   ✅ md5 identical
worker-package/package.json   ✅ md5 identical
```

Both contain:
```json
{
  "name": "ganyiq-worker",
  "scripts": {
    "start": "npx tsx index.ts"
  },
  "dependencies": {
    "tsx": "^4.19.0",
    "typescript": "^5.5.0"
  }
}
```

**No new dependencies required** for the missing files (they use only Node built-ins and Python stdlib).

## 6. Environment Variables

| Variable | Currently in worker-package/.env.local? | Required for? |
|----------|----------------------------------------|---------------|
| `DEEPGRAM_API_KEY` | ✅ (required) | Transcription |
| `GANYIQ_API_URL` | ✅ (required) | API communication |
| `WORKER_NAME` | ✅ (required) | Worker identity |
| `POLL_INTERVAL_MS` | ✅ (optional) | Polling frequency |
| `FFMPEG_LOCATION` | ✅ (optional) | ffmpeg path |
| `HF_TOKEN` | ✅ (optional) | PyAnnote diarization |
| `VIBEVOICE_API_URL` | ❌ NOT in .env | VibeVoice vLLM server (new file) |
| `FASTER_WHISPER_MODEL` | ❌ NOT in .env | FasterWhisper model size |

**New env vars needed:** 2 (VIBEVOICE_API_URL, FASTER_WHISPER_MODEL) — for the new provider chain.

---

## 7. Deliverables

### A. Files that MUST be copied into worker-package/

| Priority | File | Reason |
|----------|------|--------|
| P0 | **scene-detector.ts** | Scene-aware clipping depends on this |
| P0 | **viral-moment-detector.ts** | viral_score computation on worker |
| P1 | **visual-quality-scorer.py** | Visual quality scoring (OpenCV) |
| P2 | **broll-engine.ts** | B-roll insertion (not yet integrated) |
| P2 | **fasterwhisper-transcribe.py** | Local transcription fallback |

### B. Files that MUST NOT be copied

| File | Reason |
|------|--------|
| `vibevoice-provider.ts` (lib/) | Server-side only — VibeVoice runs as separate Docker vLLM server |
| `fasterwhisper-provider.ts` (lib/) | Server-side TypeScript wrapper — worker calls Python directly |
| `fallback-chain.ts` (lib/) | Server-side orchestration only |
| `provider-router.ts` (lib/) | Server-side routing only |
| `deepgram-vibevoice-fusion.ts` (lib/) | Server-side fusion only |
| `speaker-face-mapper.ts` (lib/) | Server-side mapping only |
| Any `lib/` files | Worker has its own independent TypeScript project |

### C. Required package.json changes

**None.** All new worker files use only Node.js built-ins or Python stdlib.

| File | Dependencies |
|------|-------------|
| `scene-detector.ts` | `child_process`, `fs`, `path` (built-in) |
| `viral-moment-detector.ts` | None (pure TypeScript) |
| `broll-engine.ts` | `child_process`, `fs`, `path` (built-in) |
| `visual-quality-scorer.py` | `opencv-python`, `numpy` (Python packages) |
| `fasterwhisper-transcribe.py` | `faster-whisper` (Python package) |

**Python dependencies to install on PC-GANY:**
```bash
pip install opencv-python numpy faster-whisper
```

### D. Required .env changes

Add to worker-package/.env.local:
```env
# VibeVoice server (for speaker diarization)
VIBEVOICE_API_URL=http://localhost:8000
VIBEVOICE_API_KEY=

# FasterWhisper (local CPU fallback)
FASTER_WHISPER_MODEL=small
FASTER_WHISPER_DEVICE=cpu
FASTER_WHISPER_COMPUTE=int8
```

### E. Is a new ZIP required?

**YES** — worker-package/ is **5 files behind** worker/. The ZIP (`/tmp/ganyiq-worker.zip`) was created on June 11 and has NOT been updated since.

| Check | Current | Required |
|-------|---------|----------|
| Files in ZIP (from June 11) | 22 | 27 (+5) |
| scene-detector.ts | ❌ Missing | ✅ Include |
| viral-moment-detector.ts | ❌ Missing | ✅ Include |
| visual-quality-scorer.py | ❌ Missing | ✅ Include |
| broll-engine.ts | ❌ Missing | ✅ Include |
| fasterwhisper-transcribe.py | ❌ Missing | ✅ Include |

**Action:** Copy 5 files from worker/ to worker-package/, regenerate ZIP, deploy to PC-GANY.

---

## 8. Critical Finding: Score Black Hole

```
VPS API                          Worker                    Render Output
─────────────────────────────────────────────────────────────────────
clip_params {
  final_score: 42    ─────────▶  clip-renderer.ts      ▶  ffmpeg command
  viral_score: 7                            │                 -ss start
  information_gain: 8                       │                 -to end
  attention_capture: 9                      │                 (no scores)
  harm: 2                                   ▼
}                                     ALL SCORES IGNORED
```

**The worker receives final_score, viral_score, etc. but DOES NOTHING with them.** The render pipeline has no concept of scores — it just cuts the video from startTime to endTime. Scores are used only server-side for ranking and display.

This is **by design** (scores affect WHAT to render, not HOW to render it), but means:
- Worker doesn't need to change for score integration
- The missing files are about NEW WORKER CAPABILITIES (scene detection, viral detection), not about score propagation
- The ZIP update is for these new capabilities, not for fixing score flow

---

## 9. Summary

| Check | Result |
|-------|--------|
| Files missing in worker-package | **5** (scene-detector, viral-moment-detector, broll-engine, visual-quality-scorer, fasterwhisper-transcribe) |
| Files content-drifted | **0** (all 20 shared files are identical) |
| Package.json drift | **0** (identical) |
| Tsconfig drift | **0** (identical) |
| New env vars required | **2** (VIBEVOICE_API_URL, FASTER_WHISPER_MODEL) |
| New Python deps required | **3** (opencv-python, numpy, faster-whisper) |
| Score black hole | **Confirmed**: scores sent but ignored (by design — worker doesn't need them for rendering) |
| ZIP regeneration needed | **YES** |
