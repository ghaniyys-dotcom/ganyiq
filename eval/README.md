# ganyIQ — Evaluation Suite

> **Purpose:** Benchmark, validate, and track ganyIQ's moment discovery quality
> **Location:** `eval/` — not deployed, not included in production builds

---

## Folder Structure

```
eval/
├── README.md                          ← This file
├── review-template.md                 ← Human reviewer scorecard form
│
├── golden-transcripts/                ← Immutable podcast transcripts
│   ├── business-01-fellexandro.json
│   ├── comedy-01-awalminggu.json
│   └── ... (one per analysis)
│
├── expected-moments/                  ← Human-verified correct moments
│   ├── business-01-fellexandro.expected.json
│   └── ... (one per transcript)
│
├── scorecards/                        ← Completed human reviews
│   ├── yyyy-mm-dd-founder-bus-01.md
│   └── ... (one per review)
│
├── baselines/                         ← Benchmark results
│   ├── v1.0-deepseek-v4-flash.json
│   └── ... (one per model/prompt version)
│
├── url-tracker.csv                    ← 100-analysis collection tracker
│
├── batch-submit.sh                    ← Submit URLs to API in batches
│
├── run-eval.ts                        ← Benchmark runner (to be built)
└── aggregate-scores.ts                ← Scorecard aggregator (to be built)
```

---

## Naming Conventions

### Transcript Files

```
{category}-{sequence}-{channelSlug}.json

Category: business | motivation | comedy | finance | storytelling | controversy
Sequence: 2-digit number (01, 02, ...)
ChannelSlug: short recognizable name (lowercase, hyphens)

Example: business-01-fellexandro.json
         controversy-02-deddycorbuzier.json
```

### Expected Moment Files

```
{transcript-stem}.expected.json

Example: business-01-fellexandro.expected.json
         controversy-02-deddycorbuzier.expected.json
```

### Scorecard Files

```
{date}-{reviewer}-{category}-{seq}.md

Date:     YYYY-MM-DD
Reviewer: reviewer name/username (lowercase, no spaces)
Category: abbreviated (bus, mot, com, fin, stl, con)
Seq:      2-digit number

Example: 2026-06-02-founder-bus-01.md
         2026-06-03-clipper-rizky-com-01.md
```

### Baseline Files

```
v{version}-{model}.json

Version: Semantic version for this benchmark run
Model:   Model name with punctuation removed

Example: v1.0-deepseek-v4-flash.json
         v1.1-deepseek-v4-flash-prompt-v2.json
```

---

## How Benchmarks Work

### Overview

A benchmark compares the pipeline's output against the Golden Dataset's expected moments. It measures how well the AI finds the same moments that human reviewers identified.

### Benchmark Flow

```
1. LOAD golden transcripts (eval/golden-transcripts/*.json)
2. For each transcript:
   a. Reconstruct metadata + transcript from the file
   b. Call the SAME pipeline used in production:
      - buildAnalysisPrompt(metadata, transcript)
      - callLLM(system, user)         [uses live API]
      - rankMoments(rawMoments, transcript)
   c. Load expected moments from eval/expected-moments/*.expected.json
   d. Compare pipeline output vs expected:
      - Which expected moments were found? (Recall)
      - Which returned moments match expected? (Precision)
      - How close are the scores? (MAE)
      - How accurate are DNA tags? (Tag Accuracy)
      - How accurate are timestamps? (Timestamp Error)
3. Aggregate across all transcripts
4. Write baseline to eval/baselines/
5. Generate report
```

### Key Metrics

| Metric | Formula | Meaning |
|---|---|---|
| **Recall** | `matchedExpected / totalExpected` | What fraction of known-good moments did the AI find? |
| **Precision** | `matchedExpected / totalReturned` | What fraction of AI's suggestions are actually good? |
| **Score MAE** | `avg(|aiScore - humanScore|)` | How close are AI scores to human scores? |
| **Tag Accuracy** | `avg(correctTags / 3)` | How well does the AI assign DNA tags? |
| **Timestamp Error** | `avg(|aiStartTime - humanStartTime|)` | How accurate are the timestamps? (seconds) |

### Example Benchmark Run

```
$ npx tsx eval/run-eval.ts --model=deepseek-v4-flash --prompt=mvp-v1

Loading 12 golden transcripts...
  business-01 ✅  5/7 expected found
  business-02 ✅  4/6 expected found
  comedy-01   ✅  6/8 expected found
  ...

══════════════════════════════════════════════════
Benchmark v1.0 — deepseek-v4-flash / mvp-v1
══════════════════════════════════════════════════

  Recall:         71.4%  (target: ≥ 70%)
  Precision:      62.1%  (target: ≥ 60%)
  Score MAE:      7.8    (target: ≤ 8.0)
  Tag Accuracy:   63.5%  (target: ≥ 60%)
  Timestamp Error: 4.2s  (target: ≤ 5.0s)

  Total transcripts:  12
  Expected moments:   84
  Matched:            60
  Processing time:    38.2s avg

  VERDICT: ✅ ALL METRICS PASS
══════════════════════════════════════════════════
  Baseline written: eval/baselines/v1.0-deepseek-v4-flash.json
```

### Matching Algorithm

A pipeline-returned moment is considered a "match" with an expected moment if:

```
|ai.startTime - expected.startTime| < 15 seconds
  AND
|ai.endTime - expected.endTime| < 15 seconds
```

This 15-second tolerance accounts for the fact that different clippers may identify slightly different clip boundaries for the same moment.

---

## When to Run Benchmarks

| Trigger | Action |
|---|---|
| After prompt change | Full benchmark on all golden transcripts |
| After model change | Full benchmark + compare vs previous baseline |
| After ranking change | Full benchmark |
| Every 2 weeks (MVP) | Full benchmark for tracking |
| Before public launch | Full benchmark + verify all metrics pass |

---

## Creating a New Golden Transcript

See `docs/GOLDEN_DATASET_SPEC.md` for the complete specification.

Quick steps:

```bash
# 1. Find a YouTube URL
# 2. Submit to production pipeline
curl -s -X POST http://localhost:3000/api/analyze \
  -H "Content-Type: application/json" \
  -d '{"url":"https://www.youtube.com/watch?v=..."}'

# 3. Extract transcript from response (or from DB via analysisId)
# 4. Save as eval/golden-transcripts/{category}-{seq}-{channel}.json
# 5. Get 3 human reviewers to identify expected moments
# 6. Save as eval/expected-moments/{same-stem}.expected.json
# 7. Update eval/url-tracker.csv
```

---

## Tools

| Script | Purpose | Status |
|---|---|---|
| `batch-submit.sh` | Submit multiple URLs to the API | 🟡 Needs creation |
| `run-eval.ts` | Run benchmark against Golden Dataset | 🔴 Not yet built |
| `aggregate-scores.ts` | Aggregate scorecards into metrics | 🔴 Not yet built |

---

## Dependencies

The eval suite requires:
- Node.js 20+ with `tsx` (available in devDependencies)
- Access to a running ganyIQ API instance (local or deployed)
- A valid `OPENCODE_GO_API_KEY` in the environment
- For benchmarks: golden transcripts + expected moments populated
