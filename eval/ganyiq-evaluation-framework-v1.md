# GANYIQ Judge V2 — Evaluation Framework v1

## Overview

| Item | Value |
|------|-------|
| Purpose | Human evaluation of Judge V2 vs V1 ranking quality |
| Dataset | Gold Dataset V2 (80 clips: 3 anchors + 72 real + 5 duplicates) |
| Evaluation Type | Offline, single-rater, blind |
| Final Decision | Go / Tune / No-Go for Judge V2 production deployment |
| Next Action | Complete labeling, then compute metrics |

---

## 1. Human Labeling Methodology — Audit

### 1.1 Current State

| Aspect | Status | Risk |
|--------|--------|------|
| Blind labeling | ✅ Scorer cannot see V1/V2 scores | Low |
| Anchors present | ✅ 3 calibration clips at start | Low |
| Duplicates embedded | ✅ 5 pairs for consistency check | Low |
| Randomized order | ✅ No project grouping | Low |
| Sample diversity | ✅ 6 categories, 4 formats, 6 channels | Low |
| Score range | ✅ V1 30-95, V2 24-100, full coverage | Low |

### 1.2 Identified Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| **Single rater** | HIGH | No inter-rater reliability possible. Mitigation: duplicate consistency check only |
| **Label drift** | MEDIUM | Anchor re-read recommended midway. Mitigation: 3 anchors stay visible |
| **Fatigue bias** | MEDIUM | 80 clips × 30s avg reading = 40 min. Mitigation: cap at 45 min |
| **Context deprivation** | MEDIUM | No video context, only transcript excerpt. Mitigation: all clips compared equally |
| **Language mixing** | LOW | 5 projects Indonesian, 1 English. Risk: scorer may score EN differently. Track per-language correlation |

### 1.3 Labeling Quality Checklist (Post-Hoc)

After labeling, verify:

1. **Duplicate consistency**: For 5 duplicate pairs, |score₁ - score₂| ≤ 1 for ≥ 4/5 pairs (80%)
2. **Anchor ordering**: BAD < AVG < EXCELLENT in human scores (if violated → scorer didn't use scale)
3. **No degenerate scoring**: Check for all-1s, all-10s, or single-value patterns
4. **Time monotonic**: Last 20 clips not systematically lower than first 20 (fatigue check)
5. **Category balance**: No category systematically above/below others (genre bias check)

---

## 2. Human Labeling Guide

### 2.1 Setup

1. Open `ganyiq-gold-dataset-v2.csv` in Google Sheets
2. **Do NOT** look at columns: `v1Score`, `v2Hook`, `v2Hook`, `v2Connection`, `v2Trend`, `v2Raw`, `v2Curved`
3. Hide those columns if necessary (Sheets → right-click column → Hide)
4. Only visible: `clipId`, `transcriptExcerpt`, `HUMAN_SCORE_1_10`, `HUMAN_NOTES`
5. Read the anchors first (first 3 rows) to calibrate your scale

### 2.2 Scoring Rubric (1-10)

| Score | Label | Description | Operational Criteria |
|-------|-------|-------------|---------------------|
| **1-2** | **Bad / Filler** | Not clip-worthy. Would skip. | Outro/intro filler, unsubscribe prompt, meaningless transition, or content that requires >30s setup before it gets interesting. If this appeared in Shorts feed, you'd scroll past in <1s. |
| **3-4** | **Weak** | Low interest, poor hook. | Generic statement with no hook, no emotional trigger, no data. Self-contained but boring. Might work if paired with strong visual, but transcript alone is flat. No curiosity gap. |
| **5-6** | **Average** | Moderately interesting, some value. | Has 1-2 signal elements (question, emotion word, educational point) but lacks a strong opening hook or closing punch. Feels like "background content." Would work as part of a compilation but not standalone. |
| **7-8** | **Good** | Engaging, likely to perform well. | Opens with a hook (question, strong statement, emotional reveal), has coherent narrative arc within the clip, and delivers at least one "moment" that would make someone save/share. Self-contained meaning. |
| **9-10** | **Excellent** | Exceptional. Guaranteed to perform. | Immediate hook in first 3s, high emotional/educational/surprise density, universal relatability, and a memorable line or moment that begs to be clipped. Would generate comments/shares organically. Feels "inevitable" as a clip. |

### 2.3 Decision Flow for Each Clip

```
Read excerpt (1-2s)
├─ Does it grab attention immediately?
│   YES → Is there a clear narrative/point?
│   │   YES → Score 7-10 (rate density + originality)
│   │   NO  → Score 5-6 (hook without substance)
│   NO  → Is there any value (data, emotion, education)?
│       YES → Score 5-6 (value without hook)
│       NO  → Is it a filler/outro/transition?
│           YES → Score 1-2
│           NO  → Score 3-4
```

### 2.4 Calibration Anchors (REFERENCE ONLY — DO NOT CHANGE)

| Anchor | ClipId | V2 Curved | Expected Human Score | Rationale |
|--------|--------|-----------|---------------------|-----------|
| BAD | ANCHOR_BAD | 24 | **1-2** | "Oke itu aja dari gue. Makasih udah nonton. Jangan lupa subscribe." — Pure outro filler, no content value |
| AVERAGE | ANCHOR_AVG | 69 | **5-6** | "Banyak yang nanya, gimana sih cara mulai bisnis kalo modalnya pas-pasan?" — Generic question, no hook, but addresses a real pain point |
| EXCELLENT | ANCHOR_EXCELLENT | 100 | **9-10** | "Sumpah, gua pernah nangis karena mention penuh amarah. Padahal isi konten gua positif. Ini kenapa gue pengen ngajak ngobrol topik ini. Karena gue peduli." — Vulnerability + emotion + mission statement |

**⚠ Anchor scores are FIXED.** They exist only to calibrate your scale. Do not change them.

### 2.5 Scoring Protocol

1. **Read excerpt once.** First impression is usually correct.
2. **Score within 5-10 seconds** per clip. Overthinking reduces signal.
3. **Use full 1-10 range.** If all your scores are 5-8, you're not using the scale. Force yourself to use 1-2 for true filler and 9-10 for truly exceptional moments.
4. **Take a 2-minute break** after clip #30 to reset.
5. **Total session:** Max 45 minutes. If not done, stop and resume later. Labeling accuracy drops after 45 min.

---

## 3. Quality Control Procedure

### 3.1 Anchor Validation

After labeling, check:

```
BAD_human < AVG_human < EXCELLENT_human ?
├─ YES → Scale calibration OK
├─ NO  → Scorer misused scale. Re-label or discard session
```

### 3.2 Duplicate Consistency

5 clips appear twice with different IDs. After labeling:

```
For each duplicate pair (a, b):
  delta = |human_score_a - human_score_b|
  
Pass if: delta ≤ 1 for ≥ 4/5 pairs (80%)
Warning if: delta ≤ 1 for 3/5 pairs (60%)
Fail if: delta ≤ 1 for < 3/5 pairs (< 60%)

If FAIL: scorer was inconsistent → re-labeling needed
```

### 3.3 Scoring Distribution Check

Expected distribution (based on dataset composition):

| Tier | Count | Expected Human Mean | Expected Human Range |
|------|-------|---------------------|----------------------|
| High (24 clips) | 24 | 6.5-8.5 | 4-10 |
| Medium (24 clips) | 24 | 4.5-6.5 | 2-8 |
| Negative (24 clips) | 24 | 1.0-3.5 | 1-6 |

If any tier has mean outside expected range, check for:
- **Ceiling effect**: scorer never uses below 5 → rescale
- **Floor effect**: scorer never uses above 5 → rescale
- **Reversed polarity**: high scored lower than negative → scorer misunderstood scale

### 3.4 Fatigue Check

```
First_20_mean vs Last_20_mean
├─ delta ≤ 0.5 → No fatigue bias
├─ 0.5 < delta ≤ 1.0 → Mild fatigue, acceptable with note
└─ delta > 1.0 → Significant fatigue. Consider partial re-label
```

### 3.5 Category Bias Check

```
For each category (6 total):
  category_mean vs overall_mean
├─ |delta| ≤ 0.5 → No category bias
├─ |delta| ≤ 1.0 → Minor bias, note in report
└─ |delta| > 1.0 → Systematic bias against category
```

---

## 4. Evaluation Metrics — Definitive

### 4.1 Primary Metric: Spearman Rank Correlation (ρ)

**What it measures:** Monotonic rank agreement between system ranking and human ranking.

**Formula:** Standard Spearman's ρ (Pearson on ranks).

**Why primary:** We care about _ordering_ of clip quality, not absolute scores. Spearman captures whether the system's "top clips" match the human's "top clips."

**Target Thresholds:**

| ρ Value | Interpretation | Decision |
|---------|---------------|----------|
| ρ ≥ 0.70 | Strong agreement | ✅ **GO** — production ready |
| 0.50 ≤ ρ < 0.70 | Moderate agreement | ⚠ **TUNE** — usable signal, needs tuning |
| 0.30 ≤ ρ < 0.50 | Weak agreement | ❌ **REJECT** — unreliable for production |
| ρ < 0.30 | No agreement | 🔴 **FAIL** — random or inverse ranking |

**Sub-metrics:**
- ρ(V1 vs Human) — baseline performance
- ρ(V2 vs Human) — Judge V2 performance
- ρ(Hook vs Human), ρ(Coherence vs Human), ρ(Connection vs Human), ρ(Trend vs Human) — per-dimension contribution
- Δρ = ρ(V2) - ρ(V1) — **the single most important number.** If Δρ > 0.1 → V2 improves over V1.

### 4.2 Secondary Metric: Kendall Tau (τ)

**What it measures:** Pairwise rank agreement. More strict than Spearman.

**Formula:** τ = (concordant - discordant) / (n * (n-1) / 2)

**Why secondary:** Gives a more precise measure of how many pairwise comparisons the system gets right.

**Target Thresholds:**

| τ Value | Interpretation |
|---------|---------------|
| τ ≥ 0.50 | Strong |
| 0.30 ≤ τ < 0.50 | Moderate |
| τ < 0.30 | Weak |

### 4.3 Ranking Metric: NDCG@5

**What it measures:** How well the system's top-5 recommendations match human's top-5, with position discount.

**Gain mapping:**

| Human Score | Gain |
|-------------|------|
| 9-10 | 3 (perfect) |
| 7-8 | 2 (good) |
| 5-6 | 1 (average) |
| 1-4 | 0 (poor) |

**Target Thresholds:**

| NDCG@5 | Interpretation | Decision |
|--------|---------------|----------|
| ≥ 0.85 | Excellent top-5 matching | ✅ **GO** |
| 0.70 ≤ NDCG@5 < 0.85 | Good top-5 matching | ⚠ **TUNE** |
| 0.50 ≤ NDCG@5 < 0.70 | Poor top-5 matching | ❌ **REJECT** |
| < 0.50 | Random top-5 | 🔴 **FAIL** |

**Note:** NDCG@5 is meaningful only for clips where human score ≥ 7 (high-quality). If less than 10 clips have human score ≥ 7, NDCG becomes unreliable. Check this before interpreting.

### 4.4 Precision Metric: Precision@3

**What it measures:** Of the system's top-3 clips, how many are also in the human's top-3?

**Target Thresholds:**

| P@3 | Interpretation | Decision |
|-----|---------------|----------|
| ≥ 0.67 (2/3) | High precision | ✅ **GO** |
| = 0.33 (1/3) | Low precision | ⚠ **TUNE** |
| = 0.00 (0/3) | Zero precision | ❌ **REJECT** |

**Note:** With only 72 non-anchor clips and wide score distribution (24 negatives), Precision@3 tests the system's ability to identify true top clips from a realistic pool.

### 4.5 Overlap Metric: Top-3 Overlap

**What it measures:** Raw count of clips shared between system top-3 and human top-3.

**Target Thresholds:**

| Overlap | Interpretation | Decision |
|---------|---------------|----------|
| 3/3 | Perfect match | ✅ **GO** |
| 2/3 | Good match | ✅ **GO** |
| 1/3 | Poor match | ⚠ **TUNE** |
| 0/3 | No match | ❌ **REJECT** |

### 4.6 Quality Metric: Duplicate Consistency Score

**What it measures:** Self-consistency of the human scorer.

**Target Thresholds:**

| Pass Rate | Interpretation | Action |
|-----------|---------------|--------|
| ≥ 80% (4/5) | Consistent scorer | ✅ Accept results |
| 60% (3/5) | Borderline | ⚠ Flag in report, accept |
| < 60% (< 3/5) | Inconsistent | 🔴 Reject results, re-label |

### 4.7 Exploratory: Dimensional Contribution

**What it measures:** Which of the 4 Judge V2 dimensions correlates best with human judgment.

**Calculation:** Spearman ρ between each dimension score and human score.

**Target Thresholds:**

| Dimension | Target ρ | Notes |
|-----------|----------|-------|
| Hook | ρ ≥ 0.50 | Must be highest — hook is primary quality signal |
| Coherence | ρ ≥ 0.30 | Secondary signal |
| Connection | ρ ≥ 0.30 | Tertiary signal |
| Trend | ρ ≥ 0.20 | Weakest — currently lacks temporal context |

**If Hook is NOT the highest predictor:**
→ The prompt rubric is misaligned with human preference
→ Re-design rubric to emphasize what humans actually value

**If Trend is the highest predictor:**
→ The dataset has recency bias or the LLM is using external knowledge
→ Investigate before production

---

## 5. Go/No-Go Decision Matrix

### 5.1 Overall Decision

```
Primary gate: Spearman ρ(V2 vs Human) ≥ 0.70?
├─ YES → Check NDCG@5 ≥ 0.85?
│   ├─ YES → ✅ GO (production ready)
│   └─ NO  → ⚠ GO-CONDITIONAL (production with monitoring)
│
└─ NO → Check Δρ = ρ(V2) - ρ(V1) > 0?
    ├─ YES (V2 > V1) → ⚠ TUNE (V2 is better than V1, but not good enough)
    └─ NO (V2 ≤ V1) → Check if ρ(V1) ≥ 0.70?
        ├─ YES (V1 is actually good) → Deploy V1, deprecate V2
        └─ NO (neither works) → 🔴 SCRAP — neither V1 nor V2 captures human preference
```

### 5.2 Decision Table

| Spearman V2 | NDCG@5 | Δρ (V2-V1) | Duplicate Pass | Decision |
|-------------|--------|-------------|----------------|----------|
| ≥ 0.70 | ≥ 0.85 | — | ≥ 80% | ✅ **GO** |
| ≥ 0.70 | < 0.85 | — | ≥ 80% | ⚠ **GO-CONDITIONAL** (deploy with feature flag + monitoring) |
| 0.50-0.69 | ≥ 0.70 | > 0.10 | ≥ 80% | ⚠ **TUNE** (improve prompt/weight, re-run) |
| 0.50-0.69 | ≥ 0.70 | ≤ 0.10 | ≥ 80% | ⚠ **TUNE-LOW** (V2 not better than V1 — consider hybrid) |
| < 0.50 | < 0.70 | — | — | ❌ **NO-GO** (re-design needed) |
| — | — | — | < 60% | 🔴 **INVALID** (re-label before evaluation) |

### 5.3 Action Plan Per Decision

**✅ GO:**
- Deploy Judge V2 as replacement for V1 ranking
- Keep feature flag `ENABLE_JUDGE_V2=true` with ability to rollback
- Begin collecting production human feedback
- Start Phase 2 (Multi-generator architecture)

**⚠ GO-CONDITIONAL:**
- Deploy with `ENABLE_JUDGE_V2=true` but monitor NDCG@5 weekly
- Keep V1 as fallback with `ENABLE_JUDGE_V2=auto-rollback`
- If NDCG@5 drops below 0.80 in production → auto-rollback to V1
- Start tuning prompt while monitoring

**⚠ TUNE:**
- Do NOT deploy to production
- Fix in order: (1) prompt rubric → (2) dimension weights → (3) trend context injection
- Re-run gold dataset evaluation after each fix
- Re-evaluate after 3 tuning cycles max
- If still < 0.70 after 3 cycles → downgrade to NO-GO

**❌ NO-GO:**
- Scrap Judge V2 approach
- Consider alternative: (a) fine-tune embedding model on clip quality, (b) V1 + simple LLM re-ranking hybrid, (c) buy/rent Opus-level system
- Do NOT start Phase 2 until a viable scoring system exists

### 5.4 Critical Failure Signals (Any One = Immediate NO-GO)

| Signal | Check | Action |
|--------|-------|--------|
| V2 ρ < V1 ρ by > 0.05 | Δρ < -0.05 | V2 is actively worse than V1 |
| Hook ρ < 0.20 | Dimensional check | Hook dimension not capturing what humans value |
| Trend ρ > Hook ρ | Dimensional check | Trend dominating over hook — likely recency bias |
| NDCG@5 < 0.50 | Ranking check | Top-5 recommendations don't match human at all |
| Precision@3 = 0 | Ranking check | System's top picks completely miss human preference |

---

## 6. Dataset Adequacy Review

### 6.1 Is 80 Clips Enough?

| Consideration | Verdict | Rationale |
|---------------|---------|-----------|
| Statistical power | ⚠ **Borderline** | For Spearman ρ with 72 real clips: at ρ=0.70, power ≈ 0.80. For ρ=0.50, power ≈ 0.55. Marginal for detecting ρ < 0.70. |
| Category coverage | ✅ **Adequate** | 6 categories × 12 clips each → reasonable per-category stability |
| Negative sampling | ✅ **Adequate** | 24 negatives (35%) → good for Precision@3 (tests ability to reject) |
| Duplicate validation | ✅ **Adequate** | 5 pairs → enough for 80% threshold with 1 failure margin |
| NDCG@5 reliability | ⚠ **Borderline** | If only ~10 clips have human score ≥ 7, NDCG@5 becomes unreliable. With 24 high-quality clips, expect 8-15 to score ≥ 7. |

### 6.2 Minimum Detectable Effect

With n=72 (removing 3 anchors + 5 duplicates counted once):

```
For Spearman ρ:
  At α=0.05, power=0.80:
  Minimum detectable ρ = 0.32

For Δρ (V2 vs V1):
  Paired rank correlation test:
  Minimum detectable Δρ = 0.15
  
Conclusion: 72 clips can detect whether V2 is "moderately better" than V1,
but cannot reliably distinguish "slightly better" (Δρ < 0.15).
```

### 6.3 Recommendation: Expand to 150-200 Clips?

| For | Against |
|-----|---------|
| Higher statistical power (detect Δρ ≥ 0.10) | 3-4× longer labeling (120-180 min) → fatigue risk |
| More stable NDCG@5 estimates | Diminishing returns: 72→150 clips adds ~2-3 more high-score clips |
| Better category-level analysis | 6 categories × 25 clips → still per-category N is small |
| More negative diversity | 24 negatives already sufficient for P@3 |

**Verdict: 80 clips is ADEQUATE for initial benchmark.**

**Do NOT expand yet.** Label the 80 clips first. Then:
- If ρ(V2) is clearly high (≥ 0.70) or clearly low (< 0.30): 80 clips is enough to make a decision
- If ρ(V2) is marginal (0.40-0.60): expand to 150 clips for higher precision before deciding
- The 5 duplicates effectively reduce usable sample to 72 → this is acceptable

**Expansion trigger:** ρ(V2) between 0.40 and 0.60 after first 80-clip labeling.

---

## 7. Recommended Experiment Sequence

### Phase 1: Initial Evaluation (Current)

```
1. Label 80 clips (you) → 45 min
2. Compute QC checks:
   - Duplicate consistency
   - Anchor ordering
   - Fatigue analysis
   PASS → Continue. FAIL → Re-label with corrections.
3. Compute primary metrics:
   - Spearman ρ(V2 vs Human)
   - Δρ = ρ(V2) - ρ(V1)
   - Kendall τ(V2 vs Human)
   - NDCG@5, P@3, Top-3 overlap
4. Compute dimensional analysis:
   - ρ(Hook), ρ(Coherence), ρ(Connection), ρ(Trend)
   - Best/worst dimension identification
5. Decision: GO / TUNE / NO-GO
```

**Output:** `eval/judge-v2-initial-results.md` with all metrics and decision.

### Phase 2: Tuning (If Needed)

```
IF decision = TUNE:
  1. Fix #1: Prompt rubric (add anchor examples, force 0-10 range)
  2. Re-run Judge V2 on same dataset
  3. Re-compute metrics
  4. If ρ improves by ≥ 0.10 → continue
  5. If not → Fix #2: Dimension weights
  
  6. Fix #2: Weight tuning
     Hook: 1.5x (highest human correlation expected)
     Coherence: 1.0x
     Connection: 0.75x
     Trend: 0.5x (lowest human correlation)
  7. Re-run Judge V2
  8. Re-compute metrics
  9. If ρ ≥ 0.70 → GO
  
  10. If still < 0.70 after 3 cycles → NO-GO
```

### Phase 3: Expansion (If Needed)

```
IF ρ marginal (0.40-0.60) after Phase 1:
  1. Extract 70-120 additional clips (7-10 per project + more negatives)
  2. Label in second session (max 45 min)
  3. Merge with Phase 1 dataset
  4. Re-compute all metrics
  5. Make final decision
```

### Phase 4: Production Validation

```
IF decision = GO or GO-CONDITIONAL:
  1. Deploy Judge V2 with ENABLE_JUDGE_V2=true (A/B: 50% traffic)
  2. Collect production metrics:
     - User engagement on V2-ranked clips vs V1-ranked clips
     - Share rate, click-through rate, video completion rate
  3. After 2 weeks: compare V2 vs V1 production metrics
  4. If V2 performs better → full rollout
  5. If not → rollback, analyze production vs gold dataset discrepancy
```

---

## 8. Summary: What Success Looks Like

```
After Phase 1:

┌────────────────────────────────────────┐
│                                        │
│  Spearman ρ(V2 vs Human) ≥ 0.70       │  ✅ Strong signal
│  + Δρ(V2 - V1) > 0.10                 │  ✅ Clearly better than V1
│  + NDCG@5 ≥ 0.85                      │  ✅ Top-5 matches human
│  + Precision@3 ≥ 0.67                 │  ✅ Top-3 precision
│  + Duplicate consistency ≥ 80%        │  ✅ Scorer is reliable
│  + Hook correlation ≥ 0.50            │  ✅ Hook has predictive power
│  + Trend NOT dominating               │  ✅ No recency bias
│                                        │
│  = GO. Ship it.                        │
│                                        │
└────────────────────────────────────────┘
```

---

## Appendices

### A. Metric Calculation Details (For Post-Labeling Python Script)

```python
# After CSV is returned with HUMAN_SCORE_1_10 filled:

import pandas as pd, numpy as np
from scipy.stats import spearmanr, kendalltau

df = pd.read_csv('labeled_dataset.csv')
real = df[~df['isAnchor'] & ~df['originalClipId'].notna()]

# Spearman
v1_rho, _ = spearmanr(real['HUMAN_SCORE_1_10'], real['v1Score'])
v2_rho, _ = spearmanr(real['HUMAN_SCORE_1_10'], real['v2Curved'])

# Kendall Tau
v1_tau, _ = kendalltau(real['HUMAN_SCORE_1_10'], real['v1Score'])
v2_tau, _ = kendalltau(real['HUMAN_SCORE_1_10'], real['v2Curved'])

# NDCG@5
# Sort by system score, compute DCG@5 using human_score gains
# Divide by IDCG@5 (human's ideal ranking)

# Duplicate consistency
dups = df[df['originalClipId'].notna()]
for _, dup in dups.iterrows():
    orig = df[df['clipId'] == dup['originalClipId']]
    delta = abs(dup['HUMAN_SCORE_1_10'] - orig['HUMAN_SCORE_1_10'].iloc[0])
```

### B. Decision Report Template

```markdown
# Judge V2 Evaluation Report

## Summary
- Spearman ρ(V2 vs Human): X.XX
- Δρ (V2 - V1): +X.XX
- Decision: [GO / TUNE / NO-GO]

## Metrics Table
| Metric | Value | Threshold | Pass? |
|--------|-------|-----------|-------|
| Spearman V2 | X.XX | ≥ 0.70 | ✅/❌ |
| Spearman V1 | X.XX | — | baseline |
| Δρ | X.XX | > 0.10 | ✅/❌ |
| Kendall τ | X.XX | ≥ 0.50 | ✅/❌ |
| NDCG@5 | X.XX | ≥ 0.85 | ✅/❌ |
| Precision@3 | X.XX | ≥ 0.67 | ✅/❌ |
| Top-3 Overlap | X/3 | ≥ 2/3 | ✅/❌ |
| Dup Consistency | X/5 | ≥ 4/5 | ✅/❌ |
| Hook ρ | X.XX | ≥ 0.50 | ✅/❌ |

## Dimensional Analysis
| Dimension | ρ vs Human | Best Project | Worst Project |
|-----------|-----------|-------------|---------------|
| Hook | X.XX | P0X | P0X |
| Coherence | X.XX | P0X | P0X |
| Connection | X.XX | P0X | P0X |
| Trend | X.XX | P0X | P0X |

## Quality Control
- Anchor ordering: [PASS/FAIL]
- Fatigue delta: X.XX [PASS/FAIL]
- Category bias: [NONE/MINOR/SIGNIFICANT]
