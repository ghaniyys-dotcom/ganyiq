# Phase 2.3 — Insight Generator Benchmark
**Date:** 2026-06-16
**Comparison:** Insight First (B) vs Hook First (A)

---

## Raditya Dika (`lqeDF5JwYvM`)

### Generator Output Summary

| Metric | Hook (A) | Insight (B) |
|--------|----------|-------------|
| Raw candidates | 20 | 7 |
| Capped (maxRaw) | 15 | 7 |
| Top K (local) | 5 | 5 |
| Generation time | 84ms | 55ms |

### Hook Generator (A) — Top 5

| # | ID | Time | Score | Signals |
|---|----|------|-------|---------|
| 1 | `hook_1` | 2:10-2:51 | 100 | emotional_opening, question_driven |
| 2 | `hook_7` | 22:18-23:02 | 73 | emotional_opening, surprising_claim |
| 3 | `hook_0` | 1:34-2:15 | 60 | emotional_opening, question_driven |
| 4 | `hook_2` | 6:48-7:24 | 60 | emotional_opening, question_driven |
| 5 | `hook_10` | 28:44-29:18 | 60 | surprising_claim, controversial |

### Insight Generator (B) — Top 5

| # | ID | Time | Score | Signals |
|---|----|------|-------|---------|
| 1 | `insight_0` | 37:40-38:27 | 100 | counterintuitive |
| 2 | `insight_1` | 31:00-31:49 | 96 | counterintuitive |
| 3 | `insight_2` | 1:25-2:15 | 86 | lesson |
| 4 | `insight_3` | 6:48-7:38 | 86 | lesson |
| 5 | `insight_4` | 43:51-44:41 | 79 | framework |

### Hook vs Insight Overlap

**Per-candidate overlap (Insight Top 5 vs Hook Top 5):**

| Insight Candidate | Hook Best Match | Time Ovl | Tx Ovl | Composite | Overlap? |
|-------------------|-----------------|----------|--------|-----------|----------|
| `insight_0` @ 37:40 | `—` @ — | 0.000 | — | 0.000 | ✅ no |
| `insight_1` @ 31:00 | `—` @ — | 0.000 | — | 0.000 | ✅ no |
| `insight_2` @ 1:25 | `hook_0` @ 1:34 | 0.812 | 0.812 | 0.812 | ⚠ YES |
| `insight_3` @ 6:48 | `hook_2` @ 6:48 | 0.709 | 0.709 | 0.709 | ⚠ YES |
| `insight_4` @ 43:51 | `—` @ — | 0.000 | — | 0.000 | ✅ no |

**Overlap rate:** 2/5 Insight clips overlap with Hook Top 5 (40%)

### New Discoveries (vs Hook All Candidates)

Insight clips that Hook completely misses (no overlap with ANY Hook candidate):

| # | ID | Time | Score | Signals |
|---|----|------|-------|---------|
| 1 | `insight_0` | 37:40-38:27 | 100 | counterintuitive |
| 2 | `insight_1` | 31:00-31:49 | 96 | counterintuitive |
| 3 | `insight_4` | 43:51-44:41 | 79 | framework |

**New discoveries:** 3/5 (60%)

### Combined Pool Analysis

| Generator | Raw Top K | Surviving Dedup | % of Pool |
|-----------|-----------|-----------------|-----------|
| Hook (A) | 5 | 5 | 63% |
| Insight (B) | 5 | 3 | 38% |
| **Total** | **10** | **8** | **100%** |

Dropped by dedup: insight_2, insight_3

### Failure Analysis

| Metric | Insight | Hook (ref) |
|--------|---------|------------|
| Score range | 57-100 | 0-100 |
| Mean score | 82.1 | 41.3 |
| Score=0 count | 0 | 2 |
| Zero-candidate windows? | ✅ no | ✅ no |

**Top Insight excerpt (opening 100 chars):**

- #1 (score=100, counterintuitive): "dia semprotsemar parfum biasanya suka ada ada bercak gatal di leher atau mungkin biasanya di tangan kalau suka pakai par..."
- #2 (score=96, counterintuitive): "komedo ada peradangan juga di situ sama lamalama bisa jadi ada bakterinya jadi jerawat bunga kadang ada yang cuma kecilk..."
- #3 (score=86, lesson): "katanya langsung kita awong saya sopan santun sekarang ini sopan santun udah salaman belum sama nikita tadi udah tadi ud..."

### Project Verdict

| Criterion | Threshold | Result | Status |
|-----------|-----------|--------|--------|
| Hook overlap | <40% | 40% | ❌ FAIL |
| New discoveries | ≥60% | 60% | ✅ PASS |
| **Overall** | | | **❌ FAIL** — review before Phase 2.4 |

---

## Tom Lembong (`lpQrUTWXHZU`)

### Generator Output Summary

| Metric | Hook (A) | Insight (B) |
|--------|----------|-------------|
| Raw candidates | 86 | 55 |
| Capped (maxRaw) | 15 | 15 |
| Top K (local) | 5 | 5 |
| Generation time | 273ms | 222ms |

### Hook Generator (A) — Top 5

| # | ID | Time | Score | Signals |
|---|----|------|-------|---------|
| 1 | `hook_7` | 13:45-14:06 | 100 | emotional_opening, question_driven, surprising_claim |
| 2 | `hook_35` | 42:47-43:21 | 100 | controversial, emotional_opening, question_driven |
| 3 | `hook_68` | 89:38-89:56 | 100 | surprising_claim, question_driven |
| 4 | `hook_1` | 1:44-2:07 | 81 | surprising_claim, emotional_opening, question_driven |
| 5 | `hook_77` | 102:04-102:21 | 76 | surprising_claim, emotional_opening |

### Insight Generator (B) — Top 5

| # | ID | Time | Score | Signals |
|---|----|------|-------|---------|
| 1 | `insight_0` | 106:29-107:18 | 100 | counterintuitive, problem, principle |
| 2 | `insight_1` | 104:59-105:41 | 70 | counterintuitive, framework, problem |
| 3 | `insight_2` | 34:16-35:05 | 60 | counterintuitive, explanation, framework |
| 4 | `insight_3` | 62:24-62:55 | 41 | principle, counterintuitive, framework |
| 5 | `insight_4` | 24:36-25:10 | 38 | explanation, causal, framework |

### Hook vs Insight Overlap

**Per-candidate overlap (Insight Top 5 vs Hook Top 5):**

| Insight Candidate | Hook Best Match | Time Ovl | Tx Ovl | Composite | Overlap? |
|-------------------|-----------------|----------|--------|-----------|----------|
| `insight_0` @ 106:29 | `—` @ — | 0.000 | — | 0.000 | ✅ no |
| `insight_1` @ 104:59 | `—` @ — | 0.000 | — | 0.000 | ✅ no |
| `insight_2` @ 34:16 | `—` @ — | 0.000 | — | 0.000 | ✅ no |
| `insight_3` @ 62:24 | `—` @ — | 0.000 | — | 0.000 | ✅ no |
| `insight_4` @ 24:36 | `—` @ — | 0.000 | — | 0.000 | ✅ no |

**Overlap rate:** 0/5 Insight clips overlap with Hook Top 5 (0%)

### New Discoveries (vs Hook All Candidates)

Insight clips that Hook completely misses (no overlap with ANY Hook candidate):

| # | ID | Time | Score | Signals |
|---|----|------|-------|---------|
| 1 | `insight_0` | 106:29-107:18 | 100 | counterintuitive, problem, principle |
| 2 | `insight_1` | 104:59-105:41 | 70 | counterintuitive, framework, problem |
| 3 | `insight_2` | 34:16-35:05 | 60 | counterintuitive, explanation, framework |
| 4 | `insight_3` | 62:24-62:55 | 41 | principle, counterintuitive, framework |
| 5 | `insight_4` | 24:36-25:10 | 38 | explanation, causal, framework |

**New discoveries:** 5/5 (100%)

### Combined Pool Analysis

| Generator | Raw Top K | Surviving Dedup | % of Pool |
|-----------|-----------|-----------------|-----------|
| Hook (A) | 5 | 5 | 50% |
| Insight (B) | 5 | 5 | 50% |
| **Total** | **10** | **10** | **100%** |

Dropped by dedup: none

### Failure Analysis

| Metric | Insight | Hook (ref) |
|--------|---------|------------|
| Score range | 19-100 | 56-100 |
| Mean score | 37.1 | 73.7 |
| Score=0 count | 0 | 0 |
| Zero-candidate windows? | ✅ no | ✅ no |

**Top Insight excerpt (opening 100 chars):**

- #1 (score=100, counterintuitive+problem+principle): "dengan sebuah rencana ada faktor tak terduga muncul dari samping ya terduga muncul dari samping ya terduga muncul dari s..."
- #2 (score=70, counterintuitive+framework+problem): "rencana saya yang terbaik ya. Kita harus mencapai target yang saya bikin ya kan? mencapai target yang saya bikin ya kan?..."
- #3 (score=60, counterintuitive+explanation+framework): "teknis untuk bisa menjadi pilot pesawat terbang ya. kemudian ee sekolah-sekolah terbang ya. kemudian ee sekolah-sekolah ..."

### Project Verdict

| Criterion | Threshold | Result | Status |
|-----------|-----------|--------|--------|
| Hook overlap | <40% | 0% | ✅ PASS |
| New discoveries | ≥60% | 100% | ✅ PASS |
| **Overall** | | | **✅ PASS** |

---

## Fajar Sadboy (`FN283CT4rgg`)

### Generator Output Summary

| Metric | Hook (A) | Insight (B) |
|--------|----------|-------------|
| Raw candidates | 34 | 20 |
| Capped (maxRaw) | 15 | 15 |
| Top K (local) | 5 | 5 |
| Generation time | 43ms | 46ms |

### Hook Generator (A) — Top 5

| # | ID | Time | Score | Signals |
|---|----|------|-------|---------|
| 1 | `hook_19` | 35:32-36:10 | 100 | surprising_claim, emotional_opening, question_driven |
| 2 | `hook_0` | 2:19-3:01 | 67 | controversial, question_driven |
| 3 | `hook_25` | 47:48-48:19 | 67 | emotional_opening, controversial, question_driven |
| 4 | `hook_9` | 19:33-19:58 | 47 | controversial, question_driven, emotional_opening |
| 5 | `hook_10` | 20:23-20:51 | 47 | curiosity_gap, question_driven |

### Insight Generator (B) — Top 5

| # | ID | Time | Score | Signals |
|---|----|------|-------|---------|
| 1 | `insight_0` | 24:55-25:52 | 100 | lesson, explanation |
| 2 | `insight_1` | 9:53-10:42 | 55 | counterintuitive |
| 3 | `insight_2` | 30:49-31:41 | 55 | counterintuitive |
| 4 | `insight_3` | 4:27-5:19 | 51 | causal |
| 5 | `insight_4` | 41:38-42:30 | 51 | causal |

### Hook vs Insight Overlap

**Per-candidate overlap (Insight Top 5 vs Hook Top 5):**

| Insight Candidate | Hook Best Match | Time Ovl | Tx Ovl | Composite | Overlap? |
|-------------------|-----------------|----------|--------|-----------|----------|
| `insight_0` @ 24:55 | `—` @ — | 0.000 | — | 0.000 | ✅ no |
| `insight_1` @ 9:53 | `—` @ — | 0.000 | — | 0.000 | ✅ no |
| `insight_2` @ 30:49 | `—` @ — | 0.000 | — | 0.000 | ✅ no |
| `insight_3` @ 4:27 | `—` @ — | 0.000 | — | 0.000 | ✅ no |
| `insight_4` @ 41:38 | `—` @ — | 0.000 | — | 0.000 | ✅ no |

**Overlap rate:** 0/5 Insight clips overlap with Hook Top 5 (0%)

### New Discoveries (vs Hook All Candidates)

Insight clips that Hook completely misses (no overlap with ANY Hook candidate):

| # | ID | Time | Score | Signals |
|---|----|------|-------|---------|
| 1 | `insight_0` | 24:55-25:52 | 100 | lesson, explanation |
| 2 | `insight_1` | 9:53-10:42 | 55 | counterintuitive |
| 3 | `insight_2` | 30:49-31:41 | 55 | counterintuitive |
| 4 | `insight_3` | 4:27-5:19 | 51 | causal |

**New discoveries:** 4/5 (80%)

### Combined Pool Analysis

| Generator | Raw Top K | Surviving Dedup | % of Pool |
|-----------|-----------|-----------------|-----------|
| Hook (A) | 5 | 5 | 50% |
| Insight (B) | 5 | 5 | 50% |
| **Total** | **10** | **10** | **100%** |

Dropped by dedup: none

### Failure Analysis

| Metric | Insight | Hook (ref) |
|--------|---------|------------|
| Score range | 33-100 | 20-100 |
| Mean score | 47.1 | 45.5 |
| Score=0 count | 0 | 0 |
| Zero-candidate windows? | ✅ no | ✅ no |

**Top Insight excerpt (opening 100 chars):**

- #1 (score=100, lesson+explanation): "umur 11 tahun kalau keluar satu hari tidak pulang saja orang khawatir iya apalagi seminggu pasti dicari ya karena pemiki..."
- #2 (score=55, counterintuitive): "itu travelling itu bukan travelling dia bilang iya loh dor traveling kalau menurutku itu traveling engga lebih ke apa ya..."
- #3 (score=55, counterintuitive): "190 ada 90 mungkin mundur lagi nih ini masih bisa logis itu kaya yang kemarin loh kaya bahrain sama indopism itu 90 tamb..."

### Project Verdict

| Criterion | Threshold | Result | Status |
|-----------|-----------|--------|--------|
| Hook overlap | <40% | 0% | ✅ PASS |
| New discoveries | ≥60% | 80% | ✅ PASS |
| **Overall** | | | **✅ PASS** |

---

## Global Summary

| Metric | Hook (A) | Insight (B) | Combined Pool |
|--------|----------|-------------|---------------|
| Total raw candidates | 140 | 82 | 222 |
| Top K total | 15 | 15 | 30 |

**Phase 2.3 Gate Decision:**

See per-project results above. Insight Generator must demonstrate:
- [ ] Hook overlap < 40%
- [ ] ≥ 60% new discoveries (vs Hook)
- [ ] Distinct candidate profile from Hook Generator

*Generated by insight-benchmark.ts at 2026-06-16T00:18:30.858Z*