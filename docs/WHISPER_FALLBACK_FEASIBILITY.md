# Whisper Fallback Feasibility Audit

> **Date:** 2026-06-02
> **Purpose:** Evaluate whether a Whisper-based speech-to-text fallback is feasible for Indonesian podcast transcript acquisition in GANYIQ's current Vercel + Neon architecture.
> **Status:** Pre-implementation feasibility audit

---

## 1. Current State

```
┌──────────────────────────────────────────────────────────────────┐
│                      CURRENT PIPELINE                            │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  YouTube URL → validate → InnerTube API → XML parse →           │
│  DeepSeek analysis → ranking → PostgreSQL → response             │
│                                                                  │
│  FAILURE MODE: LOGIN_REQUIRED (Indonesian videos)                │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Transcript Success Rate (Vercel Production)

| Category | Success | Count |
|---|---|---|
| English (Rick Astley) | ✅ 100% | 1/1 |
| Indonesian (Raditya Dika, Deddy Corbuzier, Suara Berkelas) | ❌ 0% | 0/3 |
| **Overall** | **25%** | **1/4** |

**Root cause:** YouTube returns `LOGIN_REQUIRED` for Indonesian content from cloud IPs (Vercel + DigitalOcean). Not a code bug.

---

## 2. Audio Acquisition Methods

### 2.1 yt-dlp ✅ Best Option

| Factor | Assessment |
|---|---|
| Installed on VPS | ✅ v2026.03.17 |
| Vercel compatibility | ❌ Binary not available in serverless |
| DO IP block (English) | ✅ Works (Rick Astley verified) |
| DO IP block (Indonesian) | ❌ LOGIN_REQUIRED (same as API) |
| DO IP + cookies.txt (Indonesian) | ❌ Still fails — JS challenge unsolvable |
| Audio-only extraction | ✅ Formats available: opus 46kbps, m4a 49kbps |
| File size (60min podcast) | ~17-20MB (opus/m4a) |

**Verdict:** yt-dlp works but faces the same IP restrictions. However, running yt-dlp on a **non-cloud network** (residential proxy, or downloaded externally) would bypass.

### 2.2 youtubei.js (current library)

| Factor | Assessment |
|---|---|
| Currently used | ✅ Already in codebase |
| Metadata fetch | ✅ Working (after cache fix) |
| InnerTube caption fetch | ❌ Fails with LOGIN_REQUIRED for Indonesian |
| Audio download capability | ✅ Has `download()` method, but untested |
| Vercel compatibility | ⚠️ Needs `/tmp` for cache (already fixed) |

**Verdict:** youtubei.js can potentially download audio streams, but would face same IP block for Indonesian content.

### 2.3 Direct Stream Extraction

| Factor | Assessment |
|---|---|
| Base URL | YouTube delivers audio via progressive streams or DASH |
| Auth required | Same InnerTube API keys needed |
| IP dependency | Same block applies |
| Complexity | Very high — custom stream parsing |

**Verdict:** Not recommended. Same IP block, higher complexity than yt-dlp.

### 2.4 YouTube Data API v3 (Captions)

| Factor | Assessment |
|---|---|
| Official Google API | ✅ v3 is official and supported |
| Cost | Free: 200 queries/day ($5/1,000 after) |
| IP independence | ✅ Uses Google's infrastructure, not caller's IP |
| Caption coverage | Only videos that HAVE captions enabled |
| Indonesian caption coverage | Unknown — depends on uploader |
| Transcript format | `textTrack` format available |

**Verdict:** Promising alternative for caption acquisition. Bypasses IP block entirely because requests go to `youtube.googleapis.com` not `www.youtube.com`. Worth testing before Whisper fallback.

---

## 3. Speech-to-Text Provider Comparison

| Provider | Cost/min | Indonesian Support | Timestamps | URL Submission | Vercel Compatible |
|---|---|---|---|---|---|
| **Deepgram** (nova-2) | $0.0043 | ✅ Yes (language: id) | ✅ Word-level | ✅ Yes (URL) | ✅ ✅ ✅ |
| **AssemblyAI** (best) | $0.0375 | ✅ Yes (17+ languages) | ✅ Word+Paragraph | ✅ Yes (URL) | ✅ ✅ ✅ |
| **OpenAI Whisper API** | $0.0060 | ✅ Yes (99 langs) | ⚠️ Approx (chunked) | ❌ File upload only | ❌ (25MB limit) |
| **Groq Whisper** | **FREE** (1,440 req/day) | ⚠️ multilingual model | ⚠️ Basic | ❌ File upload only | ❌ (25MB limit) |

### Key Constraint

**Vercel serverless CANNOT handle file uploads to STT APIs:**
- Max execution time: 60s (Hobby) / 300s (Pro)
- Audio download + upload to STT would exceed this for long podcasts
- Max request body: 4.5MB

**Therefore, only URL-submission providers (Deepgram, AssemblyAI) work with Vercel.**

---

## 4. Vercel Serverless Constraints Analysis

| Constraint | Limit | Impact on Audio Processing |
|---|---|---|
| Execution timeout | 60s (Hobby) / 300s (Pro) | ❌ Downloading 60min+ audio impossible |
| Memory | 1024MB | ⚠️ Tight for audio processing |
| Ephemeral storage (/tmp) | 512MB | ✅ Enough for 20MB audio file |
| Binary support | No yt-dlp binary | ❌ Cannot download audio |
| Request body | 4.5MB | ❌ Cannot upload audio files |
| Response size | 4.5MB | ✅ Transcript JSON is small (~100KB) |

**Conclusion:** Audio processing CANNOT run entirely on Vercel serverless. Must use either:
- **A.** URL-submission STT API (Deepgram/AssemblyAI)
- **B.** External worker (VPS-based processing)
- **C.** Hybrid: VPS downloads audio → sends to STT API

---

## 5. Hybrid Strategy Design

### Recommended Architecture

```
┌──────────┐     YouTube URL      ┌──────────┐
│          │ ───────────────────→ │          │
│  Client  │                      │  Vercel  │
│          │ ←── moments JSON ── │  (API)   │
└──────────┘                      └────┬─────┘
                                       │
                              ┌────────┴────────┐
                              │  Try InnerTube   │
                              │  captions first  │
                              └────────┬────────┘
                                       │
                         ╔═════════════╩═════════════╗
                         ║ SUCCESS?                   ║
                         ║    │ YES          │ NO     ║
                         ╚════╪══════════════╪════════╝
                              │              │
                              │     ┌────────┴────────┐
                              │     │  Dispatch to     │
                              │     │  STT Provider    │
                              │     │  (via URL)       │
                              │     └────────┬────────┘
                              │              │
                              │     ┌────────┴────────┐
                              │     │  STT downloads   │
                              │     │  audio internally│
                              │     │  (their IP, not  │
                              │     │  Vercel's IP)    │
                              │     └────────┬────────┘
                              │              │
                              │     ┌────────┴────────┐
                              │     │  Return          │
                              │     │  transcript      │
                              │     └────────┬────────┘
                              │              │
                         ╔════╩══════════════╩══════╗
                         ║  Continue with DeepSeek  ║
                         ║  analysis + ranking +    ║
                         ║  DB storage              ║
                         ╚═══════════════════════════╝
```

### Pipeline Changes Required

**Current (simplified):**
```
fetchVideoData()
  → try InnerTube captions
  → if LOGIN_REQUIRED, throw
```

**Proposed:**
```
fetchVideoData()
  → try InnerTube captions (Step 1)
  → if LOGIN_REQUIRED:
      → try YouTube Data API v3 captions (Step 2 - NEW)
      → if STILL unavailable:
          → call WhisperFallback (Step 3 - NEW)
            → POST youtube URL to STT provider
            → poll for result
            → return transcript
```

### Files to Create/Modify

| File | Action | Purpose |
|---|---|---|
| `lib/youtube.ts` | Modify `fetchCaptionTracksWithFallback()` | Add YouTube Data API v3 step |
| `lib/youtube-tts.ts` | **New file** | Whisper fallback provider logic |
| `lib/types.ts` | Modify | Add Whisper config types |
| `.env.local` / Vercel env | Add | `WHISPER_API_KEY` (Deepgram or AssemblyAI) |
| `docs/WHISPER_OPERATIONS.md` | **New file** | Provider API usage docs |

### Code Change Estimate

- **YouTube Data API v3**: ~50 lines (new fetch method)
- **Whisper fallback service**: ~150 lines (provider abstraction + polling)
- **Pipeline orchestration**: ~30 lines (conditional fallback chain)
- **Total**: ~230 lines of new code

---

## 6. STT Provider Deep Dive

### 6.1 Recommended: Deepgram (nova-2)

| Factor | Value |
|---|---|
| Cost | $0.0043/min → $0.258/hr → ~$0.26 per 60min podcast |
| Indonesian support | ✅ `language: id` parameter |
| URL submission | ✅ `POST {"url": "..."}` — Vercel-compatible |
| Speed | ~1-2x real-time (streaming available) |
| Timestamps | ✅ Word-level |
| Free tier | First $200 credit, no expiry |
| Key API call | `POST https://api.deepgram.com/v1/listen?model=nova-2&language=id&punctuate=true&utterances=true&diarize=false` |

**Why Deepgram over AssemblyAI:**
- 8.7x cheaper ($0.0043 vs $0.0375 per min)
- More languages (30+ vs 17+)
- Faster (~1x real-time vs ~2-3x)
- Better free tier ($200 vs $50)

### 6.2 Secondary: AssemblyAI

| Factor | Value |
|---|---|
| Cost | $0.0375/min → $2.25/hr |
| Differentiator | Speaker diarization, content moderation, chapter detection |
| URL submission | ✅ Accepts audio URLs directly |
| **Risk** | Expensive at scale |

### 6.3 Not Recommended for Vercel

| Provider | Why Not |
|---|---|
| **OpenAI Whisper API** | File upload only (max 25MB). Vercel can't handle file upload within 60s. |
| **Groq Whisper** | Same file upload limitation. Free but impractical on Vercel. |
| **Self-hosted Whisper (VPS)** | Requires GPU for real-time processing. DO VPS has no GPU. CPU-only faster-whisper would take 5-10x real-time (5-10 hours for 1hr podcast). |

---

## 7. Cost Model

### Assumptions
- Average podcast: **60 minutes**
- Transcript success rate (InnerTube): **25%** (English works, Indonesian fails)
- Whisper fallback needed for: **75% of analyses** (Indonesian videos)
- Cost calculated for Deepgram ($0.0043/min)

### Scenario: 10 analyses/day

| Component | Daily Volume | Monthly Cost |
|---|---|---|
| InnerTube captions (free) | 2.5 videos/day | $0 |
| Deepgram fallback (7.5 videos × 60min) | 450 min/day | **$1.94/day → $58/mo** |
| DeepSeek API (10 analyses) | 10/day | ~$0.50/mo (negligible) |
| **Total** | | **~$58/mo** |

### Scenario: 100 analyses/day

| Component | Daily Volume | Monthly Cost |
|---|---|---|
| Deepgram fallback (75 videos × 60min) | 4,500 min/day | **$19.35/day → $581/mo** |
| DeepSeek API (100 analyses) | 100/day | ~$5/mo |
| **Total** | | **~$586/mo** |

### Scenario: 1,000 analyses/day

| Component | Daily Volume | Monthly Cost |
|---|---|---|
| Deepgram fallback (750 videos × 60min) | 45,000 min/day | **$193.50/day → $5,805/mo** |
| DeepSeek API (1,000 analyses) | 1,000/day | ~$50/mo |
| **Total** | | **~$5,855/mo** |

### Cost Optimization Opportunities

| Strategy | Savings | Complexity |
|---|---|---|
| Cache transcripts (already implemented) | High | ✅ Already done |
| YouTube Data API v3 (free, 200 queries/day) | 200 free checks/day | Low (implement first) |
| Only transcribe unique videos | Medium | Low |
| Use Groq for short videos (<10min) | Low | Medium |
| Batch processing with compression | Medium | Medium |
| Negotiate Deepgram volume pricing | 30-50% | Low (email sales) |

---

## 8. YouTube Data API v3 — Priority Pre-requisite

**Before implementing Whisper fallback, test YouTube Data API v3 captions.**

### Why

YouTube Data API v3 uses Google's infrastructure (not caller's IP):
- `GET https://youtube.googleapis.com/youtube/v3/captions/{captionId}?key={API_KEY}`
- Requests go to `youtube.googleapis.com`, not `www.youtube.com`
- No IP reputation issues — Google authenticates by API key

### What We Need

1. **Enable YouTube Data API v3** in Google Cloud Console
2. **Get API key** (free, 200 queries/day)
3. **List caption tracks**: `GET /youtube/v3/captions?part=snippet&videoId={id}`
4. **Download caption**: `GET /youtube/v3/captions/{id}?key={key}&tfmt=srt`

### Expected Impact

- **Conservative estimate**: 30-50% of Indonesian videos have auto-generated captions
- **Best case**: 70%+ coverage (YouTube auto-generates Indonesian captions for popular content)
- **Cost**: $0 (200 free queries/day — more than our current rate of ~10/day)

**Implementation complexity:** ~50 lines of code, 1-2 hours.

---

## 9. Recommendation

### Immediate (Do First) — YouTube Data API v3 ⏰ 2 hours

```
1. Enable YouTube Data API v3 in Google Cloud Console
2. Add caption fetch via v3 as Step 1b in fetchCaptionTracksWithFallback()
3. Test with Indonesian videos
4. Measure new success rate
```

**Expected cost:** $0 (free tier — 200 queries/day)
**Expected success rate improvement:** +30-50% (conservative) to +70% (optimistic)
**Risk:** Very low — official Google API, well-documented, no IP dependency

### Short-term — Deepgram Whisper Fallback ⏰ 4-6 hours

**Only if YouTube Data API v3 doesn't achieve >80% coverage.**

```
1. Add DEEPGRAM_API_KEY to env vars
2. Create lib/youtube-tts.ts — Deepgram URL-submission wrapper
3. Add fallback step after YouTube Data API fails
4. Poll for transcription completion
5. Parse into TranscriptSegment[] format
```

### Long-term (Scale) — VPS Whisper Worker 🕐 2-3 days

**Only at 100+ analyses/day when costs become significant.**

```
1. Deploy faster-whisper on VPS
2. Vercel → VPS worker → faster-whisper → return transcript
3. Eliminates per-minute API costs
4. One-time infra setup ~$6/mo DO droplet
```

---

## 10. Decision Matrix

| Strategy | Success Rate | Cost (100/day) | Implementation | Timeline |
|---|---|---|---|---|
| **Current** (InnerTube only) | ~25% | $0 | ✅ Done | Now |
| **+ YouTube Data API v3** | ~60-80%* | **$0** | ✅ Easy | **Do this first** |
| **+ Deepgram fallback** | ~95%+ | **$586/mo** | ⏳ 4-6 hours | After YT API test |
| **+ VPS Whisper worker** | ~95%+ | **$6/mo** (VPS) | ⏳ 2-3 days | At scale |

*\*Estimated based on typical YouTube auto-caption coverage for Indonesian content*

---

## 11. Final Verdict

```
╔═══════════════════════════════════════════════════════════════╗
║                                                               ║
║                    WHISPER FALLBACK                           ║
║                    FEASIBILITY VERDICT                        ║
║                                                               ║
║  ✅ FEASIBLE with URL-submission providers (Deepgram)         ║
║  ❌ NOT POSSIBLE on Vercel alone (file upload providers)      ║
║                                                               ║
║  RECOMMENDATION:                                              ║
║  1. Implement YouTube Data API v3 FIRST (free, ~2h)           ║
║  2. If coverage <80%, add Deepgram fallback (~$0.26/video)    ║
║  3. At 100+/day, consider VPS Whisper worker for cost saving  ║
║                                                               ║
╚═══════════════════════════════════════════════════════════════╝
```

### Implementation Order

| Priority | Task | Est. Effort | Cost Impact |
|---|---|---|---|
| 🔴 **P0** | YouTube Data API v3 integration | 2 hours | $0 (free tier) |
| 🟡 **P1** | Deepgram fallback (if needed) | 4-6 hours | $58-586/mo |
| 🟢 **P2** | Cache optimization (dedup unique videos) | 1 hour | Reduces costs |
| 🔵 **P3** | VPS Whisper worker (at scale) | 2-3 days | ~$6/mo VPS |

---

*End of feasibility audit. No implementation begun.*
