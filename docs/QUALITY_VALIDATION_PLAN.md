# Quality Validation Plan

> **Version:** 1.0
> **Date:** 2026-06-02
> **Status:** ACTIVE
> **Phase:** 4.5 (Post-Pipeline Validation)
> **Purpose:** Ensure ganyIQ outputs are genuinely useful for professional clippers

---

## Table of Contents

1. [Test Methodology](#1-test-methodology)
2. [Evaluation Categories](#2-evaluation-categories)
3. [Scoring Criteria](#3-scoring-criteria)
4. [Manual Reviewer Rubric](#4-manual-reviewer-rubric)
5. [Pass/Fail Thresholds](#5-passfail-thresholds)
6. [Golden Dataset Plan](#6-golden-dataset-plan)
7. [Collection Process (50–100 Analyses)](#7-collection-process-50100-analyses)
8. [Benchmarking Model Upgrades](#8-benchmarking-model-upgrades)
9. [Failure Patterns](#9-failure-patterns)
10. [Quality Scorecard Template](#10-quality-scorecard-template)

---

## 1. Test Methodology

### 1.1 Philosophy

ganyIQ's output must be judged by the standard of a **professional Indonesian podcast clipper**, not by academic or algorithmic metrics. A moment is "good" if a real clipper would clip it.

### 1.2 Two-Layer Validation

```
Layer 1: Automated (Synthetic)
  ─────────────────────────────────
  Pipeline integrity checks:
  • HTTP 200 returned
  • Moments array is non-empty
  • All required fields present
  • Timestamps within video duration
  • Scores within 0-100
  • DNA tags from valid list
  • Confidence is high/medium/low
  • No duplicate timestamps after dedup

  Run: Every commit / CI pipeline
  Tool: test/eval/run-eval.ts (to be built)

Layer 2: Human (Manual Review)
  ─────────────────────────────────
  Domain expert evaluates each moment:
  • "Would I clip this?"
  • "Is the reasoning correct?"
  • "Are the DNA tags accurate?"
  • "Does the timestamp match the content?"

  Run: Weekly batch of 10 analyses
  Reviewer: Founder / beta clipper
  Tool: Quality Scorecard (Section 10)
```

### 1.3 Evaluation Frequency

| Phase | Frequency | Sample Size | Reviewer |
|---|---|---|---|
| MVP Beta (Weeks 1-4) | Daily | 5 analyses | Founder |
| MVP Beta (Weeks 5-8) | Every 2 days | 10 analyses | Founder + 2 beta clippers |
| Post-Launch | Weekly | 10 analyses | 3-5 beta clippers |
| Model Upgrade | Full Golden Dataset | 20+ analyses | Founder + 3 beta clippers |

### 1.4 Scoring Scale

All criteria use a standard **1-5 scale**:

| Score | Label | Meaning |
|---|---|---|
| 5 | 🔥 Excellent | Better than a professional clipper would do |
| 4 | ✅ Good | Matches professional clipper quality |
| 3 | ⚠️ Acceptable | Usable but has minor issues |
| 2 | ❌ Poor | Notable problems, would not trust |
| 1 | 🚫 Failing | Completely wrong or unusable |

---

## 2. Evaluation Categories

Each category targets a specific content niche that Indonesian podcast clippers work with. Categories ensure diverse testing across different content styles.

### Category Matrix

| # | Category | Description | Example Channels | Key DNA Priorities |
|---|---|---|---|---|
| 1 | **Podcast Business** | Entrepreneurship, startup, career talk | Podkesmas, Selamat Pagi Bosku, Suara Berkelas | authority, money, motivation |
| 2 | **Podcast Motivation** | Self-improvement, mindset, life advice | Mario Teguh, Ayah Taufik, Podcast Psychology | motivation, relatability, educational |
| 3 | **Podcast Comedy** | Humor, satire, entertainment | Podcast Awal Minggu, Rony Suara, Praz Teguh | humor, curiosity, hookPower |
| 4 | **Podcast Finance** | Investing, crypto, personal finance | Fellexandro Ruby, Nadine Waworuntu, Market Buzz | money, controversy, authority |
| 5 | **Podcast Storytelling** | Personal stories, biographies, confessions | Curhat Bang, Cerita Kopi, Sekarang Saya | emotion, storytelling, relatability |
| 6 | **Podcast Controversy** | Debates, hot topics, political discussion | Deddy Corbuzier, Talkpod, Side Action | controversy, shock, hookPower |

### Category Minimums

Each validation batch must include at least **1 analysis from each category** to ensure balanced coverage. A full validation cycle (10 analyses) should span all 6 categories with 4 additional analyses from any category.

---

## 3. Scoring Criteria

Each moment in an analysis is scored across 6 dimensions.

### 3.1 Timestamp Accuracy

Does the start/end time actually match the content described?

| Score | Criteria |
|---|---|
| 5 | Perfect match — timestamp points exactly to the described moment |
| 4 | Off by <3 seconds — still usable, no manual adjustment needed |
| 3 | Off by 3-10 seconds — noticeable but the right segment |
| 2 | Off by 10-30 seconds — wrong part of the conversation |
| 1 | Completely wrong — timestamp points to unrelated content |

### 3.2 Clip Usefulness

Would a clipper actually use this moment?

| Score | Criteria |
|---|---|
| 5 | "I would clip this immediately" — obvious viral hit |
| 4 | "I would consider clipping this" — solid candidate |
| 3 | "Maybe, if I need volume" — background filler |
| 2 | "I would skip this" — not worth the editing time |
| 1 | "This is not a clip" — unusable segment |

### 3.3 Hook Quality

Does the first 3 seconds grab attention?

| Score | Criteria |
|---|---|
| 5 | Instant hook — first sentence demands attention |
| 4 | Strong opening — interesting within 3 seconds |
| 3 | Moderate — takes 5-10 seconds to get interesting |
| 2 | Weak — no clear hook, slow start |
| 1 | No hook — meandering, no entry point |

### 3.4 Viral Potential

How likely is this clip to perform well on Indonesian TikTok/Reels/Shorts?

| Score | Criteria |
|---|---|
| 5 | Very high — controversy, emotion, or money topic. Strong shareability. |
| 4 | High — interesting topic, clear audience appeal |
| 3 | Moderate — might work, depends on editing |
| 2 | Low — niche interest, low engagement ceiling |
| 1 | Very low — boring, overdone, or irrelevant |

### 3.5 DNA Tag Accuracy

Do the assigned DNA tags match the actual content?

| Score | Criteria |
|---|---|
| 5 | All 3 tags are perfectly accurate and insightful |
| 4 | 2/3 tags accurate, 1 is acceptable but not perfect |
| 3 | 2/3 tags accurate, 1 is wrong |
| 2 | 1/3 tags accurate, rest are wrong or missing |
| 1 | All tags wrong or irrelevant to the moment |

### 3.6 Reasoning Quality

Does the AI's explanation make sense and help the clipper decide?

| Score | Criteria |
|---|---|
| 5 | Specific, insightful reasoning that a clipper would find genuinely useful |
| 4 | Clear and correct, explains why the moment works |
| 3 | Vague but correct — doesn't add insight but doesn't mislead |
| 2 | Generic reasoning that could apply to any moment |
| 1 | Wrong, misleading, or completely generic ("This is a good clip") |

---

## 4. Manual Reviewer Rubric

### 4.1 Review Process

A human reviewer evaluates one analysis at a time:

1. **Watch the video** (or scrub through key sections) — 5-10 minutes
2. **Read each moment card** with timestamp, score, DNA tags, reasoning
3. **Seek to each timestamp** in YouTube and watch the 15-90 second segment
4. **Score each moment** on all 6 criteria (Sections 3.1–3.6)
5. **Record qualitative notes** — what worked, what didn't, what surprised
6. **Submit scorecard** — one per analysis

### 4.2 Reviewer Qualifications

| Role | Required | Ideal But Not Required |
|---|---|---|
| **Founder** | Deep product knowledge | Clipping experience |
| **Beta Clipper** | 6+ months podcast clipping | 10K+ follower account |
| **Power User** | 20+ analyses completed | Revenue from clipping |

### 4.3 Reviewer Bias Mitigation

- Reviewers should NOT know the AI's scores before reviewing
- Timestamps should be presented without the score visible during first watch
- "Founder's Pet" moments (obvious viral clips) should not inflate perception
- At least 2 reviewers per analysis for inter-rater reliability check

### 4.4 Inter-Rater Reliability

If two reviewers disagree by more than 2 points on any criterion, a third reviewer adjudicates. The majority score is recorded. Disagreements are logged for calibration training.

---

## 5. Pass/Fail Thresholds

### 5.1 MVP Launch Criteria

An analysis is considered **PASSING** if ALL of these are true:

| # | Criterion | Minimum | Measurement |
|---|---|---|---|
| LC1 | Pipeline returns 200 OK | 100% | CI test |
| LC2 | ≥1 elite moment (score ≥ 85) | 70% of analyses | DB query |
| LC3 | ≥3 moments total | 80% of analyses | DB query |
| LC4 | Timestamp accuracy | Average ≥ 3.5/5 | Human review |
| LC5 | Clip usefulness | Average ≥ 3.0/5 | Human review |
| LC6 | Hook quality | Average ≥ 3.0/5 | Human review |
| LC7 | Viral potential | Average ≥ 3.0/5 | Human review |
| LC8 | DNA tag accuracy | Average ≥ 3.0/5 | Human review |
| LC9 | Reasoning quality | Average ≥ 3.0/5 | Human review |

### 5.2 Per-Category Minimums

| Category | Min. Avg Score (all criteria) | Current Status |
|---|---|---|
| Podcast Business | 3.0/5 | ⏳ Not tested yet |
| Podcast Motivation | 3.0/5 | ⏳ Not tested yet |
| Podcast Comedy | 3.5/5 | ⏳ Not tested yet |
| Podcast Finance | 3.0/5 | ⏳ Not tested yet |
| Podcast Storytelling | 3.5/5 | ⏳ Not tested yet |
| Podcast Controversy | 3.5/5 | ⏳ Not tested yet |

### 5.3 Overall Product Health

| Metric | Red (Fix Immediately) | Yellow (Watch) | Green (Healthy) |
|---|---|---|---|
| Avg score across all criteria | < 2.5 | 2.5–3.4 | ≥ 3.5 |
| % analyses with ≥1 elite moment | < 50% | 50–69% | ≥ 70% |
| Timestamp accuracy avg | < 2.5 | 2.5–3.4 | ≥ 3.5 |
| DNA tag accuracy avg | < 2.5 | 2.5–3.4 | ≥ 3.5 |
| Reasoning quality avg | < 2.5 | 2.5–3.4 | ≥ 3.5 |

### 5.4 Kill Switch

If after 20 human-reviewed analyses the average clip usefulness score is **below 2.5/5**, the current prompt/LLM configuration is not viable. Stop feature development and focus exclusively on prompt engineering.

---

## 6. Golden Dataset Plan

### 6.1 What Is a Golden Dataset

A permanent, version-controlled set of 20+ podcast transcripts with:
- Known "correct" moments identified by human experts
- Expected DNA tag profiles per moment
- Expected score ranges per moment
- Timestamps verified to be accurate

This dataset NEVER changes. It is the definitive benchmark for all future prompt and model changes.

### 6.2 Dataset Structure

```
eval/
├── golden-transcripts/
│   ├── business-01-fellexandro.json       ← transcript + metadata
│   ├── business-02-selamatpagi.json
│   ├── motivation-01-marioteguh.json
│   ├── motivation-02-psikologi.json
│   ├── comedy-01-awalminggu.json
│   ├── comedy-02-ronysuara.json
│   ├── finance-01-fellexandroruby.json
│   ├── finance-02-nadine.json
│   ├── storytelling-01-curhatbang.json
│   ├── storytelling-02-ceritakopi.json
│   ├── controversy-01-deddycorbuzier.json
│   └── controversy-02-talkpod.json
│
├── expected-moments/
│   ├── business-01-fellexandro.expected.json  ← human-verified moments
│   ├── business-02-selamatpagi.expected.json
│   └── ... (one per transcript)
│
├── run-eval.ts                                ← automated comparison script
└── QUALITY_VALIDATION_PLAN.md                 ← this file
```

### 6.3 Golden Transcript Requirements

Each transcript file must contain:

```json
{
  "youtubeId": "abc123def45",
  "title": "Judul Podcast",
  "channelName": "Nama Channel",
  "durationSeconds": 5400,
  "segments": [
    { "start": 120.5, "duration": 4.2, "text": "..." }
  ]
}
```

### 6.4 Expected Moments Requirements

Each expected moment file must contain:

```json
[
  {
    "startTime": 2042.5,
    "endTime": 2098.0,
    "worthClippingScore": 88,
    "tier": "elite",
    "confidence": "high",
    "dnaTags": ["controversy", "authority", "money"],
    "reasoning": "Verified: guest drops controversial tax claim at 34:02. Confirmed by 3 reviewers."
  }
]
```

### 6.5 Golden Dataset Curation Process

1. **Select 20 diverse podcast episodes** (at least 3 per category)
2. **Extract transcripts** using the production pipeline
3. **Have 3 clippers independently identify top 10 moments** per episode
4. **Compare selections** — moments chosen by ≥2 clippers become "expected"
5. **Average their scores** to produce the ground truth score
6. **Reviewers agree on DNA tags** for each expected moment
7. **Reviewers write reference reasoning** for each moment
8. **Lock the dataset** in version control
9. **Run baseline evaluation** with current model — record as v1.0

---

## 7. Collection Process (50–100 Analyses)

### 7.1 Why 50–100?

Statistical significance for identifying failure patterns. With <20 analyses, a single bad result looks like a systemic problem. With 50-100, real patterns emerge and outliers can be identified.

### 7.2 Collection Pipeline

```
Step 1: Source Videos
  ─────────────────
  Collect 50-100 YouTube URLs across all 6 categories.
  Sources:
  • YouTube search for each category (sorted by views, last 3 months)
  • Top Indonesian podcast channels (Deddy Corbuzier, Podkesmas, etc.)
  • Beta clipper recommendations ("what are you clipping this week?")
  • Telegram group submissions

Step 2: Submit to Pipeline
  ────────────────────────
  POST /api/analyze for each URL.
  Record: analysisId, category, URL, timestamp.
  Store in a tracking spreadsheet.

Step 3: Automated Validation
  ─────────────────────────
  For each analysis:
  • Verify HTTP 200
  • Verify moments array non-empty
  • Verify all fields present
  • Record processing time
  Flag any analysis that fails automated checks.

Step 4: Human Review (Sampled)
  ────────────────────────────
  Review 20 of 100 analyses (20% sample, at least 3 per category).
  Use the Quality Scorecard template.
  Prioritize reviews for categories with low automated scores.

Step 5: Pattern Analysis
  ─────────────────────
  After 50 analyses:
  • Aggregate scores by category
  • Identify top failure patterns
  • Tune prompt if needed
  • Re-run affected category

  After 100 analyses:
  • Lock baseline metrics
  • Create Golden Dataset (Section 6)
  • Proceed to beta launch or iteration
```

### 7.3 Video Selection Criteria

| Criterion | Requirement | Why |
|---|---|---|
| Duration | 20–180 minutes | Represents typical podcast length |
| Language | Primarily Bahasa Indonesia | Target market |
| Transcript | YouTube captions available | Pipeline requirement |
| Upload date | Within last 6 months | Current content = current slang/references |
| Channel diversity | Max 5 videos per channel | Avoids channel bias |
| Popularity | 10K–1M views | Indicates audience exists |

### 7.4 Distribution Target

| Category | Min Analyses | Review Sample |
|---|---|---|
| Podcast Business | 12 | 3 |
| Podcast Motivation | 12 | 3 |
| Podcast Comedy | 12 | 3 |
| Podcast Finance | 12 | 3 |
| Podcast Storytelling | 12 | 3 |
| Podcast Controversy | 12 | 3 |
| Extra (any category) | 28 | 2 |
| **Total** | **100** | **20** |

---

## 8. Benchmarking Model Upgrades

### 8.1 When to Benchmark

Benchmarking is triggered by:

1. **Prompt change** — any edit to `lib/prompt.ts` `ANALYSIS_TASK` or `SYSTEM_PROMPT`
2. **Model change** — switching LLM provider or model version
3. **Pipeline change** — modifying `lib/analyzer.ts` validation or retry logic
4. **Scoring change** — modifying `lib/ranking.ts` thresholds
5. **Scheduled** — every 2 weeks during MVP beta

### 8.2 Benchmarking Process

```
1. CHECKOUT
   ─────────
   Create a new branch: benchmark/<version>-<date>
   Lock the current Golden Dataset as baseline.

2. RUN
   ───
   eval/run-eval.ts --model=<model> --prompt=<version>
   This runs every golden transcript through the pipeline and
   compares output against expected moments.

3. COMPARE
   ────────
   Metrics collected per analysis:
   • Recall:   % of expected moments found (any score)
   • Precision:% of returned moments that match expected
   • Score MAE: Mean Absolute Error between expected vs. actual scores
   • Tag Accuracy: % of DNA tags matching expected tags
   • Timestamp Error: Avg absolute difference in startTime (seconds)

4. REPORT
   ───────
   Generate a benchmark report:

   === Benchmark v1.0 → v2.0 ===
   Recall:         72% → 78%  (+6%  ✅)
   Precision:      65% → 63%  (-2%  ⚠️)
   Score MAE:      8.4 → 6.2  (-26% ✅)
   Tag Accuracy:   61% → 68%  (+7%  ✅)
   Timestamp Error: 4.2s → 3.1s (-26% ✅)
   Avg Processing: 38s → 42s  (+4s  ⚠️)
   ──────────────────────────────
   VERDICT: IMPROVED → DEPLOY ✅

5. DECIDE
   ───────
   • If ALL metrics improve → deploy 🟢
   • If any metric regresses >5% AND no metric improves >10% → reject 🔴
   • If mixed → manual human review of 10 analyses to decide
```

### 8.3 Expected Baseline (v1.0)

The following baselines will be established after the first Golden Dataset is created:

| Metric | Target | Current (v1.0) |
|---|---|---|
| Recall | ≥ 70% | ⏳ Pending dataset |
| Precision | ≥ 60% | ⏳ Pending dataset |
| Score MAE | ≤ 8.0 | ⏳ Pending dataset |
| Tag Accuracy | ≥ 60% | ⏳ Pending dataset |
| Timestamp Error | ≤ 5.0s | ⏳ Pending dataset |
| Avg Processing | ≤ 60s | ✅ 40s (verified) |

### 8.4 Regression Detection

If a model upgrade causes any metric to regress by more than 5%, the pipeline must flag it as a **REGRESSION WARNING** and require human sign-off before deployment. This prevents silent quality degradation during "upgrades."

---

## 9. Failure Patterns

### 9.1 Pattern Catalogue

Each failure pattern is documented with: symptoms, root cause, detection method, and fix.

#### FP-1: Over-scoring

| Field | Detail |
|---|---|
| **Symptom** | Moments consistently score 85+ when they are clearly average. Every analysis has 5+ elite moments. |
| **Root Cause** | LLM is not calibrated to "be harsh." Prompt's "only 2-4 should score above 85" is ignored. |
| **Detection** | Average score across all moments > 75. More than 4 elite moments per analysis. |
| **Fix** | Strengthen scoring instruction in prompt. Add few-shot examples of correct score distribution. Reduce temperature. |

#### FP-2: Under-scoring

| Field | Detail |
|---|---|
| **Symptom** | Genuinely viral moments score below 70. No elite moments even when content is clearly clip-worthy. |
| **Root Cause** | LLM is too conservative. Fear of over-scoring causes under-scoring. |
| **Detection** | Average score < 50 on content that reviewers rate highly. |
| **Fix** | Calibrate with examples of correctly scored viral clips. Adjust temperature upward. |

#### FP-3: Hallucinated Hooks

| Field | Detail |
|---|---|
| **Symptom** | AI describes a hook that doesn't exist in the transcript. Timestamps point to content that doesn't match the reasoning. |
| **Root Cause** | LLM fills gaps in the transcript with fabricated context. Common with low-quality transcripts. |
| **Detection** | Human review reveals mismatch between timestamp content and AI reasoning. Timestamp cross-referencing shows content at that time doesn't match. |
| **Fix** | Strengthen "only score based on transcript" rule. Add validation: "If you can't find a clear hook, score lower." Consider transcript quality indicator. |

#### FP-4: Wrong DNA Tags

| Field | Detail |
|---|---|
| **Symptom** | DNA tags don't match the moment. e.g., a casual joke tagged as ["authority", "money", "controversy"]. |
| **Root Cause** | LLM doesn't understand the distinction between DNA categories. |
| **Detection** | Tag accuracy score < 3.0/5 in human review. Consistent mis-tagging of certain categories. |
| **Fix** | Add few-shot examples showing correct tag assignment. Include explicit definitions for each DNA tag in the prompt. |

#### FP-5: Weak Reasoning

| Field | Detail |
|---|---|
| **Symptom** | Reasoning is generic and could apply to any moment: "This is a strong moment that will perform well." |
| **Root Cause** | LLM defaults to safe, generic language instead of specific analysis. |
| **Detection** | Reasoning quality score < 3.0/5. Reasoning contains generic phrases like "will perform well" without specific justification. |
| **Fix** | Add instruction: "Be specific. Mention exact words from the transcript." Add constraint: "No generic phrases like 'will perform well.'" |

#### FP-6: Timestamp Drift

| Field | Detail |
|---|---|
| **Symptom** | Timestamps do not align with the described content. Typically off by 5-30 seconds. |
| **Root Cause** | Transcript segment boundaries don't match the LLM's perceived moment boundaries. The LLM sees text but estimates time imprecisely. |
| **Detection** | Timestamp accuracy score < 3.0/5. Systematic offset (always shift by +X seconds). |
| **Fix** | Ensure transcript format includes explicit timestamps per segment. Add instruction to reference specific [MM:SS] markers. Post-process to snap timestamps to nearest transcript segment boundary. |

#### FP-7: Empty/Trivial Results

| Field | Detail |
|---|---|
| **Symptom** | Pipeline returns 0 moments or only 1-2 low-scoring moments for content that clearly has clip-worthy content. |
| **Root Cause** | Transcript too short, LLM timeout, or overly strict validation filtering. |
| **Detection** | total_moments_found = 0 or 1. |
| **Fix** | Check transcript quality first. Log validation rejection reasons. Adjust validation thresholds if over-filtering. |

#### FP-8: Category Blindness

| Field | Detail |
|---|---|
| **Symptom** | Pipeline performs well on 3 categories but poorly on the other 3. |
| **Root Cause** | LLM is biased toward certain content styles (e.g., good at controversy, bad at comedy). |
| **Detection** | Per-category scores show significant variance (>1.5 point gap between best and worst). |
| **Fix** | Add category-specific instructions to the prompt. Adjust temperature per category. Collect more training data for weak categories. |

### 9.2 Failure Pattern Matrix

| Pattern | Severity | Frequency (est.) | Detection | Ease of Fix |
|---|---|---|---|---|
| Over-scoring | 🟡 Medium | Frequent | Easy (automated) | Easy (prompt tweak) |
| Under-scoring | 🟡 Medium | Moderate | Easy (human review) | Easy (prompt tweak) |
| Hallucinated hooks | 🔴 High | Rare | Hard (requires human review) | Medium |
| Wrong DNA tags | 🟡 Medium | Moderate | Medium (human review) | Medium (few-shot examples) |
| Weak reasoning | 🟡 Medium | Frequent | Medium (human review) | Medium (prompt constraints) |
| Timestamp drift | 🔴 High | Moderate | Medium (cross-reference) | Medium (post-processing) |
| Empty/trivial | 🔴 High | Rare | Easy (automated) | Easy (debug transcript) |
| Category blindness | 🟡 Medium | Unknown | Medium (per-category tracking) | Hard (requires data) |

### 9.3 Alerting

When any failure pattern is detected in ≥30% of a batch, an automatic alert is raised. The founder reviews and decides whether to:
1. **Accept** — known limitation, acceptable for MVP
2. **Fix prompt** — quick iteration on `lib/prompt.ts`
3. **Escalate** — deeper investigation needed

---

## 10. Quality Scorecard Template

### 10.1 Scorecard Form

```
═══════════════════════════════════════════════════════
GANYIQ QUALITY SCORECARD
═══════════════════════════════════════════════════════

REVIEWER:      [name]
DATE:          [YYYY-MM-DD]
ANALYSIS ID:   [uuid]
VIDEO URL:     [url]
CATEGORY:      [business|motivation|comedy|finance|storytelling|controversy]

═══════════════════════════════════════════════════════
PART A: OVERALL IMPRESSION
═══════════════════════════════════════════════════════

1. Would you use this analysis in your clipping workflow?
   [ ] Definitely yes
   [ ] Probably yes
   [ ] Maybe
   [ ] Probably no
   [ ] Definitely no

2. How many minutes did you save by using ganyIQ?
   [ ] >30 minutes
   [ ] 15-30 minutes
   [ ] 5-15 minutes
   [ ] <5 minutes
   [ ] Wasted time (wrong results)

3. Would you trust ganyIQ to find clips for a client?
   [ ] Yes, without checking
   [ ] Yes, with quick validation
   [ ] Yes, but I'd double-check every moment
   [ ] No, I prefer my own judgment

═══════════════════════════════════════════════════════
PART B: PER-MOMENT SCORING
═══════════════════════════════════════════════════════

MOMENT #1: [rank] — [startTimestamp] → [endTimestamp]
  Score: [0-100] | Tier: [elite/secondary]
  DNA: [tag1, tag2, tag3]
  Reasoning: [text]

  Timestamp Accuracy:   1 2 3 4 5
  Clip Usefulness:      1 2 3 4 5
  Hook Quality:         1 2 3 4 5
  Viral Potential:      1 2 3 4 5
  DNA Tag Accuracy:     1 2 3 4 5
  Reasoning Quality:    1 2 3 4 5
  ─────────────────────────────────
  MOMENT AVERAGE:      [x.x]/5

  Notes: [free text]

MOMENT #2: (repeat above)
...

═══════════════════════════════════════════════════════
PART C: ANALYSIS-LEVEL METRICS
═══════════════════════════════════════════════════════

Total moments found:         [n]
Elite moments:               [n]  (score ≥ 85)
Secondary moments:           [n]  (score 70-84)
Total moments you'd clip:    [n]  (your manual count)
Overlap (AI ∩ yours):        [n]  (moments AI found AND you'd clip)
Missed by AI:                [n]  (moments you'd clip but AI missed)

              TARGET    ACTUAL
Recall:        ≥ 60%     [n/n] = [x%]
Precision:     ≥ 50%     [n/n] = [x%]

═══════════════════════════════════════════════════════
PART D: QUALITATIVE FEEDBACK
═══════════════════════════════════════════════════════

What did ganyIQ get RIGHT?
──────────────────────────
[free text]

What did ganyIQ get WRONG?
──────────────────────────
[free text]

Are there moments the AI missed that you consider obvious?
──────────────────────────────────────────────────────────
[free text]

How would you improve this analysis?
────────────────────────────────────
[free text]

═══════════════════════════════════════════════════════
PART E: FAILURE PATTERN CHECK
═══════════════════════════════════════════════════════

Check any that apply:
[ ] Over-scoring   (moments scored too high)
[ ] Under-scoring  (moments scored too low)
[ ] Hallucinated hooks (reasoning doesn't match video)
[ ] Wrong DNA tags
[ ] Weak reasoning (vague/generic)
[ ] Timestamp drift (timestamps off by 5s+)
[ ] Empty/trivial  (too few moments)
[ ] Category blindness (poor on this content type)
[ ] Other: _____________

═══════════════════════════════════════════════════════
```

### 10.2 Scorecard Storage

Completed scorecards are stored as Markdown files:

```
eval/scorecards/
├── 2026-06-02-founder-business-01.md
├── 2026-06-02-founder-comedy-01.md
├── 2026-06-03-clipper1-motivation-01.md
└── ...
```

### 10.3 Scorecard Aggregation

A script (`eval/aggregate-scores.ts`) reads all scorecards and produces:

```json
{
  "period": "2026-06-01 to 2026-06-07",
  "totalScorecards": 12,
  "reviewers": 3,
  "averages": {
    "timestampAccuracy": 3.8,
    "clipUsefulness": 3.5,
    "hookQuality": 3.6,
    "viralPotential": 3.4,
    "dnaTagAccuracy": 3.2,
    "reasoningQuality": 3.1
  },
  "overallAverage": 3.43,
  "failurePatterns": {
    "overScoring": 2,
    "weakReasoning": 4,
    "timestampDrift": 1
  },
  "verdict": "GREEN — Healthy. Watch reasoning quality."
}
```

---

## Quick Reference Card

```
VALIDATION WORKFLOW
════════════════════════════════════════════════════════

DAILY (MVP Beta):
  □ Run 5 analyses (diverse categories)
  □ Verify automated checks pass
  □ Log any pipeline errors

WEEKLY:
  □ Run 10 analyses (all 6 categories)
  □ Human review 3 analyses with scorecard
  □ Aggregate scores
  □ Check failure pattern alerts
  □ Tune prompt if needed

BENCHMARK (Model/Prompt Change):
  □ Run eval/run-eval.ts against Golden Dataset
  □ Compare metrics to baseline
  □ If regression > 5%: reject
  □ If improvement: deploy

PRE-LAUNCH GATE:
  □ 20 human-reviewed analyses
  □ Avg clip usefulness ≥ 3.0/5
  □ No unresolved failure patterns
  □ Golden Dataset locked v1.0
  □ Baseline metrics recorded
```

---

> **Next Action:** Create the first Golden Transcript from a known working analysis, then begin collecting 50-100 real podcast analyses across all 6 categories. The first 20 analyses should be human-reviewed to establish baseline scores.
