# Review Assignment Guide

> **Version:** 1.0
> **Date:** 2026-06-02
> **Purpose:** Standardized process for assigning, conducting, and resolving quality reviews

---

## 1. Reviewer Workflow

### 1.1 Complete Review Cycle

```
┌─────────────────────────────────────────────────────────────────────┐
│                       REVIEW CYCLE                                   │
│                                                                     │
│  ASSIGN        ANALYZE        SCORE        SUBMIT        RESOLVE    │
│  ┌─────┐      ┌────────┐    ┌──────┐    ┌───────┐      ┌────────┐  │
│  │ Pick│─────►│ Watch  │───►│ Fill │───►│ Save  │─────►│ Close  │  │
│  │ one │      │ video  │    │score-│    │ .md   │      │ ticket │  │
│  │     │      │ + seek │    │ card │    │ file  │      │        │  │
│  └─────┘      └────────┘    └──────┘    └───────┘      └────────┘  │
│                                                                     │
│  Est. time: 30-60 min per analysis                                  │
└─────────────────────────────────────────────────────────────────────┘
```

### 1.2 Step-by-Step

#### Step 1: Assignment

1. Coordinator selects an analysis from the URL tracker with status `submitted`
2. Coordinator assigns a reviewer: update tracker `reviewer` field
3. Reviewer receives:
   - YouTube URL of the analyzed video
   - `analysisId` to fetch results from API
   - Link to `eval/review-template.md`
   - Deadline (typically 48 hours)

#### Step 2: Preparation (5 minutes)

1. Open the YouTube video in a browser
2. Fetch analysis results:
   ```
   GET /api/analyze/{analysisId}
   ```
   (once the GET endpoint is built) OR see the response from the original POST
3. Open `eval/review-template.md` and make a copy as:
   `eval/scorecards/{date}-{reviewer}-{category}-{seq}.md`

#### Step 3: Watch & Identify (15-30 minutes)

1. **Watch the full video** at 1x speed (or 1.25x for podcasts >60 min)
2. **Note your own top moments** during the watch:
   - Timestamp (start-end)
   - Brief note on why it's clip-worthy
   - Your intuitive score (0-100)
3. After watching, finalize your list of 5-10 moments

#### Step 4: Compare with AI (10-15 minutes)

1. For each moment the AI returned:
   - Seek to the timestamp in YouTube
   - Watch the 15-90 second segment
   - Score each criterion on the scorecard (1-5)
   - Note whether YOU would have identified this moment
2. For moments YOU found that the AI missed:
   - Note them in Part D of the scorecard
   - Seek to the timestamp and confirm it's actually clip-worthy

#### Step 5: Complete Scorecard (5 minutes)

1. Calculate your stats:
   - Overlap: moments BOTH you and AI found
   - Missed: moments you found but AI didn't
   - Recall: Overlap / (Overlap + Missed)
   - Precision: Overlap / Total AI moments
2. Complete the qualitative feedback sections
3. Check the failure pattern checklist
4. Mark pass/fail

#### Step 6: Submit (2 minutes)

1. Save the scorecard file
2. Notify the coordinator
3. Coordinator updates the URL tracker: `review_status = "reviewed"`

### 1.3 Time Budget

| Activity | First Time | Experienced |
|---|---|---|
| Video watching (60 min podcast) | 45 min | 30 min |
| Moment identification | 15 min | 10 min |
| Per-moment scoring (5 moments) | 20 min | 10 min |
| Qualitative feedback | 10 min | 5 min |
| Save and submit | 5 min | 2 min |
| **Total** | **~95 min** | **~57 min** |

---

## 2. Review Ownership

### 2.1 Role Definitions

| Role | Responsibility | Authority |
|---|---|---|
| **Coordinator** (Founder) | Assign reviews, track progress, resolve disputes, maintain quality | Final say on all scores |
| **Primary Reviewer** | Complete scorecard, identify missed moments, flag issues | Score their assigned analyses |
| **Secondary Reviewer** | Spot-check primary reviewer scores, provide second opinion | Flag discrepancies >2 points |
| **Beta Clipper** (External) | Real-world validation, domain expertise, honest feedback | Advisory only |

### 2.2 Assignment Rules

- **No reviewer reviews their own analyses** — always fresh eyes
- **Category matching preferred** — assign Business podcasts to reviewers with business interest
- **Rotation required** — no reviewer does >3 consecutive analyses from the same category
- **Max load** — 3 reviews per week per reviewer (prevents fatigue)

### 2.3 Ownership Matrix

| Category | Primary Owner | Secondary Owner |
|---|---|---|
| Business | Founder | Beta Clipper 1 |
| Motivation | Founder | Beta Clipper 2 |
| Comedy | Beta Clipper 1 | Founder |
| Finance | Founder | Beta Clipper 2 |
| Storytelling | Beta Clipper 2 | Beta Clipper 1 |
| Controversy | Founder | Beta Clipper 1 |

---

## 3. Conflict Resolution

### 3.1 Types of Conflicts

| Type | Definition | Resolution |
|---|---|---|
| **Score discrepancy** | Two reviewers differ by >2 points on a criterion | Third reviewer adjudicates |
| **Moment disagreement** | One reviewer considers a moment good, another considers it bad | Majority rule (≥2/3) |
| **Category mismatch** | Reviewer consistently scores differently on one category | Re-calibrate or reassign category |
| **Pattern disagreement** | Reviewer flags a failure pattern that others don't see | Group discussion + group vote |

### 3.2 Resolution Escalation

```
LEVEL 1: Reviewer Pair
  ─────────────────────────
  Two reviewers discuss their differences.
  Can they agree within 1 point?
  YES → Record final score.
  NO → Escalate to Level 2.

LEVEL 2: Coordinator
  ─────────────────────────
  Coordinator reviews the disputed analysis.
  Coordinator assigns a final score.
  Decision is binding.

LEVEL 3: Founder
  ─────────────────────────
  If coordinator's decision is contested:
  Founder makes final, non-appealable decision.
  Document as precedent for future reviews.
```

### 3.3 Precedent Log

All resolved disputes are logged in `eval/scorecards/DISPUTES_LOG.md`:

```markdown
## Dispute #001 — 2026-06-02

Analysis:      business-01-fellexandro
Criterion:     DNA Tag Accuracy
Disagreement:  Reviewer A: 4, Reviewer B: 2
Level 1:       Could not resolve (2 point gap)
Level 2:       Coordinator ruled: 3
Precedent:     "DNA tags for authority-themed content should
               default to authority + educational, not money."
```

---

## 4. Scoring Consistency Rules

### 4.1 Calibration Baseline

Every reviewer must complete a **calibration review** before their first real assignment:

1. Review a pre-selected "calibration analysis" (same video for all reviewers)
2. Submit their scorecard
3. Coordinator compares against the consensus scores
4. Any criterion where the reviewer differs by >1 point from consensus → discuss
5. Reviewer updates their understanding of the scoring scale
6. Calibration scorecard is stored as `eval/scorecards/CALIBRATION-{reviewer}.md`

### 4.2 Scoring Anchors

To ensure consistency across reviewers, use these anchor definitions:

| Score | Anchor Example |
|---|---|
| **5 — Excellent** | "This moment would get 1M+ views on TikTok. Obvious viral hit." |
| **4 — Good** | "This moment is clearly clip-worthy. Would perform well." |
| **3 — Acceptable** | "It's a clip. Might work, might not. Wouldn't be my first choice." |
| **2 — Poor** | "I wouldn't clip this. Too slow, too niche, or too generic." |
| **1 — Failing** | "This is not a clip. Wrong timestamp, wrong content, or AI hallucination." |

### 4.3 Common Scoring Pitfalls

| Pitfall | Description | Correction |
|---|---|---|
| **Generosity bias** | Tendency to give 4s and 5s because the tool "tried hard" | Score the OUTPUT, not the effort. Be harsh. |
| **Severity bias** | Tendency to give 2s and 1s because "AI should be perfect" | Compare against a HUMAN clipper, not perfection. |
| **Halo effect** | First moment is good → all moments get higher scores | Score each moment independently. |
| **Recency bias** | Last moment seen influences overall rating | Score moments in random order. |
| **Confirmation bias** | Scoring higher because you WANT the product to succeed | Imagine you're paying for this tool. Would you pay? |

### 4.4 Score Normalization

If a reviewer consistently scores >0.5 points above/below the group average across 3+ reviews:
1. Flag the reviewer for re-calibration
2. Their scores may be normalized by -0.5/+0.5 in aggregate reports
3. If pattern persists after re-calibration, replace the reviewer

---

## 5. Calibration Process

### 5.1 Initial Calibration Session

**When:** Before first review batch
**Duration:** 60 minutes
**Participants:** All active reviewers

**Agenda:**

```
1. (10 min) Review the scoring criteria definitions
   - Walk through each criterion: Timestamp Accuracy, Clip Usefulness,
     Hook Quality, Viral Potential, DNA Tag Accuracy, Reasoning Quality
   - Read anchor examples aloud
   - Answer questions

2. (20 min) Group review of a sample analysis
   - Open the calibration video + analysis results
   - Each reviewer scores the first moment independently
   - Compare scores as a group
   - Discuss discrepancies
   - Repeat for 2-3 moments

3. (20 min) Independent calibration review
   - Each reviewer completes a full scorecard for a second analysis
   - Submit independently
   - Coordinator compares and shares results

4. (10 min) Debrief
   - Discuss common differences
   - Set expectations
   - Confirm readiness
```

### 5.2 Re-Calibration Triggers

A reviewer is re-calibrated when:

1. **New reviewer onboarding** — every new reviewer completes calibration
2. **Score drift** — reviewer's average deviates >0.5 from group mean for 3+ consecutive reviews
3. **Major prompt change** — if the prompt changes significantly, recalibrate
4. **Monthly** — even consistent reviewers re-calibrate monthly
5. **After dispute** — if a reviewer was overruled in a Level 2 dispute, re-calibrate

### 5.3 Calibration Materials

| Material | Location | Purpose |
|---|---|---|
| Calibration analysis | Coordinator selects | Standard video for all reviewers |
| Consensus scorecard | `eval/scorecards/CALIBRATION-CONSENSUS.md` | Pre-scored by coordinator |
| Reviewer scorecard | `eval/scorecards/CALIBRATION-{reviewer}.md` | Filled during session |
| Scoring cheat sheet | Below this table | Quick reference |

### 5.4 Scoring Cheat Sheet

```
QUICK REFERENCE: SCORING MOMENTS
══════════════════════════════════════════════════

TIMESTAMP ACCURACY
  5 = Exact match    │  3 = Off by 3-10s   │  1 = Completely wrong
  4 = Off by <3s     │  2 = Off by 10-30s  │

CLIP USEFULNESS
  5 = Would clip now │  3 = Maybe          │  1 = Not a clip
  4 = Good candidate │  2 = Would skip     │

HOOK QUALITY
  5 = Instant hook   │  3 = 5-10s to hook  │  1 = No hook
  4 = Strong opening │  2 = Weak start     │

VIRAL POTENTIAL
  5 = Very high      │  3 = Moderate       │  1 = Very low
  4 = High           │  2 = Low            │

DNA TAG ACCURACY
  5 = All 3 perfect  │  3 = 2/3 correct    │  1 = All wrong
  4 = 2/3 perfect    │  2 = 1/3 correct    │

REASONING QUALITY
  5 = Insightful     │  3 = Vague but ok   │  1 = Wrong/misleading
  4 = Clear & useful │  2 = Generic        │
```

---

## 6. Reviewer Communication

### 6.1 Review Briefing Template

When assigning a review, send this to the reviewer:

```
--- REVIEW ASSIGNMENT ---

Hi [reviewer],

Please review the following ganyIQ analysis:

  Video:   [title]
  URL:     [youtube_url]
  Category:[category]
  Duration:[X] minutes

Instructions:
  1. Watch the video (full or first 30 min minimum)
  2. Fetch results: GET /api/analyze/[analysisId]
  3. Fill scorecard: eval/review-template.md
  4. Save as: eval/scorecards/[date]-[name]-[category]-[seq].md
  5. Submit by: [deadline]

Deadline: [date]

Thanks!
```

### 6.2 Feedback Collection

After each review batch, ask reviewers:

1. "Was the scorecard easy to use? Any confusing sections?"
2. "Were the scoring criteria clear?"
3. "How long did the review actually take?"
4. "Any suggestions for improving the review process?"

---

## 7. Quality Assurance

### 7.1 Review Quality Checks

| Check | Frequency | Method |
|---|---|---|
| Scorecard completeness | Every submission | Verify all sections filled |
| Score range validation | Every submission | No ALL-5s or ALL-1s |
| Inter-rater reliability | Every batch | Compare overlapping reviews |
| Timestamp cross-check | Random 20% | Verify 1 random timestamp per scorecard |
| Drift detection | Every 5 reviews per reviewer | Compare vs group average |

### 7.2 Scorecard Rejection Criteria

A scorecard is rejected (returned to reviewer) if:

1. More than 2 sections are incomplete
2. All moments scored identically (e.g., all 4s)
3. Qualitative feedback is empty or single-word
4. No failure pattern checklist completed
5. No pass/fail verdict marked

---

## 8. Quick Reference Card

```
REVIEWER WORKFLOW (Cheat Sheet)
════════════════════════════════════════════════════════

1. Receive assignment ────────────  2 min
2. Open video + analysis results ──  3 min
3. Watch video + note moments ────  30-45 min
4. Seek to each AI moment ────────  10-15 min
5. Score each criterion (1-5) ────  10 min
6. Complete qualitative sections ──  5 min
7. Check failure patterns ────────  2 min
8. Save + submit ─────────────────  2 min
                                  ─────────
  TOTAL                           ~60-80 min

SCORING REMINDERS:
  • 3 = acceptable (not bad, not great)
  • 5 = rare (reserve for exceptional moments)
  • 1 = broken (wrong timestamp, hallucination)
  • Compare against a HUMAN CLIPPER, not perfection
  • Score each moment independently

CONFLICT ESCALATION:
  Differs ≤2 pts → discuss with other reviewer
  Differs >2 pts → coordinator decides
  Still contested → founder has final say
```
