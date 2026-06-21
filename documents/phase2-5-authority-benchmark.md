# Phase 2.5 — Authority Generator Benchmark
**Date:** 2026-06-16
**Comparison:** Authority (D) vs Hook (A), Insight (B), Emotion (C)

---

## Raditya Dika (`lqeDF5JwYvM`)

### Output Summary

| Metric | Hook (A) | Insight (B) | Emotion (C) | Authority (D) |
|--------|---|---|---|---|
| Raw candidates | 25 | 7 | 10 | 0 |
| Capped | 15 | 7 | 10 | 0 |
| Top K | 5 | 5 | 5 | 0 |
| Time | 53ms | 44ms | 97ms | 114ms |

### Authority Generator (D) — Top 5

| # | ID | Time | Score | Authority Signals |
|---|----|------|-------|------------------|

### Cross-Generator Overlap (Authority Top 5)

| Vs Generator | Overlap | Candidates affected |
|--------------|---------|---------------------|
| Hook (A) | N/A% | none |
| Insight (B) | N/A% | none |
| Emotion (C) | N/A% | none |

### New Discoveries (vs A+B+C Combined)

**New discoveries:** 0/0 (N/A%)

### Combined Pool (A+B+C+D)

| Generator | Top K | In Pool | % |
|-----------|-------|---------|---|
| Hook (A) | 5 | 5 | 38% |
| Insight (B) | 5 | 3 | 23% |
| Emotion (C) | 5 | 5 | 38% |
| Authority (D) | 0 | 0 | 0% |
| **Total** | **15** | **13** | **100%** |

### Authority Signal Breakdown (All Candidates)

| Signal | Count |
|--------|-------|

### Project Verdict

| Criterion | Threshold | Result | |
|-----------|-----------|--------|---|
| Hook overlap | <30% | NaN% | ❌ |
| Emotion overlap | <20% | NaN% | ❌ |
| Insight overlap | <50% | NaN% | ❌ |
| New discoveries | ≥50% | NaN% | ❌ |
| Zero candidates? | — | ⚠ | — |
| **Overall** | | | **❌ FAIL** |

---

## Tom Lembong (`lpQrUTWXHZU`)

### Output Summary

| Metric | Hook (A) | Insight (B) | Emotion (C) | Authority (D) |
|--------|---|---|---|---|
| Raw candidates | 86 | 55 | 54 | 107 |
| Capped | 15 | 15 | 15 | 15 |
| Top K | 5 | 5 | 5 | 5 |
| Time | 245ms | 200ms | 512ms | 508ms |

### Authority Generator (D) — Top 5

| # | ID | Time | Score | Authority Signals |
|---|----|------|-------|------------------|
| 1 | `auth_0` | 24:58-25:50 | 100 | expert_comparison, historical_context, data_evidence, firsthand_experience |
| 2 | `auth_1` | 7:24-8:10 | 100 | historical_context, professional_authority |
| 3 | `auth_2` | 52:53-53:34 | 92 | historical_context, data_evidence |
| 4 | `auth_3` | 93:58-94:37 | 90 | historical_context, data_evidence, domain_expertise |
| 5 | `auth_4` | 102:23-103:06 | 81 | expert_comparison, data_evidence, historical_context |

### Cross-Generator Overlap (Authority Top 5)

| Vs Generator | Overlap | Candidates affected |
|--------------|---------|---------------------|
| Hook (A) | 0% | none |
| Insight (B) | 20% | `auth_0` ↔ `insight_4` |
| Emotion (C) | 0% | none |

### New Discoveries (vs A+B+C Combined)

**New discoveries:** 2/5 (40%)
- `auth_1` @ 7:24 sig=historical_context/professional_authority
- `auth_3` @ 93:58 sig=historical_context/data_evidence/domain_expertise

### Combined Pool (A+B+C+D)

| Generator | Top K | In Pool | % |
|-----------|-------|---------|---|
| Hook (A) | 5 | 5 | 26% |
| Insight (B) | 5 | 5 | 26% |
| Emotion (C) | 5 | 4 | 21% |
| Authority (D) | 5 | 5 | 26% |
| **Total** | **20** | **19** | **100%** |

### Authority Signal Breakdown (All Candidates)

| Signal | Count |
|--------|-------|
| historical_context | 13 |
| data_evidence | 10 |
| domain_expertise | 8 |
| research_reference | 3 |
| source_attribution | 3 |
| expert_comparison | 2 |
| firsthand_experience | 2 |
| professional_authority | 1 |
| case_study | 1 |

### Project Verdict

| Criterion | Threshold | Result | |
|-----------|-----------|--------|---|
| Hook overlap | <30% | 0% | ✅ |
| Emotion overlap | <20% | 0% | ✅ |
| Insight overlap | <50% | 20% | ✅ |
| New discoveries | ≥50% | 40% | ❌ |
| Zero candidates? | — | ✅ | — |
| **Overall** | | | **❌ FAIL** |

---

## Fajar Sadboy (`FN283CT4rgg`)

### Output Summary

| Metric | Hook (A) | Insight (B) | Emotion (C) | Authority (D) |
|--------|---|---|---|---|
| Raw candidates | 46 | 20 | 8 | 4 |
| Capped | 15 | 15 | 8 | 4 |
| Top K | 5 | 5 | 5 | 4 |
| Time | 40ms | 47ms | 146ms | 108ms |

### Authority Generator (D) — Top 5

| # | ID | Time | Score | Authority Signals |
|---|----|------|-------|------------------|
| 1 | `auth_0` | 50:40-51:34 | 100 | historical_context |
| 2 | `auth_1` | 56:24-57:15 | 100 | historical_context |
| 3 | `auth_2` | 48:04-48:56 | 83 | historical_context |
| 4 | `auth_3` | 55:22-56:19 | 71 | historical_context |

### Cross-Generator Overlap (Authority Top 5)

| Vs Generator | Overlap | Candidates affected |
|--------------|---------|---------------------|
| Hook (A) | 25% | `auth_2` ↔ `hook_29` |
| Insight (B) | 0% | none |
| Emotion (C) | 0% | none |

### New Discoveries (vs A+B+C Combined)

**New discoveries:** 2/4 (50%)
- `auth_0` @ 50:40 sig=historical_context
- `auth_3` @ 55:22 sig=historical_context

### Combined Pool (A+B+C+D)

| Generator | Top K | In Pool | % |
|-----------|-------|---------|---|
| Hook (A) | 5 | 5 | 26% |
| Insight (B) | 5 | 5 | 26% |
| Emotion (C) | 5 | 5 | 26% |
| Authority (D) | 4 | 4 | 21% |
| **Total** | **19** | **19** | **100%** |

### Authority Signal Breakdown (All Candidates)

| Signal | Count |
|--------|-------|
| historical_context | 4 |

### Project Verdict

| Criterion | Threshold | Result | |
|-----------|-----------|--------|---|
| Hook overlap | <30% | 25% | ✅ |
| Emotion overlap | <20% | 0% | ✅ |
| Insight overlap | <50% | 0% | ✅ |
| New discoveries | ≥50% | 50% | ✅ |
| Zero candidates? | — | ✅ | — |
| **Overall** | | | **✅ PASS** |

---

## Global Summary

*Generated by authority-benchmark.ts at 2026-06-16T01:08:49.819Z*