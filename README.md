# GANYIQ Worker — Minimal Package

Worker for **GANYIQ** clip discovery engine. Runs on PC-GANY / laptop.

## Two Tasks Only

1. **Transcribe** — Download audio via yt-dlp → Deepgram API → submit to VPS
2. **Render Clip** — ffmpeg GPU encode + face tracking + subtitles → upload MP4

## Setup

```bash
# Install Node dependencies
npm install

# Install Python dependencies
pip install -r requirements.txt

# Configure environment
cp env-template.txt .env.local
# Edit .env.local with your API keys

# Start worker
npm start
# or: npx tsx index.ts
```

## Architecture

```
index.ts  (main loop — poll jobs from VPS)
  └─ transcribe() — yt-dlp → Deepgram API
  └─ renderClip() — ffmpeg → outputs
       └─ face-tracker.ts → face-detect-v2.py + tracker.py
       └─ subtitle-renderer.ts → emphasis-engine.ts
       └─ speaker-detector.ts → diarize.py
       └─ memory-profiler.ts + features.ts
```

## What's NOT included

- `scene-detector.ts` — runs on VPS
- `broll-engine.ts` — runs on VPS
- `viral-moment-detector.ts` — runs on VPS
- `fasterwhisper-transcribe.py` — unused (Deepgram-based)
- `visual-quality-scorer.py` — runs on VPS
