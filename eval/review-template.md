# ganyIQ — Quality Review Scorecard

> Complete this form after reviewing a ganyIQ analysis.
> One form per analysis.
> Save to: `eval/scorecards/{date}-{reviewer}-{category}-{seq}.md`

---

## Metadata

```yaml
reviewer: [your name]
date: [YYYY-MM-DD]
analysisId: [uuid from API response]
videoUrl: [YouTube URL]
category: [business | motivation | comedy | finance | storytelling | controversy]
videoDuration: [minutes]
timeSpentReviewing: [minutes]
```

---

## Part A: Overall Impression

**1. Would you use this analysis in your clipping workflow?**

- [ ] Definitely yes — this saves me real time
- [ ] Probably yes — useful but needs some improvement
- [ ] Maybe — depends on the video
- [ ] Probably no — not reliable enough
- [ ] Definitely no — I'd rather do it myself

**2. How much time did ganyIQ save you?**

- [ ] More than 30 minutes
- [ ] 15–30 minutes
- [ ] 5–15 minutes
- [ ] Less than 5 minutes
- [ ] Wasted time — results were misleading

**3. Would you trust ganyIQ for a client project?**

- [ ] Yes, without double-checking
- [ ] Yes, with a quick skim
- [ ] Yes, but I'd verify every moment manually
- [ ] No, I trust my own judgment more

**4. Overall rating of this analysis:**

```
Terrible  1 ── 2 ── 3 ── 4 ── 5  Excellent
          ○    ○    ○    ○    ○
```

---

## Part B: Per-Moment Scoring

> For each moment returned by ganyIQ:
> 1. Jump to the timestamp in YouTube
> 2. Watch the 15–90 second segment
> 3. Score each criterion 1–5 using the definitions below
> 4. Add any notes about this specific moment

### Scoring Scale

| Score | Label | Meaning |
|---|---|---|
| 5 | 🔥 Excellent | Better than a professional clipper |
| 4 | ✅ Good | Matches professional quality |
| 3 | ⚠️ Acceptable | Usable but has minor issues |
| 2 | ❌ Poor | Notable problems, wouldn't use |
| 1 | 🚫 Failing | Completely wrong or unusable |

---

### Moment #1

**Timestamp:** `[MM:SS] → [MM:SS]`
**Score:** `[0–100]` **Tier:** `[elite/secondary]`
**DNA Tags:** `[tag1, tag2, tag3]`
**Reasoning:** `[AI's explanation]`

| Criterion | 1 | 2 | 3 | 4 | 5 | Notes |
|---|---|---|---|---|---|---|
| Timestamp Accuracy | ○ | ○ | ○ | ○ | ○ | |
| Clip Usefulness | ○ | ○ | ○ | ○ | ○ | |
| Hook Quality | ○ | ○ | ○ | ○ | ○ | |
| Viral Potential | ○ | ○ | ○ | ○ | ○ | |
| DNA Tag Accuracy | ○ | ○ | ○ | ○ | ○ | |
| Reasoning Quality | ○ | ○ | ○ | ○ | ○ | |

**Moment Average:** `___ / 5`

**Would you clip this?**
- [ ] Yes, definitely
- [ ] Maybe
- [ ] No

**Notes:**
```

```

---

### Moment #2

**Timestamp:** `[MM:SS] → [MM:SS]`
**Score:** `[0–100]` **Tier:** `[elite/secondary]`
**DNA Tags:** `[tag1, tag2, tag3]`
**Reasoning:** `[AI's explanation]`

| Criterion | 1 | 2 | 3 | 4 | 5 | Notes |
|---|---|---|---|---|---|---|
| Timestamp Accuracy | ○ | ○ | ○ | ○ | ○ | |
| Clip Usefulness | ○ | ○ | ○ | ○ | ○ | |
| Hook Quality | ○ | ○ | ○ | ○ | ○ | |
| Viral Potential | ○ | ○ | ○ | ○ | ○ | |
| DNA Tag Accuracy | ○ | ○ | ○ | ○ | ○ | |
| Reasoning Quality | ○ | ○ | ○ | ○ | ○ | |

**Moment Average:** `___ / 5`

**Would you clip this?**
- [ ] Yes, definitely
- [ ] Maybe
- [ ] No

**Notes:**
```

```

---

> *Copy the Moment #N block above for each moment in the analysis.
> For analyses with more than 5 moments, continue on additional pages.*

---

## Part C: Analysis-Level Metrics

### Counts

| Metric | Value |
|---|---|
| Total moments returned by AI | `___` |
| Elite moments (score ≥ 85) | `___` |
| Secondary moments (score 70–84) | `___` |
| Moments YOU would actually clip | `___` |
| Overlap (AI found + you agree) | `___` |
| Missed by AI (you found, AI didn't) | `___` |

### Calculated

```
Recall:     Overlap / (Overlap + Missed) = ___ / ___ = ___%
Precision:  Overlap / Total AI moments   = ___ / ___ = ___%
```

---

## Part D: Qualitative Feedback

### What did ganyIQ get RIGHT?

```
[Describe moments where the AI was spot-on.
 What made them good? Was it the timestamp?
 The reasoning? The DNA tags?]
```

### What did ganyIQ get WRONG?

```
[Describe any bad moments. Wrong timestamps?
 Wrong tags? Weak reasoning?]
```

### Were there obvious moments the AI missed?

```
[List timestamps and describe the missed moments.
 Why do you think the AI missed them?]
```

### Anything surprising?

```
[Unexpectedly good results? Unexpectedly bad?
 Biases you noticed?]
```

---

## Part E: Failure Pattern Checklist

> Check all patterns you observed in THIS analysis.

- [ ] **Over-scoring** — Moments scored too high (e.g., average moments called "elite")
- [ ] **Under-scoring** — Good moments scored too low (e.g., viral moments below 70)
- [ ] **Hallucinated hooks** — Reasoning describes content that doesn't exist at that timestamp
- [ ] **Wrong DNA tags** — DNA tags don't match the moment's content
- [ ] **Weak reasoning** — Generic explanations ("This is a good clip") without specifics
- [ ] **Timestamp drift** — Timestamps are off by 5+ seconds from the actual content
- [ ] **Empty / too few results** — Analysis returned very few moments for rich content
- [ ] **Category mismatch** — Performs poorly on this content type vs. others
- [ ] **Other:** `____________________`

### Most critical issue in this analysis:

```
[Single sentence describing the #1 thing to fix]
```

---

## Part F: Pass/Fail

### Per-Moment Threshold Check

| Criterion | Your Avg Score | Pass (≥ 3.0) |
|---|---|---|
| Timestamp Accuracy | `___` | ☐ Pass ☐ Fail |
| Clip Usefulness | `___` | ☐ Pass ☐ Fail |
| Hook Quality | `___` | ☐ Pass ☐ Fail |
| Viral Potential | `___` | ☐ Pass ☐ Fail |
| DNA Tag Accuracy | `___` | ☐ Pass ☐ Fail |
| Reasoning Quality | `___` | ☐ Pass ☐ Fail |
| **Overall Average** | `___` | ☐ Pass ☐ Fail |

### Overall Verdict

- [ ] ✅ **PASS** — This analysis is production quality
- [ ] ⚠️ **PASS WITH NOTES** — Usable but has room for improvement (see Part D)
- [ ] ❌ **FAIL** — Not acceptable for production (see Part E)

---

## Reviewer Declaration

```
I have reviewed this analysis thoroughly.
I have watched the referenced video segments.
My scores reflect my honest assessment as a content professional.

Signature: ____________________
Date:      ____________________
```

---

## Save Instructions

After completing:

1. Save this file to: `eval/scorecards/{date}-{reviewer}-{category}-{seq}.md`
2. Update the URL tracker: set status to "reviewed"
3. If marking FAIL: notify the founder immediately

**Thank you for helping make ganyIQ better.** 🙏
