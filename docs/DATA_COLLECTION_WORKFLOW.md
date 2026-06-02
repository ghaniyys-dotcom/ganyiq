# Data Collection Workflow

> **Version:** 1.0
> **Date:** 2026-06-02
> **Purpose:** Standardized process for collecting 100 real podcast analyses for quality validation

---

## 1. Overview

```
┌──────────────────────────────────────────────────────────────────┐
│                     100 ANALYSIS COLLECTION                       │
│                                                                  │
│  1. SOURCE  ──►  2. SUBMIT  ──►  3. VALIDATE  ──►  4. REVIEW   │
│  Find URLs   │   POST to    │   Auto-check  │   Human review   │
│               │   /api/analyze│               │   20 samples     │
└───────────────┴──────────────┴───────────────┴──────────────────┘
```

**Goal:** 100 completed analyses across 6 categories
**Timeline:** 5-7 days (20 analyses/day)
**Review sample:** 20 analyses (at least 3 per category)

---

## 2. Source Collection (Step 1)

### 2.1 Video Sourcing Methods

| Method | Yield | Time Required | Quality |
|---|---|---|---|
| YouTube search (top videos by category) | 20-30 URLs | 1 hour | High |
| Beta clipper recommendations | 10-20 URLs | 2 hours (DMs) | Very High |
| Telegram group submissions | 10-20 URLs | 1 hour | High |
| Manual curation from known channels | 20-30 URLs | 2 hours | Very High |
| YouTube trending podcasts | 10-20 URLs | 30 min | Medium |

### 2.2 Category URLs Needed

| Category | Target | Source Strategy |
|---|---|---|
| Business | 17 | Search "podcast bisnis" + known channels |
| Motivation | 17 | Search "podcast motivasi" + Mario Teguh channel |
| Comedy | 17 | Search "podcast lucu" + Podcast Awal Minggu |
| Finance | 16 | Search "podcast keuangan" + Fellexandro Ruby |
| Storytelling | 16 | Search "curhat podcast" + Curhat Bang |
| Controversy | 17 | Search "podcast kontroversial" + Deddy Corbuzier |
| **Total** | **100** | |

### 2.3 URL Tracking Spreadsheet

Track all URLs in a simple document (`eval/url-tracker.csv`):

```csv
id,url,category,channel,title,status,analysisId,reviewer,scorecardFile
BUS-01,https://youtube.com/watch?v=...,business,Fellexandro Ruby,Cara Membangun Bisnis,submitted,a41dcbf2-...,founder,2026-06-02-founder-bus-01.md
BUS-02,https://youtube.com/watch?v=...,business,Podkesmas,Startup Talk,submitted,...,,,
... ,...,...,...,...,pending,...,,
```

### 2.4 URL Quality Checklist

Before adding a URL to the tracker, verify:

- [ ] Video is publicly accessible
- [ ] Duration between 20-180 minutes
- [ ] Language is primarily Bahasa Indonesia
- [ ] YouTube captions are available (check via `fetchVideoData`)
- [ ] Not from a channel that already has 5+ URLs in the dataset
- [ ] Video was uploaded within the last 6 months

---

## 3. Submission Pipeline (Step 2)

### 3.1 Automated Submission Script

Create a batch submission script:

```bash
#!/bin/bash
# eval/batch-submit.sh — Submit URLs from a CSV to the API

CSV="eval/url-tracker.csv"
API="http://localhost:3000/api/analyze"

# Read URLs with "pending" status, submit each
tail -n +2 "$CSV" | grep "pending" | while IFS=, read -r id url category rest; do
  echo "Submitting $id..."
  response=$(curl -s -w "\n%{http_code}" -X POST "$API" \
    -H "Content-Type: application/json" \
    -d "{\"url\":\"$url\"}")
  
  http_code=$(echo "$response" | tail -1)
  body=$(echo "$response" | head -n -1)
  
  if [ "$http_code" = "200" ]; then
    analysis_id=$(echo "$body" | grep -o '"analysisId":"[^"]*"' | cut -d'"' -f4)
    moments_count=$(echo "$body" | grep -o '"worthClippingScore"' | wc -l)
    echo "  ✅ $id → $analysis_id ($moments_count moments)"
    # Update CSV status
    sed -i "s/^$id,.*pending.*/$id,$url,$category,submitted,$analysis_id,/" "$CSV"
  else
    echo "  ❌ $id → HTTP $http_code"
    sed -i "s/^$id,.*pending.*/$id,$url,$category,failed,,/" "$CSV"
  fi
  
  sleep 2  # avoid overwhelming the API
done
```

### 3.2 Manual Submission

If batch submission is not set up, submit manually using curl:

```bash
curl -s -X POST http://localhost:3000/api/analyze \
  -H "Content-Type: application/json" \
  -d '{"url":"https://www.youtube.com/watch?v=..."}'
```

Then manually update the CSV with the returned `analysisId`.

### 3.3 Rate Limiting

The API has a rate limit of 5 analyses/IP/day. When batch submitting:
- Run in groups of 5
- Wait until the next day for the next 5
- Or change IP between batches

For the full 100 analyses, plan for **20 collection days** at 5/day.
Or disable rate limiting temporarily for dataset collection.

---

## 4. Validation (Step 3)

### 4.1 Automated Checks

After each submission, verify:

| Check | Pass/Fail | Action if Fail |
|---|---|---|
| HTTP status = 200 | | Re-submit once. If still fails, mark as `failed` in CSV |
| `moments` array is non-empty | | Flag for review — may indicate content issue |
| `analysisId` is a valid UUID | | Re-submit |
| Processing time < 120s | | Log for performance tracking (not a blocker) |

### 4.2 Failed Analysis Handling

| Failure Reason | Action |
|---|---|
| TRANSCRIPT_UNAVAILABLE | Remove from dataset, find replacement URL |
| ANALYSIS_FAILED | Retry once. If fails again, check if video is still accessible |
| INVALID_URL | Fix URL in spreadsheet |
| RATE_LIMITED | Wait 24 hours, re-submit |
| 500 Internal Error | Check server logs, fix issue, re-submit |

---

## 5. Human Review (Step 4)

### 5.1 Reviewer Assignment

| Category | Priority | Ideal Reviewer |
|---|---|---|
| Business | High | Founder (domain knowledge) |
| Motivation | Medium | Any available reviewer |
| Comedy | High | Clipper with entertainment experience |
| Finance | High | Founder or finance-savvy reviewer |
| Storytelling | Medium | Any available reviewer |
| Controversy | High | Experienced clipper |

### 5.2 Review Sample Selection

Select 20 analyses for human review using stratified sampling:

```
Analyses per category: 3 minimum
Total:                20 maximum

Algorithm:
  1. For each category, pick the 3 most recent analyses
  2. This gives 18 analyses (6 × 3)
  3. Pick 2 more from any category that had interesting results
```

### 5.3 Review Assignment Flow

```
1. Select analysis from tracker (status = "submitted")
2. Assign reviewer in tracker (status = "assigned")
3. Reviewer receives:
   - Analysis URL (or analysisId to fetch from API)
   - Scorecard template (eval/review-template.md)
4. Reviewer completes scorecard (deadline: 48 hours)
5. Reviewer submits scorecard as:
   eval/scorecards/{date}-{reviewer}-{category}-{seq}.md
6. Mark tracker: status = "reviewed"
```

### 5.4 Reviewer Instructions

Provide each reviewer with:
- The YouTube URL of the analyzed video
- The `analysisId` for fetching results from `GET /api/analyze/:id`
- The scorecard template (`eval/review-template.md`)
- These instructions:

```
1. Watch the video (at least the first 30 minutes, or scrub the full length)
2. Open the analysis results
3. For each moment:
   a. Click the timestamp to jump to that moment in YouTube
   b. Watch the 30-90 second segment
   c. Score each criterion on the scorecard
4. Complete the qualitative feedback section
5. Save the scorecard and send it back
```

---

## 6. Quality Review Process

### 6.1 Batch Review Cadence

```
Every 20 analyses submitted:
  ┌────────────────────────────────────────────┐
  │ 1. Run automated validation on all 20      │
  │ 2. Select 4 for human review (diverse cats)│
  │ 3. Assign to reviewers                     │
  │ 4. Wait for scorecards (48h deadline)      │
  │ 5. Aggregate scores                       │
  │ 6. Check failure pattern alerts            │
  │ 7. Tune prompt if needed                  │
  │ 8. Continue to next 20                    │
  └────────────────────────────────────────────┘
```

### 6.2 Mid-Collection Checkpoints

| Milestone | Action |
|---|---|
| 20 analyses | First human review batch. If avg score < 2.5/5 → STOP. Fix prompt. |
| 50 analyses | Mid-point assessment. If any category avg < 2.5/5 → increase sample for that category. |
| 80 analyses | Final prompt tuning window. No more prompt changes after 80. |
| 100 analyses | Lock baseline. Proceed to launch decision. |

### 6.3 Scorecard Aggregation

Every 20 analyses, run:

```bash
# Pseudo-command
eval/aggregate-scores.ts --input eval/scorecards/ --output eval/baselines/v1.0-snapshot.json
```

This produces aggregate metrics across all reviewed analyses.

---

## 7. Approval Flow

### 7.1 Gate: Beta Launch

```
BETA LAUNCH GATE
════════════════════════════════════════════════════════

Required before beta launch:

[ ] 100 analyses collected
[ ] 20 human-reviewed (scorecards filed)
[ ] Average clip usefulness ≥ 3.0/5
[ ] No category averages < 2.5/5
[ ] Golden Dataset v1.0 locked (12+ transcripts)
[ ] Baseline metrics recorded
[ ] ≤2 unresolved failure patterns
[ ] Processing time average < 60s

SIGN OFF:
  Founder: ___________________
  Date: ______________________
```

### 7.2 Gate: Public Launch

```
PUBLIC LAUNCH GATE
════════════════════════════════════════════════════════

Required before public launch:

[ ] All beta gate requirements met
[ ] Golden Dataset v2.0 locked (20+ transcripts)
[ ] Precision ≥ 60% on golden dataset
[ ] Recall ≥ 70% on golden dataset
[ ] Score MAE ≤ 8.0 on golden dataset
[ ] Tag Accuracy ≥ 60% on golden dataset
[ ] Timestamp Error ≤ 5.0s on golden dataset
[ ] All failure patterns documented
[ ] Mitigation plan for top 3 failure patterns

SIGN OFF:
  Founder: ___________________
  Date: ______________________
```

### 7.3 Emergency Stop

If at any point the average clip usefulness score drops below **2.0/5** on 3 consecutive reviews:
1. Stop all data collection
2. Freeze all prompt changes
3. Root cause analysis (48 hours max)
4. Implement fix
5. Re-run on affected analyses
6. Resume only if fix restores average to ≥ 3.0/5

---

## 8. Quick Reference Card

```
DAILY TASKS
═══════════════
□ Submit 5 URLs to /api/analyze
□ Update URL tracker CSV
□ Assign 1 review to a reviewer
□ Check for failure alerts

MILESTONE TASKS (every 20)
══════════════════════════
□ Aggregate scorecards
□ Check per-category averages
□ Update baselines
□ Decision: continue / stop / tune

COMPLETION TASKS (at 100)
═════════════════════════
□ Lock Golden Dataset v1.0
□ Generate baseline metrics
□ Launch decision
```

---

## 9. Tools & Scripts

| Tool | Purpose | Location |
|---|---|---|
| URL tracker | Track all 100 URLs and status | `eval/url-tracker.csv` |
| Batch submit | Submit pending URLs to API | `eval/batch-submit.sh` |
| Scorecard template | Human review form | `eval/review-template.md` |
| Aggregator | Combine scorecards into metrics | `eval/aggregate-scores.ts` (future) |
| Benchmark runner | Run golden dataset comparison | `eval/run-eval.ts` (future) |
