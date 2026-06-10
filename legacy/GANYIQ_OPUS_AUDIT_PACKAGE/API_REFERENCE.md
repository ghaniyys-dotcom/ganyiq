# GANYIQ API Reference
## All Routes, Methods, Request/Response, Auth

**Base URL (Production):** `https://ganyiq.ganys.me`
**Base URL (Dev):** `http://localhost:3003`

**Authentication Types:**
- `none` — No auth required
- `cron-secret` — `x-cron-secret` header matching `CRON_SECRET` env var
- `worker-bearer` — `Authorization: Bearer <worker_api_key>`

---

## 1. User-Facing Routes

### `POST /api/analyze`

Analyze a YouTube video for clip-worthy moments.

**Auth:** none

**Request Body:**
```json
{
  "url": "https://youtu.be/dQw4w9WgXcQ"
}
```

**Success Response (200):**
```json
{
  "analysisId": "uuid",
  "video": {
    "youtubeId": "dQw4w9WgXcQ",
    "title": "Video Title",
    "channelName": "Channel",
    "durationSeconds": 4687,
    "durationMinutes": 78
  },
  "totalMomentsFound": 15,
  "processingTimeMs": 8234,
  "eliteMoments": [
    {
      "startTime": 1790.35,
      "endTime": 1868.08,
      "worthClippingScore": 92,
      "confidence": "high",
      "dnaTags": ["hookPower", "controversy"],
      "reasoning": "This moment grabs attention...",
      "rank": 1,
      "tier": "elite",
      "startTimestamp": "29:50",
      "endTimestamp": "31:08",
      "transcriptExcerpt": "Lorem ipsum dolor sit amet..."
    }
  ],
  "secondaryMoments": [...]
}
```

**Error Responses:**
| Status | Code | Description |
|---|---|---|
| 400 | `INVALID_URL` | URL is not a valid YouTube URL |
| 404 | `TRANSCRIPT_UNAVAILABLE` | No transcript could be fetched |
| 400 | `VIDEO_TOO_LONG` | Video exceeds max duration |
| 429 | `RATE_LIMITED` | IP exceeded daily limit (10) |
| 500 | `ANALYSIS_FAILED` | LLM analysis failed |

---

### `POST /api/clips`

Create a clip generation job for a specific moment.

**Auth:** none

**Request Body:**
```json
{
  "analysisId": "uuid",
  "momentIndex": 1,
  "renderMode": "vertical"
}
```

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `analysisId` | string | yes | | UUID from analysis response |
| `momentIndex` | int | yes | | 1-based rank position |
| `renderMode` | string | no | `"landscape"` | `"landscape"` or `"vertical"` |

**Success Responses:**
- **201 (cache miss / new job):** `{ "clipId": "uuid", "status": "pending" }`
- **200 (cache hit):** `{ "clipUrl": "/clips/file.mp4", "status": "ready" }`

---

### `GET /api/clips/[id]/status`

Poll the status of a clip generation job.

**Auth:** none

**Path Parameters:** `id` — clipId from POST response

**Response:**
```json
{
  "status": "ready" | "processing" | "pending" | "failed"
}
```

**Polling recommended:** Every 5s, timeout 12 min. Status transitions:
- `pending` → job queued, not yet claimed
- `processing` → worker claimed + rendering
- `ready` → clip available
- `failed` → rendering/upload error

---

### `GET /api/clips/[id]/download`

Download or redirect to the rendered clip MP4.

**Auth:** none

**Path Parameters:** `id` — clipId

**Responses:**
- **302** → `/clips/{filename.mp4}` (ready)
- **425** → `{ "status": "pending" }` (not ready)

---

### `GET /api/history`

Get the 5 most recent analyses for the current user (IP-based).

**Auth:** none

**Response:**
```json
[
  {
    "id": "uuid",
    "video": { "title": "...", "channelName": "...", "youtubeId": "..." },
    "thumbnail": "https://img.youtube.com/vi/.../hqdefault.jpg",
    "avgScore": 78.5,
    "eliteCount": 3,
    "createdAt": "2026-06-07T..."
  }
]
```

---

### `GET /api/history/[id]`

Re-open a past analysis with full moment details.

**Auth:** none (IP-verified ownership)

**Responses:**
- **200:** `{ analysisId, videoId, video: {...}, moments: [...], isRestored: true }`
- **403:** `{ error: "FORBIDDEN" }` (wrong IP)
- **404:** Not found

---

## 2. Internal / Admin Routes

### `GET /api/health`

Database connectivity probe.

**Auth:** none

**Response:**
```json
{ "status": "ok", "database": "connected" }
```
503 if database is unreachable.

---

### `GET /api/version`

Build information for deployment tracking.

**Auth:** none

**Response:**
```json
{
  "sha": "fcebf14",
  "buildTimestamp": "2026-06-07T10:00:00Z",
  "deployVersion": "v2-compact"
}
```

Env vars: `GIT_SHA`, `VERCEL_GIT_COMMIT_SHA`, `BUILD_TIMESTAMP`, `DEPLOY_VERSION`.

---

### `GET /api/cron/cleanup-jobs`

Periodic cleanup: release stale claimed jobs, mark workers offline.

**Auth:** `x-cron-secret` header

**Headers required:** `x-cron-secret: <CRON_SECRET>`

**Response:**
```json
{
  "releasedJobs": 2,
  "markedOffline": 1,
  "totalAnalyzed": 42,
  "totalWorkers": 2
}
```

**Logic:**
- Jobs claimed >15 min → reset to `pending`
- Workers with heartbeat >5 min → marked `offline`

---

## 3. Worker Routes

### `POST /api/workers/register`

Register a new residential worker agent.

**Auth:** none

**Request Body:**
```json
{
  "workerName": "PC-GANY",
  "version": "WORKER-v1.1.0"
}
```

**Success Response (201):**
```json
{
  "id": "uuid",
  "workerName": "PC-GANY",
  "apiKey": "32-byte-hex-token"
}
```

**⚠ API key is returned ONCE.** Store it securely. Lost keys cannot be recovered.

**Error:** 409 if `workerName` already exists.

---

### `POST /api/workers/[id]/heartbeat`

Worker keepalive signal.

**Auth:** worker-bearer

**Request Body (optional):**
```json
{ "version": "WORKER-v1.1.0" }
```

**Response:**
```json
{ "status": "ok", "workerId": "uuid", "timestamp": "2026-06-07T10:00:00Z" }
```

---

### `GET /api/workers/jobs/poll`

Atomically claim the next available pending job.

**Auth:** worker-bearer

**Atomic claim:** Uses `FOR UPDATE SKIP LOCKED` to prevent race conditions.

**Recovery:** Jobs claimed >15 min are auto-reset to pending during poll.

**Success Response (200):**
```json
{
  "job": {
    "id": "uuid",
    "youtubeId": "dQw4w9WgXcQ",
    "youtubeUrl": "https://youtu.be/...",
    "createdAt": "2026-06-07T...",
    "jobType": "transcript",
    "renderMode": null
  }
}
```
For `jobType: "clip"`, also includes `clipParams: { startTime, endTime, renderMode }`.

**No Jobs Available:** HTTP 204 (empty body).

---

### `POST /api/workers/jobs/[id]/complete`

Submit transcript result after successful worker processing.

**Auth:** worker-bearer

**Request Body:**
```json
{
  "workerId": "uuid",
  "segments": [
    { "start": 0.0, "end": 5.0, "text": "Hello world" }
  ],
  "fullTranscript": "Hello world...",
  "confidence": 0.658,
  "durationMs": 45000
}
```

**Success Response:**
```json
{
  "status": "ok",
  "job_id": "uuid",
  "segments_count": 903,
  "transcript_source": "deepgram"
}
```

**Errors:**
- 401: Auth failure
- 403: Job belongs to different worker
- 409: Job already completed

---

### `POST /api/workers/jobs/[id]/fail`

Report a job failure.

**Auth:** worker-bearer

**Request Body:**
```json
{
  "workerId": "uuid",
  "errorMessage": "yt-dlp download failed: 403 Forbidden"
}
```

**Response:**
```json
{ "status": "failed", "job_id": "uuid", "retry": true, "retryCount": 1 }
```

**Retry logic:**
- `retryCount < maxRetries (3)` → status = `pending`, `worker_id` cleared
- `retryCount >= maxRetries` → status = `failed`

---

### `POST /api/workers/jobs/[id]/upload`

Upload a rendered clip MP4 file.

**Auth:** worker-bearer

**Content-Type:** `multipart/form-data`

**Fields:**
| Field | Type | Description |
|---|---|---|
| `workerId` | string | Worker UUID |
| `startTime` | number | Clip start in seconds |
| `endTime` | number | Clip end in seconds |
| `file` | file | MP4 video file |

**Response:**
```json
{
  "status": "ok",
  "job_id": "uuid",
  "filename": "clip-uuid.mp4"
}
```

**Errors:**
- 400: Not MP4
- 401: Auth failure
- 403: Wrong worker

---

## 4. API Route Map

```
Method  Path                                    Auth        Purpose
──────  ────                                    ────        ───────
POST    /api/analyze                            none        Analyze video
POST    /api/clips                              none        Generate clip
GET     /api/clips/[id]/status                  none        Poll clip status
GET     /api/clips/[id]/download                none        Download clip
GET     /api/history                            none        Recent analyses
GET     /api/history/[id]                       none        Re-open analysis
GET     /api/health                             none        DB health check
GET     /api/version                            none        Build info
GET     /api/cron/cleanup-jobs                  cron-secret Maintenance cleanup

POST    /api/workers/register                   none        Register worker
POST    /api/workers/[id]/heartbeat             worker      Worker keepalive
GET     /api/workers/jobs/poll                  worker      Claim next job
POST    /api/workers/jobs/[id]/complete          worker      Submit transcript
POST    /api/workers/jobs/[id]/fail              worker      Report failure
POST    /api/workers/jobs/[id]/upload            worker      Upload clip
```

## 5. Key Constants from Code

| Constant | Value | Location |
|---|---|---|
| Rate limit | 10/IP/day | `lib/rate-limit.ts` |
| Max candidates per batch | 15 | `lib/analyzer.ts` |
| Clip duration | 15-90s | `lib/analyzer.ts` |
| Proximity dedup window | 30s | `lib/ranking.ts` |
| Elite threshold | ≥85 | `lib/ranking.ts` |
| Secondary threshold | ≥70 | `lib/ranking.ts` |
| Job max retries | 3 | `route work/job fail` |
| Stale job timeout | 15 min | `route work/job poll` |
| Worker heartbeat stale | 5 min | `cron cleanup` |
| Poll frontend timeout | 12 min | `app/page.tsx` |
