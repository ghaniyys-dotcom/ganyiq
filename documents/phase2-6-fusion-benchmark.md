# Phase 2.6 — Multi-Generator Fusion Benchmark
**Date:** 2026-06-16
**Pipeline:** Hook + Insight + Emotion + Authority → Dedup → Diversity → Judge V2 → Top N

---

## Raditya Dika (`lqeDF5JwYvM`)

### Pipeline Flow

| Stage | Count |
|-------|-------|
| Generators → Top K | 15 candidates (hook=5, insight=5, emotion=5, authority=0) |
| → Dedup + Diversity | 15 → 14 |
| → Judge V2 | 14 ranked |
| → Final Top N | 10 output |

**Dedup removals:**
- ✗ `hook_1`: Pairwise overlap 0.653 exceeds maxPairOverlap 0.65 with insight_2

### Final Output (Top 10)

| Rank | ID | Generator | Time | Internal | Curved | Signals |
|------|----|-----------|------|----------|--------|---------|
| 1 | `emotion_0` | emotion | 52:20-53:19 | 100 | 84 | gratitude, hope, connection |
| 2 | `hook_11` | hook | 26:56-27:45 | 100 | 81 | controversial, question_driven, emotional_opening |
| 3 | `insight_0` | insight | 37:40-38:27 | 100 | 78 | counterintuitive |
| 4 | `insight_1` | insight | 31:00-31:49 | 96 | 76 | counterintuitive |
| 5 | `insight_2` | insight | 1:25-2:15 | 86 | 70 | lesson |
| 6 | `insight_3` | insight | 6:48-7:38 | 86 | 70 | lesson |
| 7 | `emotion_1` | emotion | 31:43-32:33 | 78 | 70 | vulnerability, fear |
| 8 | `hook_2` | hook | 2:10-2:51 | 75 | 67 | emotional_opening, question_driven |
| 9 | `insight_4` | insight | 43:51-44:41 | 79 | 67 | framework |
| 10 | `hook_10` | hook | 22:18-23:02 | 55 | 55 | emotional_opening, surprising_claim |

### Attribution Report

| Rank | Candidate | Generator | Time | Curved | Survival Reason |
|------|-----------|-----------|------|--------|-----------------|
| 1 | `emotion_0` | emotion | 52:20-53:19 | 84 | Ranked #1/14 by Judge V2 (curved=84). Top scorer. High-quality candidate. Emotion generator — emotional resonance. |
| 2 | `hook_11` | hook | 26:56-27:45 | 81 | Ranked #2/14 by Judge V2 (curved=81). High-quality candidate. Hook generator — strong opening hook. |
| 3 | `insight_0` | insight | 37:40-38:27 | 78 | Ranked #3/14 by Judge V2 (curved=78). High-quality candidate. Insight generator — explanatory depth. |
| 4 | `insight_1` | insight | 31:00-31:49 | 76 | Ranked #4/14 by Judge V2 (curved=76). Insight generator — explanatory depth. |
| 5 | `insight_2` | insight | 1:25-2:15 | 70 | Ranked #5/14 by Judge V2 (curved=70). Insight generator — explanatory depth. |
| 6 | `insight_3` | insight | 6:48-7:38 | 70 | Ranked #6/14 by Judge V2 (curved=70). Insight generator — explanatory depth. |
| 7 | `emotion_1` | emotion | 31:43-32:33 | 70 | Ranked #7/14 by Judge V2 (curved=70). Emotion generator — emotional resonance. |
| 8 | `hook_2` | hook | 2:10-2:51 | 67 | Ranked #8/14 by Judge V2 (curved=67). Hook generator — strong opening hook. |
| 9 | `insight_4` | insight | 43:51-44:41 | 67 | Ranked #9/14 by Judge V2 (curved=67). Insight generator — explanatory depth. |
| 10 | `hook_10` | hook | 22:18-23:02 | 55 | Ranked #10/14 by Judge V2 (curved=55). Hook generator — strong opening hook. |

### Generator Contribution

| Generator | Final # | % of Output |
|-----------|---------|-------------|
| Hook (A) | 3 | 30% |
| Insight (B) | 5 | 50% |
| Emotion (C) | 2 | 20% |
| Authority (D) | 0 | 0% |

### Diversity Metrics

| Metric | Value |
|--------|-------|
| Strategies in top 10 | 3/4 |
| Max pairwise overlap | 0.312 (limit: 0.65) |
| Total dedup removed | 1 |

### V1 Comparison

| Comparison | Value |
|------------|-------|
| V1 moments available | 15 |
| Fusion overlap with V1 top 10 | 1/10 (10%) |
| Fusion clip NOT in V1 | 9/10 new |
| V1 mean score | 88.1 |
| Fusion mean curved score | 71.8 |

### Project Verdict

| Criterion | Result |
|-----------|--------|
| Produced output | ✅ (10 clips) |
| Multi-strategy | ✅ (3/4 strategies) |
| Max overlap <0.5 | ✅ (0.312) |
| **Overall** | **✅ PASS** |

---

## Tom Lembong (`lpQrUTWXHZU`)

### Pipeline Flow

| Stage | Count |
|-------|-------|
| Generators → Top K | 20 candidates (hook=5, insight=5, emotion=5, authority=0, auth=5) |
| → Dedup + Diversity | 20 → 20 |
| → Judge V2 | 20 ranked |
| → Final Top N | 10 output |

### Final Output (Top 10)

| Rank | ID | Generator | Time | Internal | Curved | Signals |
|------|----|-----------|------|----------|--------|---------|
| 1 | `emotion_0` | emotion | 13:56-14:14 | 100 | 84 | connection, sadness, vulnerability |
| 2 | `hook_7` | hook | 13:45-14:06 | 100 | 81 | emotional_opening, question_driven, surprising_claim |
| 3 | `hook_35` | hook | 42:47-43:21 | 100 | 81 | controversial, emotional_opening, question_driven |
| 4 | `hook_68` | hook | 89:38-89:56 | 100 | 81 | surprising_claim, question_driven |
| 5 | `auth_1` | auth | 7:24-8:10 | 100 | 78 | historical_context, professional_authority |
| 6 | `auth_0` | auth | 24:58-25:50 | 100 | 78 | expert_comparison, historical_context, data_evidence |
| 7 | `insight_0` | insight | 106:29-107:18 | 100 | 78 | counterintuitive, problem, principle |
| 8 | `auth_2` | auth | 52:53-53:34 | 92 | 74 | historical_context, data_evidence |
| 9 | `emotion_1` | emotion | 74:31-75:02 | 83 | 73 | connection |
| 10 | `auth_3` | auth | 93:58-94:37 | 90 | 73 | historical_context, data_evidence, domain_expertise |

### Attribution Report

| Rank | Candidate | Generator | Time | Curved | Survival Reason |
|------|-----------|-----------|------|--------|-----------------|
| 1 | `emotion_0` | emotion | 13:56-14:14 | 84 | Ranked #1/20 by Judge V2 (curved=84). Top scorer. High-quality candidate. Emotion generator — emotional resonance. |
| 2 | `hook_7` | hook | 13:45-14:06 | 81 | Ranked #2/20 by Judge V2 (curved=81). High-quality candidate. Hook generator — strong opening hook. |
| 3 | `hook_35` | hook | 42:47-43:21 | 81 | Ranked #3/20 by Judge V2 (curved=81). High-quality candidate. Hook generator — strong opening hook. |
| 4 | `hook_68` | hook | 89:38-89:56 | 81 | Ranked #4/20 by Judge V2 (curved=81). Hook generator — strong opening hook. |
| 5 | `auth_1` | auth | 7:24-8:10 | 78 | Ranked #5/20 by Judge V2 (curved=78). Authority generator — credibility/evidence. |
| 6 | `auth_0` | auth | 24:58-25:50 | 78 | Ranked #6/20 by Judge V2 (curved=78). Authority generator — credibility/evidence. |
| 7 | `insight_0` | insight | 106:29-107:18 | 78 | Ranked #7/20 by Judge V2 (curved=78). Insight generator — explanatory depth. |
| 8 | `auth_2` | auth | 52:53-53:34 | 74 | Ranked #8/20 by Judge V2 (curved=74). Authority generator — credibility/evidence. |
| 9 | `emotion_1` | emotion | 74:31-75:02 | 73 | Ranked #9/20 by Judge V2 (curved=73). Emotion generator — emotional resonance. |
| 10 | `auth_3` | auth | 93:58-94:37 | 73 | Ranked #10/20 by Judge V2 (curved=73). Authority generator — credibility/evidence. |

### Generator Contribution

| Generator | Final # | % of Output |
|-----------|---------|-------------|
| Hook (A) | 3 | 30% |
| Insight (B) | 1 | 10% |
| Emotion (C) | 2 | 20% |
| Authority (D) | 4 | 40% |

### Diversity Metrics

| Metric | Value |
|--------|-------|
| Strategies in top 10 | 4/4 |
| Max pairwise overlap | 0.331 (limit: 0.65) |
| Total dedup removed | 0 |

### V1 Comparison
⚠ No V1 data available for this project.

### Project Verdict

| Criterion | Result |
|-----------|--------|
| Produced output | ✅ (10 clips) |
| Multi-strategy | ✅ (4/4 strategies) |
| Max overlap <0.5 | ✅ (0.331) |
| **Overall** | **✅ PASS** |

---

## Fajar Sadboy (`FN283CT4rgg`)

### Pipeline Flow

| Stage | Count |
|-------|-------|
| Generators → Top K | 19 candidates (hook=5, insight=5, emotion=5, authority=0, auth=4) |
| → Dedup + Diversity | 19 → 19 |
| → Judge V2 | 19 ranked |
| → Final Top N | 10 output |

### Final Output (Top 10)

| Rank | ID | Generator | Time | Internal | Curved | Signals |
|------|----|-----------|------|----------|--------|---------|
| 1 | `emotion_0` | emotion | 49:38-50:30 | 100 | 84 | gratitude, transformation |
| 2 | `hook_23` | hook | 35:32-36:10 | 100 | 81 | surprising_claim, emotional_opening, question_driven |
| 3 | `insight_0` | insight | 24:55-25:52 | 100 | 78 | lesson, explanation |
| 4 | `auth_0` | auth | 50:40-51:34 | 100 | 78 | historical_context |
| 5 | `auth_1` | auth | 56:24-57:15 | 100 | 78 | historical_context |
| 6 | `auth_2` | auth | 48:04-48:56 | 83 | 69 | historical_context |
| 7 | `hook_0` | hook | 2:19-3:01 | 67 | 62 | controversial, question_driven |
| 8 | `hook_29` | hook | 47:48-48:19 | 67 | 62 | emotional_opening, controversial, question_driven |
| 9 | `auth_3` | auth | 55:22-56:19 | 71 | 62 | historical_context |
| 10 | `hook_38` | hook | 65:06-66:06 | 67 | 62 | surprising_claim, question_driven |

### Attribution Report

| Rank | Candidate | Generator | Time | Curved | Survival Reason |
|------|-----------|-----------|------|--------|-----------------|
| 1 | `emotion_0` | emotion | 49:38-50:30 | 84 | Ranked #1/19 by Judge V2 (curved=84). Top scorer. High-quality candidate. Emotion generator — emotional resonance. |
| 2 | `hook_23` | hook | 35:32-36:10 | 81 | Ranked #2/19 by Judge V2 (curved=81). High-quality candidate. Hook generator — strong opening hook. |
| 3 | `insight_0` | insight | 24:55-25:52 | 78 | Ranked #3/19 by Judge V2 (curved=78). High-quality candidate. Insight generator — explanatory depth. |
| 4 | `auth_0` | auth | 50:40-51:34 | 78 | Ranked #4/19 by Judge V2 (curved=78). Authority generator — credibility/evidence. |
| 5 | `auth_1` | auth | 56:24-57:15 | 78 | Ranked #5/19 by Judge V2 (curved=78). Authority generator — credibility/evidence. |
| 6 | `auth_2` | auth | 48:04-48:56 | 69 | Ranked #6/19 by Judge V2 (curved=69). Authority generator — credibility/evidence. |
| 7 | `hook_0` | hook | 2:19-3:01 | 62 | Ranked #7/19 by Judge V2 (curved=62). Hook generator — strong opening hook. |
| 8 | `hook_29` | hook | 47:48-48:19 | 62 | Ranked #8/19 by Judge V2 (curved=62). Hook generator — strong opening hook. |
| 9 | `auth_3` | auth | 55:22-56:19 | 62 | Ranked #9/19 by Judge V2 (curved=62). Authority generator — credibility/evidence. |
| 10 | `hook_38` | hook | 65:06-66:06 | 62 | Ranked #10/19 by Judge V2 (curved=62). Hook generator — strong opening hook. |

### Generator Contribution

| Generator | Final # | % of Output |
|-----------|---------|-------------|
| Hook (A) | 4 | 40% |
| Insight (B) | 1 | 10% |
| Emotion (C) | 1 | 10% |
| Authority (D) | 4 | 40% |

### Diversity Metrics

| Metric | Value |
|--------|-------|
| Strategies in top 10 | 4/4 |
| Max pairwise overlap | 0.310 (limit: 0.65) |
| Total dedup removed | 0 |

### V1 Comparison

| Comparison | Value |
|------------|-------|
| V1 moments available | 15 |
| Fusion overlap with V1 top 10 | 0/10 (0%) |
| Fusion clip NOT in V1 | 10/10 new |
| V1 mean score | 72.7 |
| Fusion mean curved score | 71.6 |

### Project Verdict

| Criterion | Result |
|-----------|--------|
| Produced output | ✅ (10 clips) |
| Multi-strategy | ✅ (4/4 strategies) |
| Max overlap <0.5 | ✅ (0.310) |
| **Overall** | **✅ PASS** |

---

## Global Summary

| Project | Raw Pool | After Dedup | After Judge | Final N | Strategies |
|---------|----------|-------------|-------------|---------|------------|
| Raditya Dika | 15 | 14 | 14 | 10 | 3/4 |
| Tom Lembong | 20 | 20 | 20 | 10 | 4/4 |
| Fajar Sadboy | 19 | 19 | 19 | 10 | 4/4 |

**Success Criterion:** Fusion must outperform either V1 baseline or best individual generator.

*Generated by fusion-benchmark.ts*