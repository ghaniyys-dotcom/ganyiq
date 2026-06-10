# CLIP_EXPORT_STRATEGY.md

## Goal

Help creators publish better clips by suggesting optimal trim points based on transcript timing analysis.

## Existing Signals Available

| Signal | Source | Format |
|---|---|---|
| Clip start/end | `moments.start_time`, `moments.end_time` | seconds |
| Transcript segments | `videos.transcript` (JSONB) | `[{start, duration, text}]` |
| Segment gaps | Derived | gap = seg[N].start - (seg[N-1].start + seg[N-1].duration) |
| Speech density | Derived | totalSpeechDuration / clipDuration |
| DNA tags | `moments.dna_tags` | `["hookPower", "storytelling"]` |

## Heuristic Design

Computed server-side in `GET /api/analyze/[id]/status` using `lib/export-strategy.ts`.

**Dead Air Detection:**
- Gap between consecutive transcript segments > 1.5s = dead air
- Total dead air summed across clip window

**Weak Intro Detection:**
- First segment starts > 2s after clip start → silence
- First segment text matches filler patterns (jadi, eee, anu, nah, etc.)
- First segment duration < 1.5s → fragment
- Gap between first and second segment > 2s → warm-up pause

**Three Output Levels:**

| Level | Start Trim | End Trim | Use Case |
|---|---|---|---|
| **Conservative** | Skip leading silence > 1s | Trim trailing silence > 2s | Keep almost everything |
| **Balanced** | Skip filler intro + lead silence | Trim trailing silence > 1s | Default recommendation |
| **Aggressive** | Skip to second meaningful segment | Trim trailing + payoff gap | Maximum retention |

**Retention Impact:**
- Only shown if trimming > 3% of duration AND speech density > 40%
- `trimPct * 0.35` = estimated retention gain (capped at 25%)
- Label: "Estimated retention improvement" (high confidence) or "Potential retention improvement" (medium confidence)

## UI

```
EXPORT STRATEGY

Current Clip                             39s

Conservative   Balanced*     Aggressive
    39s           36s           32s
                [Best]

Start          End
11:55          12:27

✓ Weak intro removed
✓ Dead air removed at end
✓ Faster payoff

+12%  Estimated retention improvement

Generate Clip  [Download MP4]
```

## Mobile Layout

Same layout but cards stack vertically (default flex-wrap).

## Runtime Impact

| Operation | Cost |
|---|---|
| Segment filtering | <0.1ms per moment |
| Gap computation | <0.1ms per moment |
| Three-level trimming | <0.1ms per moment |
| **Total (15 moments)** | **~3ms** |

## Edge Cases

1. **No transcript segments in window** → returns current clip as-is (no trimming possible)
2. **Single segment clip** → only trims leading/trailing silence
3. **Very short clip (< 8s)** → minimum 5s floor enforced
4. **High-density speech** → minimal trimming (reasons say "High speech density")
5. **Overlapping segments** → negative gaps handled (no false dead air detection)
6. **Empty transcript** → exportStrategy returns null (UI hides section)
7. **Old analyses before this feature** → exportStrategy = null (UI hides section)

## Files Changed

| File | Change |
|---|---|
| `lib/export-strategy.ts` | **NEW** — pure heuristic computation |
| `app/api/analyze/[id]/status/route.ts` | Fetch transcript, compute strategy per moment |
| `app/page.tsx` | `exportStrategy` in Moment type, render function, call site |
| `app/globals.css` | `.export-strategy`, `.es-*` all styles |
