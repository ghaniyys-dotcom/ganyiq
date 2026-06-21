# Phase 2.2 — Hook Generator Audit Report
**Date:** 2026-06-15
**Gate:** Generator A diagnostics — score ceiling, normalization, diversity

---

## Project: Raditya Dika (`lqeDF5JwYvM`)

### 1. Score Distribution

| Metric | Value |
|--------|-------|
| N | 20 |
| Mean | 31.00 |
| Std | 29.73 |
| P50 (median) | 33 |
| P90 | 73 |
| P95 | 100 |
| Count(score=100) | 1 |
| Count(score=0) | 7 |
| Min | 0 |
| Max | 100 |

**Histogram (score → count):**

| Range | Count | Bar |
|-------|-------|-----|
| 0-9 | 8 | ████████████████████ |
| 10-19 | 0 |  |
| 20-29 | 2 | █████ |
| 30-39 | 1 | ███ |
| 40-49 | 3 | ████████ |
| 50-59 | 1 | ███ |
| 60-69 | 3 | ████████ |
| 70-79 | 1 | ███ |
| 80-89 | 0 |  |
| 90-99 | 1 | ███ |

### 2. Raw Score (Pre-Normalization)

The internalScore is 0-100 normalized. The underlying `netScore` (openingHookScore - penaltyScore) is the raw value before normalization.

**Score=100 candidates:** 1
- `hook_1` @ 2:10-2:51 (40.7s)
  Signals: emotional_opening, question_driven
  Confidence: high
  Excerpt: "sih inget ga dulu adegannya apa yang kamu liat waduh banyak lagi ya kamu liat apa adegannya kamu ga ..."

### 3. Ceiling Investigation

**Verdict:** ✅ **NO CEILING** — only 1 candidate (or 0) scored 100. Normal spread.
- 1 candidate(s) at score=100 — healthy score ceiling

**Score gap (top1 - top2):** 27
✅ Gap is within normal range.

### 4. Diversity Audit (Top 5)

#### Signal Composition

| # | Candidate | Time | Score | Signals | Penalties |
|---|-----------|------|-------|---------|-----------|
| 1 | `hook_1` | 2:10-2:51 | 100 | emotional_opening, question_driven | none |
| 2 | `hook_7` | 22:18-23:02 | 73 | emotional_opening, surprising_claim | none |
| 3 | `hook_0` | 1:34-2:15 | 60 | emotional_opening, question_driven | none |
| 4 | `hook_2` | 6:48-7:24 | 60 | emotional_opening, question_driven | none |
| 5 | `hook_10` | 28:44-29:18 | 60 | surprising_claim, controversial | none |

#### Cluster Membership (Top 5 only)

| Cluster | Members | Contains Top 5 |
|---------|---------|----------------|
| `cluster-0` | 1 clip(s) @ 1:34-2:15 [hook] | `hook_0` |
| `cluster-1` | 1 clip(s) @ 2:10-2:51 [hook] | `hook_1` |
| `cluster-2` | 1 clip(s) @ 6:48-7:24 [hook] | `hook_2` |
| `cluster-7` | 1 clip(s) @ 22:18-23:02 [hook] | `hook_7` |
| `cluster-10` | 1 clip(s) @ 28:44-29:18 [hook] | `hook_10` |

#### Top-5 Pairwise Overlap Matrix

| Pair | Time Ovl | Tx Ovl | Composite | Verdict |
|------|----------|--------|-----------|---------|
| `hook_1` ↔ `hook_7` | 0.000 | 0.123 | 0.126 | ✅ distinct |
| `hook_1` ↔ `hook_0` | 0.061 | 0.239 | 0.358 | ✅ distinct |
| `hook_1` ↔ `hook_2` | 0.000 | 0.104 | 0.286 | ✅ distinct |
| `hook_1` ↔ `hook_10` | 0.000 | 0.114 | 0.040 | ✅ distinct |
| `hook_7` ↔ `hook_0` | 0.000 | 0.114 | 0.123 | ✅ distinct |
| `hook_7` ↔ `hook_2` | 0.000 | 0.118 | 0.125 | ✅ distinct |
| `hook_7` ↔ `hook_10` | 0.000 | 0.133 | 0.130 | ✅ distinct |
| `hook_0` ↔ `hook_2` | 0.000 | 0.176 | 0.312 | ✅ distinct |
| `hook_0` ↔ `hook_10` | 0.000 | 0.105 | 0.037 | ✅ distinct |
| `hook_2` ↔ `hook_10` | 0.000 | 0.107 | 0.037 | ✅ distinct |

#### Diversity Scores (Top 5 within pool)

| Candidate | Novelty | Moment Spread | Intent Div | Composite |
|-----------|---------|---------------|------------|----------|
| `hook_1` | 0.797 | 0.170 | 0.000 | 0.379 |
| `hook_7` | 0.874 | 0.571 | 0.000 | 0.549 |
| `hook_0` | 0.793 | 0.193 | 0.000 | 0.384 |
| `hook_2` | 0.810 | 0.000 | 0.000 | 0.324 |
| `hook_10` | 0.939 | 0.807 | 0.000 | 0.658 |

### 6. Project Verdict

✅ **Passes audit.** Score distribution is healthy. Top 5 are diverse and distinct.

---

## Project: Tom Lembong (`lpQrUTWXHZU`)

### 1. Score Distribution

| Metric | Value |
|--------|-------|
| N | 86 |
| Mean | 41.85 |
| Std | 19.02 |
| P50 (median) | 39 |
| P90 | 67 |
| P95 | 76 |
| Count(score=100) | 3 |
| Count(score=0) | 0 |
| Min | 6 |
| Max | 100 |

**Histogram (score → count):**

| Range | Count | Bar |
|-------|-------|-----|
| 0-9 | 1 | █ |
| 10-19 | 9 | ███████ |
| 20-29 | 11 | ████████ |
| 30-39 | 27 | ████████████████████ |
| 40-49 | 14 | ██████████ |
| 50-59 | 11 | ████████ |
| 60-69 | 5 | ████ |
| 70-79 | 4 | ███ |
| 80-89 | 1 | █ |
| 90-99 | 3 | ██ |

### 2. Raw Score (Pre-Normalization)

The internalScore is 0-100 normalized. The underlying `netScore` (openingHookScore - penaltyScore) is the raw value before normalization.

**Score=100 candidates:** 3
- `hook_7` @ 13:45-14:06 (20.5s)
  Signals: emotional_opening, question_driven, surprising_claim
  Confidence: high
  Excerpt: "ya dan dia ya dan dia ya bisa bayangin kan bangganya kayak apa ya bisa bayangin kan bangganya kayak ..."
- `hook_35` @ 42:47-43:21 (33.8s)
  Signals: controversial, emotional_opening, question_driven, surprising_claim
  Confidence: high
  Excerpt: "gubernur ya kan. gubernur ya kan. Sijin pun juga kalau enggak salah ingat Sijin pun juga kalau engga..."
- `hook_68` @ 89:38-89:56 (17.9s)
  Signals: surprising_claim, question_driven
  Confidence: high
  Excerpt: "penegakan hukum. penegakan hukum. Betul. Betul. Betul. Singapura itu jelas. Apapun yang harus Singap..."

**Pairwise overlap matrix (score=100 candidates):**

| |
| Pair | Time Ovl | Tx Ovl | Sem Ovl | Composite | Flags |
|---|--|--|--|--|--|
| hook_7 ↔ hook_35 | 0.000 | 0.155 | 0.750 | 0.242 | ok |
| hook_7 ↔ hook_68 | 0.000 | 0.072 | 0.667 | 0.192 | ok |
| hook_35 ↔ hook_68 | 0.000 | 0.092 | 0.500 | 0.157 | ok |

### 3. Ceiling Investigation

**Verdict:** ✅ **GENUINE TOP CLIPS** — multiple score=100 candidates are genuinely different moments with low pairwise overlap.
- 3 candidates scored 100
- Pairwise overlap rate among score=100: 0% (below threshold 0.65)
- These are genuinely strong hook moments, not duplicates

**Score gap (top1 - top2):** 0
✅ Gap is within normal range.

### 4. Diversity Audit (Top 5)

#### Signal Composition

| # | Candidate | Time | Score | Signals | Penalties |
|---|-----------|------|-------|---------|-----------|
| 1 | `hook_7` | 13:45-14:06 | 100 | emotional_opening, question_driven, surprising_claim | none |
| 2 | `hook_35` | 42:47-43:21 | 100 | controversial, emotional_opening, question_driven | none |
| 3 | `hook_68` | 89:38-89:56 | 100 | surprising_claim, question_driven | none |
| 4 | `hook_1` | 1:44-2:07 | 81 | surprising_claim, emotional_opening, question_driven | none |
| 5 | `hook_77` | 102:04-102:21 | 76 | surprising_claim, emotional_opening | none |

#### Cluster Membership (Top 5 only)

| Cluster | Members | Contains Top 5 |
|---------|---------|----------------|
| `cluster-1` | 1 clip(s) @ 1:44-2:07 [hook] | `hook_1` |
| `cluster-4` | 1 clip(s) @ 13:45-14:06 [hook] | `hook_7` |
| `cluster-18` | 1 clip(s) @ 42:47-43:21 [hook] | `hook_35` |
| `cluster-34` | 1 clip(s) @ 89:38-89:56 [hook] | `hook_68` |
| `cluster-38` | 1 clip(s) @ 102:04-102:21 [hook] | `hook_77` |

#### Top-5 Pairwise Overlap Matrix

| Pair | Time Ovl | Tx Ovl | Composite | Verdict |
|------|----------|--------|-----------|---------|
| `hook_7` ↔ `hook_35` | 0.000 | 0.155 | 0.242 | ✅ distinct |
| `hook_7` ↔ `hook_68` | 0.000 | 0.072 | 0.192 | ✅ distinct |
| `hook_7` ↔ `hook_1` | 0.000 | 0.141 | 0.299 | ✅ distinct |
| `hook_7` ↔ `hook_77` | 0.000 | 0.058 | 0.187 | ✅ distinct |
| `hook_35` ↔ `hook_68` | 0.000 | 0.092 | 0.157 | ✅ distinct |
| `hook_35` ↔ `hook_1` | 0.000 | 0.065 | 0.210 | ✅ distinct |
| `hook_35` ↔ `hook_77` | 0.000 | 0.079 | 0.153 | ✅ distinct |
| `hook_68` ↔ `hook_1` | 0.000 | 0.017 | 0.173 | ✅ distinct |
| `hook_68` ↔ `hook_77` | 0.000 | 0.054 | 0.102 | ✅ distinct |
| `hook_1` ↔ `hook_77` | 0.000 | 0.036 | 0.179 | ✅ distinct |

#### Diversity Scores (Top 5 within pool)

| Candidate | Novelty | Moment Spread | Intent Div | Composite |
|-----------|---------|---------------|------------|----------|
| `hook_7` | 0.770 | 0.289 | 0.000 | 0.409 |
| `hook_35` | 0.810 | 0.000 | 0.000 | 0.324 |
| `hook_68` | 0.844 | 0.467 | 0.000 | 0.501 |
| `hook_1` | 0.785 | 0.409 | 0.000 | 0.457 |
| `hook_77` | 0.845 | 0.591 | 0.000 | 0.545 |

### 5. Deep Dive: Why 3× Score=100?

**Hypothesis testing:**

| Hypothesis | Evidence | Verdict |
|------------|----------|---------|
| **H1: Genuine** — three distinct strong hook moments | Avg pairwise overlap among score=100: 0.197 (threshold=0.65) | ✅ SUPPORTED |
| **H2: Normalization artifact** — maxScore is low, so many clips compress to 100 | Candidates near max (≥95): 0 below 100 + 3 at 100 = 3 total high-score | — |
| | | ✅ No compression — clean score separation |
| **H3: Scoring bug** — all score=100 have identical raw signal scores | — | See below |

**Score=100 candidates detail:**

| ID | Time | Duration | Signals | Confidence | 
|----|------|----------|---------|------------|
| `hook_7` | 13:45-14:06 | 20.5s | emotional_opening, question_driven, surprising_claim | high |
| `hook_35` | 42:47-43:21 | 33.8s | controversial, emotional_opening, question_driven, surprising_claim | high |
| `hook_68` | 89:38-89:56 | 17.9s | surprising_claim, question_driven | high |

**Final verdict on Tom Lembong 3×100:**

✅ **Genuine top clips.** The 3 score=100 candidates are from different moments (avg overlap 0.197), with different signal compositions. They are genuinely strong hook moments. No normalization artifact or scoring bug detected.

### 6. Project Verdict

✅ **Passes audit.** Score distribution is healthy. Top 5 are diverse and distinct.

---

## Project: Fajar Sadboy (`FN283CT4rgg`)

### 1. Score Distribution

| Metric | Value |
|--------|-------|
| N | 34 |
| Mean | 24.76 |
| Std | 23.50 |
| P50 (median) | 20 |
| P90 | 47 |
| P95 | 67 |
| Count(score=100) | 1 |
| Count(score=0) | 8 |
| Min | 0 |
| Max | 100 |

**Histogram (score → count):**

| Range | Count | Bar |
|-------|-------|-----|
| 0-9 | 10 | ████████████████████ |
| 10-19 | 5 | ██████████ |
| 20-29 | 8 | ████████████████ |
| 30-39 | 0 |  |
| 40-49 | 8 | ████████████████ |
| 50-59 | 0 |  |
| 60-69 | 2 | ████ |
| 70-79 | 0 |  |
| 80-89 | 0 |  |
| 90-99 | 1 | ██ |

### 2. Raw Score (Pre-Normalization)

The internalScore is 0-100 normalized. The underlying `netScore` (openingHookScore - penaltyScore) is the raw value before normalization.

**Score=100 candidates:** 1
- `hook_19` @ 35:32-36:10 (37.3s)
  Signals: surprising_claim, emotional_opening, question_driven
  Confidence: high
  Excerpt: "ga lahir umur sama oki 20.07 lahir 2007 wih kencang sekali ya oh iya 17 berarti betul mana ktp ktp b..."

### 3. Ceiling Investigation

**Verdict:** ✅ **NO CEILING** — only 1 candidate (or 0) scored 100. Normal spread.
- 1 candidate(s) at score=100 — healthy score ceiling

**Score gap (top1 - top2):** 33
✅ Gap is within normal range.

### 4. Diversity Audit (Top 5)

#### Signal Composition

| # | Candidate | Time | Score | Signals | Penalties |
|---|-----------|------|-------|---------|-----------|
| 1 | `hook_19` | 35:32-36:10 | 100 | surprising_claim, emotional_opening, question_driven | greeting, transition) |
| 2 | `hook_0` | 2:19-3:01 | 67 | controversial, question_driven | greeting) |
| 3 | `hook_25` | 47:48-48:19 | 67 | emotional_opening, controversial, question_driven | greeting) |
| 4 | `hook_9` | 19:33-19:58 | 47 | controversial, question_driven, emotional_opening | greeting) |
| 5 | `hook_10` | 20:23-20:51 | 47 | curiosity_gap, question_driven | greeting) |

#### Cluster Membership (Top 5 only)

| Cluster | Members | Contains Top 5 |
|---------|---------|----------------|
| `cluster-0` | 1 clip(s) @ 2:19-3:01 [hook] | `hook_0` |
| `cluster-9` | 1 clip(s) @ 19:33-19:58 [hook] | `hook_9` |
| `cluster-10` | 1 clip(s) @ 20:23-20:51 [hook] | `hook_10` |
| `cluster-19` | 1 clip(s) @ 35:32-36:10 [hook] | `hook_19` |
| `cluster-25` | 1 clip(s) @ 47:48-48:19 [hook] | `hook_25` |

#### Top-5 Pairwise Overlap Matrix

| Pair | Time Ovl | Tx Ovl | Composite | Verdict |
|------|----------|--------|-----------|---------|
| `hook_19` ↔ `hook_0` | 0.000 | 0.105 | 0.099 | ✅ distinct |
| `hook_19` ↔ `hook_25` | 0.000 | 0.098 | 0.159 | ✅ distinct |
| `hook_19` ↔ `hook_9` | 0.000 | 0.125 | 0.169 | ✅ distinct |
| `hook_19` ↔ `hook_10` | 0.000 | 0.082 | 0.091 | ✅ distinct |
| `hook_0` ↔ `hook_25` | 0.000 | 0.101 | 0.202 | ✅ distinct |
| `hook_0` ↔ `hook_9` | 0.000 | 0.091 | 0.198 | ✅ distinct |
| `hook_0` ↔ `hook_10` | 0.000 | 0.070 | 0.108 | ✅ distinct |
| `hook_25` ↔ `hook_9` | 0.000 | 0.052 | 0.268 | ✅ distinct |
| `hook_25` ↔ `hook_10` | 0.000 | 0.109 | 0.101 | ✅ distinct |
| `hook_9` ↔ `hook_10` | 0.000 | 0.045 | 0.078 | ✅ distinct |

#### Diversity Scores (Top 5 within pool)

| Candidate | Novelty | Moment Spread | Intent Div | Composite |
|-----------|---------|---------------|------------|----------|
| `hook_19` | 0.870 | 0.333 | 0.000 | 0.465 |
| `hook_0` | 0.848 | 0.397 | 0.000 | 0.478 |
| `hook_25` | 0.817 | 0.603 | 0.000 | 0.538 |
| `hook_9` | 0.822 | 0.018 | 0.000 | 0.335 |
| `hook_10` | 0.905 | 0.000 | 0.000 | 0.362 |

### 6. Project Verdict

✅ **Passes audit.** Score distribution is healthy. Top 5 are diverse and distinct.

---

## Global Summary

| Check | Raditya Dika | Tom Lembong | Fajar Sadboy | Overall |
|-------|-------------|-------------|--------------|---------|
| Score ceiling issue | See above | See above | See above | — |
| Diversity issue | See above | See above | See above | — |

**Phase 2.3 Gate Decision:**

✅ **GATE: PASSED** — No ceiling bug. Diversity is healthy. Proceed to Phase 2.3 (Generator B: Insight First).

---
*Generated by `hook-audit.ts` at 2026-06-15T23:30:16.327Z*