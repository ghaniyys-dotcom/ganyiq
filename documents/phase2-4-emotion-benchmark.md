# Phase 2.4 — Emotion Generator Benchmark
**Date:** 2026-06-16
**Comparison:** Emotion (C) vs Hook (A) vs Insight (B)

---

## Raditya Dika (`lqeDF5JwYvM`)

### Generator Output Summary

| Metric | Hook (A) | Insight (B) | Emotion (C) |
|--------|----------|-------------|-------------|
| Raw candidates | 20 | 7 | 10 |
| Capped | 15 | 7 | 10 |
| Top K | 5 | 5 | 5 |
| Time | 56ms | 59ms | 94ms |

### Emotion Generator (C) — Top 5

| # | ID | Time | Score | Emotional Signals |
|---|----|------|-------|-------------------|
| 1 | `emotion_0` | 52:20-53:19 | 100 | gratitude, hope, connection |
| 2 | `emotion_1` | 31:43-32:33 | 78 | vulnerability, fear |
| 3 | `emotion_2` | 10:06-10:57 | 42 | connection |
| 4 | `emotion_3` | 24:51-25:42 | 35 | failure |
| 5 | `emotion_4` | 40:32-41:20 | 35 | failure |

### Overlap Analysis

**Emotion vs Hook (Top 5):**

| Emotion Candidate | Best Match | Time Overlap | Overlap? |
|------------------|------------|-------------|----------|
| `emotion_0` @ 52:20 | — | 0.000 | ✅ no |
| `emotion_1` @ 31:43 | — | 0.000 | ✅ no |
| `emotion_2` @ 10:06 | — | 0.000 | ✅ no |
| `emotion_3` @ 24:51 | — | 0.000 | ✅ no |
| `emotion_4` @ 40:32 | — | 0.000 | ✅ no |
| **Total** | | **0/5** | **0%** |

**Emotion vs Insight (Top 5):**

| Emotion Candidate | Best Match | Time Overlap | Overlap? |
|------------------|------------|-------------|----------|
| `emotion_0` @ 52:20 | — | 0.000 | ✅ no |
| `emotion_1` @ 31:43 | insight_1 @ 31:00 | 0.116 | ✅ no |
| `emotion_2` @ 10:06 | — | 0.000 | ✅ no |
| `emotion_3` @ 24:51 | — | 0.000 | ✅ no |
| `emotion_4` @ 40:32 | — | 0.000 | ✅ no |
| **Total** | | **0/5** | **0%** |

### New Discoveries (Emotion vs Hook + Insight Combined)

Emotion clips that neither Hook nor Insight find (>30% overlap):

**New discoveries:** 3/5 (60%)

### Combined Pool (3 Generators)

| Generator | Top K | Surviving Dedup | % of Pool |
|-----------|-------|-----------------|-----------|
| Hook (A) | 5 | 5 | 38% |
| Insight (B) | 5 | 3 | 23% |
| Emotion (C) | 5 | 5 | 38% |
| **Total** | **15** | **13** | **100%** |

Dropped: insight_2, insight_3

### Emotional Signal Breakdown (All Candidates)

| Signal | Count |
|--------|-------|
| connection | 4 |
| gratitude | 2 |
| hope | 2 |
| failure | 2 |
| vulnerability | 1 |
| fear | 1 |
| sadness | 1 |

### Project Verdict

| Check | Threshold | Result | Status |
|-------|-----------|--------|--------|
| Hook overlap <50% | <50% | 0% | ✅ |
| Insight overlap <50% | <50% | 0% | ✅ |
| New discoveries ≥60% | ≥60% | 60% | ✅ |
| Zero-candidate? | — | ✅ no | — |
| Mean score | — | 40.6 | — |

**Overall: ✅ PASS**

---

## Tom Lembong (`lpQrUTWXHZU`)

### Generator Output Summary

| Metric | Hook (A) | Insight (B) | Emotion (C) |
|--------|----------|-------------|-------------|
| Raw candidates | 86 | 55 | 54 |
| Capped | 15 | 15 | 15 |
| Top K | 5 | 5 | 5 |
| Time | 241ms | 189ms | 506ms |

### Emotion Generator (C) — Top 5

| # | ID | Time | Score | Emotional Signals |
|---|----|------|-------|-------------------|
| 1 | `emotion_0` | 13:56-14:14 | 100 | connection, sadness, vulnerability |
| 2 | `emotion_1` | 74:31-75:02 | 83 | connection |
| 3 | `emotion_2` | 28:02-28:22 | 82 | connection, gratitude, hope |
| 4 | `emotion_3` | 20:48-21:20 | 74 | vulnerability, transformation, sadness |
| 5 | `emotion_4` | 3:36-4:09 | 54 | connection |

### Overlap Analysis

**Emotion vs Hook (Top 5):**

| Emotion Candidate | Best Match | Time Overlap | Overlap? |
|------------------|------------|-------------|----------|
| `emotion_0` @ 13:56 | hook_7 @ 13:45 | 0.528 | ⚠ YES |
| `emotion_1` @ 74:31 | — | 0.000 | ✅ no |
| `emotion_2` @ 28:02 | — | 0.000 | ✅ no |
| `emotion_3` @ 20:48 | — | 0.000 | ✅ no |
| `emotion_4` @ 3:36 | — | 0.000 | ✅ no |
| **Total** | | **1/5** | **20%** |

**Emotion vs Insight (Top 5):**

| Emotion Candidate | Best Match | Time Overlap | Overlap? |
|------------------|------------|-------------|----------|
| `emotion_0` @ 13:56 | — | 0.000 | ✅ no |
| `emotion_1` @ 74:31 | — | 0.000 | ✅ no |
| `emotion_2` @ 28:02 | — | 0.000 | ✅ no |
| `emotion_3` @ 20:48 | — | 0.000 | ✅ no |
| `emotion_4` @ 3:36 | — | 0.000 | ✅ no |
| **Total** | | **0/5** | **0%** |

### New Discoveries (Emotion vs Hook + Insight Combined)

Emotion clips that neither Hook nor Insight find (>30% overlap):

**New discoveries:** 3/5 (60%)

### Combined Pool (3 Generators)

| Generator | Top K | Surviving Dedup | % of Pool |
|-----------|-------|-----------------|-----------|
| Hook (A) | 5 | 5 | 36% |
| Insight (B) | 5 | 5 | 36% |
| Emotion (C) | 5 | 4 | 29% |
| **Total** | **15** | **14** | **100%** |

Dropped: emotion_0

### Emotional Signal Breakdown (All Candidates)

| Signal | Count |
|--------|-------|
| connection | 9 |
| joy | 4 |
| gratitude | 3 |
| transformation | 3 |
| sadness | 2 |
| vulnerability | 2 |
| hope | 2 |

### Project Verdict

| Check | Threshold | Result | Status |
|-------|-----------|--------|--------|
| Hook overlap <50% | <50% | 20% | ✅ |
| Insight overlap <50% | <50% | 0% | ✅ |
| New discoveries ≥60% | ≥60% | 60% | ✅ |
| Zero-candidate? | — | ✅ no | — |
| Mean score | — | 50.3 | — |

**Overall: ✅ PASS**

---

## Fajar Sadboy (`FN283CT4rgg`)

### Generator Output Summary

| Metric | Hook (A) | Insight (B) | Emotion (C) |
|--------|----------|-------------|-------------|
| Raw candidates | 34 | 20 | 8 |
| Capped | 15 | 15 | 8 |
| Top K | 5 | 5 | 5 |
| Time | 46ms | 44ms | 102ms |

### Emotion Generator (C) — Top 5

| # | ID | Time | Score | Emotional Signals |
|---|----|------|-------|-------------------|
| 1 | `emotion_0` | 49:38-50:30 | 100 | gratitude, transformation |
| 2 | `emotion_1` | 66:59-67:49 | 57 | connection |
| 3 | `emotion_2` | 10:27-11:22 | 41 | fear |
| 4 | `emotion_3` | 20:41-21:36 | 31 | connection |
| 5 | `emotion_4` | 58:08-58:58 | 31 | connection |

### Overlap Analysis

**Emotion vs Hook (Top 5):**

| Emotion Candidate | Best Match | Time Overlap | Overlap? |
|------------------|------------|-------------|----------|
| `emotion_0` @ 49:38 | — | 0.000 | ✅ no |
| `emotion_1` @ 66:59 | — | 0.000 | ✅ no |
| `emotion_2` @ 10:27 | — | 0.000 | ✅ no |
| `emotion_3` @ 20:41 | hook_10 @ 20:23 | 0.366 | ⚠ YES |
| `emotion_4` @ 58:08 | — | 0.000 | ✅ no |
| **Total** | | **1/5** | **20%** |

**Emotion vs Insight (Top 5):**

| Emotion Candidate | Best Match | Time Overlap | Overlap? |
|------------------|------------|-------------|----------|
| `emotion_0` @ 49:38 | — | 0.000 | ✅ no |
| `emotion_1` @ 66:59 | — | 0.000 | ✅ no |
| `emotion_2` @ 10:27 | insight_1 @ 9:53 | 0.310 | ⚠ YES |
| `emotion_3` @ 20:41 | — | 0.000 | ✅ no |
| `emotion_4` @ 58:08 | — | 0.000 | ✅ no |
| **Total** | | **1/5** | **20%** |

### New Discoveries (Emotion vs Hook + Insight Combined)

Emotion clips that neither Hook nor Insight find (>30% overlap):

**New discoveries:** 2/5 (40%)

### Combined Pool (3 Generators)

| Generator | Top K | Surviving Dedup | % of Pool |
|-----------|-------|-----------------|-----------|
| Hook (A) | 5 | 5 | 33% |
| Insight (B) | 5 | 5 | 33% |
| Emotion (C) | 5 | 5 | 33% |
| **Total** | **15** | **15** | **100%** |

Dropped: none

### Emotional Signal Breakdown (All Candidates)

| Signal | Count |
|--------|-------|
| connection | 5 |
| gratitude | 1 |
| transformation | 1 |
| fear | 1 |
| joy | 1 |

### Project Verdict

| Check | Threshold | Result | Status |
|-------|-----------|--------|--------|
| Hook overlap <50% | <50% | 20% | ✅ |
| Insight overlap <50% | <50% | 20% | ✅ |
| New discoveries ≥60% | ≥60% | 40% | ❌ |
| Zero-candidate? | — | ✅ no | — |
| Mean score | — | 42.3 | — |

**Overall: ❌ FAIL**

---

## Global Summary

| Metric | Hook (A) | Insight (B) | Emotion (C) | Combined |
|--------|----------|-------------|-------------|----------|
| Top K total | 15 | 15 | 15 | 45 |

**Phase 2.4 Gate:**
- [ ] Hook overlap < 50%
- [ ] Insight overlap < 50%
- [ ] New discoveries (vs A+B) ≥ 60%

*Generated by emotion-benchmark.ts at 2026-06-16T00:29:13.722Z*