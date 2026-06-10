# GANYIQ Clip Rendering Engine — Architecture V2

**Status:** Design Document | **Date:** 2026-06-10 | **Version:** 2.0

---

## 1. System Overview

GANYIQ V2 clip rendering transforms a raw video segment into a polished, professional-grade short-form clip suitable for TikTok, Instagram Reels, and YouTube Shorts.

The V2 pipeline replaces the V1 architecture (Haar Cascade + greedy tracking + no subtitles) with a modern computer vision stack: YOLOv8-face detection, ByteTrack with Kalman filter, Audio-Visual Active Speaker Detection, Whisper transcriptions, and ASS karaoke-style subtitles.

### Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        WORKER (PC-GANY)                                  │
│                                                                          │
│  ┌──────────────────┐     ┌──────────────────┐                          │
│  │  yt-dlp download  │     │  ffprobe analysis │                         │
│  │  (bestvideo[~1080]│────▶│  (source quality  │                         │
│  │   +bestaudio)     │     │   detection)      │                         │
│  └────────┬─────────┘     └──────────────────┘                          │
│           │                                                              │
│           ▼                                                              │
│  ┌──────────────────────────────────────────────────────────┐           │
│  │                ANALYSIS PIPELINE                          │           │
│  │                                                          │           │
│  │  ┌─────────────────┐   ┌───────────────────┐             │           │
│  │  │ face-detect-v2.py│   │   diarize.py      │             │           │
│  │  │ (YOLOv8-face     │   │  (PyAnnote        │             │           │
│  │  │  + ONNX)         │   │   diarization)    │             │           │
│  │  └────────┬─────────┘   └─────────┬─────────┘             │           │
│  │           │                       │                        │           │
│  │           ▼                       ▼                        │           │
│  │  ┌──────────────────────────────────────────────┐          │           │
│  │  │         tracker.py (ByteTrack + Kalman)       │          │           │
│  │  │         + speaker-detector.ts (AV-ASD fusion) │          │           │
│  │  └──────────────────────┬───────────────────────┘          │           │
│  │                         │                                   │           │
│  │                         ▼                                   │           │
│  │  ┌──────────────────────────────────────────────┐          │           │
│  │  │   Rendering Decision Engine (face-tracker.ts) │          │           │
│  │  │   → Multi-crop segments with active speaker  │          │           │
│  │  │   → Reaction shots, split-screen decisions    │          │           │
│  │  │   → Smooth transitions (EMA filtering)        │          │           │
│  │  └──────────────────────┬───────────────────────┘          │           │
│  │                         │                                   │           │
│  │  ┌──────────────────────▼───────────────────────┐          │           │
│  │  │   transcribe.py (Whisper word-level STT)     │          │           │
│  │  └──────────────────────┬───────────────────────┘          │           │
│  │                         │                                   │           │
│  │  ┌──────────────────────▼───────────────────────┐          │           │
│  │  │   subtitle-renderer.ts (ASS generation +     │          │           │
│  │  │    karaoke effects + speaker coloring)       │          │           │
│  │  └──────────────────────┬───────────────────────┘          │           │
│  └─────────────────────────┼──────────────────────────────────┘           │
│                            │                                            │
│                            ▼                                            │
│  ┌──────────────────────────────────────────────────────────┐           │
│  │              FFmpeg RENDER PIPELINE                       │           │
│  │                                                          │           │
│  │  trim │→│ crop/scale (with EMA smooth) │→│ sharpen       │           │
│  │  │→│ ASS subtitle overlay │→│ NVENC encode (cq20) │→│ output │     │
│  └──────────────────────────────────────────────────────────┘           │
│                            │                                            │
│                            ▼                                            │
│                    Upload to VPS via API                                 │
└─────────────────────────────────────────────────────────────────────────┘
```

## 2. Component Specifications

### 2.1 P0.5 — Source Quality Upgrade

**File change:** `worker/clip-renderer.ts` — yt-dlp format string

| Before | After |
|--------|-------|
| `-f "best[height<=720]"` | `-f "bestvideo[height<=1080]+bestaudio/best[height<=1080]"` |

This downloads up to 1080p source video when available. Typical 1080p YouTube video gives ~2.25× more pixels than 720p.

### 2.2 P0.1 — YOLOv8-face Face Detector

**Files:** `worker/face-detect-v2.py`

**Model:** YOLOv8n-face (Nano variant, ~10MB ONNX)
- GitHub: https://github.com/derronqi/yolov8-face
- mAP: ~90% on WIDER Face (vs. Haar Cascade ~55%)
- CPU inference: ~15-30ms per frame
- Output: bounding boxes + 5 landmarks (left eye, right eye, nose, left mouth, right mouth) + confidence score

**Integration:**
```
face-detect.py (Haar Cascade) ← OLD, kept as fallback
face-detect-v2.py (YOLOv8 ONNX) ← NEW, primary
```

Both return the same JSON schema for backward compatibility.

### 2.3 P0.4 — ByteTrack + Kalman Filter Tracker

**Files:** `worker/tracker.py`, `worker/tracker.ts`

**TrackPy (Python):**
- ByteTrack algorithm: two-stage matching (high conf → low conf via IoU)
- Kalman filter: predicts face position between detections
- Appearance Re-ID: 128-dim embedding via lightweight feature extractor
- Output: tracked faces with persistent IDs

**TrackerSync (TypeScript):**
- Receives tracked frames from Python
- Fallback if Python unavailable: improved greedy matching with EMA
- Wraps the Python tracker output

### 2.4 P0.2 — Audio-Visual Active Speaker Detection

**Files:** `worker/diarize.py`, `worker/speaker-detector.ts`

**Diarization (Python):**
- PyAnnote speaker-diarization-3.1 for audio-only diarization
- Or Deepgram utterance-based diarization (already have API key)
- Output: `[{speaker, start, end}]`

**AV-ASD Fusion (TypeScript):**
- Aligns audio diarization with visual face tracking
- Computes per-speaker lip motion energy from face landmarks
- Detects: active speaker, listeners, reactions (laughter/gasp via audio energy)
- Per-frame output: `{ faceId, isActiveSpeaker, lipMotionEnergy, audioEvent }`

### 2.5 P0.3 — Subtitle System (Whisper + ASS Karaoke)

**Files:** `worker/transcribe.py`, `worker/subtitle-renderer.ts`

**Transcription (Python):**
- Whisper `small` model for word-level timestamps
- Falls back to Deepgram segments if Whisper unavailable
- Output: word-level timestamps with confidence

**ASS Generation (TypeScript):**
- Generates Advanced SubStation Alpha (.ass) subtitle file
- Features:
  - Karaoke word highlighting (`\K` tags)
  - Speaker-aware coloring (distinct colors per speaker)
  - Smart positioning (avoids face region)
  - 2-line maximum, 40 chars per line
  - Bottom 12% of frame, centered
  - Geist Sans Bold font (28px), 2px black outline, 8% background opacity
- Output: `.ass` file consumed by ffmpeg `ass` filter

### 2.6 FFmpeg Render Pipeline

**Render command structure:**

```bash
ffmpeg -y
  -i "source.mp4"
  -filter_complex "
    [0:v]trim=start=T1:end=T2,setpts=PTS-STARTPTS[trimmed];
    [trimmed]split=N[seg0]...[segN];
    # Each segment: crop → lanczos scale → unsharp → subtitle
    [seg0]crop=...:...,scale=1080:1920:flags=lanczos,
          unsharp=5:5:0.8:3:3:0.4[out0];
    # Multi-face: split → crop each → vstack/hstack
    [seg1]split=2[c0][c1];
    [c0]crop=...:...[f0];
    [c1]crop=...:...[f1];
    [f0][f1]vstack=inputs=2[s1];
    # Concat
    [out0][s1]...[outN]concat=n=N:v=1:a=1[vid];
    [vid]ass=subtitles.ass[finalv]
  "
  -map "[finalv]" -map "0:a"
  -c:v h264_nvenc -preset p7 -cq 22
  -c:a aac -b:a 128k
  "output.mp4"
```

## 3. Dependency Installation

The worker machine (PC-GANY) needs:

### Python packages:
```bash
pip install opencv-python-headless onnxruntime pyannote.audio torch torchaudio whisper
```

### Model files:
- `yolov8n-face.onnx` — downloaded automatically by `face-detect-v2.py`
- Whisper model — downloaded automatically on first use

### Windows setup:
```powershell
# setup.ps1
pip install opencv-python onnxruntime pyannote.audio torch torchaudio whisper
```

## 4. Fallback Chain

Each component has a fallback to ensure clip rendering never fails:

| Component | Primary | Fallback 1 | Fallback 2 |
|-----------|---------|------------|------------|
| Face Detection | YOLOv8-face (ONNX) | Haar Cascade (existing) | No face → center crop |
| Identity Tracking | ByteTrack (Python) | Greedy matching (TS) | No tracking → center |
| Speaker Detection | AV-ASD Fusion | Audio-only diarization | All faces equal |
| Transcription | Whisper word-level | Deepgram segments | No subtitles |
| Encoding | NVENC (GPU) | libx264 (CPU) | — |
| Upscaling | Lanczos + unsharp | Bilinear | — |

## 5. File Map

### New files:
| File | Purpose |
|------|---------|
| `worker/face-detect-v2.py` | YOLOv8-face ONNX detector |
| `worker/tracker.py` | ByteTrack + Kalman filter (Python) |
| `worker/tracker.ts` | Tracker integration & fallback (TS) |
| `worker/diarize.py` | PyAnnote speaker diarization |
| `worker/speaker-detector.ts` | AV-ASD fusion logic |
| `worker/transcribe.py` | Whisper word-level transcription |
| `worker/subtitle-renderer.ts` | ASS subtitle generation |
| `worker/setup.sh` | Linux setup script |
| `worker/setup.ps1` | Windows setup script |

### Modified files:
| File | Changes |
|------|---------|
| `worker/face-tracker.ts` | Integrate new tracker, export TrackResult with speakers |
| `worker/clip-renderer.ts` | 1080p source, subtitle integration, sharpening |
| `worker/index.ts` | Pass env to render functions |
| `worker-package/*` | Mirror all worker changes |

## 6. Quality Targets

| Metric | V1 (Current) | V2 Target |
|--------|-------------|-----------|
| Face detection accuracy (WIDER Face) | ~55% mAP | >90% mAP |
| Face detection rate (profile faces) | ~40% | >85% |
| Identity swap rate | ~15% of clips | <2% of clips |
| Multi-speaker detection | None | Full (AV-ASD) |
| Subtitle rendering | None | Karaoke + speaker-color |
| Source quality | 720p max | 1080p available |
| Output sharpness | Soft (2.67× upscale) | Sharp (lanczos + unsharp) |
| Transition smoothness | Hard cuts | EMA smoothed + crossfade |
| Reaction detection | None | Laughter, gasp, emotion |
