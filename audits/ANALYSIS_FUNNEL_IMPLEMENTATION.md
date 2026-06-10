# ANALYSIS_FUNNEL_IMPLEMENTATION.md

## Goal

Show users how GANYIQ progressively filters content from raw transcript → final recommendations. Builds trust by making the pipeline visible.

## Funnel Visualization

```
ANALYSIS FUNNEL

11,249         846            118            42             15             6
Transcript  →  Transcript  →  Candidate   →  High Signal →  Elite      →  Final
Words          Segments       Moments        Moments        Candidates    Recommendations

Raw speech     Broken down    Potential      Scored above   Top-tier      Highest
captured       by sentence    clip           quality        clips         confidence
from audio     boundary       opportunities  threshold      (score ≥85)   picks
                                             (≥70)
```

## Data Sources

| Stage | Pipeline Metric | DB Column | Real? |
|---|---|---|---|
| **Transcript Words** | `transcriptWordCount` | `analysis_metrics.transcript_words` | ✅ Sum of word counts across all segments |
| **Transcript Segments** | `videoData.transcript.length` | `analysis_metrics.transcript_segments` | ✅ Actual segment count from Deepgram/YouTube |
| **Candidate Moments** | `rawMoments.length` | `analysis_metrics.candidates_extracted` | ✅ Real LLM-scored output count |
| **High Signal Moments** | `rawMoments.filter(s >= 70)` | `analysis_metrics.high_signal_candidates` | ✅ NEW — pipeline now computes this |
| **Elite Candidates** | `rankedMoments.filter(tier=elite)` | `analysis_metrics.elite_clips` | ✅ Existing |
| **Final Recommendations** | `rankedMoments.length` | `analysis_metrics.candidates_ranked` | ✅ Existing |

## Backend Changes

### 1. New DB columns

```sql
ALTER TABLE analysis_metrics ADD COLUMN high_signal_candidates integer;
ALTER TABLE analysis_metrics ADD COLUMN transcript_words integer;
```

### 2. Pipeline metrics update (`lib/analyze-pipeline.ts`)

```typescript
const highSignalCount = rawMoments.filter(m => m.worthClippingScore >= 70).length;
const transcriptWordCount = videoData.transcript.reduce(
  (sum, seg) => sum + (seg.text?.split(/\s+/).length || 0), 0
);
```

Stored in the existing `INSERT INTO analysis_metrics` query.

### 3. API update (`GET /api/analyze/[id]/status`)

On completed status, fetches `analysis_metrics` and returns:

```json
{
  "funnel": {
    "transcriptWords": 11249,
    "transcriptSegments": 846,
    "candidateMoments": 118,
    "highSignalMoments": 42,
    "eliteMoments": 10,
    "finalRecommendations": 6
  }
}
```

## Frontend Design

### Desktop

Horizontal flow with arrow SVG connectors between cards:

```
[11,249      ]  ↓  [846         ]  ↓  [118         ]  ↓  [42          ]  ↓  [15          ]  ↓  [6           ]
[Transcript  ]     [Transcript  ]     [Candidate   ]     [High Signal ]     [Elite       ]     [Final       ]
[Words       ]     [Segments    ]     [Moments     ]     [Moments     ]     [Candidates  ]     [Recommend.. ]
```

### Mobile (≤600px)

Vertical flow, rows layout with arrow rotated 90°:

```
[11,249  Transcript Words      ]
             ↓
[846     Transcript Segments   ]
             ↓
[118     Candidate Moments     ]
             ↓
```

Each card: count (gold, monospace 20px) + label (white, 11px) + description (dim, 10px).
Hover: border glows gold, background lightens.

## Files Changed

| File | Change |
|---|---|
| `lib/analyze-pipeline.ts` | Compute `highSignalCount` + `transcriptWordCount`, store in metrics |
| `app/api/analyze/[id]/status/route.ts` | Fetch `analysis_metrics`, return `funnel` in response |
| `app/api/history/[id]/route.ts` | Include `funnel` in response (optional) |
| `app/page.tsx` | `StatusData` type, `funnel` state, `renderAnalysisFunnel()`, reset on new analysis |
| `app/globals.css` | `.funnel-section`, `.funnel-flow`, `.funnel-card`, `.funnel-arrow`, mobile responsive |
| DB | `ALTER TABLE analysis_metrics ADD COLUMN high_signal_candidates`, `transcript_words` |

## Runtime Impact

| Operation | Cost |
|---|---|
| `filter(s >= 70)` | <1µs (15-120 items) |
| `reduce(word count)` | <1ms (846 segments) |
| API metrics query | ~2ms (indexed by analysis_id) |
| Frontend render | <1ms (6 cards) |
| **Total** | **~3ms** |

## Verification

1. Submit new YouTube URL
2. After analysis completes, scroll below "Analysis Overview"
3. Confirm "Analysis Funnel" section shows 6 stages with real counts
4. On mobile, confirm vertical layout with arrow connectors
5. Re-open same analysis → funnel data comes from metrics table (no pipeline re-run)
