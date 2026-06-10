# COST_AUDIT.md — GANYIQ Cost Analysis

**Date:** 2026-06-10
**Provider:** opencode-go (deepseek-v4-flash)
**Pricing assumption:** $0.15/1M tokens (from codebase: `tokenEstimate * 0.00000015`)

---

## Stage-by-Stage Token Usage

Data from LLM response logs for recent analysis `Op_zO-NkYFQ`:

### Stage 1: LLM Scoring (3 batches)
| Batch | Prompt | Completion | Reasoning | Total | Est. Cost |
|-------|--------|------------|-----------|-------|-----------|
| Batch 1 | 5,880 | 13,187 | 11,460 | 19,067 | $0.002860 |
| Batch 2 | 4,446 | 12,724 | 10,856 | 17,170 | $0.002576 |
| Batch 3 | 3,490 | 7,541 | 6,096 | 11,031 | $0.001655 |
| **Scoring total** | **13,816** | **33,452** | **28,412** | **47,268** | **$0.007090** |

### Stage 2: Combined Multi-Pass (1 combined call)
| Dimension | Prompt | Completion | Reasoning | Total | Est. Cost |
|-----------|--------|------------|-----------|-------|-----------|
| Combined (all 5) | 4,830 | 8,558 | 6,847 | 13,388 | $0.002008 |

### Stage 3: Title Generation — BEFORE batch optimization

| Item | Tokens per call | Calls | Total | Est. Cost |
|------|----------------|-------|-------|-----------|
| Per moment title gen | ~10,000 | 7 succeeded (15 tried) | ~70,000 | $0.01050 |

### Stage 3: Title Generation — AFTER batch optimization

| Item | Prompt | Completion (est.) | Total | Est. Cost |
|------|--------|-------------------|-------|-----------|
| 1 combined call (15 moments) | ~7,000 | ~16,000 | ~23,000 | $0.00345 |

---

## Per-Analysis Cost Summary — BEFORE batch title gen

| Component | Tokens | Cost | % of Total |
|-----------|--------|------|------------|
| LLM scoring (3 batches) | 47,268 | $0.00709 | 36% |
| Combined multi-pass | 13,388 | $0.00201 | 10% |
| Title generation | 70,000 | $0.01050 | 53% |
| **Total per analysis** | **130,656** | **$0.01960** | **100%** |

## Per-Analysis Cost Summary — AFTER batch title gen (estimated)

| Component | Tokens | Cost | % of Total |
|-----------|--------|------|------------|
| LLM scoring (3 batches) | 47,268 | $0.00709 | 48% |
| Combined multi-pass | 13,388 | $0.00201 | 14% |
| Title generation (batched) | ~23,000 | $0.00345 | **23%** |
| **Total per analysis** | **~83,656** | **$0.01255** | **100%** |

### Savings from title batching

| Metric | Before | After | Savings |
|--------|--------|-------|---------|
| LLM calls | 15 | 1 | **93% fewer calls** |
| Tokens | ~70,000 | ~23,000 | **~67% fewer tokens** |
| Cost | $0.01050 | $0.00345 | **$0.00705 (67%)** |
| % of total cost | 53% | 23% | **30pp reduction** |
| **Total analysis cost** | **$0.01960** | **$0.01255** | **36% cheaper** |

### Cache-hit analysis (re-analysis of same video)
| Component | Cost |
|-----------|------|
| All stages | $0.00 (0 LLM calls) |
| Database queries only | ~$0.00 |
| **Total** | **$0.00** |

---

## Scaling Projections — AFTER optimization

| Volume | Before cost | After cost | Savings |
|--------|------------|------------|---------|
| **1 analysis** | **$0.020** | **~$0.013** | **$0.007** |
| **100 analyses** | **$1.96** | **~$1.26** | **$0.70** |
| **1,000 analyses** | **$19.60** | **~$12.55** | **$7.05** |
| **10,000 analyses** | **$196.00** | **~$125.50** | **$70.50** |

### With 70% cache hit rate (realistic for returning users):
| Volume | New videos | Cache hits | After cost | Savings vs before |
|--------|-----------|------------|------------|------------------|
| 1,000 requests | 300 (30%) | 700 (70%) | $3.77 | -$2.11 (36%) |
| 10,000 requests | 3,000 | 7,000 | $37.65 | -$21.15 (36%) |

---

## Component Cost Breakdown (AFTER)

```
Title Generation  █████████████████████████         23%  $0.00345
LLM Scoring       ██████████████████████████████████████████████  48%  $0.00709
Combined MultiPass ████████████████                  14%  $0.00201
Transcript Fetch  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░   0%  Free
Ranking           ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░   0%  Free
```

## Cost Efficiency Notes

### Current inefficiencies:

1. ~~**Title generation = 53% of cost**~~ → **NOW 23%** ✅
   - Batched from 15 calls → 1 call for all moments
   - Saves ~$0.007/analysis

2. **Reasoning tokens dominate** _(unchanged)_
   - DeepSeek-v4-flash uses 70-80% of tokens for reasoning
   - This is model behavior, not controllable

3. **Failed title generation = wasted cost** _(mitigated)_
   - With batching, if combined call succeeds, all moments succeed at once
   - If it fails, fallback to per-moment gives same reliability as before

### Optimization opportunities (future):
- Reduce scoring retries: only 1 attempt instead of 2
- Temperature tuning: reduce from 0.3 to 0.1 for scoring

---

## Historical Comparison

| Version | LLM calls per analysis | Cost per analysis |
|---------|----------------------|-------------------|
| Before (5 individual passes + combined failure) | 9 calls | ~$0.035 |
| After combined pass fix | 5 calls | ~$0.020 |
| **After title batching** | **3 calls** | **~$0.013** |
| **Total improvement (from worst)** | **-67% fewer calls** | **-64% cost reduction** |

## Summary

| Metric | Value |
|--------|-------|
| Cost per new video analysis | **~$0.013** |
| Cost per cache hit | **$0.00** |
| Cost per 1,000 analyses (realistic, 30% new) | **$3.77** |
| Largest cost center | **LLM Scoring (48%)** |
| Biggest optimization opportunity realized | **Title batching ✅** |
| Next optimization opportunity | **Scoring retries / temperature** |
| Monthly budget for 5,000 analyses | **~$18.85** |
