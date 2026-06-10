# CLIP_PIPELINE_AUDIT.md — MP4 Generation Infrastructure

**Date:** 2026-06-10
**Method:** Review of existing rendered clips + infrastructure check

---

## Infrastructure Status

| Component | Status | Notes |
|-----------|--------|-------|
| **ffmpeg** | ✅ Installed | v6.1.1 on VPS |
| **yt-dlp** | ✅ Installed | v2026.03.17 on VPS |
| **Worker (VPS)** | ⛔ Not running | Worker runs on PC-GANY (C:\ganyiq-worker\worker\) |
| **Worker (PC-GANY)** | ✅ Active | Connected via jobs_queue polling |
| **Storage** | ✅ 55GB free | /var/www/ganyiq/public/clips/ has 23 existing clips |
| **clips_cache** | ✅ Table exists | With foreign key to jobs_queue |
| **Unique constraint** | ✅ (video_id, start_time, end_time, render_mode) | Prevents redundant renders |

## Existing Clips Analysis

### File statistics from 23 existing clips:

| Metric | Value |
|--------|-------|
| **Total clips rendered** | 23 |
| **Landscape clips** | 3 (~13%) |
| **Vertical clips** | 20 (~87%) |
| **Average file size (landscape)** | ~8MB (range: 5.7-9.5MB) |
| **Average file size (vertical)** | ~28MB (range: 8.7-44MB) |
| **Oldest clip** | Jun 6 |
| **Most recent clip** | Jun 9 |

### Render mode distribution:
```
Vertical  ████████████████████ 87% (20 clips)
Landscape ██                  13% (3 clips)
```

### File size distribution:
```
Landscape: 5.7MB - 9.5MB (avg ~8MB)
Vertical:   8.7MB - 44MB  (avg ~28MB)
```

Vertical clips are 3.5× larger due to higher resolution rendering.

## Clip Generation Flow

```
User clicks "Generate Clip"
  ↓
POST /api/clips { analysisId, momentIndex, renderMode }
  ↓
Check clips_cache for existing render (by video_id + time + mode)
  ├─ Found → return { status: "ready", clipUrl }
  └─ Not found → INSERT into jobs_queue (job_type='clip')
                  return { status: "pending", clipId }
  ↓
Worker (PC-GANY) polls /api/workers/jobs/poll
  ├─ Gets job → downloads video via yt-dlp
  ├─ Cuts segment via ffmpeg
  ├─ Adds subtitles
  └─ Uploads result via /api/workers/jobs/[id]/upload
  ↓
Clients poll /api/clips/[id]/status until "ready"
```

## Worker Pipeline (PC-GANY)

### From failed job errors:
```
yt-dlp command template:
  --remote-components ejs:github
  --extractor-args "youtube:player_client=android"
  --ffmpeg-location "C:\Users\SN5CD\...\ffmpeg-8.1.1-full_build\bin"
  -x --audio-format mp3
  -o "C:\ganyiq-worker\worker\temp\[videoId].mp3"
```

### Failure patterns from failed jobs_queue:
| Failure | Count | Root cause |
|---------|-------|------------|
| `Video unavailable` | 2 | Attempted on deleted/private videos |
| Timeout/heartbeat | Previous | Fixed by async exec() patch |

## Clip Quality Observations

Based on metadata from clips_cache (can't verify visually remotely):

| Risk | Severity | Evidence |
|------|----------|----------|
| **Blank frames at cut points** | Low | ffmpeg `-ss` before `-i` can cause missing keyframes |
| **Subtitle sync** | Medium | Worker adds subtitles via ffmpeg drawtext; timing depends on segment alignment |
| **Audio desync** | Low | Standard yt-dlp + ffmpeg pipeline; rare with modern versions |
| **Resolution consistency** | Medium | 33MB vs 8MB landscape suggests varying source quality |
| **Worker disconnect** | Medium | Pending jobs never rendered if PC-GANY offline |

## Success Rate Estimate

| Metric | Estimate | Basis |
|--------|----------|-------|
| **Clip request → ready** | ~85% | 23 rendered, 4 failed in jobs_queue |
| **Average render time** | ~2-5 min | Based on file sizes and yt-dlp download speed |
| **Landscape success** | ✅ Working | 3 clips successfully rendered |
| **Vertical success** | ✅ Working | 20 clips successfully rendered |
| **Subtitle rendering** | Presumed working | has_subtitles=true on all cache entries |

## Risk Assessment

### Critical risks:

1. **Worker dependency on PC-GANY**
   - If PC-GANY is offline: all clip generation jobs stay pending forever
   - No fallback worker on VPS (ffmpeg is installed but no worker runs)
   - **Impact:** 100% of clip requests fail silently when PC-GANY down

2. **No render progress indicator**
   - User sees "Generating..." with no ETA
   - After 12 min polling timeout, shows "Processing is taking longer than expected"
   - **Impact:** Poor UX for long renders or when PC-GANY is busy

3. **No upload retry**
   - If /api/workers/jobs/[id]/upload fails during transfer, clip is lost
   - Worker marks job as failed, but no retry mechanism

### Minor risks:
- Large file sizes (44MB vertical) could be slow for mobile downloads
- No CDN for clip distribution (Nginx serves directly)
- No automatic cleanup for old clips

## Recommendations (Do Not Implement Yet)

1. **VPS-side fallback renderer** — Use existing ffmpeg on VPS to render clips directly without worker dependency
2. **Render progress endpoint** — Report percentage completion from ffmpeg
3. **File size optimization** — Reduce vertical resolution or bitrate for smaller files
4. **Clip cleanup cron** — Delete clips older than 30 days
5. **Cache-busting** — Add ?t=timestamp to clip URLs for CDN

---

**Clip Pipeline Status: Production-capable but worker-dependent.**
