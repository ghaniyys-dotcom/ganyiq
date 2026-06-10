# SCORE_BREAKDOWN_PLAN.md — Explain Every Score

## Requirement

Show component scores for every recommended clip:

```
97 Exceptional

Hook Strength      9.5
Storytelling       9.2
Emotion            7.8
Authority          8.5
Retention          9.4
Relatability       9.1
```

## Investigation: Do Component Scores Already Exist?

**No.** The LLM output (stored in `analyses.raw_llm_response`) only contains:

```json
{
  "worthClippingScore": 97,      // 0-100 overall
  "confidence": "high",           // high | medium | low
  "dnaTags": ["hookPower", "storytelling", "authority"],
  "reasoning": "1-2 sentence explanation"
}
```

There are **no individual dimension scores** like "Hook Strength: 9.5" in any existing data field. The LLM scores each candidate holistically with a single number + tags.

**Available data per moment:**
| Field | Type | Example |
|---|---|---|
| `worthClippingScore` | number (0-100) | 97 |
| `confidence` | enum | "high" |
| `dnaTags` | string[] | ["hookPower", "storytelling", "emotion"] |
| `reasoning` | text | "Clip ini sangat strong karena..." |

## Derivation Strategy (No LLM, Deterministic)

### Rule

Derive 6 component scores (0-10 scale) from **existing data only**:

1. **Overall score** → sets the anchor (base = score ÷ 10)
2. **dnaTags** → boost/suppress specific components
3. **dnaTag count diversity** → influences retention / general engagement
4. **confidence** → controls differentiation spread

### Component ↔ Primary DNA Tag Mapping

| Component | Primary DNA Tag | Fallback / Related Tags |
|---|---|---|
| Hook Strength | `hookPower` | — |
| Storytelling | `storytelling` | `humor` (narrative humor) |
| Emotion | `emotion` | `vulnerability`, `inspiration`, `motivation` |
| Authority | `authority` | `educational` |
| Retention | *(composite)* | `hookPower` + `curiosity` + tag diversity |
| Relatability | `relatability` | `humor`, `vulnerability` |

### Algorithm

```
For each component score (0-10):

  1. Base = worthClippingScore / 10
     (97 → 9.7)

  2. Confidence spread factor:
     high:   ±1.5 (differentiate strongly)
     medium: ±0.8 (moderate)
     low:    ±0.3 (cluster near base)

  3. Tag modifier:
     Primary tag found:     +spread × 0.8
     Related tag found:     +spread × 0.4
     Both primary+related:  +spread × 1.0
     No tag:                -spread × 0.5

  4. Retention is special — always positive unless zero tags:
     tagDiversityBoost = min(dnaTags.length, 5) × 0.3
     Base + tagDiversityBoost + hookPower bonus + curiosity bonus

  5. Clamp to [0.0, 10.0]
  6. Round to 1 decimal
```

### Example Derivation

**Moment:** score=97, confidence=high, dnaTags=["hookPower","storytelling","authority","motivation"]

| Component | Base | Spread | Tags | Modifier | Final | Rationale |
|---|---|---|---|---|---|---|
| Hook Strength | 9.7 | 1.5 | hookPower ✓ | +1.2 | **9.7** | Base+80% spread, capped at 10 → 9.7 |
| Storytelling | 9.7 | 1.5 | storytelling ✓ | +1.2 | **9.2** | Base+80% spread = 9.2 |
| Emotion | 9.7 | 1.5 | none, motivation related | -0.75 | **8.95 ≈ 9.0** | No primary, related tag partly offsets |
| Authority | 9.7 | 1.5 | authority ✓ | +1.2 | **9.2** | Base+80% spread |
| Retention | 9.7 | 1.5 | 4 tags + hookPower | +1.5 | **9.4** | Composite: diversity + hookPower |
| Relatability | 9.7 | 1.5 | none | -0.75 | **8.95 ≈ 9.0** | No tag found |

**Note:** These are illustrative. The actual algorithm will be tuned during implementation.

## Implementation

### File

`lib/score-breakdown.ts` — deterministic, synchronous, zero dependencies beyond types.

### Interface

```typescript
export interface ScoreBreakdown {
  hookStrength: number;   // 0-10
  storytelling: number;   // 0-10
  emotion: number;        // 0-10
  authority: number;      // 0-10
  retention: number;      // 0-10
  relatability: number;   // 0-10
}

export function deriveScoreBreakdown(
  score: number,          // 0-100
  confidence: string,     // "high" | "medium" | "low"
  dnaTags: string[],      // from LLM output
): ScoreBreakdown
```

### Purity

- **No IO** — pure calculation, synchronous
- **No LLM calls** — zero API cost
- **No randomness** — deterministic (same inputs = same outputs)
- **No DB reads** — can be called from frontend or backend

### Storage

Add `score_breakdown jsonb` column to `moments` table for caching, but can also compute on-the-fly since it's deterministic and instant.

### API Inclusion

Return `scoreBreakdown` alongside existing moment data in:
- `GET /api/analyze/[id]/status`
- `GET /api/history/[id]`

## UI Design

**Location:** Inside Featured Workspace, in the score area (next to the score badge).

**Current:**
```
97 Exceptional
```

**Target:**
```
97 Exceptional

Hook Strength  ███████████ 9.5
Storytelling   ██████████░ 9.2
Emotion        ████████░░░ 7.8  
Authority      █████████░░ 8.5
Retention      ██████████░ 9.4
Relatability   █████████░░ 9.1
```

- Mini progress bars (10 segments, gold fill for score, dim for remainder)
- Score label on the right
- Compact enough to fit in the workspace metadata area
- Animate on reveal (stagger fade)

Alternatively (more compact for mobile):

```
97 Exceptional

Hook  ███████████ 9.5  │  Story  ██████████░ 9.2
Emote ████████░░░ 7.8  │  Auth   █████████░░ 8.5
Reten ██████████░ 9.4  │  Relate █████████░░ 9.1
```

## Delivered Output

### Files Changed

| File | Change |
|---|---|
| `lib/score-breakdown.ts` | **NEW** — deterministic derivation function |
| `lib/types.ts` | Add `ScoreBreakdown` type |
| `app/api/.../status/route.ts` | Include `scoreBreakdown` in moment response |
| `app/page.tsx` | Render mini bars in workspace |
| `app/globals.css` | `.score-breakdown` styles |

### Cost

- **LLM calls:** 0 (zero)
- **CPU time:** <1µs per moment
- **DB space:** ~200 bytes per moment (if cached)
- **Engineering time:** ~15 minutes
