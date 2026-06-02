# First 100 Analyses Plan

> **Version:** 1.0
> **Date:** 2026-06-02
> **Goal:** Collect 100 real podcast analyses across 6 categories to validate ganyIQ output quality

---

## 1. Target Distribution

### Final Target

| Category | Count | Percentage | Rationale |
|---|---|---|---|
| **Business** | 20 | 20% | High clipper demand, clear ROI moments |
| **Motivation** | 20 | 20% | High virality potential, broad audience |
| **Comedy** | 20 | 20% | Most clipped category, tests humor detection |
| **Storytelling** | 15 | 15% | Tests narrative understanding |
| **Finance** | 15 | 15% | Niche but high-value, tests authority detection |
| **Controversy** | 10 | 10% | Smallest but highest stakes, tests sensitivity |
| **Total** | **100** | **100%** | |

### Why This Distribution

Business and Motivation get the most allocation because:
- They represent the largest segments of Indonesian podcast content
- Clippers report the highest demand for business/motivation clips
- These categories have the clearest "viral DNA" signals (money, authority, motivation)

Controversy gets the smallest allocation because:
- It's inherently risky (sensitive content)
- Fewer professional clippers specialize in controversy
- Lower volume of suitable content with captions available

---

## 2. Collection Targets

### Weekly Milestones

| Week | Target | Cumulative | Daily Rate | Focus |
|---|---|---|---|---|
| Week 1 | 20 | 20 | 3-4/day | First cross-category pass (3 per category + 2 extra) |
| Week 2 | 25 | 45 | 4-5/day | Fill gaps in Business, Motivation, Comedy |
| Week 3 | 25 | 70 | 4-5/day | Fill gaps in remaining categories |
| Week 4 | 30 | 100 | 5-6/day | Final push, re-submit failures, spot checks |
| **Total** | **100** | **100** | | |

### Weekly Category Targets

```
Week 1 (20 total):          Week 2 (25 total):          Week 3 (25 total):          Week 4 (30 total):
  Business:    4              Business:    5              Business:    5              Business:    6
  Motivation:  4              Motivation:  5              Motivation:  5              Motivation:  6
  Comedy:      4              Comedy:      5              Comedy:      5              Comedy:      6
  Storytelling:3              Storytelling:4              Storytelling:4              Storytelling:4
  Finance:     3              Finance:     4              Finance:     4              Finance:     4
  Controversy: 2              Controversy: 2              Controversy: 2              Controversy: 4
```

### Cumulative Target Per Category

```
Category        W1    W2    W3    W4    Target
─────────────────────────────────────────────
Business         4 ──  9 ── 14 ── 20 ── ✅ 20
Motivation       4 ──  9 ── 14 ── 20 ── ✅ 20
Comedy           4 ──  9 ── 14 ── 20 ── ✅ 20
Storytelling     3 ──  7 ── 11 ── 15 ── ✅ 15
Finance          3 ──  7 ── 11 ── 15 ── ✅ 15
Controversy      2 ──  4 ──  6 ── 10 ── ✅ 10
─────────────────────────────────────────────
Total           20 ── 45 ── 70 ── 100 ── ✅ 100
```

### Daily Workflow

```
Each day:
  1. Open eval/url-tracker.csv
  2. Find 5 videos marked "pending" across different categories
  3. Submit each to POST /api/analyze
  4. Record analysisId and submitted_at in the tracker
  5. If failed: mark as "failed", find replacement
  6. If succeeded: mark as "submitted"
  
  Time required: ~15 minutes for submission + 40s per analysis = ~20 mins/day
  Total: ~45 minutes/day including selection time
```

---

## 3. Review Milestones

### Review Sample Schedule

| Batch | When | Analyses to Review | Categories Covered | Reviewer |
|---|---|---|---|---|
| R1 | After 20 collected | 4 analyses (top 2 categories) | Business, Motivation | Founder |
| R2 | After 40 collected | 4 analyses (next 2 categories) | Comedy, Finance | Founder |
| R3 | After 60 collected | 4 analyses (remaining categories) | Storytelling, Controversy | Founder |
| R4 | After 80 collected | 4 analyses (mixed across all) | All 6 categories | Founder + 1 clipper |
| R5 | After 100 collected | 4 analyses (best and worst) | All 6 categories | Founder + 2 clippers |
| **Total** | **End of Week 4** | **20 reviews** | **All categories** | **3 reviewers max** |

### Review Depth

| Batch | Review Type | Criteria |
|---|---|---|
| R1-R2 | Deep review | Full scorecard, all 6 criteria per moment |
| R3 | Light review | Overall impression only + failure pattern check |
| R4-R5 | Full review + inter-rater | Full scorecard, 2 reviewers per analysis |

### Decision Points

```
After R1 (20 analyses / 4 reviews):
  If avg clip usefulness < 2.5/5 → STOP. Tune prompt.
  If avg ≥ 2.5/5 → CONTINUE to R2.

After R3 (60 analyses / 12 reviews):
  If any category avg < 2.5/5 → Expand review for that category.
  If all categories ≥ 2.5/5 → CONTINUE.

After R5 (100 analyses / 20 reviews):
  If overall avg ≥ 3.0/5 → PROCEED to launch prep.
  If avg 2.5-2.9/5 → Tune prompt, re-run on R5 analyses.
  If avg < 2.5/5 → HALT. Architecture review needed.
```

---

## 4. Launch Readiness Checkpoints

### Checkpoint A: Pipeline Health (Week 1)

```
After 20 analyses submitted:
────────────────────────────────
[ ] Success rate ≥ 90% (≤2 failures out of 20)
[ ] Average processing time < 60s
[ ] No consistent error patterns
[ ] Rate limiting not blocking collection

Verdict: ___ / 4 gates
```

### Checkpoint B: Category Coverage (Week 2)

```
After 45 analyses submitted:
────────────────────────────────
[ ] All 6 categories have ≥4 analyses each
[ ] No single category exceeds 30% of total
[ ] At least 4 different channels per category
[ ] Video lengths range from 20-180 minutes

Verdict: ___ / 4 gates
```

### Checkpoint C: Quality Baseline (Week 3)

```
After 70 analyses submitted + 12 reviews completed:
────────────────────────────────────────────────────
[ ] Avg timestamp accuracy ≥ 3.0/5
[ ] Avg clip usefulness ≥ 3.0/5
[ ] Avg DNA tag accuracy ≥ 3.0/5
[ ] Avg reasoning quality ≥ 3.0/5
[ ] Hallucination rate < 20% of moments
[ ] Timestamp drift < 5s average

Verdict: ___ / 6 gates
```

### Checkpoint D: Launch Readiness (Week 4)

```
After 100 analyses submitted + 20 reviews completed:
──────────────────────────────────────────────────────
[ ] All Checkpoints A, B, C passed
[ ] Overall average score ≥ 3.0/5
[ ] No category below 2.5/5
[ ] Production pipeline stable for 100 consecutive runs
[ ] Golden Dataset v1.0 locked (12+ transcripts)
[ ] Benchmark baseline recorded
[ ] Failure patterns documented
[ ] Mitigation plan for top 3 patterns

LAUNCH VERDICT: ___ / 8 gates
  ☐ PROCEED TO BETA
  ☐ CONDITIONAL (fix top issues first)
  ☐ HALT (quality not acceptable)
```

---

## 5. Quality Thresholds

### Hard Thresholds (Must Pass)

| Metric | Threshold | Measurement |
|---|---|---|
| Pipeline success rate | ≥ 90% | Failed submits / Total submits |
| Avg processing time | ≤ 60s | `processing_time_ms` from DB |
| Avg clip usefulness | ≥ 3.0/5 | Human review scorecard |
| Avg timestamp accuracy | ≥ 3.0/5 | Human review scorecard |
| Category coverage | All 6 categories ≥ 4 analyses | URL tracker |
| Category balance | No category > 25% of total | URL tracker |

### Soft Thresholds (Target, Not Blocking)

| Metric | Target | Stretch Goal |
|---|---|---|
| Avg DNA tag accuracy | 3.0/5 | 3.5/5 |
| Avg reasoning quality | 3.0/5 | 3.5/5 |
| Avg hook quality | 3.0/5 | 3.5/5 |
| Hallucination rate | < 20% | < 10% |
| Timestamp drift avg | < 5s | < 3s |
| Elite moments per analysis | ≥ 1 | ≥ 2 |

---

## 6. Failure Recovery

### Video Not Available

If a submitted video returns TRANSCRIPT_UNAVAILABLE or ANALYSIS_FAILED:

1. Mark as `failed` in URL tracker
2. Find a replacement video from the same category
3. Add replacement as a new row in tracker
4. Submit replacement
5. If 3+ consecutive failures in same category → find better channels for that category

### Rate Limited

If you hit the 5/day rate limit:

1. Stop submitting for 24 hours
2. Pre-select 5 URLs for the next day
3. Submit in the morning (fresh limit)
4. If rate limiting persists >3 days → temporarily increase limit in .env.local

### Low Quality Scores

If after R1 review, quality scores are below threshold:

1. Stop collection
2. Analyze failure patterns (which criteria are weak?)
3. Tune prompt in `lib/prompt.ts`
4. Re-run on the 4 reviewed analyses
5. Re-review
6. If improved → resume collection
7. If not improved → try different model or deeper prompt changes

---

## 7. Quick Reference

```
COLLECTION SUMMARY
════════════════════════════════════════════════════════

Target:      100 analyses
Timeline:    4 weeks (5-6 per day)
Categories:  6 (Business, Motivation, Comedy, Storytelling, Finance, Controversy)
Reviews:     20 analyses across 5 batches
Reviewers:   Founder + up to 2 beta clippers
Gate checks: 4 checkpoints (Pipeline, Coverage, Quality, Launch)
Hard fails:  Pipeline < 90%, Usefulness < 3.0/5, Coverage missing categories

START DATE:  [Today]
END DATE:    [Today + 28 days]
```

---

## 8. Tools Needed

| Tool | Purpose | Status |
|---|---|---|
| `eval/url-tracker.csv` | Track all 100 URLs | ✅ Template created (needs population) |
| `eval/batch-submit.sh` | Automated submission | 🔴 Not yet built |
| `eval/aggregate-scores.ts` | Scorecard aggregation | 🔴 Not yet built |
| `POST /api/analyze` | Submit analysis | ✅ Live |
| `GET /api/analyze/:id` | Fetch results for review | 🔴 Not yet built |
| `eval/review-template.md` | Scorecard form | ✅ Created |
