# TITLE_GENERATION.md — AI Title Suggestions for Clips

## Overview

Generate 3-5 title variations per recommended clip in 5 style categories. Titles are cached in DB — never regenerated if they already exist.

## Architecture

```
analyze-pipeline.ts
  └─ storing_results stage
       └─ INSERT moments (with RETURNING id)
       └─ generateAllTitlesForAnalysis() [fire & forget]
            └─ for each moment:
                 └─ generateTitlesForMoment()
                      ├─ Check DB cache (moments.suggested_titles)
                      ├─ If miss: call LLM → parse → store in DB
                      └─ Return titles
```

## Prompt

**System prompt:** Professional clip-title strategist. Generate 5 title variations (one per style) in Indonesian under 80 chars each.

**Style categories:**
| Style | Description | Example |
|---|---|---|
| `curiosity` | Makes viewer wonder "why/how" | "Andre Taulany Salah Paham Hadiah Ultahnya" |
| `emotional` | Tugs at feelings (haru, lucu, relatable) | "Momen Haru Andre Curhat Soal Keluarga" |
| `viral` | Punchy, shareable, controversy/shock | "JAWABAN ANDRE BIKIN SEMUA HENING!" |
| `story` | Narrative hook | "Kisah Andre Dapet Hadiah Gitar Tapi Minta Sepeda" |
| `professional` | Safe, descriptive | "Andre Taulany Berbagi Pengalaman tentang Hadiah" |

**User prompt inputs:**
- Video title & channel name
- Clip timestamp (start—end)
- Score (0-100)
- DNA tags (hookPower, curiosity, emotion, etc.)
- AI reasoning for why this clip is worth clipping
- Transcript excerpt (up to 800 chars)

**Temperature:** 0.7 (creative variety)
**Max tokens:** 2048
**Model:** `deepseek-v4-flash` (same as scoring, via OpenCode Go API)

## Cost Estimate

| Metric | Per moment | Per analysis (15 moments) |
|---|---|---|
| LLM calls | 1 | 15 (3 concurrent) |
| Input tokens | ~400 | ~6,000 |
| Output tokens | ~300 | ~4,500 |
| Total tokens | ~700 | ~10,500 |
| Cost (@$0.15/1M tokens) | ~$0.0001 | ~$0.0016 |
| Time (parallel 3-concurrency) | ~3-5s | ~15-25s |

**Note:** Runs fire-and-forget after pipeline completes. Does NOT block analysis results — titles populate asynchronously.

## Caching Strategy

**Storage:** `moments.suggested_titles` (JSONB column)

```json
[
  { "style": "curiosity", "title": "Andre Taulany Salah Paham Hadiah Ultahnya" },
  { "style": "emotional", "title": "Momen Haru Andre Curhat Soal Keluarga" },
  { "style": "viral",     "title": "JAWABAN ANDRE BIKIN SEMUA HENING!" },
  { "style": "story",     "title": "Kisah Andre Dapet Hadiah Gitar Tapi Minta Sepeda" },
  { "style": "professional", "title": "Andre Taulany Berbagi Pengalaman tentang Hadiah" }
]
```

**Cache check:** `generateTitlesForMoment()` checks `moments.suggested_titles` first. If array exists with ≥3 entries, returns cached.

**Never regenerate:** Once titles are stored, any subsequent load of the same analysis skips the LLM call entirely. No background job, no re-computation.

**Existing analyses:** Titles are NULL for analyses completed before this deployment. They'd need a backfill script to populate retroactively. Not implemented — only new analyses get titles.

## UI Design

**Location:** Inside Featured Workspace, under "WHY GANYIQ PICKED THIS" section.

**Rendering:**
```
┌────────────────────────────────────────────┐
│  SUGGESTED TITLES                           │
│                                             │
│  ┌──────────────────────────────────────┐   │
│  │ Curiosity  Andre Salah Paham... [Copy]│   │
│  └──────────────────────────────────────┘   │
│  ┌──────────────────────────────────────┐   │
│  │ Emotional   Momen Haru Andre...  [Copy]│   │
│  └──────────────────────────────────────┘   │
│  ┌──────────────────────────────────────┐   │
│  │ Viral       JAWABAN ANDRE BIKI... [Copy]│   │
│  └──────────────────────────────────────┘   │
│  ┌──────────────────────────────────────┐   │
│  │ Story       Kisah Andre Dapet... [Copy]│   │
│  └──────────────────────────────────────┘   │
│  ┌──────────────────────────────────────┐   │
│  │ Professional Andre Taulany Berb...[Copy]│   │
│  └──────────────────────────────────────┘   │
└────────────────────────────────────────────┘
```

**Copy button:** Uses `navigator.clipboard.writeText()`. Shows ✓ feedback for 2 seconds after copy. No "toast" — inline state change.

**Loading state:** Titles are generated asynchronously after analysis completes. If they haven't populated yet (or analysis is old), the section is simply hidden. No skeleton loading.

## Files Changed

| File | Change |
|---|---|
| `lib/title-generator.ts` | **NEW** — LLM call, prompt, caching logic |
| `lib/analyze-pipeline.ts` | RETURNING id on INSERT moments + fire-and-forget title generation |
| `app/api/analyze/[id]/status/route.ts` | SELECT `suggested_titles` in moments query |
| `app/api/history/[id]/route.ts` | SELECT `suggested_titles` in moments query |
| `app/page.tsx` | Moment type + STYLE_LABELS + Suggested Titles UI + copy state |
| `app/globals.css` | `.title-suggestions` + `.title-suggestion-row` + `.title-copy-btn` etc. |
| DB | `ALTER TABLE moments ADD COLUMN suggested_titles jsonb` |

## Verification

1. Submit a new YouTube URL to `ganyiq.ganys.me`
2. After analysis completes (~4 min), open a clip in the Featured Workspace
3. Scroll to "Suggested Titles" section under "WHY GANYIQ PICKED THIS"
4. Each title row shows: style badge (gold caps) | title text | Copy button
5. Click Copy → button shows ✓ for 2s
6. Submit same URL again → titles load instantly from cache (no LLM call)
