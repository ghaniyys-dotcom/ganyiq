# GANYIQ Performance Report

## Benchmark Data & System Performance Metrics

---

## 1. VPS System Metrics

**Measurement time:** 2026-06-07 10:00-11:00 UTC (during active clip rendering)

| Metric | Value | Notes |
|---|---|---|
| **CPU** | 2 cores, 97% idle | Load avg: 0.08/0.11/0.06 |
| **RAM** | 3.9 GB total, 2.5 GB used (64%) | 1.4 GB available |
| **Swap** | 2.0 GB total, 629 MB used (31%) | Moderate swap usage |
| **Disk** | 77 GB total, 20 GB used (25%) | ~58 GB free |
| **Disk I/O** | 2.86 r/s, 3.74 w/s | Very low IO wait (0.17%) |
| **Network** | Not benchmarked | Single VPS, 1 Gbps (est.) |

**Memory consumers (top processes):**
| Process | RAM | CPU |
|---|---|---|
| tsserver (×5) | 10.5% each | 0.1-0.2% each |
| Hermes Gateway (Python) | 8.1% | 1.1% |
| Next.js (ganyiq) | 4.0% | 0.3% |
| PM2 daemon | 0.9% | 0.0% |
| npm (ganyiq wrapper) | 1.4% | 0.2% |

**⚠ Observation:** 5 tsserver instances consume ~52% of RAM collectively (2 GB). This is a known issue — Hermes Gateway spawns tsserver per session and doesn't reap them.

---

## 2. LLM Analysis Pipeline Timing

Measured from production PM2 logs (Vl_D-ggWvtA analysis, June 7):

| Phase | Duration | Notes |
|---|---|---|
| InnerTube transcript fetch | **13.5 ms** | Very fast for native YouTube transcripts |
| Candidate extraction (V2) | <50 ms | Deterministic, no LLM |
| LLM batch scoring (mimo-v2.5) | ~8-15s | 15 candidates, 4772 prompt tokens + 2297 completion |
| Lead-in expansion | <1 ms | 3/15 clips expanded by 12s |
| **Total analysis time** | **~15-30s** | (includes all overhead) |

**LLM usage (mimo-v2.5 example):**
| Metric | Value |
|---|---|
| Prompt tokens | 4,772 |
| Completion tokens | 2,297 |
| Total tokens | 7,069 |
| Cost (inference) | ~$0.00131 |
| Cost per analysis | ~$0.00067 (prompt) + $0.00064 (completion) |

**Fallback rate:** Not tracked in production. In-memory counters reset on restart. No persistent fallback metric.

---

## 3. Worker Pipeline Timing

### Transcript Job (Vl_D-ggWvtA, 903 segments)

| Phase | Duration | Notes |
|---|---|---|
| yt-dlp audio download | **57s** | bestaudio, ~47 min video |
| Deepgram STT (Nova-2) | **11s** | 903 segments, confidence 0.658 |
| Upload + complete | **~1s** | |
| **Total transcript job** | **~69s** | |

### Clip Job — Vertical Face-Tracked (Vl_D-ggWvtA, 1790-1868s)

**BEFORE V2.4A-opt fix (processing ALL frames):**

| Phase | Duration | Notes |
|---|---|---|
| yt-dlp video download | **70s** | 720p, ~78 min video |
| Cached | 0s | |
| Face detection (4688 frames) | **~7 min** | **BOTTLENECK** — processed entire video |
| Face tracking + identity | <1s | 4688 samples, 3987 with faces |
| FFmpeg segments | **~10s** | |
| Upload | **~3s** | 29.3 MB |
| **Total clip job (V2.4)** | **~8.5 min** | |

**AFTER V2.4A-opt fix (clip-range only):**

| Phase | Duration | Notes |
|---|---|---|
| Face detection (~80 frames) | **~5s** | Only clip range + 10s padding |
| Face tracking + identity | <1s | 80 samples, 68 with faces |
| FFmpeg segments | **~10s** | 2 segments |
| Upload | **~3s** | ~29 MB |
| **Total clip job (V2.4A)** | **~1-2 min** | **~5x faster** |

---

## 4. Clip Rendering Timing

### Vertical Mode

| Segment count | FFmpeg time | CRF 18, 1080×1920 |
|---|---|---|
| 1 segment (78s clip) | ~8-12s | Single ffmpeg command |
| 2 segments (78s split) | ~10-15s | Per-segment encode + concat |
| 5+ segments | ~20-40s | Overhead from multiple ffmpeg processes |

**Concat overhead:** Negligible for <10 segments (uses `-c copy` — stream copy, no re-encode).

### Landscape Mode

| Action | Duration |
|---|---|
| FFmpeg cut (stream copy) | ~2-5s |
| **Total (landscape)** | **~2-5s** |

---

## 5. Queue Timing

| Metric | Value | Notes |
|---|---|---|
| Job poll frequency | Every 30s | Worker sleep between polls |
| Stale job recovery | 15 min | Jobs claimed >15min reset to pending |
| Heartbeat frequency | Every 60s | Worker keepalive |
| Frontend poll frequency | Every 5s | Client polls clip status |
| Frontend poll timeout | 12 min | Max wait for clip to render |

**Typical queue wait times:**
- If worker is idle: job claimed within **0-30s**
- If worker is busy: job waits until current job completes
- Single worker → sequential processing only

---

## 6. Video Cache Performance

| Metric | Value |
|---|---|
| Cache TTL | 7 days |
| Max cache size | 50 GB (LRU eviction) |
| Cache directory | `cache/{videoId}.mp4` |
| Cache hit rate | DATA NOT AVAILABLE (no metrics system) |
| yt-dlp download speed | DATA NOT AVAILABLE (depends on ISP) |

---

## 7. Nginx / HTTP Performance

From access log analysis (June 7):

| Route | Avg Response Size | Frequency |
|---|---|---|
| `POST /api/analyze` | 1,304 bytes | ~1 per session |
| `POST /api/clips` | 79-109 bytes | ~2-3 per session |
| `GET /api/clips/[id]/status` | 98-176 bytes | ~15-40 calls per clip (5s polling) |
| `GET /clips/{filename}.mp4` | 6-29 MB | ~2 per clip |
| `GET /api/history` | 616-695 bytes | ~1 per session |
| `GET /api/health` | ~50 bytes | Cron monitoring |

**Notable:** `/api/clips/[id]/status` is the most-called endpoint. A single clip can generate 40+ polling calls.

---

## 8. Database Performance

| Metric | Value |
|---|---|
| Rows (videos) | ~50 |
| Rows (analyses) | ~200 |
| Rows (moments) | ~2,500 |
| Rows (workers) | 2 |
| Rows (jobs_queue) | ~100 |
| Rows (clips_cache) | 8 |
| Neon provisioned | 0.5 GB (free tier) |
| Connections | Serverless pool (auto-scales) |

**Query profile (no slow queries detected at MVP scale):**
- All queries use indexed columns
- Partial indexes on jobs_queue make polling efficient
- Neon serverless handles connection pooling automatically

---

## 9. Known Bottlenecks

| Bottleneck | Severity | Evidence |
|---|---|---|
| **Face detection on full video** | 🔴 CRITICAL | 7 min for 4688 frames (FIXED in V2.4A-opt) |
| **Single worker sequential** | 🟡 MAJOR | Only 1 active worker, all jobs serial |
| **tsserver memory leak** | 🟡 MAJOR | 5 instances ~2 GB RAM (non-GANYIQ issue) |
| **Swap usage (629 MB)** | 🟡 MAJOR | 31% swap used — memory pressure |
| **No caching for analyses** | 🟢 MINOR | Same video re-analyzed = same LLM cost |
| **No query result caching** | 🟢 MINOR | Every DB query hits Neon |

---

## 10. Performance Recommendations

1. **Deploy V2.4A-opt** — 5x faster face detection already in source but not deployed
2. **Add a second worker** — Halve queue wait times immediately
3. **Reset tsserver regularly** — Reclaim ~2 GB RAM weekly (cron: `pkill -f tsserver`)
4. **Add analysis cache** — Skip LLM for re-analysis of same video
5. **Stream clip downloads** — Add `X-Accel-Buffering: no` for large MP4s
