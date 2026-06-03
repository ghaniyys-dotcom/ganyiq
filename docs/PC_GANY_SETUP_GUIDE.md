# PC-GANY Setup Guide

## Residential Worker for GANYIQ Transcript Acquisition

---

This guide will turn your Windows PC into a **GANYIQ transcript worker**. Your PC will download YouTube audio, transcribe it with Deepgram, and send results back to the GANYIQ API.

---

## What You Need Before Starting

| Item | Where to Get It |
|------|----------------|
| **Node.js 18+** | https://nodejs.org (download LTS) |
| **yt-dlp** | https://github.com/yt-dlp/yt-dlp/releases (download `.exe`) |
| **ffmpeg** | https://ffmpeg.org/download.html (or use `winget install ffmpeg`) |
| **Deepgram API Key** | https://console.deepgram.com (sign up, get API key) |
| **GANYIQ API URL** | `https://ganyiq.vercel.app` (your Vercel deployment) |

---

## Step 1: Install Node.js

1. Go to https://nodejs.org
2. Download the **LTS** version (left button)
3. Run the installer — click **Next** until it finishes
4. **Restart your PC** after installation

Verify it worked — open **Command Prompt** (Win+R → type `cmd` → Enter):

```
node --version
npm --version
```

You should see version numbers (e.g., `v20.11.0` and `10.2.4`).

---

## Step 2: Install yt-dlp

**Option A — Download EXE (easiest):**

1. Go to https://github.com/yt-dlp/yt-dlp/releases
2. Download `yt-dlp.exe` from the latest release
3. Move it to `C:\yt-dlp\yt-dlp.exe`
4. Add to PATH:
   - Win+R → `sysdm.cpl` → Advanced → Environment Variables
   - Under "System variables", find `Path` → Edit → New
   - Add `C:\yt-dlp`
   - Click OK on all windows

**Option B — Using winget (faster):**

Open **Command Prompt as Administrator** and paste:

```
winget install yt-dlp.yt-dlp
```

Verify:

```
yt-dlp --version
```

---

## Step 3: Install ffmpeg

**Option A — Using winget (recommended):**

Open **Command Prompt as Administrator** and paste:

```
winget install ffmpeg
```

**Option B — Manual:**

1. Download from https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-full.7z
2. Extract to `C:\ffmpeg`
3. Add `C:\ffmpeg\bin` to PATH (same method as Step 2)
4. Restart Command Prompt

Verify:

```
ffmpeg -version
```

---

## Step 4: Create the Worker Folder

Open **Command Prompt** and run:

```cmd
mkdir C:\GANYIQ-Worker
cd C:\GANYIQ-Worker
```

---

## Step 5: Install Dependencies

In the same Command Prompt window:

```cmd
npm init -y
npm install typescript @types/node tsx
```

---

## Step 6: Create the Worker File

Create the file `C:\GANYIQ-Worker\index.ts` with this content:

> **Note:** Copy the full content from the repository file `worker/index.ts`.  
> Ask the AI agent to provide the exact content, or copy it from the GitHub repo after commit.

After creating the file, create `C:\GANYIQ-Worker\.env.local`:

```env
GANYIQ_API_URL=https://ganyiq.vercel.app
DEEPGRAM_API_KEY=YOUR_DEEPGRAM_API_KEY_HERE
WORKER_NAME=PC-GANY
POLL_INTERVAL_MS=30000
```

Replace `YOUR_DEEPGRAM_API_KEY_HERE` with your actual Deepgram key.

---

## Step 7: Run the Worker

```cmd
cd C:\GANYIQ-Worker
npx tsx index.ts
```

You should see:

```
╔══════════════════════════════════════════╗
║        GANYIQ Residential Worker         ║
║           WORKER-v1.1.0                  ║
╚══════════════════════════════════════════╝

[YYYY-MM-DD HH:MM:SS] [CONFIG    ] API URL:        https://ganyiq.vercel.app
[YYYY-MM-DD HH:MM:SS] [CONFIG    ] Worker Name:    PC-GANY
[YYYY-MM-DD HH:MM:SS] [CONFIG    ] Worker ID:      NOT REGISTERED
[YYYY-MM-DD HH:MM:SS] [REGISTER  ] Registering as "PC-GANY"...
[YYYY-MM-DD HH:MM:SS] [REGISTER  ] Registered successfully!
[YYYY-MM-DD HH:MM:SS] [REGISTER  ]   Worker ID:  xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
[YYYY-MM-DD HH:MM:SS] [REGISTER  ]   Saved to:   C:\GANYIQ-Worker\.env.local
[YYYY-MM-DD HH:MM:SS] [MAIN      ] Worker started. Press Ctrl+C to stop.
```

**On first run, the worker registers itself automatically** and saves its credentials to `.env.local`. You only need to run it once.

---

## Step 8: Keep It Running (Optional)

To keep the worker running 24/7, you can use **Task Scheduler**:

1. Win+R → `taskschd.msc` → Enter
2. Click "Create Task"
3. **General tab:** Name = `GANYIQ Worker`, check "Run whether user is logged on or not"
4. **Triggers tab:** New → "Begin the task: At startup"
5. **Actions tab:** New →
   - Action: `Start a program`
   - Program: `C:\Program Files\nodejs\npx.cmd`
   - Arguments: `tsx C:\GANYIQ-Worker\index.ts`
   - Start in: `C:\GANYIQ-Worker`
6. OK → Enter password when prompted

---

## How It Works

```
                          ┌──────────────────┐
                          │  GANYIQ API      │
                          │  (Vercel)        │
                          └────────┬─────────┘
                                   │
                          YouTube transcript
                          request comes in
                                   │
                          ┌────────▼─────────┐
                          │  YouTube API      │
                          │  tries captions   │
                          └────────┬─────────┘
                                   │
                          FAILS for Indonesian
                          videos (IP blocked)
                                   │
                          ┌────────▼─────────┐
                          │  Neon jobs_queue  │
                          │  Job enqueued     │
                          └────────┬─────────┘
                                   │
                    ┌──────────────┴──────────────┐
                    │  PC-GANY polls every 30s    │
                    │  Claims job                 │
                    └──────────────┬──────────────┘
                                   │
                    ┌──────────────▼──────────────┐
                    │  yt-dlp downloads audio     │
                    │  Deepgram transcribes       │
                    │  Result submitted to API    │
                    └──────────────┬──────────────┘
                                   │
                          ┌────────▼─────────┐
                          │  Result cached    │
                          │  in PostgreSQL    │
                          └──────────────────┘
```

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `yt-dlp not found` | Make sure yt-dlp is in PATH. Restart Command Prompt after PATH changes. |
| `ffmpeg not found` | Install ffmpeg. It's required by yt-dlp for audio conversion. |
| `Deepgram API error` | Check your API key is correct in `.env.local` |
| `Registration failed (409)` | Worker name already taken. Delete `.env.local` and use a different WORKER_NAME, or delete the old worker in Neon dashboard. |
| `Poll returns 401` | Worker credentials expired or changed. Delete `.env.local` and re-run to re-register. |
| `ECONNREFUSED` | Your internet is down or the GANYIQ API is unreachable. |
| `yt-dlp download slow` | This is normal for long videos. The 5-minute timeout may need adjusting for videos >30 min. |

---

## What to Expect

- **No jobs initially** → Worker polls every 30s, gets 204 (no jobs)
- **When a video is submitted to /api/analyze** and YouTube captions fail → Job appears in queue
- **Worker claims the job** → Downloads audio (~1-5 min for 30-min video) → Transcribes (~30s-2min) → Submits result
- **Result is cached** → Next time `/api/analyze` is called for the same video, it finds the cached transcript immediately

---

## Files on Your PC

```
C:\GANYIQ-Worker\
├── index.ts          # Worker script (do not modify)
├── package.json      # npm config (do not modify)
├── tsconfig.json     # TypeScript config (do not modify)
├── .env.local        # Your config (created automatically)
└── temp\             # Temp audio files (auto-cleaned)
```

---

*For support, contact the GANYIQ team.*
