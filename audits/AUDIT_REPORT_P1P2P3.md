# GANYIQ Pipeline Audit Report

## Summary

Three issues audited. Two are confirmed. One is a perception gap.

| Priority | Issue | Status | Impact |
|---|---|---|---|
| P1 | 15 candidates → 6 output | ✅ **Perception gap** (see below) | None — production works correctly |
| P2 | Analysis result cache | ❌ **Missing** — LLM re-runs every time | ~3 min wasted per re-analysis |
| P3 | Progress UI mismatch | ❌ **Confirmed** — cards 2 stays stuck, card 3 never shows | User believes pipeline is stuck |

---

## P1: 15 Candidates → 6 Output — INVESTIGATION

### Evidence

**Production DB stores 15 moments for every completed analysis:**

| Analysis | Video | Status | Elite | Secondary | Total |
|---|---|---|---|---|---|
| 6f67c3cc | 1IFvEow8cg0 | ✅ completed | 10 | 5 | **15** |
| f4c9b324 | 1IFvEow8cg0 | ✅ completed | 10 | 5 | **15** |
| 9b1826f8 | 1IFvEow8cg0 | ✅ completed | 10 | 5 | **15** |
| 050a9e70 | Hw_v5pYT7a8 | ✅ completed | 10 | 5 | **15** |

**API returns 15 moments:**
```json
{
  "moments": [/* 15 items */],
  "totalMomentsFound": 15
}
```

**Frontend renders:**
- 1 Hero card (elite #1)
- 5 More Elite Picks (elite #2–6 rendered by `.slice(1, 6)`)
- 5 Secondary Picks (all 5 secondary)

Total visible cards: **11** (not 6).

### Root Cause: Perception Gap

The user's `total_moments_found = 15` matches `moments.length = 15`. The pipeline is NOT reducing 15→6. The user may be:

1. Counting only "More Elite Picks" section (5 cards) + hero (1 card) = 6 elite total
2. Looking at an earlier version of the UI before the V3 redesign
3. Running the **outdated source code** (`/root/GANYIQ/`) which has `MAX_ELITE=5, MAX_SECONDARY=10` — this code was **reverted in the repo but not deployed**

### Critical Finding: Source ≠ Production

The source code at `/root/GANYIQ/lib/ranking.ts` has been **reverted** to a simpler version (MAX_ELITE=5, MAX_SECONDARY=10, simple 30s proximity dedup, fixed thresholds at 85/70).

The **production** code at `/var/www/ganyiq/lib/ranking.ts` is the **advanced Phase 5A/5C version** (MAX_ELITE=10, MAX_SECONDARY=5, multi-factor dedup, adaptive thresholds, speaker boosts, genre boosts, diversity enforcement).

**The reverted source has NEVER been deployed.** deploy.sh syncs from `/root/GANYIQ/` → would overwrite the advanced production code with the simpler version on next deploy!

**Fix:** `git checkout` the deployed version into the repo, or update the source to match production.

### File-Level Comparison

| Feature | Source (`/root/GANYIQ/`) | Production (`/var/www/ganyiq/`) |
|---|---|---|
| MAX_ELITE | 5 | 10 |
| MAX_SECONDARY | 10 | 5 |
| Elite threshold | 85 (fixed) | 80 (adaptive) |
| Secondary threshold | 70 (fixed) | 50 (adaptive) |
| Dedup method | 30s proximity only | Multi-factor (time, DNA, score, transcript) |
| Speaker boost | ❌ | ✅ (+5 for multi-speaker, +8 for debate) |
| Genre boost | ❌ | ✅ |
| Diversity enforcement | ❌ | ✅ (promotes different-topic clips) |
| Transcript Jaccard dedup | ❌ | ✅ (removes near-duplicate excerpts) |
| "Solid" tier | ❌ | ✅ (below secondary but above minimum) |
| Forensic logging | Minimal | Detailed per-moment dedup logging |

---

## P2: Analysis Result Cache — INVESTIGATION

### Evidence

**Every URL submission runs the full pipeline, regardless of previous analyses:**

File: `/var/www/ganyiq/app/api/analyze/route.ts` (lines 88–128)

```typescript
// Only checks if video EXISTS to get videoDbId — NOT if it has analysis results
const existing = await query('SELECT id FROM videos WHERE youtube_id = $1', [youtubeId]);
if (existing.rows.length > 0) {
  videoDbId = existing.rows[0].id;
}
// ALWAYS creates new analysis — even if previous ones exist
const result = await query(
  `INSERT INTO analyses (video_id, ip_address, status, ...) VALUES (...) RETURNING id`
);
// ALWAYS runs full pipeline
runAnalysisPipeline(analysisId, youtubeId, trimmedUrl, ipAddress);
```

**Pipeline ALWAYS executes (file: `/var/www/ganyiq/lib/analyze-pipeline.ts`):**
1. `fetchVideoDataWithFallback()` — **CACHED** ✅ (transcript in `videos.transcript`)
2. `analyzeTranscript()` — **NOT cached** ❌ (~2 min LLM scoring + ~2 min multi-pass)
3. `rankMoments()` — **NOT cached** ❌ (<10ms, negligible)
4. DB insert of 15+ rows — runs every time

### What IS cached

**Transcript** — stored in `videos` table, column `transcript` (jsonb). Key: `youtube_id` UNIQUE. Fetched in ~16ms on re-analysis. Already working (confirmed by `[CACHE]` logging).

### What is NOT cached

- **Raw moments** (from LLM scoring)
- **Multi-pass moments** (from combined pass)
- **Ranked moments** (scores + tiers)
- **Final recommendations** (15 stored in `moments` table)

### Current Behavior

When same video is analyzed again:
```
[ANALYZE route] Creates new analysis record → runs pipeline
  → fetchVideoDataWithFallback finds cached transcript → 16ms ✅
  → analyzeTranscript runs LLM batch scoring → ~2 min ❌
  → analyzeTranscript runs combined multi-pass → ~2 min ❌
  → rankMoments runs → <10ms ✅
  → DB insert moments → <10ms ✅
Total: ~4 min when LLM could be skipped
```

### Expected Behavior

When same video has a previous completed analysis:
```
[ANALYZE route] Checks for existing analysis with status='completed'
  → Loads existing moments from DB → <10ms
  → Returns immediately
Total: <100ms
```

### Design Proposal

**Add pre-pipeline cache check:**

File: `/var/www/ganyiq/app/api/analyze/route.ts`

```typescript
// After getting videoDbId, before creating new analysis:
const existingCompleted = await query(
  `SELECT a.id FROM analyses a 
   WHERE a.video_id = $1 AND a.status = 'completed'
   ORDER BY a.created_at DESC LIMIT 1`,
  [videoDbId]
);

if (existingCompleted.rows.length > 0) {
  // Return the existing analysis directly — skip pipeline
  return NextResponse.json({
    analysisId: existingCompleted.rows[0].id,
    status: 'completed',
    cached: true,
  });
}
```

Then on frontend: when `status: 'completed'` AND `cached: true`, load moments from history endpoint.

**Alternative (simpler):** Check inside `runAnalysisPipeline` itself — if the video already has completed moments in the DB, skip the LLM stages and just link them.

### Estimated Impact

| Metric | Current | With Cache | Δ |
|---|---|---|---|
| Re-analysis runtime | ~4 min | <100ms | **-99.9%** |
| LLM cost per re-analysis | ~$0.003 | $0 | **-100%** |
| User wait time | ~4 min | instant | **-100%** |
| Engineering effort | — | ~2 hours | — |

---

## P3: Progress UI is Lying — INVESTIGATION

### Evidence

**Backend stages set (file: `/var/www/ganyiq/lib/analyze-pipeline.ts`):**

The pipeline sets 4 stages:
```typescript
await setStage(analysisId, 'fetching_transcript');  // Stage 1
await setStage(analysisId, 'extracting_candidates'); // Stage 2
// ** NO stage set for batch_analysis or multi_pass **
await setStage(analysisId, 'ranking');               // Stage 3
await setStage(analysisId, 'storing_results');       // Stage 4
```

But `analyzeTranscript()` (called during Stage 2) internally runs:
1. Candidate extraction (<50ms)
2. **LLM batch scoring** (~2 min) ← Should be `batch_analysis`
3. **Combined multi-pass** (~2 min) ← Should be `multi_pass`

**Backend never pushes `batch_analysis` or `multi_pass`** because the pipeline only sets `extracting_candidates` before calling `analyzeTranscript()`, and the function runs to completion without any DB progress updates.

### Stage Mapping

```
Backend → Frontend
─────────────────────
queued              → 'fetching'      → Card 1
fetching_transcript → 'fetching'      → Card 1 ✓
extracting_candidates → 'extracting'  → Card 2 ✓
batch_analysis      → 'analyzing'     → Card 3 (NEVER SET)
multi_pass          → 'analyzing'     → Card 3 (NEVER SET)
ranking             → 'ranking'       → Card 4 ✓
storing_results     → 'ranking'       → Card 4 ✓
```

### What the User Sees

1. **Card 1 (Transcript):** ✅ Works — shows `fetching_transcript`, completes when transcript fetched
2. **Card 2 (Candidate Moments):** ⚠️ Shows "active" for **4+ minutes** while LLM scoring + multi-pass run
3. **Card 3 (Scoring Candidates):** ❌ **NEVER shows** — backend never sets `batch_analysis` or `multi_pass`
4. **Card 4 (Building Final Picks):** ✅ Shows when `ranking` stage is set, but appears **suddenly** without Card 3 ever having shown

### Secondary Bug: Live Counts Never Update

The status API returns `totalMomentsFound` only at completion (it's `NULL` during processing):

File: `/var/www/ganyiq/app/api/analyze/[id]/status/route.ts` (lines 53–61):
```typescript
// Processing response includes totalMomentsFound but it's always 0/NULL
return NextResponse.json({
  analysisId: row.id,
  status: row.status,
  stage: row.progress_stage || 'queued',
  totalMomentsFound: row.total_moments_found || 0,  // Always 0 during processing
});
```

Frontend never updates `liveCandidates` or `liveTotalMomentsFound` during the pipeline, so:
- Card 2 (Candidate Moments): Shows "0 moments found" then jumps to full count
- Card 3 (Scoring Candidates): Shows "0/0 processed" then jumps to completed

### Fix (Two Parts)

**Part A: Add intermediate stage updates in the pipeline**

File: `/var/www/ganyiq/lib/analyze-pipeline.ts`
```typescript
// Stage 2a: Extract candidates
await setStage(analysisId, 'extracting_candidates');
const analysisResult = await analyzeTranscript(videoData.metadata, videoData.transcript);

// Add between Stage 2 and Stage 3:
await setStage(analysisId, 'batch_analysis');  // ← NEW
// Or better: insert stage updates inside analyzeTranscript at meaningful points

await setStage(analysisId, 'multi_pass');       // ← NEW
await setStage(analysisId, 'ranking');
```

**Part B: Add live progress data to status API**

Store `live_candidates_found` and `scored_count` in the `analyses` table during the pipeline so the status API can return them during processing:

```typescript
// After batch scoring completes:
await query(
  'UPDATE analyses SET candidates_scored = $1 WHERE id = $2',
  [allValidMoments.length, analysisId]
);
```

---

## Actions Required

### Immediate (Fix Source Code Drift)

**Sync `/root/GANYIQ/lib/ranking.ts` with production before next deploy:**

```bash
cp /var/www/ganyiq/lib/ranking.ts /root/GANYIQ/lib/ranking.ts
git -C /root/GANYIQ add lib/ranking.ts
git -C /root/GANYIQ commit -m "sync ranking.ts with deployed version (Phase 5A/5C)"
```

Otherwise the next `deploy.sh` will REGRESS to the simplified ranking with MAX_ELITE=5.

---

### Priority 1 — Candidate Drop

| Aspect | Verdict |
|---|---|
| Is there a bug? | ❌ No. Production stores 15 moments correctly |
| Perception gap? | ✅ Source was reverted but never deployed. User may be confusing source with production |
| Action | Sync source to match production. No code change needed on prod |

---

### Priority 2 — Analysis Cache

| Aspect | Verdict |
|---|---|
| Transcript cached? | ✅ Yes (working, ~16ms) |
| Analysis results cached? | ❌ **No. Every submission re-runs LLM** |
| Effort | ~2 hours to implement |
| Impact | **Saves ~4 min and ~$0.003 per re-analysis** |
| Recommendation | ✅ **Implement. Highest ROI.** Return existing `moments` from DB instead of re-running LLM |

---

### Priority 3 — Progress UI

| Aspect | Verdict |
|---|---|
| Card 1 (Transcript) | ✅ Working |
| Card 2 (Candidate Moments) | ⚠️ Stays active for 4+ min while LLM runs |
| Card 3 (Scoring Candidates) | ❌ **Never shows** — backend never sets `batch_analysis` or `multi_pass` |
| Card 4 (Building Final Picks) | ✅ Shows but appears suddenly |
| Live counts | ❌ All show 0 until completion |
| Effort | ~1 hour to add stage updates |
| Impact | Users won't panic thinking the pipeline is stuck |
| Recommendation | ✅ **Implement. High trust signal.** Add stage updates between pipeline phases |
