# GANYIQ — Known Issues (Current as of 2026-06-07)

---

## 1. Face Tracking Issues

### 1.1 Camera Target Selection (V2.4A — PARTIALLY FIXED)
- **Status:** Fixed for multi-face. Camera no longer gets "stuck in middle" between two faces.
- **Remaining:** Only the `DOMINANT_SWITCH_RATIO (1.2)` controls switching. In 3+ person scenarios, camera may still behave suboptimally.

### 1.2 Dead Zone Is X-Only
- **Issue:** `DEAD_ZONE_PX (30px)` only checks X-axis movement. Vertical jitter within dead zone is ignored.
- **Impact:** Minor vertical wobble in output.
- **Fix needed:** Add `cy` dead zone check.

### 1.3 `CONFIDENCE_LOCK_THRESHOLD` Dead Code
- **Issue:** Declared as constant `0.25` but never referenced in actual camera target logic. The dead zone and hold logic work independently.
- **Impact:** Code confusion. No behavioral impact.
- **Fix needed:** Remove or implement.

### 1.4 No-Face Frames Reported as `hasFace: true`
- **Issue:** In `buildSegments()`, frames without faces are still pushed with `hasFace: true` using locked last-known position.
- **Impact:** Downstream code cannot distinguish genuine face tracking from locked-position fallback.
- **Fix needed:** Add a separate flag or confidence field.

### 1.5 Haar Cascade Detection Quality
- **Issue:** OpenCV Haar Cascade is the most basic face detector. Misses angled/small faces, false positives, no facial landmarks.
- **Impact:** Reduced tracking accuracy, especially in group shots or profile angles.
- **Fix possible:** MediaPipe Face Detection, MTCNN, or DLIB.

### 1.6 Face Ratio Binary Gate (30%)
- **Issue:** If `faceRatio < 0.3`, entire clip uses center crop fallback — even if faces are present at key moments.
- **Impact:** Clips with sparse but important face moments get no tracking.
- **Fix possible:** Dynamic threshold or fallback to center-crop per segment, not per clip.

### 1.7 No Non-Maximum Suppression (NMS)
- **Issue:** `detectMultiScale` can return overlapping detections for the same face.
- **Impact:** Inflated face count, potential identity confusion.

---

## 2. Speaker Tracking (Not Yet Implemented)

### 2.1 No Multi-Speaker Awareness
- **Issue:** Camera selects dominant face by size/center/stability, NOT by who is currently speaking.
- **Impact:** Wrong speaker can be cropped when a quieter person talks while the dominant face looks active.
- **Fix:** V2.4 planned — Deepgram diarization + lip movement correlation.

### 2.2 No Split-Screen
- **Issue:** When 2+ speakers are active simultaneously, the camera must pick one. In Opus Clip, both speakers appear in split screen.
- **Impact:** Loss of context in multi-speaker moments.
- **Fix:** V2.5 planned — dynamic split screen layout.

### 2.3 No Reaction Tracking
- **Issue:** When speaker A is talking and speaker B reacts (nod, smile, laugh), the camera doesn't capture the reaction.
- **Impact:** Misses human-interest moments.
- **Fix:** V3 planned.

---

## 3. Queue System Issues

### 3.1 Worker Duplicate Processing (RARE)
- **Issue:** If worker claims job but crashes before completing, the job is reset after 15 min stale timeout. If another worker claims it before the first worker recovers and sends `POST /complete`, both workers process the same job.
- **Impact:** Wasted bandwidth. Final result from first complete wins.
- **Risk:** Low. The `FOR UPDATE SKIP LOCKED` pattern prevents this well.

### 3.2 No Job Priority
- **Issue:** Jobs are processed FIFO. No mechanism to prioritize short transcript jobs over long clip jobs.
- **Impact:** A 10-minute clip job blocks a transcript job from being claimed.
- **Fix possible:** Multiple queues or priority levels.

### 3.3 No Queue Metrics
- **Issue:** No dashboard or metrics showing queue depth, average wait time, job age.
- **Impact:** Ops blind — can't tell if workers are keeping up.

### 3.4 No Graceful Worker Shutdown
- **Issue:** Killing a worker mid-render loses the in-progress job. The job goes stale for 15 min before another worker can claim it.
- **Impact:** 15-minute delay on failure.

---

## 4. Rendering Pipeline Issues

### 4.1 No Keyframe Alignment
- **Issue:** FFmpeg cut uses input `-ss` (fast seek), which starts at the nearest keyframe (GOP boundary).
- **Impact:** Clip may start/end a few frames earlier than intended. With 720p H.264 (keyframe interval ~2-10s), this can be significant.
- **Fix possible:** `-noaccurate_seek` or re-encode with `-ss` as output option.

### 4.2 Per-Segment Encode Quality
- **Issue:** Each vertical segment is independently encoded with `-crf 18`. With variable bitrate, quality may vary between segments.
- **Impact:** Slight visual inconsistency at segment boundaries.
- **Risk:** Low. CRF 18 is visually lossless.

### 4.3 Upload Retry — No Exponential Backoff
- **Issue:** Upload retry waits exactly 3s regardless of attempt number.
- **Impact:** If server is overloaded, both attempts fail nearly simultaneously.

### 4.4 Upload Uses Blob Construction
- **Issue:** `new Blob(chunks)` in Node.js instead of streaming file upload.
- **Impact:** Higher memory usage for large files.

---

## 5. Database / Schema Issues

### 5.1 No `updated_at` on `videos`
- **Issue:** Videos table has only `fetched_at`. No way to detect stale cache entries automatically.
- **Impact:** Manual cache invalidation only.

### 5.2 No CHECK Constraint on `events.event_type`
- **Issue:** Event types enforced only in application layer (`lib/validators.ts`), not in DB.
- **Impact:** Direct SQL inserts can create invalid event types. (Intentionally loose for future types.)

### 5.3 Rate Limit Query Has No Index
- **Issue:** Rate limit check (`SELECT COUNT(*) FROM analyses WHERE ip_address = $1 AND created_at > ...`) has no composite index on `(ip_address, created_at)`.
- **Impact:** Sequential scan acceptable at current scale (~200 rows). Will become a bottleneck at 10K+ analyses.

### 5.4 No Partitioning or Archiving
- **Issue:** No strategy for archiving old analyses, moments, or events.
- **Impact:** At production scale, tables grow unbounded.

---

## 6. LLM Pipeline Issues

### 6.1 Fallback Model Knowledge Gap
- **Issue:** Fallback models (Mimo, Qwen3) are not tested as thoroughly as DeepSeek. They may produce lower quality scores or different scoring distributions.
- **Impact:** Inconsistent analysis quality across fallback invocations.

### 6.2 No Prompt Version Tracking
- **Issue:** `prompt_version` is stored per analysis, but there's no canonical version history or A/B testing framework.
- **Impact:** Hard to correlate prompt changes with quality metrics.

### 6.3 Single-Point LLM Call
- **Issue:** All LLM traffic goes through `opencode.ai/zen/go/v1/chat/completions`. No failover to another provider.
- **Impact:** If OpenCode goes down, analysis pipeline is completely blocked.

---

## 7. Deployment Issues

### 7.1 Production Out of Sync
- **Issue:** Source (`/root/GANYIQ/`) is ahead of production (`/var/www/ganyiq/`) by several commits. Latest V2.4A-opt improvements not deployed.
- **Impact:** Production still uses old confidence threshold (0.6 vs 0.25).
- **Root cause:** Manual deploy process — no auto-deploy on commit.

### 7.2 Code Drift in face-tracker.ts
- **Issue:** `CONFIDENCE_LOCK_THRESHOLD` differs: 0.25 (source) vs 0.6 (production).
- **Impact:** Production may have different tracking behavior than expected.
- **Root cause:** Possible hotfix in production not synced back.

### 7.3 No Staging Environment
- **Issue:** Changes go directly from `/root/GANYIQ/` (dev) to `/var/www/ganyiq/` (prod). No intermediate staging.
- **Impact:** Every deploy carries some risk.

---

## 8. Infrastructure Issues

### 8.1 Single VPS, No Redundancy
- **Issue:** All services run on one 2-core VPS. No failover, no load balancing.
- **Impact:** Complete outage if VPS goes down.

### 8.2 PM2 Runs as Root
- **Issue:** PM2 daemon and the `ganyiq` process run as root.
- **Impact:** Security best practice violation. Process break could expose entire system.

### 8.3 RAM Pressure (3.8 GB for 2 Node.js apps)
- **Issue:** At 2.6 GB used out of 3.8 GB with swap usage (629 MB), headroom is limited.
- **Impact:** Memory pressure during heavy workloads (build + serving).
- **Note:** Current load is very low; this is manageable.

### 8.4 No CDN for Clips
- **Issue:** Clip MP4s are served directly from the VPS over Nginx, not from a CDN.
- **Impact:** Bandwidth costs. Single point of failure for downloads.

---

## 9. Monitoring Issues

### 9.1 No Error Tracking
- **Issue:** No Sentry, no error aggregation. Errors appear only in PM2 logs or console.
- **Impact:** Silent failures. Bugs discovered only by user report.

### 9.2 No Performance Monitoring
- **Issue:** No APM. Event loop latency tracked only via PM2.
- **Impact:** Hard to detect regressions without benchmarks.

---

## 10. Security Issues

### 10.1 No API Rate Limiting on Worker Routes
- **Issue:** Only analysis endpoint has rate limiting. Worker endpoints are auth-protected but not rate-limited.
- **Impact:** A compromised worker key could flood the API.

### 10.2 API Key Only Returned Once
- **Issue:** Worker API key is returned on registration and never stored in plaintext (only SHA-256 hash).
- **Impact:** Lost key = must re-register worker. No key rotation mechanism.

### 10.3 No HTTPS for Local API
- **Issue:** The VPS API communicates with workers over HTTPS (public), but worker-to-VPS internal calls are not rate-limited per endpoint.
- **Impact:** Acceptable for MVP, but not production-hardened.
