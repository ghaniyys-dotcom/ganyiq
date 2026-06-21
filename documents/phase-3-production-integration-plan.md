# Phase 3 — Production Integration Plan

**Date:** 2026-06-16  
**Status:** Design review (pre-implementation)  
**Applies to:** Production deployment of Multi-Generator + Judge V2 pipeline  

---

## 1. Current V1 Production Pipeline Map

### 1.1 Entry Points

```
User → POST /api/analyze (Next.js API route)
         ├─ validateYouTubeUrl()
         ├─ checkRateLimit()         ← IP-based, 100/day
         ├─ create analysis record   ← status='pending'
         └─ return 202 { analysisId }
             
[Background] → runAnalysisPipeline(analysisId, youtubeId, rawUrl, ip)
```

### 1.2 V1 Pipeline Stages

```
Stage 1: FETCH_TRANSCRIPT
         fetchVideoDataWithFallback(youtubeId, url)
         └─ YouTube API → transcript (JSONB)
         └─ Fallback: Deepgram STT if YouTube fails

Stage 2: CANDIDATE EXTRACTION
         extractCandidates(transcript) → CandidateWindow[35]
         └─ Deterministic signal scoring (25 signal types)
         └─ Window formation + Sentence Boundary Recovery
         └─ <50ms, no LLM calls

Stage 3: BATCH ANALYSIS (LLM)
         analyzeTranscript() → RawMoment[]
         └─ 1 batched LLM call (deepseek-v4-flash)
         └─ Scores: worthClippingScore (0-100), DNA tags
         └─ ~2000-4000 tokens input
         └─ Multi-pass verification (1 combined LLM call)

Stage 4: JUDGE V2 (feature-flagged, ENABLE_JUDGE_V2=true)
         enrichWithJudgeV2(moments, transcript, judgeLlm)
         └─ Optional — adds judgeResult to each moment
         └─ 1 batched LLM call
         └─ 4 dimensions: hook, coherence, connection, trend

Stage 5: RANKING
         rankMoments() → RankedMoment[15-20]
         └─ Multi-factor dedup (time, DNA, score, transcript)
         └─ Adaptive threshold → elite/secondary tiers
         └─ No LLM calls — pure arithmetic

Stage 6: STORE RESULTS
         INSERT into moments (15-20 rows)
         INSERT into analysis_metrics
         Fire-and-forget: generateAllTitlesForAnalysis()
```

### 1.3 Data Flow

```
YouTube URL
  ↓
POST /api/analyze → 202 { analysisId }
  ↓ (background)
videos table (transcript JSONB fetch)
  ↓
CandidateWindow[35] (deterministic)
  ↓
LLM → RawMoment[35]  ← COST CENTER (~2000-4000 tokens)
  ↓
Optional: Judge V2 LLM → enriched moments  ← SECONDARY COST
  ↓
rankMoments() → RankedMoment[15-20] (deterministic)
  ↓
moments table (INSERT 15-20 rows)
  ↓
User polls GET .../status → sees results
```

### 1.4 Cost Profile (V1, per analysis)

| Component | Tokens | Cost (est) | Latency |
|-----------|--------|-----------|---------|
| Transcript fetch | 0 | Free | 1-5s |
| Candidate extraction | 0 | Free | <50ms |
| LLM batch analysis | 2000-4000 | ~$0.0003-0.0006 | 5-15s |
| Judge V2 (if enabled) | 1500-3000 | ~$0.0002-0.0005 | 3-10s |
| Ranking | 0 | Free | <100ms |
| DB storage | 0 | Free | <500ms |
| **Total** | **3500-7000** | **$0.0005-0.0011** | **10-30s** |

---

## 2. Integration Plan

### 2.1 Architecture: Multi-Generator Pipeline Replaces Stage 3-5

```
CURRENT V1:
  Extraction → LLM Batch → Ranking → Output

NEW V2:
  Extraction → [4 Generators → Dedup → Diversity → Judge V2 → Ranking] → Output
```

### 2.2 Detailed Stage Replacement

```
V1 Stage 1-2  (FETCH + EXTRACTION)
  │                ← UNCHANGED
  ▼
V1 Stage 3    (LLM BATCH ANALYSIS)
  │
  │  REPLACED BY:
  │  ┌─────────────────────────────────────────────────┐
  │  │  Hook Generator (signal-based, no LLM)         │
  │  │  Insight Generator (structural markers, no LLM)│
  │  │  Emotion Generator (structural markers, no LLM)│
  │  │  Authority Generator (structural markers, no LLM)│
  │  └──────────────┬──────────────────────────────────┘
  │                 ↓  Top 5 each
  │      ┌─────────────────────┐
  │      │  Candidate Pool     │ 20 candidates
  │      └─────────┬───────────┘
  │                ↓
  │      ┌─────────────────────┐
  │      │  dedupPool()        │ cluster + maxPerCluster
  │      │  diversity.ts       │ pairwise overlap check
  │      └─────────┬───────────┘
  │                ↓  14-20 survivors
  │      ┌─────────────────────┐
  │      │  Judge V2           │ re-rank candidates
  │      │  (LLM, batched)     │ 4 dimensions + curvedScore
  │      └─────────┬───────────┘
  │                ↓  ranked + scored
  ▼
V1 Stage 5    (RANKING)
  │                ← MODIFIED: now ranks by curvedScore
  ▼
V1 Stage 6    (STORE RESULTS)
  │                ← UNCHANGED (moments table, metrics)
  ▼
```

### 2.3 Schema Changes

**New table: `generator_attribution`** (optional, for debugging)

```sql
CREATE TABLE generator_attribution (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  moment_id UUID REFERENCES moments(id) ON DELETE CASCADE,
  generator VARCHAR(20) NOT NULL,         -- 'hook'|'insight'|'emotion'|'authority'
  internal_score INT,
  curved_score DECIMAL(5,2),
  trigger_signals JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_gen_attr_moment ON generator_attribution(moment_id);
CREATE INDEX idx_gen_attr_generator ON generator_attribution(generator);
```

**Existing `moments` table:** Add `judge_result` JSONB column (if not already present):

```sql
ALTER TABLE moments ADD COLUMN IF NOT EXISTS judge_result JSONB;
```

**Existing `analysis_metrics` table:** Add generator columns:

```sql
ALTER TABLE analysis_metrics ADD COLUMN IF NOT EXISTS
  num_generators INT,                    -- how many generators produced output
  num_generator_candidates INT,          -- total candidates before dedup
  num_dedup_removed INT,                 -- candidates removed by dedup
  diversity_score DECIMAL(4,3);          -- avg diversity score of final pool
```

### 2.4 File Changes Summary

| File | Action | Reason |
|------|--------|--------|
| `lib/analyze-pipeline.ts` | **MODIFY** | Replace LLM batch with multi-generator stage |
| `lib/multi-generator/types.ts` | **MODIFY** | Add 'authority' to GeneratorStrategy |
| `lib/multi-generator/index.ts` | **MODIFY** | Export new generators |
| `lib/multi-generator/pipeline.ts` | **IMPLEMENT** | Full pipeline orchestrator |
| `lib/ranking.ts` | **MODIFY** | Accept V2 candidates with curvedScore |
| `lib/judge-integration.ts` | **UPDATE** | Accept GeneratorCandidate[] |
| `lib/score-spread.ts` | **MODIFY** | Handle curvedScore display |
| `.env` | **UPDATE** | Add feature flag |
| `db/migrate.ts` | **UPDATE** | Add generator_attribution table |

### 2.5 No New Dependencies

Zero new npm packages. All 4 generators, dedup, diversity scoring are pure TypeScript. Judge V2 uses the existing LLM interface.

---

## 3. Migration Strategy

### 3.1 Feature Flag: Four-Phase Rollout

```env
# .env — staged enablement
V2_MULTI_GENERATOR_ENABLED=false    # Phase 3a: off (V1 default)
V2_MULTI_GENERATOR_SHADOW=false     # Phase 3b: shadow mode
V2_MULTI_GENERATOR_ENABLED=true     # Phase 3c: canary
V2_MULTI_GENERATOR_FORCE=true       # Phase 3d: full rollout
```

### 3.2 Phase 3a: Feature Flag + Code (Day 1-2)

- Merge all V2 code with `V2_MULTI_GENERATOR_ENABLED=false`
- Zero behavior change — V1 runs as before
- Verify compilation, DB migrations, no regressions
- **Rollback:** `git revert` — no data impact since code is inert

### 3.3 Phase 3b: Shadow Mode (Day 3-7)

When `V2_MULTI_GENERATOR_SHADOW=true`:
- V2 runs PARALLEL to V1 on every analysis
- V1 output goes to user (status quo)
- V2 output is logged + stored in `generator_attribution` table
- Both pipelines run independently — no conflict

**Shadow mode behavior:**
```
V1 Pipeline → moments table → user sees V1 results
V2 Pipeline → generator_attribution table → no user visible change
              ↑ silently runs in background after V1 completes
```

**Shadow mode data collected:**
- V2 curvedScore distribution
- Generator contribution ratios
- Dedup rates
- Diversity scores
- Latency comparison (V1 vs V2)

**Rollback:** Set `V2_MULTI_GENERATOR_SHADOW=false`. No user impact.

### 3.4 Phase 3c: Canary / A/B Test (Day 8-14)

When `V2_MULTI_GENERATOR_ENABLED=true` (default for 10% of users):
- 10% of analyses use V2 pipeline
- 90% use V1 (control group)
- Compare: acceptance rate, watch time, retention

**A/B test design:**

| Group | % | Pipeline | Measurement |
|-------|---|----------|-------------|
| Control | 90% | V1 | Baseline metrics |
| Treatment | 10% | V2 Multi-Gen | All metrics + attribution |

**A/B routing:**
```typescript
function selectPipeline(analysisId: string): 'v1' | 'v2' {
  // Deterministic — same video always same pipeline
  const hash = hashCode(analysisId);
  return hash % 100 < 10 ? 'v2' : 'v1';
}
```

**Rollback:** Set `V2_MULTI_GENERATOR_ENABLED=false` → all traffic returns to V1.

### 3.5 Phase 3d: Full Rollout (Day 15+)

When `V2_MULTI_GENERATOR_FORCE=true`:
- 100% of analyses use V2 pipeline
- V1 code path remains as fallback
- Monitor KPIs for 7 days
- If V2 KPIs < V1 baseline, auto-rollback

**Auto-rollback trigger:**
```typescript
// Check every hour
if (v2Metrics.clipAcceptanceRate < v1Baseline * 0.9) {
  await setFeatureFlag('V2_MULTI_GENERATOR_ENABLED', false);
  await notifyOps('Auto-rollback: V2 acceptance rate dropped below 90% of V1 baseline');
}
```

### 3.6 Complete Rollback Plan

| Scenario | Action | Recovery Time | Data Loss |
|----------|--------|--------------|-----------|
| Bug in generator code | Set flag=false, deploy fix | 5min + deploy | Zero |
| Judge V2 LLM failure | Set `ENABLE_JUDGE_V2=false` | <1min | Zero (curvedScore fallback) |
| Empty pool from all generators | Fall back to V1 extraction | <1min | Zero |
| Cost spike >2x | Set flag=false, investigate | 5min | Zero |
| Any unexpected behavior | Set flag=false | <1min | Zero |

---

## 4. Performance Analysis

### 4.1 Latency Breakdown

| Stage | V1 (current) | V2 (new) | Delta |
|-------|-------------|----------|-------|
| Transcript fetch | 1-5s | 1-5s | **0** |
| Candidate extraction | <50ms | <50ms | **0** |
| LLM analysis | 5-15s | **—** (removed) | **-5 to -15s** ✅ |
| 4 generators | — | 50-250ms total | **+50 to +250ms** |
| Dedup + diversity | — | <5ms | **+5ms** |
| Judge V2 | 3-10s | 3-10s | **0** (already present) |
| Ranking | <100ms | <100ms | **0** |
| DB storage | <500ms | <500ms | **0** |
| **Total** | **10-30s** | **5-16s** | **-30% to -50%** ✅ |

**Key insight:** Removing the LLM batch analysis stage saves 5-15s. The 4 generators add only 50-250ms because they are pure signal-based (no LLM calls). **V2 is faster than V1.**

### 4.2 Token Impact

| Component | V1 tokens | V2 tokens | Delta |
|-----------|----------|----------|-------|
| LLM batch analysis | 2000-4000 | **0** (removed) | **-2000 to -4000** ✅ |
| Judge V2 | 1500-3000 | 800-2000 (fewer candidates) | **-700 to -1000** ✅ |
| **Total** | **3500-7000** | **800-2000** | **-60% to -77%** ✅ |

**Why Judge V2 uses fewer tokens:** V1 had 35 candidates → Judge V2 evaluated all 35. V2 has 14-20 (after dedup) → Judge V2 evaluates fewer candidates. Each candidate adds ~50 tokens to the batch prompt.

### 4.3 Cost Impact

| Component | V1 cost | V2 cost | Delta |
|-----------|---------|---------|-------|
| LLM analysis | $0.0003-0.0006 | $0 | **-$0.0003 to -$0.0006** |
| Judge V2 | $0.0002-0.0005 | $0.0001-0.0003 | **-$0.0001 to -$0.0002** |
| **Total per analysis** | **$0.0005-0.0011** | **$0.0001-0.0003** | **-70% to -80%** ✅ |

### 4.4 Memory Impact

| Metric | V1 | V2 | Delta |
|--------|-----|-----|-------|
| JS heap per analysis | ~15-25MB | ~5-10MB | **-50% to -60%** ✅ |
| Peak memory (LLM) | ~30-50MB | ~0MB (no LLM gen) | **-100%** ✅ |
| DB storage per analysis | ~15KB | ~20KB (attribution) | **+33%** |
| Overall VPS impact | Negligible | Negligible | **No change** |

### 4.5 Database Impact

| Table | V1 rows | V2 rows | Delta |
|-------|---------|---------|-------|
| `moments` | 15-20 | 15-20 | **0** |
| `generator_attribution` | 0 | 0-20 (new) | **+0 to +20** |

Total additional storage: ~2KB per analysis. At 100 analyses/day = ~200KB/day. **Negligible.**

---

## 5. Production Risks

### 5.1 Risk Matrix

| # | Risk | Probability | Impact | Mitigation |
|---|------|------------|--------|------------|
| R1 | Generator returns 0 candidates | Medium (Raditya Dika case) | Low — falls back to other generators | Pool dedup handles gracefully; if all return 0 → V1 fallback |
| R2 | Judge V2 LLM failure | Low (same as current) | Medium — no curvedScore | `ENABLE_JUDGE_V2=false` → use internalScore as fallback |
| R3 | All 4 generators produce empty pool | Low (only possible on extremely short/strange videos) | High — no clips returned | Fallback to V1 candidate extraction |
| R4 | Generators produce too many duplicates | Medium | Medium — wasted Judge V2 calls | `maxPerCluster=2` and `maxPairOverlap=0.65` hard limits |
| R5 | Cost spike from unexpected LLM retries | Low | Low — budget safety | Judge V2 has `batchSize=10` and `maxRetries=3` baked in |
| R6 | Diversity filter removes ALL candidates | Low | High — empty output | Floor: if survivors < 3 after dedup, skip diversity score filter |
| R7 | Generator disagrees with V1 significantly | Expected | Low — that's the point | A/B test measures if users prefer V2 clips |
| R8 | Timeout chain (users wait >30s) | Low | Medium — bad UX | Pipeline has `setStage()` progress reporting; frontend polls every 2s |
| R9 | Feature flag logic bug | Low | Medium — wrong pipeline runs | Unit test flag logic; shadow mode validates before canary |
| R10 | DB migration on live table | Low | Low — additive column only | `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` is safe |

### 5.2 Failure Mode: Empty Pool (R3)

If all generators return 0 candidates (possible on very short videos or noise-only transcripts):

```typescript
async function runMultiGeneratorOrFallback(transcript, videoId) {
  const pool = await runAllGenerators(transcript, videoId);
  if (pool.length === 0) {
    console.warn('[V2] All generators returned 0 — falling back to V1 extraction');
    return runV1LegacyPipeline(transcript, videoId);
  }
  // ... normal V2 flow
}
```

### 5.3 Failure Mode: Judge V2 Failure (R2)

If Judge V2 LLM call fails (network error, API key expired, rate limit):

```typescript
async function judgeWithFallback(candidates) {
  try {
    return await judgeEngine.evaluateBatch(candidates);
  } catch (err) {
    console.error('[V2] Judge V2 failed — using internalScore fallback', err.message);
    // Fallback: use generator's own internalScore as Judge score
    return candidates.map(c => ({
      ...c,
      curvedScore: c.metadata.internalScore,
      judgeResult: null,
    }));
  }
}
```

### 5.4 Failure Mode: Feature Flag Flip-Flop (R9)

```typescript
// test/pipeline-routing.test.ts
describe('Pipeline routing', () => {
  it('routes to V1 when V2_MULTI_GENERATOR_ENABLED=false', () => { /* ... */ });
  it('routes to V2 when V2_MULTI_GENERATOR_ENABLED=true', () => { /* ... */ });
  it('logs both in shadow mode without affecting V1 output', () => { /* ... */ });
});
```

---

## 6. Success Metrics

### 6.1 Production KPIs

| KPI | Definition | Measurement | V1 Baseline | V2 Target |
|-----|-----------|-------------|-------------|-----------|
| **Clip acceptance rate** | % of analyses where user renders at least 1 clip | `rendered_clips / total_analyses` | ~60% | ≥65% |
| **Human override rate** | % of auto-selected clips manually replaced by user | `manual_clips / total_clips` | Unknown | <10% |
| **Watch time per clip** | Average seconds watched for rendered clips | From YouTube Analytics | Unknown | ≥70% of clip duration |
| **Retention** | % of users who analyzed >1 video | `returning_users / total_users` | Unknown | ≥20% |
| **Average clips per video** | Number of clips offered in UI | `total_clips / total_analyses` | 15 | 10-15 |
| **Full-pipeline success rate** | % of analyses that complete without error | `completed / total_analyses` | ~95% | ≥95% |
| **Average processing time** | Time from POST to status=completed | Pipeline timer | ~20s | <15s |
| **Average cost per analysis** | LLM API cost | Token tracking | ~$0.0008 | <$0.0003 |

### 6.2 V2-Specific Metrics

| Metric | Instrumentation | Purpose |
|--------|---------------|---------|
| Generator contribution % | `generator_attribution` table | Ensure all 4 generators are used |
| Dedup removal rate | `analysis_metrics.num_dedup_removed` | Detect if dedup is too aggressive |
| Diversity score (avg) | `analysis_metrics.diversity_score` | Track pool health |
| Empty pool rate | Log when fallback to V1 triggers | Detect content gaps |
| Generator latency per analysis | `generator_attribution.created_at` | Track gen performance |
| Judge V2 score distribution | `moments.judge_result` | Monitor for score drift |

### 6.3 Monitoring Dashboard

**Alerting thresholds:**
- Empty pool rate > 5% → investigate generator signal coverage
- Dedup removal rate > 50% → dedup too aggressive, relax constraints
- Judge V2 avg curvedScore < 40 → Judge quality degraded
- Pipeline success rate < 90% → infrastructure issue
- Cost per analysis > $0.001 → token budget exceeded

---

## 7. Implementation Order (Phase 3)

### Phase 3a: Code + Flag (Day 1-2)

1. Add 'authority' to GeneratorStrategy type
2. Export all generators from barrel
3. Implement `lib/multi-generator/pipeline.ts` orchestrator
4. Create `lib/v2-pipeline.ts` — the new Stage 3-5 replacement
5. Add feature flag to `.env`
6. Modify `lib/analyze-pipeline.ts` to check flag
7. DB migration: generator_attribution table + metrics columns
8. Unit tests: routing, fallback, empty pool
9. Deploy with flag=false

### Phase 3b: Shadow Mode (Day 3-7)

1. Implement shadow mode in `lib/analyze-pipeline.ts`
2. Add V2 → generator_attribution logging
3. Monitor for 5 days
4. Verify:
   - No errors from shadow mode
   - Generators produce candidates on real traffic
   - Dedup works on real data
   - Latency within expected range
5. **Go/No-Go decision** based on shadow data

### Phase 3c: Canary / A/B Test (Day 8-14)

1. Implement A/B routing
2. Deploy flag=true for 10%
3. Monitor KPIs for 7 days
4. Compare V1 vs V2 metrics
5. **Go/No-Go decision** based on A/B results

### Phase 3d: Full Rollout (Day 15+)

1. Set flag=true for 100%
2. Monitor for 7 days
3. Remove V1 code path if V2 stabilizes
4. Archive V1 as rollback option

---

## Appendix A: Pipeline Code Structure

### New file: `lib/v2-pipeline.ts`

```typescript
export async function runV2Pipeline(
  transcript: TranscriptSegment[],
  videoId: string,
  analysisId: string,
): Promise<{
  rankedMoments: RankedMoment[];
  attribution: GeneratorAttribution[];
  metrics: V2Metrics;
}> {
  // 1. Run all generators in PARALLEL (Promise.allSettled)
  // 2. Aggregate top K
  // 3. dedupPool() — cluster-aware dedup
  // 4. Judge V2 — evaluate survivors
  // 5. Rank by curvedScore DESC
  // 6. Post-process into RankedMoment[]
  // 7. Build attribution
  // 8. Return
}
```

### Modified: `lib/analyze-pipeline.ts`

```typescript
// In runAnalysisPipeline, after Stage 2:
if (isMultiGeneratorEnabled()) {
  const v2Result = await runV2Pipeline(transcript, videoId, analysisId);
  rankedMoments = v2Result.rankedMoments;
  // Store attribution
  // Store metrics
} else {
  // Original V1 flow
  const analysisResult = await analyzeTranscript(...);
  // ... existing code
}
```

---

*End of Phase 3 Planning Document*
