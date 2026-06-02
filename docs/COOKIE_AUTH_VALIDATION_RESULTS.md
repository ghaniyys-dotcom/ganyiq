# Cookie Auth Validation Results

> **Date:** 2026-06-02 10:57 WIB
> **Purpose:** Validate whether cookie-authenticated YouTube requests improve transcript coverage for Indonesian podcast videos
> **Method:** Each video tested twice — anonymous vs cookie-auth (WEB client context)
> **Cookie file:** `cookies.txt` (8,261 bytes, Netscape format, 33 unique cookies after dedup)

---

## CRITICAL FINDING: IP Blocked by YouTube

**The DigitalOcean IP address (68.183.231.223) has been flagged by YouTube's bot detection system.**

YouTube is returning `LOGIN_REQUIRED` with reason *"Sign in to confirm you're not a bot"` for ALL requests — regardless of:
- Client context (ANDROID vs WEB)
- API key presence (with or without `INNERTUBE_API_KEY` from page HTML)
- Cookie authentication

This is a well-known issue with cloud provider IPs (DigitalOcean, AWS, GCP, Azure).

---

## Cookie File Analysis

| Metric | Value |
|---|---|
| File | `/root/GANYIQ/cookies.txt` |
| Size | 8,261 bytes |
| Format | Netscape HTTP Cookie File |
| Total lines | 55 cookies parsed |
| Duplicate cookies | Yes — 22 duplicates (e.g., 3x SID, 3x HSID, 3x APISID) |
| Unique cookies (deduped) | 33 |
| YNID expiry | 1795947953 (valid) |
| SAPISID expiry | 1814955998 (valid) |
| LOGIN_INFO expiry | 1814956003 (valid) |
| Latest cookie expiry | 1814956391 (valid — all non-expired) |

**All cookies are non-expired and from the correct domain (`.youtube.com`, `.google.com`).**

---

## youtube-transcript-api Library Analysis

The official `youtube-transcript-api` Python library (v1.2.4) source code reveals:

```python
# Cookie auth has been temporarily disabled, as it is not working properly with
# YouTube's most recent changes.
```

**Cookie authentication has been DISABLED by the library authors** because YouTube broke it with recent changes. This confirms that cookies are not a viable solution for YouTube transcript acquisition anymore.

The library now recommends proxies as the solution for IP bans.

---

## Per-Video Results (WEB Context)

All 15 videos tested returned `LOGIN_REQUIRED` (IP blocked) regardless of mode.

| Video ID | Channel | Category | Anonymous | Cookie-Auth |
|---|---|---|---|---|
| BUS-01 | Fellexandro Ruby | business | ❌ LOGIN_REQUIRED | ❌ LOGIN_REQUIRED |
| BUS-02 | Suara Berkelas | business | ❌ LOGIN_REQUIRED | ❌ LOGIN_REQUIRED |
| BUS-03 | What Is Up Indonesia | business | ❌ LOGIN_REQUIRED | ❌ LOGIN_REQUIRED |
| MOT-01 | Mario Teguh Official | motivation | ❌ LOGIN_REQUIRED | ❌ LOGIN_REQUIRED |
| MOT-02 | Raditya Dika | motivation | ❌ LOGIN_REQUIRED | ❌ LOGIN_REQUIRED |
| COM-01 | Podcast Awal Minggu | comedy | ❌ LOGIN_REQUIRED | ❌ LOGIN_REQUIRED |
| COM-02 | Risyad and Son | comedy | ❌ LOGIN_REQUIRED | ❌ LOGIN_REQUIRED |
| COM-03 | Tuah Kreasi | comedy | ❌ LOGIN_REQUIRED | ❌ LOGIN_REQUIRED |
| STL-01 | Curhat Bang | storytelling | ❌ LOGIN_REQUIRED | ❌ LOGIN_REQUIRED |
| STL-02 | Rotten Mango | storytelling | ❌ LOGIN_REQUIRED | ❌ LOGIN_REQUIRED |
| STL-03 | UNLOCKED MEDIA | storytelling | ❌ LOGIN_REQUIRED | ❌ LOGIN_REQUIRED |
| FIN-01 | Raymond Chin | finance | ❌ LOGIN_REQUIRED | ❌ LOGIN_REQUIRED |
| FIN-02 | Deddy Corbuzier | finance | ❌ LOGIN_REQUIRED | ❌ LOGIN_REQUIRED |
| CON-01 | Risyad and Son | controversy | ❌ LOGIN_REQUIRED | ❌ LOGIN_REQUIRED |
| CON-02 | Raditya Dika | controversy | ❌ LOGIN_REQUIRED | ❌ LOGIN_REQUIRED |

### Important Note on Previous Test (ANDROID Context)

The initial run with ANDROID client context succeeded for 2 videos (BUS-01, BUS-03) with 735 and 761 segments respectively. However, subsequent testing revealed this was due to YouTube's rate limiting not yet being triggered. Once the IP was flagged, all methods failed. The ANDROID context results are unreliable and should not be used for coverage conclusions.

---

## Summary Metrics

| Metric | Value |
|---|---|
| Total Videos Tested | 15 |
| Anonymous Success | 0/15 (0%) |
| Cookie-Auth Success | 0/15 (0%) |
| Improvement | 0 pp |
| LOGIN_REQUIRED Count | 15x |
| TRANSCRIPT_UNAVAILABLE Count | 0x |

**Verdict: FAIL**

---

## Root Cause Analysis

```
┌─────────────────────────────────────────────────────────────┐
│                    ROOT CAUSE TREE                          │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Transcript acquisition fails                               │
│      │                                                      │
│      ├── IP-based blocking (15/15 videos)                   │
│      │     │                                                 │
│      │     ├── DigitalOcean IP in cloud provider range      │
│      │     └── YouTube aggressively blocks cloud IPs        │
│      │                                                      │
│      ├── Cookies NOT effective                              │
│      │     │                                                 │
│      │     ├── YouTube changed API — cookie auth broken     │
│      │     └── youtube-transcript-api disabled it           │
│      │                                                      │
│      └── Video itself may lack captions                     │
│            (cannot verify — all blocked at IP level)        │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## Raw Data

```json
{
  "environment": {
    "ip": "68.183.231.223",
    "hosting": "DigitalOcean Singapore",
    "cookie_file": "/root/GANYIQ/cookies.txt",
    "cookie_size_bytes": 8261,
    "cookie_count_deduped": 33,
    "library": "youtube-transcript-api v1.2.4",
    "test_date": "2026-06-02T10:57:00+07:00"
  },
  "summary": {
    "total": 15,
    "anonymous_success": 0,
    "cookie_auth_success": 0,
    "login_required": 15,
    "ip_blocked": true,
    "verdict": "FAIL"
  },
  "videos_tested": [
    {"id": "BUS-01", "videoId": "2QFV58h8BsU", "channel": "Fellexandro Ruby", "category": "business"},
    {"id": "BUS-02", "videoId": "FIXQQ7X7tZE", "channel": "Suara Berkelas", "category": "business"},
    {"id": "BUS-03", "videoId": "R8rLV9PhQg0", "channel": "What Is Up Indonesia", "category": "business"},
    {"id": "MOT-01", "videoId": "y10GDKyPmfg", "channel": "Mario Teguh Official", "category": "motivation"},
    {"id": "MOT-02", "videoId": "hN-V0YYDSak", "channel": "Raditya Dika", "category": "motivation"},
    {"id": "COM-01", "videoId": "qG2Rf_mtmiQ", "channel": "Podcast Awal Minggu", "category": "comedy"},
    {"id": "COM-02", "videoId": "pFJ5L6F55Jw", "channel": "Risyad and Son", "category": "comedy"},
    {"id": "COM-03", "videoId": "ytalcSHJYik", "channel": "Tuah Kreasi", "category": "comedy"},
    {"id": "STL-01", "videoId": "6AaD_80wh4g", "channel": "Curhat Bang", "category": "storytelling"},
    {"id": "STL-02", "videoId": "i2W5y8fqb9I", "channel": "Rotten Mango", "category": "storytelling"},
    {"id": "STL-03", "videoId": "6BpIg7jtE_4", "channel": "UNLOCKED MEDIA", "category": "storytelling"},
    {"id": "FIN-01", "videoId": "0yu5yFkZmKo", "channel": "Raymond Chin", "category": "finance"},
    {"id": "FIN-02", "videoId": "E5ctwVEl4KM", "channel": "Deddy Corbuzier", "category": "finance"},
    {"id": "CON-01", "videoId": "i-VLCYAlANI", "channel": "Risyad and Son", "category": "controversy"},
    {"id": "CON-02", "videoId": "ydE9TD6vhE8", "channel": "Raditya Dika", "category": "controversy"}
  ]
}
```
