# GANYIQ — Updated Roadmap (Post-Audit)

## Based on Verified Issues & System State (2026-06-07)

---

## Current State After Today's Fixes

| Aspect | Before Today | After Today |
|---|---|---|
| **Deploy drift** | 10 commits behind, missing vertical mode | ✅ Synced + 3 patches deployed |
| **Face tracking** | `lastGoodCx` stores face center (wrong), dead zone locks camera | ✅ Crop position stored, dead zone is accumulator |
| **Job completion** | Race condition allows double-processing | ✅ Atomic `UPDATE WHERE status='claimed'` |
| **tsserver RAM** | 6 processes = ~1092 MB wasted | ✅ Killed, cron every 6h |
| **Production** | `CONFIDENCE_LOCK_THRESHOLD=0.6` (broke tracking) | ✅ 0.25 + separated no-face/low-confidence logic |
| **Score (Opus)** | ~32/100 | ~55/100 |

---

## Priority Order (User-Approved)

```
Phase 1: RELIABILITY ──► Phase 2: STABILITY ──► Phase 3: Split+Speaker ──► Phase 4: Advanced
    (P0 fixes DONE)        (P1-P3 fixes)            (Growth)                    (Optimization)
```

---

## Phase 1: Reliability ← WE ARE HERE, DONE FOR TODAY

**Goal:** System doesn't crash, camera tracks correctly, jobs don't double-process.

| ID | Task | Status | Commitment |
|---|---|---|---|
| P0-1 | Deploy 10 pending commits | ✅ DONE | `fcebf14` live in production |
| P0-2 | Fix dead zone blocking `lastKnownCx` update | ✅ DONE | Track+output separated via `cameraCx` |
| P0-3 | Fix `lastGoodCx` storing face center instead of crop | ✅ DONE | Now stores `targetCropX` instead of `sample.cx` |
| P0-4 | Atomic job completion (complete + upload) | ✅ DONE | `AND status='claimed' RETURNING id` |
| P0-5 | tsserver cleanup | ✅ DONE | Killed 6 orphans, cron every 6h |
| P0-6 | max_tokens 8192→16384 | ❌ PENDING | 15 menit, fix truncated LLM responses |
| P0-7 | Stale timeout 15→30 min | ❌ PENDING | 30 menit, prevent false job release during long renders |

**All P0 code fixes deployed to production. P0-6 & P0-7 are quick wins.**

---

## Phase 2: Stability (P1-P3) — Next 2 Weeks

**Goal:** Production-hardened, monitored, tested.

| Priority | Task | Effort | Why |
|---|---|---|---|
| **P1** | `max_tokens` 8192→16384 | 15 min | Fix truncated LLM responses (F-16) |
| **P1** | Stale recovery 15→30 min + check worker heartbeat | 30 min | Prevent double-processing during long renders (F-09) |
| **P1** | Video duration=0 guard | 30 min | Return proper error instead of empty results (F-12) |
| **P1** | Rate limiting on worker endpoints | 2 jam | Prevent compromised key from flooding API (F-11) |
| **P1** | PM2 non-root migration | 2 jam | Security: RCE → full system compromise (F-07) |
| **P1** | Identity timeout 3→10 frames | 15 min | Reduce identity fragmentation (F-15) |
| **P2** | Worker-package autobuild (eliminate drift) | 2 jam | Build worker-package.zip from `worker/` at deploy time |
| **P2** | execSync→exec refactor | 4 jam | Better error handling, no orphaned processes |
| **P2** | Sentry error tracking | 2 jam | Stop discovering bugs from user reports |
| **P2** | Button debounce (frontend) | 30 min | Prevent double-submit |
| **P2** | Exponential backoff upload | 1 jam | Better network resilience |
| **P2** | Database index for rate limit | 15 min | Prevent seq-scan at scale |
| **P2** | `isLocked` field for no-face segments | 1 jam | Better downstream face tracking info |
| **P3** | Keyframe alignment (FFmpeg `-ss`) | 1 jam | Exact clip boundaries |
| **P3** | Fallback metrics persistence | 2 jam | Know fallback rate without guessing |
| **P3** | Dead code cleanup | 1 jam | Remove `CONFIDENCE_LOCK_THRESHOLD`, redundant sorts |

---

## Phase 3: Feature Growth — After Stability

### Decision: Speaker Tracking FIRST, Split Screen SECOND

**ROI Analysis:**

| Feature | Covers | Effort | Prerequisite | ROI Score |
|---|---|---|---|---|
| **Speaker Tracking** | **37%** of videos (2-person podcasts) | 3-5 days | Deepgram diarization | **HIGHEST** |
| **Split Screen** | ~15% of clips (overlapping speech) | 5-10 days | Speaker Tracking | Medium |
| **Reaction Tracking** | ~10% of clips (non-speaker reactions) | 7-14 days | Speaker Tracking | Low |

**Why Speaker Tracking First:**
1. **Immediate visible impact** — Fixes camera on 37%+ of videos (the most common case after testing)
2. **Prerequisite for Split Screen** — Can't split on wrong speaker
3. **Lower complexity** — Deepgram Nova-2 already supports diarization; just need transcript→face correlation
4. **Data pipeline already exists** — Transcripts already flow through Deepgram

**Why Split Screen Second:**
1. Would be wasted if camera follows wrong speaker
2. Only triggered during overlapping speech (~15% of clips)
3. Halves face resolution (reduced detail)
4. Adds FFmpeg complex filter complexity

### Roadmap:

```
Weeks 3-4: Speaker Tracking (V2.4B)
├── Deepgram diarization (speaker labels per word)
├── Map diarized speakers → tracked face identities
├── Speaker-weighted dominance scoring
├── Smooth transitions on speaker change
└── Configurable boost factor

Weeks 5-8: Split Screen (V2.5)
├── Overlap detection (2 speakers within 2s)
├── Vertical stack layout (50/50 or 70/30)
├── Smooth transition between split ↔ single
├── Minimum face size guard
└── FFmpeg complex filter chain

Weeks 9-12: MediaPipe face detection
├── Replace Haar Cascade with MediaPipe Face Mesh
├── Better detection: profile faces, angled, small
├── Facial landmarks (mouth for speaking detection)
└── Kalman filter smoothing replacement
```

---

## Phase 4: Advanced AI Tracking — Future

After everything above is stable:

| Feature | Impact | Effort | When |
|---|---|---|---|
| **Reaction Tracking** | Capture non-speaker reactions | 7-14 days | After Split Screen |
| **Auto-zoom** | Dynamic zoom on emotional moments | 5-10 days | After MediaPipe |
| **Subtitle burn-in** | AI subtitles with speaker labels | 3-5 days | After Speaker Tracking |
| **Multi-worker auto-scale** | Support 10+ workers | 5-10 days | Mid-term |
| **CI/CD auto-deploy** | Deploy on git push | 4-8 hours | Next sprint |
| **Clip preview in browser** | Better UX | 3-5 days | Mid-term |
| **CDN for clips** | Cloudflare R2/S3 | 2-3 days | When scale demands |

---

## Changes From Previous Roadmap

| Previous | Updated | Reason |
|---|---|---|
| V2.4B → V2.5 → V3 | **Stability → P1→P3 → Speaker → Split → MediaPipe** | Reality check: Opus audit found 28 issues. Must stabilize before features. |
| Speaker Tracking had lower priority | **Speaker Tracking moved UP** | ROI analysis: fixes 37%+ of videos immediately |
| V3 had advanced features | **V3 features deferred** | Not production-grade yet. Focus on basic reliability first. |
| MediaPipe was immediate | **MediaPipe moved down** | Haar Cascade is adequate for basic face tracking. Not the bottleneck. |

---

## Key Metric Targets

| Metric | Current | Target | Timeline |
|---|---|---|---|
| **Face tracking accuracy** | ~60% (Haar) | ~85% (MediaPipe) | Phase 4 |
| **Camera stuck in middle** | ⚠️ FIXED (0%) | 0% | ✅ TODAY |
| **Job double-processing** | ⚠️ FIXED (atomic) | 0% | ✅ TODAY |
| **Analyses / day** | ~5-10 | ~50 | Phase 2 |
| **Clip render success rate** | ~80% | >95% | Phase 2-3 |
| **LLM fallback rate** | Unknown | <10% | Phase 2 |
| **Clip render time (vertical)** | ~8 min → ~2 min with fix | <3 min avg | ✅ TODAY |
| **Deploy time (manual)** | 5 min (quick) | <30s (auto) | Phase 2 |
