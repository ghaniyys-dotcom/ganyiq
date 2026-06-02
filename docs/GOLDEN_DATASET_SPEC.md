# Golden Dataset Specification

> **Version:** 1.0
> **Date:** 2026-06-02
> **Status:** DRAFT (awaiting first transcripts)
> **Purpose:** Permanent, version-controlled benchmark for all prompt and model changes

---

## 1. Dataset Structure

```
eval/
├── golden-transcripts/          ← Immutable transcript files
│   ├── business-01-fellexandro.json
│   ├── business-02-selamatpagi.json
│   ├── motivation-01-marioteguh.json
│   ├── motivation-02-psikologi.json
│   ├── comedy-01-awalminggu.json
│   ├── comedy-02-ronysuara.json
│   ├── finance-01-nadine.json
│   ├── finance-02-marketbuzz.json
│   ├── storytelling-01-curhatbang.json
│   ├── storytelling-02-ceritakopi.json
│   ├── controversy-01-deddycorbuzier.json
│   ├── controversy-02-talkpod.json
│   └── ... (up to 20+ files)
│
├── expected-moments/            ← Human-verified correct moments
│   ├── business-01-fellexandro.expected.json
│   ├── business-02-selamatpagi.expected.json
│   └── ... (one per transcript, same stem)
│
├── scorecards/                  ← Completed human reviews
│   ├── 2026-06-02-founder-business-01.md
│   ├── 2026-06-03-clipper1-comedy-01.md
│   └── ...
│
├── baselines/                   ← Benchmark results per version
│   ├── v1.0-deepseek-v4-flash.json
│   ├── v1.1-deepseek-v4-flash-prompt-v2.json
│   └── ...
│
├── review-template.md           ← Reviewer form (this directory)
├── run-eval.ts                  ← Benchmark runner (to be built)
├── aggregate-scores.ts          ← Scorecard aggregator (to be built)
└── README.md                    ← This file
```

---

## 2. Transcript Storage Format

### 2.1 File Naming

```
{category}-{sequence}-{channel-slug}.json

Examples:
  business-01-fellexandro.json
  comedy-01-awalminggu.json
  controversy-01-deddycorbuzier.json

Rules:
  • Lowercase only
  • Hyphens for word separators
  • 2-digit sequence number (01-20)
  • Channel slug: short, recognizable name
  • .json extension
```

### 2.2 JSON Structure

Each transcript file contains the EXACT output of `fetchVideoData()` plus metadata:

```json
{
  "_metadata": {
    "datasetId": "business-01-fellexandro",
    "category": "business",
    "sequence": 1,
    "channelSlug": "fellexandro",
    "dateAdded": "2026-06-02",
    "sourceUrl": "https://www.youtube.com/watch?v=...",
    "durationMinutes": 98,
    "reviewers": ["founder"],
    "status": "draft"
  },
  "youtubeId": "abc123def45",
  "title": "Fellexandro Ruby - Cara Membangun Bisnis dari Nol",
  "channelName": "Fellexandro Ruby",
  "durationSeconds": 5880,
  "segments": [
    {
      "start": 120.5,
      "duration": 4.2,
      "text": "Jadi gini ceritanya, gue mulai bisnis dari nol banget..."
    }
  ]
}
```

### 2.3 `_metadata` Fields

| Field | Type | Description |
|---|---|---|
| `datasetId` | string | Unique identifier: `{category}-{seq}-{channel}` |
| `category` | string | One of: `business`, `motivation`, `comedy`, `finance`, `storytelling`, `controversy` |
| `sequence` | integer | 2-digit sequence number per category |
| `channelSlug` | string | Short channel identifier |
| `dateAdded` | string | ISO date when transcript was added |
| `sourceUrl` | string | Original YouTube URL |
| `durationMinutes` | integer | Video duration in minutes |
| `reviewers` | string[] | List of reviewer usernames who validated this |
| `status` | string | `draft` → `reviewed` → `locked` |

### 2.4 Transcript Acquisition

Transcripts are sourced from the production pipeline:

```
fetchVideoData(youtubeId) → { metadata, transcript, videoDbId }
```

The `transcript` array is stored directly as `segments`. No modification.
The `metadata` fields are stored as top-level keys.

---

## 3. Expected Moments Format

### 3.1 File Naming

```
{transcript-stem}.expected.json

Examples:
  business-01-fellexandro.expected.json
  comedy-01-awalminggu.expected.json
```

### 3.2 JSON Structure

```json
{
  "_metadata": {
    "datasetId": "business-01-fellexandro",
    "version": 1,
    "createdAt": "2026-06-02",
    "reviewers": ["founder", "clipper-rizky", "clipper-adi"],
    "method": "majority-vote-3-reviewers",
    "notes": "All 3 reviewers independently identified top 10 moments. Overlap: 7/10."
  },
  "expectedMoments": [
    {
      "startTime": 2042.5,
      "endTime": 2098.0,
      "worthClippingScore": 88,
      "tier": "elite",
      "confidence": "high",
      "dnaTags": ["controversy", "authority", "money"],
      "reasoning": "Verified: guest drops controversial tax claim at 34:02. Confirmed by 3 reviewers.",
      "reviewerConsensus": 3,
      "reviewerAvgScore": 87.3
    }
  ],
  "expectedCount": {
    "elite": 3,
    "secondary": 7,
    "total": 10
  }
}
```

### 3.3 Expected Moment Fields

| Field | Type | Description |
|---|---|---|
| `startTime` | number | Start time in seconds (human-verified) |
| `endTime` | number | End time in seconds (human-verified) |
| `worthClippingScore` | integer | Averaged human score (0-100) |
| `tier` | string | `elite` or `secondary` |
| `confidence` | string | `high`, `medium`, or `low` |
| `dnaTags` | string[] | Exactly 3 DNA tags |
| `reasoning` | string | Reference reasoning (for comparison) |
| `reviewerConsensus` | integer | Number of reviewers who identified this moment |
| `reviewerAvgScore` | number | Average score across reviewers |

### 3.4 Expected Count Fields

| Field | Description |
|---|---|
| `elite` | Number of elite moments identified by reviewers |
| `secondary` | Number of secondary moments identified by reviewers |
| `total` | Total moments identified |

---

## 4. Reviewer Guidelines

### 4.1 Reviewer Independence

1. Reviewers watch the FULL video before reviewing
2. Reviewers identify their own top moments WITHOUT seeing AI output
3. After independent identification, reviewers compare with AI output
4. Scoring is done blind to AI scores

### 4.2 Review Process Per Transcript

```
1. Watch full video (1x speed, or 1.5x for long podcasts)
2. Note timestamps of potential clips during watch
3. After watching, list top 10 moments with:
   - Timestamp (start-end in seconds)
   - Score (0-100, your judgment)
   - Top 3 DNA tags
   - 1-sentence reasoning
4. Submit to coordinator (can be done via spreadsheet or form)
5. Coordinator aggregates all reviewer submissions
6. Moments identified by ≥2 reviewers → expected moment
7. Average scores → ground truth score
8. Majority DNA tags → ground truth tags
9. Coordinator writes reference reasoning
10. File is locked in version control
```

### 4.3 Time Commitment

| Video Duration | Review Time (watch) | Review Time (annotate) | Total |
|---|---|---|---|
| 30 min | 20-30 min | 10-15 min | 30-45 min |
| 60 min | 40-60 min | 10-15 min | 50-75 min |
| 90 min | 60-90 min | 10-15 min | 70-105 min |
| 120 min | 80-120 min | 10-15 min | 90-135 min |

### 4.4 Reviewer Compensation (Post-MVP)

Reviewers should be compensated for their time. Suggested model:
- IDR 50,000 per analysis review (30 min video)
- IDR 100,000 per analysis review (60+ min video)
- Bonus: IDR 500,000 for completing 10 reviews

---

## 5. Versioning Rules

### 5.1 Transcript Versioning

Transcripts are **immutable once locked**. No edits after `status: locked`.

| Status | Meaning | Can Edit? |
|---|---|---|
| `draft` | Initial capture, may have issues | ✅ Yes |
| `reviewed` | Validated by ≥1 reviewer | ⚠️ Metadata only |
| `locked` | Finalized, part of active benchmark | ❌ No |

If a locked transcript needs correction (e.g., wrong segments):
1. Create a new file: `{stem}-v2.json`
2. Update `_metadata.status = "draft"`
3. Reference the old file in `_metadata.supersedes`

### 5.2 Expected Moments Versioning

Expected moments files follow the same immutability rules. When expected moments are updated:
1. Increment `_metadata.version`
2. Old versions remain in version control (git history)
3. Current version is always the highest version number

### 5.3 Model/Prompt Version Tracking

Every benchmark run records:

```json
{
  "benchmarkVersion": "v1.0",
  "date": "2026-06-02",
  "model": "deepseek-v4-flash",
  "promptVersion": "mvp-v1",
  "promptHash": "sha256:abc123...",
  "commitHash": "git:7a3b5c1",
  "baseline": {}
}
```

### 5.4 Git Workflow

```
1. git checkout -b dataset/v1.0-initial
2. Add 20 transcript files
3. Add 20 expected-moment files (when reviewed)
4. git commit -m "dataset: add 20 golden transcripts v1.0"
5. git checkout main
6. git merge dataset/v1.0-initial --no-ff
7. Tag: git tag -a dataset-v1.0 -m "Golden Dataset v1.0"
```

Dataset branches are **never rebased**. Only merge commits.

---

## 6. Dataset Growth Plan

| Phase | Transcripts | Expected Moments | Locked | Timeline |
|---|---|---|---|---|
| v1.0 | 20 | 20 | ✅ | Week 1-2 |
| v1.1 | 30 | 30 | ✅ | Week 3-4 |
| v2.0 | 50 | 50 | ✅ | Month 2 |
| v3.0 | 100 | 100 | ✅ | Month 3 |

Each version expands coverage while maintaining backward compatibility. v1.0 expected moments are never changed, only supplemented.

---

## 7. Quality Gate

A dataset version is considered **ACTIVE** only when:

1. ✅ All transcripts are `status: locked`
2. ✅ All expected moments files exist (one per transcript)
3. ✅ Each expected moment identified by ≥2 reviewers
4. ✅ No placeholder or "TBD" values in any file
5. ✅ All `_metadata.reviewers` fields populated with real usernames
6. ✅ At least 3 categories represented with ≥3 transcripts each

**The dataset is NOT ready for benchmarking until all gates pass.**
