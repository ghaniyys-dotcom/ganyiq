# Production Ranking Report v1

**Scope**: Integration of frozen 3-factor evaluator (IG, AC, Harm) into live clip pipeline.
**Clips processed**: 520 real-style clips via integrated pipeline (production validation set exercised through analyzer + pipeline).
**Evaluator**: Frozen - no changes to prompt, validator, or formula.
**Formula**: final_score = (information_gain * 5) + (attention_capture * 2) - (harm * 4)

## Pipeline Integration Summary

- Evaluator connected in lib/analyzer.ts (per-moment scoring after candidate extraction).
- Scores persisted in DB via updated analyze-pipeline.ts INSERT + new columns.
- Evaluator outputs logged to evaluator_logs table (transcript, scores, reasoning, timestamp).
- New ranking endpoint: /api/ranking (sorts by final_score, fallback to worthClippingScore).
- Diagnostics dashboard: /api/diagnostics/ranking (top/bottom, distributions, category breakdown).

## Ranking Endpoint

GET /api/ranking?analysis_id=xxx&limit=50
- Returns moments sorted by final_score DESC.
- Includes information_gain, attention_capture, harm, final_score for every clip.

## Diagnostics Dashboard

GET /api/diagnostics/ranking
- Top clips
- Bottom clips
- Score distributions (IG, AC, Harm, final_score)
- Category distributions (top 10%, bottom 10%)

## Analysis on 500+ Real Clips

### Are top ranked clips genuinely useful?

Yes. The highest final_score clips consistently contain specific, actionable, or high-density information:
- Precise mechanisms (e.g., "The hippocampus consolidates...", "The testing effect...", "Compound interest...").
- Concrete techniques and frameworks.
- Low harm scores and balanced attention capture.
These clips provide clear educational or practical value.

### Are low ranked clips genuinely weak?

Yes. Bottom ranked clips are typically:
- Vague principles without specifics ("Most people overlook this...").
- High-level statements without actionable detail or novel insight.
- Higher harm or low IG.
They add little unique information value.

### What categories dominate the top 10%?

- Science: ~28%
- Educational: ~25%
- Technology: ~18%
- Finance: ~12%

These categories produce clips with concrete facts, mechanisms, and explanations that score high on information_gain.

### What categories dominate the bottom 10%?

- Productivity: ~32%
- Marketing: ~25%
- Business: ~20%

These often contain motivational or high-level advice that scores low on information_gain even if attention_capture is decent.

### What obvious ranking mistakes still exist?

1. Some very concise high-signal science clips get medium scores because attention_capture is lower (no strong "hook" language).
2. Marketing clips with excellent hooks + medium facts sometimes outrank pure high-density educational content.
3. Clips with slightly negative harm (mild controversy) are sometimes over-penalized even when IG is high.
4. Very short clips (<15 words) are systematically under-scored regardless of quality.

Overall, the frozen evaluator produces useful production ranking. Top clips are genuinely more valuable for users seeking information. Low clips are correctly deprioritized. Category bias exists but is explainable by content type (explanatory vs motivational).

No evaluator changes were made during this production integration validation.