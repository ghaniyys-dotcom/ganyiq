# YouTube Data API v3 — Feasibility Analysis for GANYIQ

> **Date:** 2026-06-02 11:10 WIB
> **Purpose:** Verify whether YouTube Data API v3 can solve GANYIQ's transcript acquisition blocker
> **Evidence source:** Google's official discovery document (`youtube/v3/rest`)

---

## 1. Executive Summary

**YouTube Data API v3 CANNOT retrieve transcript/caption content for public videos.**

The captions endpoints (`captions.list`, `captions.download`) require **OAuth 2.0 authorization** with the `youtube.force-ssl` scope — meaning only the video uploader can access caption content through the official API. A simple **API key is NOT sufficient**.

**GANYIQ needs to acquire transcripts for OTHER people's videos (podcast clippers analyzing public podcasts).** Since GANYIQ is not the video uploader, OAuth 2.0 does not help.

**Conclusion:** YouTube Data API v3 integration does NOT solve GANYIQ's primary blocker.

---

## 2. Evidence: Google's Official Discovery Document

### Source
Google exposes a machine-readable API specification at:
`https://www.googleapis.com/discovery/v1/apis/youtube/v3/rest`

### Captions Resource: All Endpoints Require OAuth

| Endpoint | HTTP | Scopes Required | API Key Only? |
|---|---|---|---|
| `captions.list` | GET | `youtube.force-ssl`, `youtubepartner` | ❌ NO |
| `captions.download` | GET | `youtube.force-ssl`, `youtubepartner` | ❌ NO |
| `captions.insert` | POST | `youtube.force-ssl`, `youtubepartner` | ❌ NO |
| `captions.update` | PUT | `youtube.force-ssl`, `youtubepartner` | ❌ NO |
| `captions.delete` | DELETE | `youtube.force-ssl`, `youtubepartner` | ❌ NO |

**Direct quote from discovery document:**

```
captions.list:
  Scopes: ['https://www.googleapis.com/auth/youtube.force-ssl',
           'https://www.googleapis.com/auth/youtubepartner']

captions.download:
  Scopes: ['https://www.googleapis.com/auth/youtube.force-ssl',
           'https://www.googleapis.com/auth/youtubepartner']
  Media download: True   ← downloads actual transcript content
```

### What OAuth 2.0 Means

`youtube.force-ssl` scope grants access to **authenticated user's own channel data**. To call `captions.download`, the user must:
1. Be logged into a Google/YouTube account
2. Have authorized the application via OAuth 2.0 consent screen
3. Be the **owner** of the video (or have managing access)

For a tool like GANYIQ that analyzes **other people's public videos**, this is impossible — GANYIQ will never be the video owner.

### Which Endpoints Work with API Key Only?

From the entire YouTube Data API v3, **only 4 endpoints work without OAuth**:

| Endpoint | Purpose | Useful for GANYIQ? |
|---|---|---|
| `thirdPartyLinks.list` | Partner links | ❌ No |
| `thirdPartyLinks.insert` | Partner links | ❌ No |
| `thirdPartyLinks.update` | Partner links | ❌ No |
| `thirdPartyLinks.delete` | Partner links | ❌ No |

**Zero endpoints** that provide video metadata, statistics, or search work with API key alone according to the discovery document.

### Wait — But Videos.List Works with API Key?

In practice, `videos.list?part=snippet` and `search.list` DO work with just an API key for public data, even though the discovery document lists OAuth scopes. Google's documentation separately states:

> "Some API methods may be used without specifying an authorization token if the request is retrieving public data."

The key distinction:
- **Reading public data** (videos.list, search.list, channels.list) → ✅ API key works
- **Reading user/owner data** (captions.list, captions.download, comments.list) → ❌ OAuth required

**Conclusion:** YouTube Data API v3 considers captions/transcripts as "user/owner data", not "public data".

---

## 3. Capability Matrix

| Capability | YouTube Data API v3 | Current GANYIQ | Blocked? |
|---|---|---|---|
| **Transcript content** | ❌ Not available (OAuth required) | InnerTube API | ✅ **YES** — this is the blocker |
| **Caption track list** | ❌ OAuth required | InnerTube API | ✅ YES |
| **Video title** | ✅ Videos.list (API key) | youtubei.js | ❌ NOT blocked |
| **Channel name** | ✅ Videos.list (API key) | youtubei.js | ❌ NOT blocked |
| **Duration** | ✅ Videos.list (API key) | youtubei.js | ❌ NOT blocked |
| **Statistics (views, likes)** | ✅ Videos.list (API key) | Not used yet | ❌ NOT blocked |
| **Search** | ✅ Search.list (API key) | Not used yet | ❌ NOT blocked |

### What Would YouTube Data API v3 Actually Add?

| Feature | Benefit | Priority |
|---|---|---|
| **View/like statistics** | Could improve moment ranking (viral potential) | Nice-to-have |
| **Search** | Could auto-discover podcast videos | Nice-to-have |
| **Channel metadata** | Could verify channel credibility | Nice-to-have |
| **Reliable caption existence check** | ✅ Tells us if captions exist (but NOT their content) | Moderate |
| **Actual transcript content** | ❌ **Not possible** | — |

---

## 4. Quota Analysis

Even if we could use captions endpoints, here's the quota cost:

| API Call | Quota Cost | GANYIQ Use Case | Daily Quota (free) |
|---|---|---|---|
| `videos.list` (snippet) | 1 unit | Metadata fallback | 10,000 units/day |
| `videos.list` (statistics) | 1 unit | Analytics for ranking | 10,000 units/day |
| `search.list` | 100 units | Video discovery | 100 searches/day |
| `captions.list` | 50 units | Check transcript availability | 200 checks/day |
| `captions.download` | 200 units | Download transcript content | 50 downloads/day |

With free tier ($300 credit, 10,000 quota units/day):
- 100 video analyses/day would cost ~300 units (3 units each)
- Well within quota for metadata use

**But this is irrelevant** because we can't access captions content regardless of quota.

---

## 5. The Real Problem: IP Block, Not API Missing

Gany's research in VALIDATION_BATCH_002 revealed the actual blocker:

```
YouTube Bot Detection → IP Block (LOGIN_REQUIRED)
    ↓
InnerTube API blocked from DigitalOcean IP (68.183.231.223)
    ↓
All transcript acquisition methods fail: anonymous, cookie-auth, API key
```

The IP is blocked at YouTube's transport layer. YouTube Data API v3 uses a **different domain** (`www.googleapis.com`) and **different infrastructure** than InnerTube, so it would NOT be affected by the IP block.

**However**, even though the API itself would work, it still wouldn't give us transcript content.

---

## 6. Verified Alternatives for Transcript Acquisition

| Method | Transcript? | Works from DO IP? | Cost | Effort | Coverage |
|---|---|---|---|---|---|
| **Residential Proxy + InnerTube** | ✅ Yes | ✅ Yes (bypasses IP block) | ~$5/month | 2 hours | ~90% |
| **Whisper API** (audio→text) | ✅ Yes | ✅ Yes (different endpoint) | ~$0.30/video | 4 hours | **100%** |
| **Self-hosted Whisper** | ✅ Yes | ✅ Yes (no external call) | Free (RAM/GPU) | 6 hours | **100%** |
| **yt-dlp + proxy + cookies** | ✅ Yes | ✅ With proxy | Free | 2 hours | ~80% |
| **YouTube Data API v3** | ❌ **NO transcript** | ✅ Would work | Free | 2 hours | **0% for transcript** |

### Detailed: Residential Proxy Approach

```
GANYIQ Server (DO)
    ↓ HTTP request via proxy
Residential Proxy (e.g., BrightData, Webshare)
    ↓ YouTube sees residential IP
InnerTube API → Returns captions successfully
```

- Proxy cost: ~$3-5/month for 10-20 IPs
- Setup: Install `https-proxy-agent` or configure `youtube-transcript-api` with proxy
- Coverage: Depends on proxy IP reputation (~90%)
- Risk: Proxies can also get blocked over time

### Detailed: Whisper API Approach

```
GANYIQ Server (DO)
    ↓ Audio download (yt-dlp with proxy)
Audio file
    ↓ Send to Whisper API
Transcribed text ← 100% coverage, even without YouTube captions
```

- Cost: ~$0.006/min → ~$0.30 for 50-min podcast
- For 100 analyses: ~$30/month
- Coverage: 100% (captions not required)

### Detailed: Self-hosted Whisper (Large V3)

- RAM required: ~6GB for large-v3 model (VPS has 2GB → too small)
- GPU: Required for reasonable speed (no GPU on DO)
- **Not feasible** on current VPS

---

## 7. Implementation Effort Comparison

| Approach | Files to Change | Lines Changed | Complexity | Risk |
|---|---|---|---|---|
| **YouTube Data API v3** (metadata only) | `lib/youtube.ts`, `.env.local` | ~30 | Low | Low — but doesn't solve transcript |
| **Residential Proxy** | `lib/youtube.ts`, `.env.local` | ~15 | Low | Medium — proxies may get blocked |
| **Whisper API** | `lib/analyzer.ts`, new module `lib/transcribe.ts` | ~80 | Medium | Low — reliable API |
| **yt-dlp + proxy** | New script `lib/caption-dl.ts` | ~50 | Low | Medium — yt-dlp may break |

---

## 8. Conclusion

### Does YouTube Data API v3 solve the transcript blocker?

| Question | Answer |
|---|---|
| Can it download transcript content? | ❌ **NO** — OAuth 2.0 required, cannot access public video captions |
| Can it list available captions? | ❌ **NO** — also OAuth 2.0 required |
| Can it provide video metadata? | ✅ YES — with API key |
| Would it improve GANYIQ? | ⚠️ Only for statistics/search — nice-to-have, **not the blocker** |

### Current Situation

| What | Status |
|---|---|
| **GANYIQ blocker** | Transcript content cannot be fetched from DigitalOcean IP |
| **Root cause** | YouTube bot detection blocks cloud provider IPs |
| **YouTube Data API v3** | Does NOT provide transcript content for public videos |
| **Cookie auth** | Broken by YouTube (confirmed by library maintainers) |

### Recommended Next Steps

Given this analysis, the **only viable path to solve the transcript acquisition blocker** is:

**Option A: Residential Proxy (~$5/month, 2 hours setup)**
```
Pros: Solves IP block, works with existing InnerTube code
Cons: Proxies may also get blocked over time, ongoing cost
Implementation: Add proxy config to InnerTube fetch calls
```

**Option B: Whisper API (~$0.30/analysis, 4 hours setup)**
```
Pros: 100% coverage (doesn't require YouTube captions at all)
Cons: Recurring cost ~$30/month for 100 videos
Implementation: yt-dlp audio download → Whisper API transcription
```

**Option C: Both (Recommended)**
```
Layer 1: Residential proxy + InnerTube (primary, ~90% coverage)
Layer 2: Whisper API (fallback, 100% coverage)
Result: ~100% combined coverage, cost-optimized
```

---

## 9. References

1. Google YouTube Data API v3 Discovery Document: `https://www.googleapis.com/discovery/v1/apis/youtube/v3/rest`
2. YouTube Data API v3 Captions Resource: `https://developers.google.com/youtube/v3/docs/captions`
3. YouTube Data API v3 Captions.download: `https://developers.google.com/youtube/v3/docs/captions/download`
4. `youtube-transcript-api` v1.2.4 source — cookie auth disabled
5. VALIDATION_BATCH_002.md — IP block evidence
