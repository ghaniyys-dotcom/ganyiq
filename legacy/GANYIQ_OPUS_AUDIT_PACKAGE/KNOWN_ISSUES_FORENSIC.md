# GANYIQ Known Issues — Forensic Analysis

## New Issues Found Beyond KNOWN_ISSUES.md

**Scope:** This document identifies issues NOT previously documented in KNOWN_ISSUES.md. It represents a fresh audit of the entire system for race conditions, resource leaks, edge cases, and architecture flaws.

---

## 1. Race Conditions

### RC-1: Worker Jobs Counter Race

**Severity:** 🟡 MAJOR
**Location:** `app/api/workers/jobs/[id]/complete/route.ts` and `fail/route.ts`
**Description:** If two concurrent completions/failures arrive for the same worker (e.g., from two parallel job processes), the `UPDATE workers SET jobs_completed = jobs_completed + 1` SQL increment runs twice, but only one insertion into the jobs_queue should have been counted.
**Evidence:** The route does a `WHERE id = $1` for the job, but worker stats use `UPDATE workers SET jobs_completed = jobs_completed + 1 WHERE id = $2`. If two requests arrive simultaneously for different jobs on the same worker, the counter will be correct. However, if a single job is completed twice (see RC-2), the counter inflates.
**Fix needed:** Use atomic `RETURNING` or add `WHERE id NOT IN (exclude already-completed)` guard on completion.

### RC-2: Non-Idempotent Job Completion

**Severity:** 🔴 CRITICAL
**Location:** `app/api/workers/jobs/[id]/complete/route.ts`
**Description:** If the worker completes a job, the API responds with 200, but the worker's TCP connection drops before receiving the response. The worker re-sends the completion POST. The API processes it again — creating duplicate result entries, double-counting worker stats.
**Evidence:** The route checks `status != 'completed'` before processing. However, there is a window between the `SELECT` check and the `UPDATE` where another completion request can pass the check. The DB-level transaction protects `jobs_queue` but the worker stats counter (`SET jobs_completed = jobs_completed + 1`) can be incremented multiple times.
**Fix needed:** Use `UPDATE jobs_queue SET status = 'completed' WHERE id = $1 AND status = 'claimed' RETURNING id` — if no row returned, the job was already completed. This is an atomic operation that eliminates the race window.

### RC-3: Cron Cleanup vs Worker Poll Race

**Severity:** 🟡 MAJOR
**Location:** `app/api/cron/cleanup-jobs/route.ts` and `app/api/workers/jobs/poll/route.ts`
**Description:** The cron job releases jobs claimed >15 min by resetting them to `pending`. Simultaneously, a worker may poll and claim a job. The cron's `UPDATE ... WHERE status = 'claimed' AND claimed_at < NOW() - INTERVAL '15 min'` could fire at the exact moment a worker's `FOR UPDATE SKIP LOCKED` query claims the same job.
**Evidence:** Both queries run independently without mutual exclusion. The cron runs as a separate HTTP request from the worker poll. While PostgreSQL serializes these transactions, the cron could overwrite the worker's `worker_id` and `claimed_at` after the worker claimed it.
**Fix needed:** Add a `claimed_at IS NOT NULL` guard in the cron query, or add a grace period (only release jobs where claimed_at > 15 min AND no heartbeat from claiming worker in 5 min).

### RC-4: Rate Limit Counter Race

**Severity:** 🟢 MINOR
**Location:** `lib/rate-limit.ts`
**Description:** The rate limit check is a `SELECT COUNT(*)` followed by an INSERT. Between the SELECT and INSERT, another request from the same IP could also check and pass the rate limit check. At high concurrency, a user could exceed the rate limit by 1-2 requests.
**Evidence:** No transaction wraps the check+insert. The check is advisory, not enforced by DB constraints.
**Fix needed:** Add a unique constraint on `(ip_address, date_trunc('day', created_at))` or use PostgreSQL advisory locks.

### RC-5: Duplicate Video Cache Entry Race

**Severity:** 🟢 MINOR
**Location:** `lib/youtube.ts` — `getCachedVideo()` + `cacheVideo()`
**Description:** Two concurrent analyses of the same YouTube URL could both miss the cache, both fetch the transcript, and both try to INSERT into `videos`. The `ON CONFLICT DO NOTHING` handles this gracefully at the DB level, but both analysis pipelines waste effort fetching the same transcript.
**Evidence:** No distributed lock or dedup check before `fetchVideoData()`. The DB unique constraint is the only safeguard.
**Fix needed:** Use `SELECT ... FOR UPDATE` or an application-level mutex keyed by `youtube_id`.

---

## 2. Resource Leaks

### RL-1: FFmpeg Child Process Leak

**Severity:** 🟡 MAJOR
**Location:** `worker/clip-renderer.ts` — `execSync()` calls
**Description:** The worker uses `execSync` for ffmpeg commands. If ffmpeg hangs (e.g., due to corrupt video), `execSync` blocks the Node.js event loop indefinitely. The 120s timeout in the code caps this, but if the worker crashes during ffmpeg, the child process may become orphaned.
**Evidence:** `worker/clip-renderer.ts` uses `execSync` for ffmpeg. On Windows, orphaned processes are typically cleaned up by the OS, but not guaranteed.
**Fix needed:** Use `exec` with `child.kill()` in a timeout handler instead of `execSync`. Or add `process.on('exit')` cleanup hooks.

### RL-2: No Temp File Cleanup on Worker Crash

**Severity:** 🟢 MINOR
**Location:** `worker/clip-renderer.ts` — `finally` block
**Description:** The worker cleans up temp files in a `finally` block. However, if the worker crashes (SIGKILL, power loss), temp files in `cache/` and `temp/` persist. Over time, this accumulates disk usage.
**Evidence:** `finally` block deletes segment files individually. A crash during rendering leaves partial files.
**Fix needed:** Worker startup should scan and clean stale temp files before beginning the main loop.

### RL-3: Video Cache Never Evicted on Disk Full

**Severity:** 🟢 MINOR
**Location:** `worker/clip-renderer.ts` — cache management
**Description:** The cache has a 50 GB max with LRU eviction, but the actual eviction logic runs only on new cache insertion. If the disk fills up from other processes (not the cache), cache insertion fails silently and falls back to re-downloading the video every time.
**Evidence:** Cache manager checks total cache size on each insert. No proactive monitoring.
**Fix needed:** Add periodic cache cleanup or free-space check before download.

---

## 3. Edge Cases

### EC-1: Zero-Length Transcript

**Severity:** 🟡 MAJOR
**Location:** `lib/analyzer.ts` — `analyzeTranscript()`
**Description:** If a video has a transcript with 0 segments (e.g., a short with no speech), `extractCandidates()` returns `[]`, and the function returns `{ moments: [], model }`. The API responds 200 with empty results, not an error. The frontend displays blank results.
**Evidence:** Line 114-117: `if (candidates.length === 0) { return { moments: [], model: TARGET_MODEL } }`. No error thrown.
**Fix needed:** Throw `AppError('NO_MOMENTS_FOUND', ...)` or at minimum return a distinct status code.

### EC-2: Video Duration Metadata = 0

**Severity:** 🟡 MAJOR
**Location:** `lib/youtube.ts` — `fetchMetadata()`
**Description:** Some YouTube videos return duration_seconds = 0 when metadata fetch fails. The code falls back to transcript-based duration estimation (commit bfab829), but if the transcript is also empty, both durations are 0. This propagates to `analyzeTranscript()` where `effectiveDuration = 0`, causing ALL timestamps to fail validation (`startTime >= 0 AND startTime >= durationSeconds(0)` → all rejected).
**Evidence:** `lib/analyzer.ts` line 122: `const effectiveDuration = metadata.durationSeconds > 0 ? metadata.durationSeconds : transcriptDuration`
**Fix needed:** Add a minimum floor (e.g., 600s = 10 min) when both durations resolve to 0.

### EC-3: URL with Extra Parameters

**Severity:** 🟢 MINOR
**Location:** `lib/validators.ts` — `extractVideoId()`
**Description:** YouTube URLs can have extra parameters (`&si=...`, `&pp=...`, `&feature=shared`). The URL regex supports these, but the `si` tracking parameter sometimes exceeds the VARCHAR(20) limit on `youtube_id` if mis-parsed.
**Evidence:** The regex pattern extracts `v=` parameter, which should always be 11 chars. But edge cases (shorts URLs, live URLs, playlist URLs with `&v=`) are handled differently.
**Fix needed:** Verify that extracted IDs are always 11 characters before DB operations.

### EC-4: Worker Registration Without Name

**Severity:** 🟢 MINOR
**Location:** `app/api/workers/register/route.ts`
**Description:** The registration endpoint doesn't validate `workerName` length or content beyond what the DB `VARCHAR(100)` constraint enforces. A worker could register with an empty name.
**Evidence:** No Zod schema or manual validation on the request body for `workerName`.
**Fix needed:** Add input validation with minimum length (3 chars) and character restrictions.

---

## 4. Configuration Flaws

### CF-1: LLM Timeout vs Nginx Timeout Race

**Severity:** 🟡 MAJOR
**Location:** `lib/analyzer.ts` line 305 vs Nginx config
**Description:** The LLM call uses `AbortSignal.timeout(500_000)` = 500s. Nginx `proxy_read_timeout` is 600s. If the LLM takes 500s to respond and the response starts streaming at 499s, there's only 1s of buffer before Nginx's 600s timeout. In practice, this is fine — but if Nginx is ever reduced to 500s or the LLM timeout increased past 500s, we get an Nginx timeout error.
**Evidence:** Previous fix `e16a61e` increased timeout from 300s→500s to match Nginx. But the mismatch remains.
**Fix needed:** Make `LLM_API_TIMEOUT = proxy_read_timeout - 60s` for safer margin.

### CF-2: CORS Not Configured

**Severity:** 🟢 MINOR
**Location:** None (CORS headers absent)
**Description:** The Next.js config has no CORS headers. If a frontend on another domain (e.g., `ganyiq.vercel.app`) tries to call `ganyiq.ganys.me` API, CORS blocks it. Currently, the frontend and API are on the same origin, so this doesn't matter — but it blocks any future multi-origin deployment.
**Evidence:** `next.config.ts` is empty.
**Fix needed:** Add CORS headers for known origins, or configure them at the Nginx level.

### CF-3: No Worker Rate Limiting

**Severity:** 🟡 MAJOR
**Location:** All worker routes
**Description:** Worker endpoints (`/poll`, `/complete`, `/fail`, `/upload`, `/heartbeat`) are protected by Bearer token auth but NOT rate-limited. A compromised worker key could flood these endpoints.
**Evidence:** Only `POST /api/analyze` has rate limiting (`lib/rate-limit.ts`). Worker routes have no rate limit logic.
**Fix needed:** Add per-worker rate limiting (e.g., max 1 poll per 10s, max 5 uploads per minute).

---

## 5. Monitoring Gaps

### MG-1: No Fallback Rate Tracking

**Severity:** 🟢 MINOR
**Location:** `lib/analyzer.ts` — `metrics` object
**Description:** The `metrics` object (lines 37-43) tracks primary/fallback success rates but resets on process restart (Next.js redeploy). This means fallback rate data is lost every deploy.
**Evidence:** In-memory counters, no persistence. Logged every 20 successes, but those logs are ephemeral.
**Fix needed:** Write fallback metrics to a DB table or expose via `/api/metrics` endpoint.

### MG-2: No Job Age Dashboard

**Severity:** 🟢 MINOR
**Location:** None (missing feature)
**Description:** There is no way to see how long jobs have been pending, which jobs are stuck, or average processing time per job type.
**Evidence:** No `/api/jobs/metrics` endpoint. No queue depth monitoring.
**Fix needed:** Add an admin endpoint exposing queue depth, average wait time, jobs by status.

---

## 6. Security Issues

### SI-1: Env File Enumeration Attempts (Ongoing)

**Severity:** 🟡 MAJOR
**Location:** Nginx logs
**Description:** Multiple IPs (179.43.146.227, 78.153.140.156, 213.209.159.175) probe for `.env` files, `.git/config`, and other sensitive paths. Nginx blocks these with 403, but the frequency is high.
**Evidence:** Nginx error log shows ~50+ blocked probe attempts on June 7 alone across multiple hostnames.
**Fix needed:** Consider fail2ban rules for repeated 403 probes, or Cloudflare WAF.

### SI-2: PM2 Runs as Root

**Severity:** 🟡 MAJOR
**Location:** System-wide
**Description:** PM2 daemon and all managed processes run as root. A vulnerability in the Next.js application could give an attacker root access to the VPS.
**Evidence:** `ps aux` shows all PM2 processes running as `root`. PM2 systemd service is `pm2-root.service`.
**Fix needed:** Create a `nodeapp` user and migrate PM2 to run under that user.

---

## 7. Frontend Issues

### FI-1: Double-Click Submit

**Severity:** 🟢 MINOR
**Location:** `app/page.tsx`
**Description:** The "Analyze" button has no debounce or disabled state during analysis. A user could click twice, submitting two analyses of the same URL concurrently.
**Evidence:** The frontend sets `stage` state, but there's no disabled attribute on the button during processing. Rate limiting prevents double-processing at the server level, but only up to the rate limit check race condition (RC-4).
**Fix needed:** Disable button during analysis pipeline.

### FI-2: No Error Recovery for Failed Clip

**Severity:** 🟢 MINOR
**Location:** `app/page.tsx` — clip status polling
**Description:** When a clip status returns `failed`, the UI shows "Clip generation failed" but provides no retry button or explanation.
**Evidence:** Frontend shows error state but no retry action.
**Fix needed:** Add a "Retry" button that re-queues the clip job.

---

## 8. Architectural Issues

### AI-1: Worker-Package Duplication

**Severity:** 🟢 MINOR
**Location:** `/root/GANYIQ/worker/` and `/root/GANYIQ/worker-package/`
**Description:** The worker source code exists in two directories with nearly identical files but subtle differences (`renderClip()` signature differs). This is a maintenance burden — changes must be made in both places.
**Evidence:** `worker/clip-renderer.ts` has `renderClip(job, env, heartbeatFn)` while `worker-package/clip-renderer.ts` has `renderClip(job, env)`. The `worker-package/index.ts` calls renderClip without heartbeatFn.
**Fix needed:** Eliminate `worker-package/` and generate it from `worker/` during the build/packaging step.

### AI-2: No Feature Flags or A/B Testing

**Severity:** 🟢 MINOR
**Location:** None (missing system-wide)
**Description:** There's no way to gradually roll out features or A/B test prompt versions. Every deployment to production is an all-or-nothing change.
**Evidence:** No feature flags in codebase. No canary deployment.
**Fix needed:** Add environment-variable-based feature flags for major experimental features.

---

## Summary of New Findings

| ID | Type | Severity | Category | Description |
|---|---|---|---|---|
| RC-2 | Race Condition | 🔴 CRITICAL | Job System | Non-idempotent job completion allows double-counting |
| RC-3 | Race Condition | 🟡 MAJOR | Job System | Cron cleanup vs worker poll race on stale job release |
| RC-1 | Race Condition | 🟡 MAJOR | Worker Stats | Worker jobs counter race under concurrent requests |
| CF-1 | Configuration | 🟡 MAJOR | LLM Pipeline | LLM timeout (500s) too close to Nginx timeout (600s) |
| CF-3 | Configuration | 🟡 MAJOR | Security | No rate limiting on worker routes |
| SI-1 | Security | 🟡 MAJOR | Infrastructure | Active .env file probing from bot networks |
| SI-2 | Security | 🟡 MAJOR | Infrastructure | PM2 and all processes run as root |
| RL-1 | Resource Leak | 🟡 MAJOR | Worker | Orphaned ffmpeg processes on worker crash |
| EC-1 | Edge Case | 🟡 MAJOR | Analysis | Zero-length transcript returns empty success, not error |
| EC-2 | Edge Case | 🟡 MAJOR | Analysis | Video with 0s duration causes all moments to fail validation |
| AI-1 | Architecture | 🟢 MINOR | Codebase | Worker-package duplication with subtle signature drift |
| RC-4 | Race Condition | 🟢 MINOR | Rate Limiting | Rate limit check race allows +1-2 extra requests |
| RC-5 | Race Condition | 🟢 MINOR | Cache | Duplicate transcript fetch race on concurrent analysis |
| CF-2 | Configuration | 🟢 MINOR | Architecture | No CORS configuration limits multi-origin deployment |
| MG-1 | Monitoring | 🟢 MINOR | Observability | Fallback metrics lost on every deploy (RAM-only) |
| FI-1 | Frontend | 🟢 MINOR | UX | No button disabled state allows double-submit |
| FI-2 | Frontend | 🟢 MINOR | UX | Failed clip has no retry mechanism |
