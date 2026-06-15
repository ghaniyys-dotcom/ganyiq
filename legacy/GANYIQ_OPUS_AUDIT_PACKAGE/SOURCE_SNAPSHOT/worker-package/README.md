# GANYIQ Worker — LAPTOP-GANY

Standalone worker agent that processes YouTube clip generation jobs from GANYIQ.

## What This Worker Does

1. Polls GANYIQ backend for pending jobs
2. Downloads YouTube videos (via yt-dlp)
3. Transcribes audio (via Deepgram — transcript jobs only)
4. Renders MP4 clips (via ffmpeg — clip jobs only)
5. Uploads final MP4 to the VPS server

## Requirements

| Software | Version | Purpose |
|---|---|---|
| **Node.js** | ≥ 18 | JavaScript runtime |
| **yt-dlp** | ≥ 2026.03.17 | YouTube video/audio download |
| **ffmpeg** | ≥ 6.0 | Video/audio processing |
| **Internet** | stable | Reach https://ganyiq.ganys.me |

## Windows Setup Instructions

### Step 1 — Install Node.js

```
1. Go to https://nodejs.org/
2. Download "LTS" version (22.x or later)
3. Run installer — check "Add to PATH"
4. Open Command Prompt (Win+R → cmd → Enter)
5. Verify: node --version   (should show v18 or higher)
```

### Step 2 — Install yt-dlp

Option A — via winget (easiest):
```
winget install yt-dlp
```

Option B — via pip:
```
pip install yt-dlp
```

Option C — manual:
```
1. Download yt-dlp.exe from https://github.com/yt-dlp/yt-dlp/releases
2. Put it in C:\Windows\System32\ (or any folder in PATH)
```

Verify:
```
yt-dlp --version
```

### Step 3 — Install ffmpeg

Option A — via winget:
```
winget install ffmpeg
```

Option B — manual:
```
1. Download from https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip
2. Extract to C:\ffmpeg\
3. Add C:\ffmpeg\bin to your PATH environment variable
4. Or just set FFMPEG_LOCATION=C:\ffmpeg\bin in .env.local later
```

Verify:
```
ffmpeg -version
```

### Step 4 — Extract Worker Package

```
1. Copy worker-package.zip to your laptop
2. Right-click → Extract All...
3. Rename the folder to ganyiq-worker
4. Open Command Prompt inside the folder:
   cd C:\path\to\ganyiq-worker
```

### Step 5 — Install Dependencies

```
npm install
```

This installs `tsx` (TypeScript runner) and type definitions.

### Step 6 — Configure

```
copy env-template.txt .env.local
```

Open `.env.local` in Notepad. Edit these values:

```
GANYIQ_API_URL=https://ganyiq.ganys.me
WORKER_NAME=LAPTOP-GANY        ← CHANGE THIS (must be unique)
```

You can also set:
- `POLL_INTERVAL_MS=30000` — how often to check for jobs (30s default)
- `DEEPGRAM_API_KEY=your_key_here` — only needed if you want to process transcript jobs
- `FFMPEG_LOCATION=C:\ffmpeg\bin` — only if ffmpeg is not in PATH

### Step 7 — Run

```
npx tsx index.ts
```

### First Run — Auto-Registration

On first run, the worker will automatically:

1. Detect it's not registered
2. POST to `/api/workers/register` with name `LAPTOP-GANY`
3. Receive a unique `WORKER_ID` and `API_KEY`
4. Save both to `.env.local`
5. Start polling for jobs

**Expected output:**

```
╔══════════════════════════════════════════════╗
║        GANYIQ Residential Worker             ║
║           WORKER-v1.1.0                      ║
╚══════════════════════════════════════════════╝

[CONFIG    ] API URL:        https://ganyiq.ganys.me
[CONFIG    ] Worker Name:    LAPTOP-GANY
[CONFIG    ] Poll Interval:  30000ms
[CONFIG    ] Worker ID:      NOT REGISTERED
[REGISTER  ] Registering as "LAPTOP-GANY"...
[REGISTER  ] Registered successfully!
[MAIN      ] Worker started. Press Ctrl+C to stop.
```

## Job Types

### Transcript Jobs
Requires `DEEPGRAM_API_KEY` to be set in `.env.local`. Worker downloads audio via yt-dlp, transcribes via Deepgram, submits result.

### Clip Jobs
No Deepgram key needed. Worker downloads video via yt-dlp, cuts segment via ffmpeg, uploads MP4 to VPS.

## Files in This Package

| File | Size | Purpose |
|---|---|---|
| `index.ts` | 18 KB | Main worker loop + transcript processing |
| `clip-renderer.ts` | 10 KB | Video caching + ffmpeg cutting + MP4 upload |
| `package.json` | 226 B | npm dependencies (tsx, typescript) |
| `tsconfig.json` | 280 B | TypeScript configuration |
| `env-template.txt` | 105 B | Template — copy to .env.local |
| `README.md` | — | This file |

## Troubleshooting

### "Missing or invalid Authorization header"
Worker is trying to upload but hasn't registered yet. Let it finish registration (check .env.local has WORKER_ID and WORKER_API_KEY).

### "yt-dlp not found"
Install yt-dlp or add it to PATH.

### "ffmpeg not found"
Install ffmpeg or set FFMPEG_LOCATION in .env.local.

### "worker_id query parameter is required"
Worker is polling without proper registration. Delete .env.local and restart.

### Multiple workers conflict
Each worker must have a unique `WORKER_NAME`. PC-GANY and LAPTOP-GANY can run simultaneously.

## Support

Backend: https://ganyiq.ganys.me
API:     https://ganyiq.ganys.me/api/health
