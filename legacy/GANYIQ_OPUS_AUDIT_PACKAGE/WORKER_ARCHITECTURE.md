# GANYIQ Worker Architecture
## Residential Worker Agent — Full Technical Documentation

---

## 1. Overview

The worker system enables **distributed processing** on residential PCs. Workers handle:
- **Transcript acquisition:** yt-dlp audio download + Deepgram STT
- **Clip rendering:** yt-dlp video download + FFmpeg cut + face tracking

This architecture exists because VPS bandwidth is too expensive for large video downloads. Workers run on Windows PCs (PC-GANY, LAPTOP-GANY).

---

## 2. Worker Agent Flow

```
npx tsx index.ts
  │
  ├─ 1. LOAD config from .env.local
  │     GANYIQ_API_URL, DEEPGRAM_API_KEY, WORKER_NAME
  │
  ├─ 2. AUTO-REGISTER if no WORKER_ID or WORKER_API_KEY
  │     POST /api/workers/register → saves ID + key
  │
  ├─ 3. MAIN LOOP (every 30s):
  │     │
  │     ├─ HEARTBEAT (every 60s):
  │     │   POST /api/workers/[id]/heartbeat
  │     │
  │     ├─ POLL for job:
  │     │   GET /api/workers/jobs/poll
  │     │   │
  │     │   ├─ 204 (no job) → sleep 30s
  │     │   │
  │     │   ├─ jobType == 'transcript':
  │     │   │   ├─ yt-dlp download audio (bestaudio)
  │     │   │   ├─ Deepgram Nova-2 STT → segments
  │     │   │   └─ POST /api/workers/jobs/[id]/complete
  │     │   │
  │     │   └─ jobType == 'clip':
  │     │       └─ renderClip(job, env)
  │     │           ├─ yt-dlp download video
  │     │           ├─ ffprobe source analysis
  │     │           ├─ render mode dispatch
  │     │           └─ POST /api/workers/jobs/[id]/upload
  │     │
  │     └─ Catch errors → POST /api/workers/jobs/[id]/fail
  │
  └─ (runs indefinitely)
```

---

## 3. Polling Flow

```
Worker                    API Server                   PostgreSQL
  │                         │                            │
  │  GET /poll (Bearer)     │                            │
  │ ──────────────────────► │                            │
  │                         │ BEGIN TRANSACTION          │
  │                         ├─ UPDATE jobs_queue SET     │
  │                         │    status='claimed'        │
  │                         │  WHERE id = (              │
  │                         │    SELECT id FROM jobs_queue│
  │                         │    WHERE status='pending'   │
  │                         │    AND retry_count < 3      │
  │                         │    ORDER BY created_at      │
  │                         │    FOR UPDATE SKIP LOCKED   │
  │                         │    LIMIT 1                  │
  │                         │  ) RETURNING *              │
  │                         ├─ Also recovers jobs         │
  │                         │   claimed >15 min ago       │
  │                         │ COMMIT                      │
  │  { job }                │                            │
  │ ◄────────────────────── │                            │
```

**Atomic claim** via `FOR UPDATE SKIP LOCKED` prevents two workers from claiming the same job. The partial index `idx_jobs_queue_poll` makes this efficient.

---

## 4. Heartbeat Flow

```
Worker                    API Server
  │                         │
  │ (every 60s)             │
  │ POST /heartbeat         │
  │ { version }             │
  │ ──────────────────────► │
  │                         │ UPDATE workers SET
  │                         │   status='online',
  │                         │   last_heartbeat=NOW(),
  │                         │   version=COALESCE($2, version)
  │                         │ WHERE id = $1
  │                         │
  │ { status: 'ok' }        │
  │ ◄────────────────────── │
```

**Stale detection:**
- Cron job (`/api/cron/cleanup-jobs`) marks workers `offline` if heartbeat >5 min stale.
- Stale claimed jobs (>15 min) are reset to `pending` for another worker.

---

## 5. Upload Flow (Clip Rendering)

```
Worker                          API Server
  │                               │
  │ Multipart POST /upload        │
  │ ────────────────────────────► │
  │                               │ Verify auth + job ownership
  │                               │ Validate MP4 header
  │                               │ Save to public/clips/{filename}
  │                               │ UPDATE clips_cache SET
  │                               │   filename, file_size, duration
  │                               │ WHERE id = clipId
  │                               │ (or INSERT if no cache row)
  │                               │ UPDATE jobs_queue SET status='completed'
  │ { status: 'ok' }              │
  │ ◄──────────────────────────── │
```

**Upload retry:** 2 attempts with 3s delay if first fails.

---

## 6. Retry Flow

```
Job fails
  │
  ├─ retry_count (0) + 1 < max_retries (3)?
  │   ├─ status = 'pending'
  │   ├─ worker_id = NULL (available to any worker)
  │   └─ retry_count++
  │
  └─ No more retries?
      └─ status = 'failed'
```

**Retry behavior by attempt:**

| Attempt | `retry_count` | Action |
|---|---|---|
| 1st failure | 0→1 | Retry available |
| 2nd failure | 1→2 | Retry available |
| 3rd failure | 2→3 | `failed` (permanent) |

---

## 7. Failure Flow

```
Any worker agent catch block:
  │
  ├─ Log error to console
  ├─ POST /api/workers/jobs/[id]/fail
  │   { workerId, errorMessage }
  └─ Continue to next poll cycle
```

**Specific failure scenarios:**

| Scenario | Error Message | Recovery |
|---|---|---|
| yt-dlp timeout (300s) | `yt-dlp failed: ...` | Retry (network issue) |
| Deepgram API error | `Deepgram error: ...` | Retry (transient) |
| FFmpeg error | `FFmpeg error: ...` | Retry (corrupt source) |
| Upload failure | `Upload failed: ...` | Retry (network) |
| Invalid job data | `Invalid job: ...` | Fail permanent |

---

## 8. Worker Package — Distribution

The worker source is duplicated in two locations (code smell):

| Location | Purpose |
|---|---|
| `/root/GANYIQ/worker/` | Development source of truth |
| `/root/GANYIQ/worker-package/` | Distribution package (identical with minor signature diff) |
| `/var/www/ganyiq/public/worker-package.zip` | Production deliverable (~20KB) |
| `/var/www/ganyiq/worker-package.zip` | Legacy archive (~13KB) |

**Known code drift:** The production copy at `/var/www/ganyiq/worker/` has a different `CONFIDENCE_LOCK_THRESHOLD` (0.6 vs source's 0.25) — possible hotfix that wasn't synced back.

---

## 9. Worker Script Signature Comparison

| Function | `worker/` | `worker-package/` |
|---|---|---|
| `renderClip()` | `(job, env, heartbeatFn)` | `(job, env)` — no heartbeatFn |
| `main loop` | Sends heartbeat during clip ops | No heartbeat during clip ops |

The `worker-package/` is the version distributed to workers. The `worker/` version has additional heartbeat support for long clip operations.

---

## 10. Worker Types

```typescript
interface Job {
  id: string;
  youtubeId: string;
  youtubeUrl: string;
  jobType: 'transcript' | 'clip';
  clipParams?: {
    startTime: number;
    endTime: number;
    renderMode?: 'landscape' | 'vertical';
  };
}

interface EnvConfig {
  apiUrl: string;
  workerId: string;
  apiKey: string;
  deepgramKey: string;
  workerName: string;
}

interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}
```

---

## 11. Key Constants

| Constant | Value | Description |
|---|---|---|
| `POLL_INTERVAL_MS` | 30,000 (30s) | Time between poll cycles |
| `HEARTBEAT_INTERVAL_MS` | 60,000 (60s) | Time between heartbeats |
| `yt-dlp audio timeout` | 300s | Audio download timeout |
| `yt-dlp video timeout` | 300s | Video download timeout |
| `Deepgram API timeout` | 600s | STT processing timeout |
| `FFmpeg cut timeout` | 120s | Clip render timeout |
| `Upload timeout` | 120s | File upload timeout |
| `Upload retries` | 2 attempts | Network retry for upload |
| `Max retries` | 3 | Job retry limit |
| `SHELL` | `cmd.exe` (Windows) | Cross-platform shell detection |
| `yt-dlp format` | `bestvideo[height<=720][vcodec^=avc1]+bestaudio[ext=m4a]/best[height<=720]` | Video quality |

---

## 12. Cross-Platform Support

| Feature | Windows (`cmd.exe`) | Unix |
|---|---|---|
| File delete | `del /f /q` | `rm -f` |
| Temp dir | `%TEMP%` | `/tmp` |
| Path separator | `\\` | `/` |
| yt-dlp | Direct | Direct |
| Python | `python3` then `python` | Same |
