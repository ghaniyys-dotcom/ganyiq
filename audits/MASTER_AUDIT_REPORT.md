# GANYIQ POST-STABILIZATION AUDIT — MASTER REPORT

**Date:** 2026-06-10
**State:** All 5 priorities audited. No implementations yet.

---

## Current System State

| Area | Status | Since |
|------|--------|-------|
| **Runtime** | **4:04** per new video | ✅ Deployed |
| **Cache hit** | <1 second | ✅ Always |
| **Combined multi-pass** | Working (1:38) | ✅ Deployed |
| **PM2 stability** | 0 crashes from pool | ✅ Deployed |
| **Zombie cleanup** | Auto-clean on startup | ✅ Deployed |
| **Build/deploy** | Proper deploy.sh flow | ✅ Deployed |
| **Page crash** | Resolved | ✅ Fixed |

---

## Priority Ranking (by ROI)

### 1. ⭐ PARALLELIZE LLM SCORING (Speed → <3 min)
**File:** Scoring batch loop — currently `for...await` sequential
**Fix:** Switch 3 scoring batches to `Promise.all()`
**Impact:** -96s runtime (4:04 → ~2:28)
**Cost:** $0
**Risk:** None (zero quality impact)
**Effort:** ~10 minutes

### 2. 🔶 FIX SCORE COMPRESSION (Quality)
**Issue:** 60% of videos have 8+ clips within 5 points of max score
**Impact:** Ranking within elite tier is arbitrary
**Fix needed:** Score spread normalization (minimum 5pt gap between tiers)
**Alternative:** Cap controversy scoring at 95 unless combined with other signals
**Risk:** Medium — needs careful calibration

### 3. 🟡 BATCH TITLE GENERATION (Cost savings)
**Current:** 1 LLM call per moment = up to 15 calls = $0.0105 (53% of cost)
**Fix:** Single LLM call for all 15 moments = ~$0.002
**Impact:** -$0.0085 per analysis (-43% cost reduction)
**Risk:** Low — title quality might decrease slightly

### 4. ⚪ VPS-SIDE CLIP RENDERER (Reliability)
**Current:** 100% dependent on PC-GANY worker
**Risk:** All clip requests fail silently when PC-GANY is offline
**Fix:** Run worker on VPS (ffmpeg already installed)
**Impact:** Clip generation always available
**Effort:** Medium — need to clone worker package

### 5. ⚪ ANALYTICS PHASE 1 (Insight)
**Lowest ROI for now** — can answer most questions from existing DB data
**Quick win:** Add cache_hit/cache_miss logging to events table

---

## Recommendation: Immediate Next Action

**Start with Priority 1** (parallelize scoring).

It's a 10-minute change with zero cost, zero quality impact, and saves 96 seconds. Gets us from 4:04 to ~2:28 — well under the 3:00 target.

**Then Priority 2** (score compression) — the biggest quality issue identified.
**Then Priority 3** (batch titles) — pure cost savings.

---

Audit reports created:
- ✅ `QUALITY_AUDIT.md` — 5 videos, 75 moments reviewed
- ✅ `COST_AUDIT.md` — $0.02/analysis, 53% from titles
- ✅ `CLIP_PIPELINE_AUDIT.md` — 23 clips rendered, worker-dependent
- ✅ `ANALYTICS_FOUNDATION.md` — Event tracking proposal
- ✅ `SPEED_ROUND_2.md` — Path to <3:00 via parallel scoring
