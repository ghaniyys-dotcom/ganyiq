# SPEED_ROUND_2.md — Bottleneck Analysis for <3 min Target

**Date:** 2026-06-10
**Current runtime:** 4:04 (244s)
**Target:** <3:00 (180s)

---

## Current Stage Breakdown

Data from latest stable analysis (Op_zO-NkYFQ, 1:10:30 podcast):

| Stage | Time | % of total | Potential | Notes |
|-------|------|-----------|-----------|-------|
| 1. Fetch transcript | ~2s | 1% | 🟢 0% | Already near-instant (YouTube API) |
| 2a. Extract candidates | 158ms | 0% | 🟢 0% | Negligible |
| 2b. LLM scoring | 2:24 | 59% | 🟡 20-30% | 3 batches × 20 candidates, each ~48s |
| 2c. Combined multi-pass | 1:38 | 40% | 🟢 0% | Already optimal — single call, works |
| 3. Ranking | 17ms | 0% | 🟢 0% | Negligible |
| 4. DB save | 30ms | 0% | 🟢 0% | Negligible |
| **Total analyze** | **4:02** | **100%** | | |

**Total full pipeline: 4:04**

## Bottleneck Analysis

### Bottleneck #1: LLM Scoring (2:24 → 59%)

**Current behavior:**
- 57 candidates split into 3 batches of 20
- Each batch: 1 LLM call, ~48s per batch
- 3 batches run sequentially (not parallel!)
- Scoring prompt includes transcript text + candidate windows

**Why sequential?** The batch loop in `candidate-extraction.ts`:
```typescript
for (let start = 0; start < candidates.length; start += 20) {
    const batch = candidates.slice(start, start + 20);
    // LLM call per batch — AWAITED (sequential)
    const result = await processBatch(batch);
}
```

**Potential:** If batches ran in PARALLEL (Promise.all), 3 batches → wall time = max(48s) = **48s instead of 2:24** → saves 96s

### Bottleneck #2: Combined Multi-Pass (1:38 → 40%)

Already optimized. Single LLM call, works reliably. No further optimization without sacrificing quality.

## Optimization Path

### Path A: Parallelize LLM scoring batches (HIGH ROI, LOW RISK)

| Change | Time saved | Risk |
|--------|-----------|------|
| Switch `for...await` → `Promise.all(3 batches)` | **~96s** | Medium — parallel calls = higher instantaneous API load |
| Keep `max_tokens: 16384` per batch | — | Low — already set correctly |

### Path B: Reduce candidates per analysis (MEDIUM ROI, QUALITY RISK)

| Change | Time saved | Risk |
|--------|-----------|------|
| Reduce from 57 to 40 candidates | ~30s | Medium — might miss edge-of-quality clips |
| Reduce from 40 to 30 candidates | ~45s | High — significantly reduces coverage for long podcasts |

### Path C: Reduce token usage per batch (LOW ROI)

| Change | Time saved | Risk |
|--------|-----------|------|
| Shorten transcript excerpts from 250→150 chars | ~10s | Medium — less context for LLM |
| Skip clip expansion (currently 2/20 expanded) | ~5s | Low — expansion adds few candidates |

## Projected Timeline

```
Path A only (parallel scoring):
  2:24 → 0:48 (parallel)
  1:38 → 1:38 (unchanged)
  ─────────────────
  Total: 2:26 → ~3:00 target ✅

Path A + Path B (parallel + 40 candidates):
  2:24 → 0:35 (parallel + fewer)
  1:38 → 1:10 (fewer to evaluate)
  ─────────────────
  Total: 1:45 → way under target
```

## Cost Impact of Parallel Scoring

| Change | Cost change |
|--------|------------|
| 3 parallel scoring calls | Same total tokens, same cost — just faster wall time |
| Combined pass unchanged | Same cost |
| **Total cost change** | **$0** — zero additional cost for parallel execution |

## Recommendation

**Implement Path A first** (parallelize LLM scoring batches).

- Zero cost increase
- Zero quality impact
- 96 seconds saved
- Gets us from 4:04 → **~2:28**
- Well under the 3:00 target

**Do not implement Path B** (reducing candidates) until quality audit confirms it's safe.

## Summary

| Metric | Current | Target | With Path A | Status |
|--------|---------|--------|-------------|--------|
| **Runtime** | 4:04 | <3:00 | **~2:28** | ✅ Achievable |
| **Cost** | $0.02 | Same | $0.02 | ✅ Zero increase |
| **Quality** | 82% | Maintain | 82% | ✅ Unchanged |
| **Risk** | — | — | Low | ✅ Simple code change |
