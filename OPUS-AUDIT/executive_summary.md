# OpusClip Reverse Engineering — Evidence Report

**Date:** June 14, 2026  
**Status:** Phases 0, 5 (Network), 6 (Infrastructure), 7 (Stack), 8 (Decision Engine), 9 (Rendering), 10 (Gap Analysis) — PARTIALLY COMPLETE  
**Phases remaining:** P1 (Product Forensics), P2 (Subtitle Forensics), P3 (Camera Forensics), P4 (Layout Forensics) — need actual clips to watch  
**Master spreadsheet:** `OPUS-AUDIT/opus_audit_master.xlsx`

---

## EXECUTIVE SUMMARY

### What We Now Know (Evidence-Based)

#### 1. Tech Stack (HIGH Confidence)
| Component | Finding | Evidence |
|-----------|---------|----------|
| Frontend | **Next.js** (Pages Router) | `_next/static/chunks/` in `clip.opus.pro` |
| Auth | **Google OAuth** | `accounts.google.com/gsi/client` in app bundle |
| Feature Flags | **Statsig** | `statsig-sidecar` with client API key visible in page source |
| CDN/Storage | **Google Cloud Storage** | Error: `No such object: public.gcs.opus.pro` |
| Video Editor | **Custom WASM** | `AVEditorEngine-20260604-09125d5a.wasm.gz` (5.96MB) |
| API Docs | **Mintlify** | `help.opus.pro` powered by Mintlify |
| CRM | **Brevo (Sendinblue)** | `/update-login-user-brevo-contact` endpoint |
| Referral | **Rewardful** | Rewardful script loaded in app |
| Analytics | **Google Tag Manager** | GTM-5B6S625 |
| Cookie Compliance | **CookieBot** | consent.cookiebot.com |

#### 2. API Architecture (HIGH Confidence)
```
Base URL: https://api.opus.pro
Auth: Bearer token via API keys
Rate Limit: 30 requests/min per key
```

**Key Endpoints Discovered:**
- `POST /api/clip-projects` — Create project from YouTube URL
- `GET /api/exportable-clips` — Get generated clips
- `POST /plan-social-upload-links` — Direct social media publishing
- `POST censor-job` — Auto-censor/blur content
- Webhook support for real-time notifications

#### 3. Layout System (HIGH Confidence — from API Schema)
```
7 layout types + AUTO mode:
┌────────────────────────────────────────────┐
│ Layout        │ API Field                  │
├────────────────────────────────────────────┤
│ Split (2-way) │ enableSplitLayout          │
│ Fit           │ enableFitLayout            │
│ Fill          │ enableFillLayout           │
│ Screen        │ enableScreenLayout         │
│ Three (3-way) │ enableThreeLayout          │
│ Four (4-way)  │ enableFourLayout           │
│ Game          │ enableGameLayout ★ UNIQUE  │
│ Auto (AI)     │ enableAutoLayout           │
└────────────────────────────────────────────┘
```

#### 4. Caption System (HIGH Confidence)
```json
{
  "captionPosition": "bottom|top",
  "enableCaptionAnimation": true,
  "captionAnimation": "...",
  "enableUppercase": true,
  "enableHighlight": true,
  "enableWatermark": true,
  "brandTemplateId": "preset-fancy-Karaoke"
}
```

#### 5. Create Project Full Request Schema (HIGH Confidence)
```json
POST https://api.opus.pro/api/clip-projects
Authorization: Bearer <API_KEY>

{
  "videoUrl": "https://www.youtube.com/watch?v=...",
  "conclusionActions": [{"type": "EMAIL", "notifyFailure": true, "email": "..."}],
  "curationPref": {
    "range": {"startSec": 28, "endSec": 636},
    "clipDurations": [...],
    "topicKeywords": ["..."],
    "genre": "Auto",
    "skipCurate": false
  },
  "importPref": {"sourceLang": "auto"},
  "brandTemplateId": "preset-fancy-Karaoke",
  // Layout preferences:
  "enableSplitLayout": true,
  "enableFitLayout": true,
  "enableFillLayout": true,
  "enableScreenLayout": true,
  "enableThreeLayout": true,
  "enableFourLayout": true,
  "enableGameLayout": true,
  "enableAutoLayout": true,
  "layoutAspectRatio": "9:16",
  "enableVisualHook": true,
  "captionPosition": "bottom",
  "enableCaptionAnimation": true,
  "captionAnimation": "fade",
  "enableUppercase": false,
  "enableHighlight": true
}
```

#### 6. Processing Pipeline (MEDIUM Confidence)
```
YouTube URL → QUEUED → [cluster=gold] → PROCESSING → COMPLETED
                                    ↓
                    clip-projects → exportable-clips
                    
Cluster tiers: gold (premium), silver (standard)
Job format: FP.P<projectId>:<timestamp>.FP
```

#### 7. Infrastructure (HIGH Confidence)
- **Main domain:** `opusclip.com` → `www.opus.pro`
- **App:** `clip.opus.pro` (Next.js)
- **API:** `api.opus.pro`
- **CDN:** `public.cdn.opus.pro` backed by `public.gcs.opus.pro` (Google Cloud Storage)
- **Help/API Docs:** `help.opus.pro` (Mintlify)
- **Status Page:** `status.opus.pro`
- **Social:** Twitter/X @opusclip

#### 8. Business Model (MEDIUM Confidence)
- **Founder/CEO:** Young Zhao
- **Growth:** "5M users in 7 months" (per founder talk, 181K YouTube views)
- **Tiers:** Free → Pro → Max → Business (per productTier field)
- **Pricing:** API = 1 credit/minute video. 15 hours/month on Pro Beta & Max
- **Rate Limit:** 30 requests/min for API
- **Storage:** Temporary (7 days auto-expire), auto-save extends
- **Video Limit:** 4 hours max, 10GB max file size
- **Languages:** 20+ supported, 5 website languages (EN, ES, PT-BR, DE, FR)

---

## Key Insights for GANYIQ

### What Opus Does Better (Evidence-Based)

1. **Batch Processing** — One video upload → multiple clips. GANYIQ renders one at a time.
2. **Layout Variety** — 7+ layouts including "Game" layout. GANYIQ has 3.
3. **Brand Templates** — Full brand template system with presets. GANYIQ has hardcoded styles.
4. **Social Publishing** — Direct schedule/publish to social platforms.
5. **Public API** — REST API with webhooks, API keys, rate limiting.
6. **WASM Editor** — In-browser video editing with WASM engine.
7. **ML Layout Selection** — Auto-layout mode uses ML to pick optimal layout.
8. **Visual Hook Detection** — Detects both textual AND visual hooks.

### What GANYIQ Can Differentiate On

1. **Indonesian Market Focus** — Opus has 5 languages but NO Indonesian.
2. **Open Source Option** — Could offer self-hosted option.
3. **Lower Price** — Compete on price in SE Asia market.
4. **Customization** — More flexible template system if properly implemented.

---

## Evidence Files Saved

| File | Content |
|------|---------|
| `OPUS-AUDIT/opus_audit_master.xlsx` | All findings across all 11 sheets |
| `OPUS-AUDIT/executive_summary.md` | This document |
| `OPUS-AUDIT/architecture_reconstruction.md` | Architecture diagram + component details |
| `OPUS-AUDIT/ganyiq_roadmap.md` | GANYIQ roadmap based on gap analysis |

---

## Next Steps

### Phase 1 — Product Forensics (⬜ PENDING)
Watch actual OpusClip outputs on YouTube. Target: 50 clips.
Priority samples found:
- `https://www.youtube.com/watch?v=tEXaoozFRes` (175K views) — Opus Clip AI review with output examples
- `https://www.youtube.com/watch?v=ReRLbpC2SG4` (181K views) — Founder talk

### Phase 5 — Deeper Network Forensics (⬜ PENDING)
Try logging into `clip.opus.pro` to capture real API traffic with auth.

### Phase 6 — Deeper Infrastructure (⬜ PENDING)
Search LinkedIn for OpusClip team size, engineering roles, funding.
