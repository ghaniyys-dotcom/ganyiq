# GANYIQ Architecture Document
## Clip Discovery Engine — Full System Architecture

---

## 1. System Overview

GANYIQ is a **clip discovery engine** that analyzes YouTube videos (primarily Indonesian podcasts) to identify clip-worthy moments using AI, then generates vertical (9:16) short-form videos from those moments. It targets the Opus Clip market: automated, speaker-aware, fast.

**High-Level Architecture:**

```
                    ┌──────────────────────────────────┐
                    │       Telegram / External         │
                    │         (Monitoring Only)          │
                    └─────────┬────────────────────────┘
                              │
                    ┌─────────▼────────────────────────┐
                    │     Vercel / Cloud (optional)     │
                    │  api.ganyiq.vercel.app            │
                    │  (Canary — currently unused)      │
                    └──────────────────────────────────┘
                              │
                    ┌─────────▼────────────────────────┐
                    │     VPS — DigitalOcean SG         │
                    │  ganyiq.ganys.me:443              │
                    │  ┌───────────────────────────┐   │
                    │  │   Nginx (reverse proxy)    │   │
                    │  │   SSL: Let's Encrypt       │   │
                    │  │   client_max_body: 100M    │   │
                    │  └──────────┬────────────────┘   │
                    │             │:3003                │
                    │  ┌──────────▼────────────────┐   │
                    │  │   PM2 — Next.js Server     │   │
                    │  │   /var/www/ganyiq          │   │
                    │  │   Node v20.20.2            │   │
                    │  └──────────┬────────────────┘   │
                    │             │                     │
                    │  ┌──────────▼────────────────┐   │
                    │  │   Next.js App Router      │   │
                    │  │   ┌─────┬─────┬─────┐    │   │
                    │  │   │ API │ UI  │ Lib │    │   │
                    │  │   └─────┴─────┴─────┘    │   │
                    │  └──────────────────────────┘   │
                    └──────────────────────────────────┘
                              │
                    ┌─────────▼────────────────────────┐
                    │     Neon PostgreSQL (SGP)         │
                    │   ┌─────────────────────────┐    │
                    │   │  videos                   │    │
                    │   │  analyses                 │    │
                    │   │  moments                  │    │
                    │   │  events                   │    │
                    │   │  jobs_queue               │    │
                    │   │  workers                  │    │
                    │   │  clips_cache              │    │
                    │   └─────────────────────────┘    │
                    └──────────────────────────────────┘
                              │
                    ┌─────────▼────────────────────────┐
                    │   Residential Workers             │
                    │   ┌─────────┐  ┌─────────┐      │
                    │   │ PC-GANY │  │LAPTOP-  │      │
                    │   │(Windows)│  │GANY     │      │
                    │   └────┬────┘  └─────────┘      │
                    │        │                          │
                    │   ┌────▼────┐                    │
                    │   │ Worker  │                    │
                    │   │ Agent   │                    │
                    │   │ ────────│                    │
                    │   │ yt-dlp  │                    │
                    │   │ Deepgram│                    │
                    │   │ FFmpeg  │                    │
                    │   │ OpenCV  │                    │
                    │   └─────────┘                    │
                    └──────────────────────────────────┘
                              │
                    ┌─────────▼────────────────────────┐
                    │     External APIs                 │
                    │   ┌─────────────────────────┐    │
                    │   │ YouTube InnerTube API    │    │
                    │   │ Deepgram Nova-2 STT     │    │
                    │   │ OpenCode Go (LLM)       │    │
                    │   └─────────────────────────┘    │
                    └──────────────────────────────────┘
```

---

## 2. User Flow

```
User
  │
  │ 1. Visit ganyiq.ganys.me
  ▼
┌────────────────────┐
│  Paste YouTube URL │
│  + Select Options  │
│  + Hit "Analyze"   │
└────────┬───────────┘
         │
         ▼
┌────────────────────┐
│  Progress Bar      │
│  ┌────────────────┐│
│  │ ████████░░░░░░░ ││
│  │ Fetching →      ││
│  │ Extracting →    ││
│  │ Analyzing →     ││
│  │ Ranking →       ││
│  └────────────────┘│
└────────┬───────────┘
         │
         ▼
┌────────────────────────────────────────────┐
│  Results Page                              │
│  ┌──────────────────────────────────────┐  │
│  │ 🎬 Video Title / Channel             │  │
│  │                                      │  │
│  │ ★ ELITE MOMENTS (max 5)              │  │
│  │   #1 🔥 Hook  at 12:34 — Score 92   │  │
│  │     [Generate Clip ▸] [Landscape]    │  │
│  │   #2 🔥 Confession at 45:01 — Sc 88 │  │
│  │     [Generate Clip ▸] [Vertical  🔘]│  │
│  │                                      │  │
│  │ ◆ SECONDARY MOMENTS (max 10)         │  │
│  │   #6 Story at 1:02:34 — Score 78    │  │
│  │     [Generate Clip ▸]               │  │
│  └──────────────────────────────────────┘  │
└────────┬───────────────────────────────────┘
         │
         │ 3. Click "Generate Clip"
         ▼
┌────────────────────┐
│  Loading spinner   │
│  (polls every 5s)  │
│  up to 12 minutes  │
└────────┬───────────┘
         │
         ▼
┌────────────────────┐
│  Download button   │
│  [Download MP4 ▸]  │
└────────────────────┘
```

---

## 3. Frontend Architecture

**Stack:** Next.js 16 App Router, React 19, TypeScript, CSS (dark theme, no framework)

**Single-page layout** (`app/page.tsx`, `~700 lines`):

| Component | Purpose |
|---|---|
| URL Input | YouTube URL validator with regex patterns |
| Analysis Pipeline | Progress simulation with stage timer |
| History Panel | Last 5 analyses (IP-based, sidebar) |
| Results Display | Moment cards with tier badges, DNA tags, transcript excerpt |
| Clip Generator | Render mode toggle (landscape/vertical), polling status |
| Empty State | SVG placeholder when no analysis loaded |

**State management:** Inline React state (`useState`) — no Redux/Zustand.

**Clip polling:** Every 5s → GET `/api/clips/[id]/status`, timeout 12 min.

**History:** Fetched on mount + after each analysis completes.

---

## 4. Backend API Flow

```
POST /api/analyze { url }
  │
  ├─ EXTRACT youtubeId from URL
  ├─ CHECK rate limit (10/day/IP)
  ├─ FETCH transcript:
  │   ├─ YouTube InnerTube API (native)
  │   ├─ Worker Queue (if no native transcript)
  │   │   └─ jobs_queue → worker polls → Deepgram
  │   └─ Direct Deepgram (VPS only, last resort)
  │
  ├─ ANALYZE via LLM:
  │   ├─ extractCandidates() — 15 signals, deterministic
  │   └─ batch LLM scoring (DeepSeek → Mimo → Qwen)
  │
  ├─ RANK results:
  │   ├─ sort by score DESC
  │   ├─ dedup 30s proximity
  │   ├─ tier (elite ≥85, secondary ≥70)
  │   └─ caps (max 5 elite, max 10 secondary)
  │
  ├─ STORE in PostgreSQL:
  │   ├─ INSERT analyses row
  │   └─ INSERT moments (10-15 rows)
  │
  └─ RESPONSE analysis result with moments
```

---

## 5. Worker Flow

```
┌──────────────────┐
│  Worker Agent     │  runs as: npx tsx index.ts
│  PC-GANY /        │  polling loop: every 30s
│  LAPTOP-GANY      │
└────────┬─────────┘
         │
         ▼  GET /api/workers/jobs/poll
    ┌────────────┐
    │ Any jobs?  │─── No ──► Sleep 30s
    └─────┬──────┘
          │ Yes
          ▼
    ┌──────────────────────┐
    │ Claim job (atomic)   │  FOR UPDATE SKIP LOCKED
    │ job_type = 'clip'?   │
    └──────┬──────┬────────┘
           │      │
      Yes  │      │  No (transcript)
           ▼      ▼
    ┌────────────┐  ┌──────────────────────┐
    │ yt-dlp     │  │ yt-dlp download audio│
    │ download   │  │ Deepgram STT (Nova-2)│
    │ video      │  │ Group into ~5s segs  │
    │            │  │ POST /complete       │
    │ Face       │  └──────────────────────┘
    │ tracking   │
    │            │
    │ FFmpeg     │
    │ crop+encode│
    │            │
    │ POST       │
    │ /upload    │
    └────────────┘
```

---

## 6. Database Flow

```
videos (1) ──→ analyses (N) ──→ moments (N)
   │                │
   │                └── events (N)      [MVP analytics, sparse]
   │
   └── clips_cache (N) ──→ jobs_queue (1) [via job_id]
                                        │
                                   workers (N) [via worker_id]
```

**Migration order:**
1. `001_create_videos.sql` — Video metadata cache
2. `002_create_analyses.sql` — Analysis records
3. `003_create_moments.sql` — Ranked clip moments
4. `004_create_events.sql` — User interaction events
5. `005_add_transcript_source.sql` — Transcript source column
6. `006_create_jobs_queue.sql` — Workers + job queue tables
7. `007_create_clips_cache.sql` — Clip render cache + job_type
8. `008_add_render_mode.sql` — Landscape/vertical support

---

## 7. Rendering Flow

```
Client clicks "Generate Clip"
  │
  ▼
POST /api/clips { analysisId, momentIndex, renderMode }
  │
  ├─ Lookup moment from DB
  ├─ Check clips_cache (video_id + start_time + end_time + render_mode)
  │   ├─ HIT → return { status: 'ready', clipUrl }
  │   └─ MISS → INSERT into jobs_queue (job_type='clip')
  │             INSERT pending entry into clips_cache
  │             Return { status: 'pending', clipId }
  │
  Worker polls job → downloads video via yt-dlp
  │
  ├─ renderMode == 'landscape'?
  │   └─ ffmpeg -c copy (stream copy, no transcode)
  │
  └─ renderMode == 'vertical'?
      ├─ Analyze faces:
      │   ├─ face-detect.py (OpenCV Haar Cascade)
      │   └─ face-tracker.ts (identity + smoothing + dominance)
      ├─ If faceRatio > 30%:
      │   └─ renderVerticalTracked() — per-segment ffmpeg + concat
      └─ Else:
          └─ ffmpeg scale=-1:1920,crop=1080:1920 (center crop)
  │
  Upload MP4 → POST /api/workers/jobs/[id]/upload
  │
  Client polls → GET /api/clips/[id]/status
  │
  Ready → GET /api/clips/[id]/download redirects to /clips/{filename}
```

---

## 8. Transcript Pipeline

```
3 acquisition paths with fallback order:

PATH 1: YouTube InnerTube API (native, ~1s, free)
  ├─ POST to youtubei/v1/player (Android client)
  ├─ fetchCaptionTracks → select Indonesian ASR/manual
  ├─ fetchTranscriptXml → word grouping into ~5s segments
  ├─ Success rate: ~40% for Indonesian podcasts
  └─ Cost: free

PATH 2: Worker Queue (residential PC, ~30-120s)
  ├─ INSERT job into jobs_queue (if not already queued)
  ├─ Worker polls → claims → yt-dlp audio → Deepgram STT
  ├─ Poll DB every 3s up to 120s for completion
  └─ Cost: Deepgram Nova-2 ($0.0204/min)

PATH 3: Direct Deepgram (VPS, ~30-60s)
  ├─ yt-dlp audio → POST to Deepgram /v1/listen
  ├─ Model: nova-2, language: id
  └─ Only runs on VPS (skipped on Vercel serverless)
```

---

## 9. Face Tracking Flow

```
face-detect.py (Python subprocess)
  ┌─ OpenCV Haar Cascade detectMultiScale
  ├─ Samples at 1 fps
  ├─ Outputs ALL faces (V2.4A: not just largest)
  └─ Clip-range only: --start-time, --end-time with 10s padding
         │
         ▼
face-tracker.ts (8-step pipeline)
  ┌─ 1. trackFaceIdentity() — Euclidean distance matching
  ├─ 2. smoothPerFace() — moving avg WITHIN identity (window=3)
  ├─ 3. interpolatePerFace() — linear fill per identity
  ├─ 4. selectCameraTarget() — dominance scoring (size+center+stability)
  ├─ 5. buildSegments() — group into CropSegment[]
  ├─ 6. mergeTinySegments() — merge <2s into next
  └─ 7. fillSegmentGaps() — interpolate between segments
         │
         ▼
renderVerticalTracked() (clip-renderer.ts)
  ┌─ Per-segment ffmpeg: crop=<w>:<h>:<cx>:<cy>,scale=1080:1920
  ├─ -crf 18, -preset medium, -c:a aac -b:a 128k
  └─ Single/multiple segment → concat demuxer -c copy
```

---

## 10. Deployment Flow

```
/root/GANYIQ/                    /var/www/ganyiq/
  (Source of Truth)         rsync     (Production)
  ┌──────────────┐     ────────►   ┌──────────────┐
  │ git repo     │                 │ PM2 server   │
  │ dev edits    │                 │ live serving │
  │ untracked    │                 │              │
  │ files        │                 │ public/clips/│
  └──────────────┘                 └──────────────┘
        │                                │
        │ git push                       │ npm start
        ▼                                ▼
    GitHub remote                    PM2 (port 3003)
                                   behind Nginx (443)
```

**deploy.sh modes:**
| Mode | Command | Action |
|---|---|---|
| Full | `bash deploy.sh` | rsync → `npm ci` → `next build` → pm2 restart |
| Quick | `bash deploy.sh --quick` | rsync → pm2 restart (no build) |
| Build | `bash deploy.sh --build` | next build at target (no sync) |
| Rollback | `bash deploy.sh --rollback HEAD~1` | git checkout → full deploy |

**Deploy excludes:** `.git`, `node_modules`, `.next`, `.env*`, `tsbuildinfo`, `cookies.txt`, `public/clips`

---

## 11. Key Design Decisions

| Decision | Rationale |
|---|---|
| **V2 Compact Pipeline** | Deterministic candidate extraction + batch LLM scoring replaces full-transcript LLM analysis. Cheaper, faster, more reliable |
| **Residential workers** | VPS bandwidth too expensive for yt-dlp downloads. Workers download + transcode on residential PCs |
| **3-path transcript fallback** | InnerTube often fails for Indonesian content. Deepgram provides reliable fallback |
| **IP-based identity** | No user accounts in MVP. IP is sufficient for rate limiting and history |
| **Per-face smoothing** | V2 bug: averaging across faces produced "mid-air" crop. V2.4A fixed by grouping by identity first |
| **4-step model fallback** | Primary DeepSeek (1 attempt) → Mimo (2) → Qwen (2). Maximizes analysis success rate |
| **FFmpeg concat -c copy** | Per-segment encode then stream-copy concat avoids generational loss |
