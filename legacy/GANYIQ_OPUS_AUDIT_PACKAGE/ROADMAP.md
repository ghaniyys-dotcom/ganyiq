# GANYIQ — Current Roadmap

---

## Version Overview

```
V1 ─── V2 ─── V2.4A ─── V2.4B ─── V2.5 ─── V3
 │                    │                   │       │
 │  Core Analysis     │  Speaker Track    │       │
 │  + Transcript      │  + Diarization   │       │
 │                    │                   │       │
 │  FIRST SHIP        │  CURRENT          │       │
 │                    │                   │       │
 └────────────────────┘───────────────────┘───────┘
                  Done               In Progress     Future
```

---

## V2.4A (Current — Multi-Face Tracking)
**Status:** ✅ Active. Camera stuck bug FIXED. Performance optimized.

### Completed
- [x] Multi-face detection (not just largest)
- [x] Identity tracking (Euclidean distance matching)
- [x] Per-face smoothing (no cross-face contamination)
- [x] Identity-aware gap interpolation
- [x] Dominant face selection (size + center + stability scoring)
- [x] Dead zone (30px X-axis)
- [x] Minimum hold (1s before switch allowed)
- [x] Switch ratio (1.2× score needed to overtake)
- [x] Lock last-known-position on no-face
- [x] Clip-range-only face detection (massive perf gain)
- [x] Confidence threshold fix (0.6 → 0.25)
- [x] Debug logging for segment values

### Remaining in V2.4A
- [ ] Y-axis dead zone (currently X-only)
- [ ] Top-off hold (hold onto target even after it scores lower, to prevent flicker)
- [ ] Camera transition smoothing (ease-in/ease-out between segments)

---

## V2.4B (Speaker-Aware Camera)
**Status:** 🔜 Next sprint
**Goal:** Match camera target to the currently speaking person

### Planned Features
- [ ] Deepgram Nova-2 diarization (speaker labels per word)
- [ ] Map diarized speakers → tracked face identities
- [ ] Speaker-weighted dominance scoring (scoring speaker gets +30% boost)
- [ ] Speaker transition: camera switches when speaker changes
- [ ] Silence/overlap handling (hold camera during short overlaps)
- [ ] Visualization debug mode (overlay speaker labels on source video)
- [ ] Configurable speaker boost factor (env var or DB config)

### Dependencies
- Deepgram diarization support (Nova-2 supports this, cost ~$0.0204/min)
- Transcript → face correlation algorithm
- Word-level timestamp alignment

### Success Criteria
- Camera follows the correct speaker in 2-person podcasts
- Transition within 0.5s of speaker change
- No switch within first 1s of speaker change (anti-flicker)

---

## V2.5 (Split-Screen)
**Status:** 🔮 Planned
**Goal:** Show multiple speakers simultaneously when they're both active

### Planned Features
- [ ] Dynamic split-screen detection (when 2+ speakers talk within 2s window)
- [ ] Vertical stack layout (Person A on top, Person B below)
- [ ] Equal split (50/50) for 2-person active moments
- [ ] Single-person crop for mono moments
- [ ] FFmpeg complex filter chain for split layout
- [ ] Smooth transition between split ↔ single modes
- [ ] Config: min split duration, transition speed, layout style

### Design Considerations
- **Target:** 25% of catalog (2-person active podcast moments)
- **Avoid:** Split-flicker — must hold split for minimum duration (3-5s)
- **Quality:** Each half must maintain minimum face size (not too zoomed out)
- **Tradeoff:** Split screen reduces each speaker's size by ~50% (less detail)

### Dependencies
- V2.4B speaker tracking must be stable first
- Otherwise split screen would show wrong speaker crops

---

## V3 (Production Grade — Opus Clip Competition)
**Status:** 🌟 Vision phase
**Goal:** Feature parity with Opus Clip

### Planned Features
- [ ] **Reaction tracking** — Capture non-speaking participant reactions (laugh, nod, shock)
- [ ] **Auto-zoom** — Dynamic zoom on emotional moments
- [ ] **Subtitle burn-in** — AI-generated subtitles with speaker labels
- [ ] **Auto trim** — Smart clip start/end with fade transitions
- [ ] **Multi-audio track** — Keep original audio in split-screen
- [ ] **Batch rendering** — Queue multiple clips from one analysis
- [ ] **Webhook notifications** — Telegram/webhook on clip ready
- [ ] **Clip preview** — In-browser video preview before download

### Platform Goals
- [ ] **CDN delivery** — Serve clips via Cloudflare/CDN
- [ ] **Multi-worker scaling** — Support 10+ concurrent workers
- [ ] **Queue dashboard** — Real-time queue monitoring
- [ ] **Quality metrics dashboard** — Score distributions, fallback rates
- [ ] **Error tracking** — Sentry integration
- [ ] **API rate limiting** — Per-endpoint rate limits
- [ ] **Staging environment** — Separate from production
- [ ] **CI/CD pipeline** — Auto-deploy on git push

---

## Current State Summary

| Category | Status | Notes |
|---|---|---|
| **Transcript acquisition** | ✅ Working | 3-path fallback, ~95% success |
| **LLM Analysis** | ✅ Working | V2 Compact, 5-15 moments per video |
| **Clip generation (landscape)** | ✅ Working | Stream copy, fast |
| **Clip generation (vertical)** | ✅ Working | Face tracked, V2.4A |
| **Worker system** | ✅ Working | 1 worker active (PC-GANY) |
| **IP rate limiting** | ✅ Working | 10/day, rolling 24h |
| **Analysis History** | ✅ Working | IP-based, re-open past results |
| **Multi-face tracking** | ✅ Working | V2.4A fixed |
| **Speaker tracking** | ❌ Not started | Deepgram diarization needed |
| **Split screen** | ❌ Not started | Depends on V2.4B |
| **Reaction tracking** | ❌ Not started | V3 feature |
| **CDN delivery** | ❌ Not started | Nginx direct serving |
| **CI/CD** | ❌ Not started | Manual deploy |
| **Error tracking** | ❌ Not started | Console logs only |
| **Multiple workers** | ⚠️ Partial | 2 registered, 1 active |

---

## Known Technical Debt

| Debt Item | Severity | Effort | Notes |
|---|---|---|---|
| Production out of sync | High | Low | Deploy latest |
| No staging | Medium | Medium | Needs second VPS/container |
| Root PM2 | Medium | Low | Create service user |
| No error tracking | Medium | Low | Add Sentry |
| X-only dead zone | Low | Low | Add Y check |
| Confidence dead code | Low | Very low | Remove/implement |
| No queue metrics | Medium | Medium | Dashboard |
| No keyframe alignment | Low | Low | FFmpeg param fix |
| Worker-package duplication | Low | Low | Symlink or CI build |
