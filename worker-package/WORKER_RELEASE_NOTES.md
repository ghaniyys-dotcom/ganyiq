# GANYIQ Worker vNEXT — Release Notes

**Date:** 2026-06-20
**Previous ZIP:** worker-package (June 11, 22 files)
**New ZIP:** worker-package-vNEXT (27 files)

---

## Added Files (5)

| File | Purpose |
|------|---------|
| `scene-detector.ts` | FFmpeg-based scene boundary detection (hard cuts, transitions) |
| `viral-moment-detector.ts` | Transcript-based viral score computation (hook, novelty, emotion) |
| `visual-quality-scorer.py` | OpenCV frame analysis (blur, brightness, exposure, face visibility) |
| `broll-engine.ts` | B-roll candidate generation and overlay infrastructure |
| `fasterwhisper-transcribe.py` | Local CPU transcription fallback (faster-whisper) |

## Dependencies

### TypeScript (no changes — all built-in Node modules)
All new .ts files use only `child_process`, `fs`, `path` — no npm install needed.

### Python (new — requirements.txt)

```bash
pip install -r requirements.txt
```

| Package | Version | Purpose |
|---------|---------|---------|
| `opencv-python` | >=4.8.0 | Video frame analysis (blur, brightness, face detection) |
| `numpy` | >=1.24.0 | Numerical arrays for OpenCV |
| `faster-whisper` | >=1.0.0 | Local CPU transcription (CTranslate2 backend) |

## New Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `VIBEVOICE_API_URL` | `http://localhost:8000` | VibeVoice vLLM server for speaker diarization |
| `FASTER_WHISPER_MODEL` | `small` | FasterWhisper model size (tiny/base/small/medium/large-v3) |
| `FASTER_WHISPER_DEVICE` | `cpu` | Inference device (cpu or cuda) |
| `FASTER_WHISPER_COMPUTE` | `int8` | Compute type (int8/float16/float32) |

## Migration Requirements

| Step | Command |
|------|---------|
| 1. Install Python deps | `pip install -r requirements.txt` |
| 2. Update .env.local | Copy new vars from env-template.txt |
| 3. Regenerate ZIP | Deploy to PC-GANY worker directory |
| 4. Test | `npx tsx index.ts` (should start without errors) |

## Install Commands

```bash
# Navigate to worker directory
cd worker-package

# Install Node dependencies (if first time)
npm install

# Install Python dependencies
pip install -r requirements.txt

# Copy and configure environment
cp env-template.txt .env.local
# Edit .env.local with your keys

# Start the worker
npx tsx index.ts
```

## File Manifest (27 files)

```
broll-engine.ts              (7.9 KB)
clip-renderer.ts             (58.6 KB)
decision-engine.ts           (42.4 KB)
diarize.py                   (23.3 KB)
emphasis-engine.ts           (15.6 KB)
face-detect-v2.py            (11.5 KB)
face-detect.py               (5.4 KB)
face-tracker.ts              (45.0 KB)
fasterwhisper-transcribe.py  (5.1 KB)  ← NEW
features.ts                  (1.9 KB)
index.ts                     (19.7 KB)
memory-profiler.ts           (8.1 KB)
participant-registry.ts      (17.6 KB)
reaction-detector.py         (23.2 KB)
scene-detector.ts            (9.5 KB)  ← NEW
speaker-detector.ts          (47.4 KB)
subtitle-renderer.ts         (23.4 KB)
subtitle-templates.ts        (16.4 KB)
tracker.py                   (13.7 KB)
tracker.ts                   (12.2 KB)
transcribe.py                (13.7 KB)
viral-moment-detector.ts     (8.2 KB)  ← NEW
visual-quality-scorer.py     (6.3 KB)  ← NEW
visual-reaction-detector.py  (27.7 KB)
```

## TypeScript Compilation

```
npx tsc --noEmit   →   0 errors
```

## Verification

- All 5 new files verified: md5 matches worker/ source
- 20 existing files: unchanged (md5 identical to worker/)
- package.json: unchanged
- tsconfig.json: unchanged
