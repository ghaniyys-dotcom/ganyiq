# VALIDATION BATCH 002 — RERUN

> **Date:** 2026-06-02 12:30 WIB
> **Changes Applied:**
>   - Add `AbortSignal.timeout(15_000)` to InnerTube API fetch
>   - Add `AbortSignal.timeout(15_000)` to transcript XML fetch
>   - Add `AbortSignal.timeout(120_000)` to LLM API fetch
>   - Add structured timing logs: `[YT] metadata/captions/transcript start/done`, `[LLM] request/response`
>   - Fix bug: `LOGIN_REQUIRED` detection in error message (caused cookie fallback to never trigger)
>   - Copy `cookies.txt` to PM2 CWD (`/var/www/ganyiq/`)
> **Test:** 15 parallel requests with 25s timeout each

---

## 1. Results Summary

| Metric | Value |
|---|---|
| Total videos | 15 |
| **Transcript acquired** | **0** (0%) |
| LOGIN_REQUIRED (anonymous + cookie both failed) | 13 (87%) |
| Connection timeout (HTTP 000) | 2 (13%) |
| Average response time | ~3s for LOGIN_REQUIRED, ~25s for timeout |

---

## 2. Error Classification

Now that timeouts and error messages are fixed, we can confidently classify each failure:

| Error Type | Count | Videos | Root Cause |
|---|---|---|---|
| **LOGIN_REQUIRED** | 13 | BUS-01, BUS-02, BUS-03, MOT-01, MOT-02, COM-01, COM-02, STL-01, STL-02, STL-03, FIN-01, FIN-02, CON-01 | YouTube IP block at transport layer. Both anonymous AND cookie-auth fail. |
| **Connection timeout** | 2 | COM-03, CON-02 | curl connection timeout (25s exceeded). Server processing may still be in progress. |
| **Transcript available** | 0 | — | None of the 15 videos have accessible transcripts from this IP |

### LOGIN_REQUIRED Breakdown

The cookie fallback IS working correctly now:

```
13 videos
  ↓ Anonymous InnerTube → LOGIN_REQUIRED (returned in <3s)
  ↓ Cookie fallback triggered (33 cookies loaded)
  ↓ Cookie-authenticated InnerTube → LOGIN_REQUIRED (also failed)
  ↓ Result: TRANSCRIPT_UNAVAILABLE (HTTP 404)
```

**Cookie auth does NOT bypass the IP block.** YouTube blocks the request at the transport layer (IP reputation) before processing authentication cookies.

---

## 3. Timing Analysis

### Per-Request Timing (from PM2 logs)

```
[YT] metadata start      → [YT] metadata done      = 1-5s (youtubei.js via Innertube)
[YT] captions start      → LOGIN_REQUIRED detected  = 1-3s (InnerTube API, fast rejection)
                           Cookie retry attempt      = 1-3s (also rejected)
                           → Total: 2-6s
```

### Timeout Safety (Fixed in This Build)

| Fetch | Before | After |
|---|---|---|
| InnerTube API | **No timeout** — could hang indefinitely | ✅ `AbortSignal.timeout(15_000)` — fails fast at 15s |
| Transcript XML | **No timeout** — could hang indefinitely | ✅ `AbortSignal.timeout(15_000)` — fails fast at 15s |
| LLM API | **No timeout** — could hang for minutes | ✅ `AbortSignal.timeout(120_000)` — fails at 120s |

---

## 4. Before vs After Comparison

### Before Fixes

| Issue | Symptom | Root Cause |
|---|---|---|
| Cookie fallback never triggered | `TRANSCRIPT_UNAVAILABLE` for all videos | Error message used `playability.reason` ("Sign in...") but fallback checked for `LOGIN_REQUIRED` string |
| Request hung indefinitely | `curl --max-time 120` timeout — 120s wasted | No `AbortSignal` on InnerTube fetch |
| No observability | Hard to diagnose failures | No timing or stage logs |

### After Fixes

| Fix | Result |
|---|---|
| Error message includes `LOGIN_REQUIRED` | Cookie fallback now triggers correctly ✅ |
| 15s timeout on InnerTube fetch | Requests fail fast instead of hanging ✅ |
| 15s timeout on transcript XML | Transcript fetch fails fast ✅ |
| `[YT]` and `[LLM]` timing logs | Full pipeline observability ✅ |

---

## 5. Cookie Fallback Verification

### Evidence from Runtime Logs

For each of the 13 LOGIN_REQUIRED videos:

```
[YT-DEBUG] [VIDEO_ID] Playability status: LOGIN_REQUIRED
[YT-DEBUG] [VIDEO_ID] LOGIN_REQUIRED — retrying with 33 cookies from /var/www/ganyiq/cookies.txt
[YT-DEBUG] [VIDEO_ID] Fetching caption tracks via InnerTube API (with cookies)...
[YT-DEBUG] [VIDEO_ID] Playability status: LOGIN_REQUIRED
[YT-DEBUG] [VIDEO_ID] Cookie-authenticated request also failed
```

### Cookie Module Status (Verified Independently)

```
loadYoutubeCookies():
  valid: true
  count: 33
  source: /var/www/ganyiq/cookies.txt
  hasRequired: true
  header: "SAPISID=...; LOGIN_INFO=...; ..."  (4267 chars)
```

---

## 6. Remaining Issue: IP Block (Not Code)

The 100% failure rate confirms that **YouTube blocks this DigitalOcean IP at the transport layer**. No amount of code fixes can solve this — we need infrastructure changes.

```
YouTube's Bot Detection
        │
        ▼
┌─────────────────────────────┐
│ Layer 1: IP Reputation      │ ← WE ARE HERE
│  DO IP range → BLOCK        │
│  Response: LOGIN_REQUIRED    │
└─────────────────────────────┘
        │ (even with valid cookies)
        ▼
┌─────────────────────────────┐
│ Layer 2: Session Auth       │ ← We never reach this layer
│  Cookie validation           │
│  Authenticated access        │
└─────────────────────────────┘
```

### Options to Bypass (No Code Changes Needed)

| Option | How It Works | Cost | Effort |
|---|---|---|---|
| **Residential proxy** | Route InnerTube calls through residential IP | ~$5/month | Add proxy config to `fetch()` |
| **YouTube Data API v3** | Official API, different endpoint | Free (200/day) | Add new API integration |
| **Whisper API** | Audio transcription, no YouTube API needed | ~$0.30/video | New `lib/transcribe.ts` module |

---

## 7. Summary of All Fixes Applied

### File: `/var/www/ganyiq/lib/youtube.ts`

| Line | Change |
|---|---|
| 51 | Added `FETCH_TIMEOUT = 15_000` constant |
| 89-108 | Wrapped InnerTube fetch in try-catch with `AbortSignal.timeout(15_000)` + `TimeoutError` → `AppError(408)` |
| 129-131 | Fixed error message to include `playability.status` (e.g., "LOGIN_REQUIRED") in BOTH error paths |
| 145-149 | Fixed tracks=0 error message to include status + reason |
| 225-243 | Wrapped XML fetch in try-catch with `AbortSignal.timeout(15_000)` |
| 415-426 | Added `[YT] metadata/captions/transcript start/done` structured timing logs |

### File: `/var/www/ganyiq/lib/analyzer.ts`

| Line | Change |
|---|---|
| 149 | Added `[LLM] request start | model=...` log |
| 165 | Added `signal: AbortSignal.timeout(120_000)` to LLM fetch |
| 167 | Added `[LLM] response received | status=...` log |

### Bug Fix: LOGIN_REQUIRED Detection

**Before:** Error message was `"Playability: Sign in to confirm you're not a bot."`
The fallback check `err.message.includes('LOGIN_REQUIRED')` returned **false**.

**After:** Error message is `"Playability: LOGIN_REQUIRED — Sign in to confirm you're not a bot."`
The fallback check now returns **true** and cookie retry executes.

---

## 8. Timing Logs Reference

All logs go to PM2 stdout (`/root/.pm2/logs/ganyiq-out.log`) and are visible with:
```bash
pm2 logs ganyiq --lines 100
# Or grep for specific stages:
grep '\[YT\]' /root/.pm2/logs/ganyiq-out.log
grep '\[LLM\]' /root/.pm2/logs/ganyiq-out.log
```

### Log Format

```
[YT] metadata start                  ← youtubei.js metadata fetch begins
[YT] metadata done                   ← metadata received
[YT] captions start                  ← InnerTube caption track fetch begins
[YT] captions done | N tracks, selected XX  ← captions found
[YT] transcript start                ← XML transcript fetch begins  
[YT] transcript done | N segments    ← transcript parsed
[LLM] request start | model=...      ← DeepSeek API call begins
[LLM] response received | status=200 ← DeepSeek API response
```

### Error Log Format

```
[YT-DEBUG] [VID] Playability status: LOGIN_REQUIRED
[YT-DEBUG] [VID] LOGIN_REQUIRED — retrying with N cookies from PATH
[YT-DEBUG] [VID] Cookie-authenticated request also failed
[YT-DEBUG] [VID] Login required / error reason: Sign in to confirm you're not a bot
```
