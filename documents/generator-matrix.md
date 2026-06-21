# Phase 2.3 — Generator Matrix

## Overview

| Generator | Strategy | Status | Phase |
|-----------|----------|--------|-------|
| A | Hook First | ✅ Completed, audited | 2.2 |
| B | Insight First | 🔨 Implementing | 2.3 |
| C | Emotion First | 📋 Planned | 2.4 |
| D | Authority First | 📋 Planned | 2.5 |

---

## Generator A — Hook First

| Attribute | Value |
|-----------|-------|
| **Status** | ✅ Completed (Phase 2.2) |
| **Core objective** | Find clips with the strongest opening hook in the first 3–10 seconds |
| **Positive signals** | curiosity_gap, controversial/hot take, surprising_claim, strong_opinion, emotional_opening, question_driven |
| **Negative signals** | greeting, guest_intro, sponsor, housekeeping, transition |
| **Signal weight range** | 3–5 (curiosity & controversy = 5, question & emotional = 3) |
| **Output** | 15 raw candidates → local top 5 |
| **Avg candidate duration** | 20–40s |
| **Known weakness** | Penalizes potential intros that start with greetings before hook; can miss slow-burn content where the insight builds over 15-30s |
| **Target overlap with B** | ~30–40% (both find surprising claims, but from different angles) |
| **Unique discovery** | Surprising/openings the V1 pipeline completely misses (90% new discoveries in Phase 2.2 benchmark) |

---

## Generator B — Insight First

| Attribute | Value |
|-----------|-------|
| **Status** | 🔨 Implementing (Phase 2.3) |
| **Core objective** | Find clips with high educational/knowledge density — frameworks, mental models, actionable advice |
| **Positive signals** | actionable_advice, educational_structure, numbers/statistics, mistakes_failures, predictions_forecasting, business_entrepreneurship, hot_take (when paired with explanation), strong_claims (when educational) |
| **Negative signals** | pure emotion without insight, banter, guest introductions, emotional-only moments, controversy without explanation, greetings, filler |
| **Signal weight range** | educational: 5, actionable: 4, frameworks: 4, numbers: 3, mistakes: 3, advice: 3 |
| **Output** | 15 raw candidates → local top 5 |
| **Avg candidate duration** | 30–60s (insights need more context than hooks) |
| **Known weakness** | May over-pick structured educational segments that sound like "lesson #1, lesson #2" — need diversity guard against template content. May miss implicit insights delivered through storytelling. |
| **Target overlap with A** | **<40%** — Hook and Insight should find different clips. Hook catches openings; Insight catches depth. |
| **Unique discovery hypothesis** | **Insight First will find clips that provide "why" answers — explanations, frameworks, and lessons. Hook First finds clips that grab attention. They complement each other: Hook gets the viewer in, Insight delivers value.** |

---

## Generator C — Emotion First

| Attribute | Value |
|-----------|-------|
| **Status** | 📋 Planned (Phase 2.4) |
| **Core objective** | Find clips with the strongest emotional resonance — vulnerability, personal stories, relatable struggles |
| **Positive signals** | vulnerability, personal_revelation, story_transitions, inspiration, emotional (high-arousal), profanity/taboo (when emotional), speaker disagreement (when passionate) |
| **Negative signals** | greetings, factual-only content, educational monologue, sponsor reads, housekeeping, transition phrases |
| **Signal weight range** | vulnerability: 5, personal: 4, story: 4, emotional: 3, inspiration: 3 |
| **Output** | 15 raw candidates → local top 5 |
| **Avg candidate duration** | 30–60s (emotional arcs take time to build) |
| **Known weakness** | Risk of over-selecting sad/dramatic moments. May pick vulnerability that lacks context. Indonesian content often mixes emotion with humor — signal separation may be noisy. |
| **Target overlap with A** | ~40–50% (emotion overlaps with emotional_opening in Hook, but Emotion First goes deeper — bukan cuma opening, the whole clip) |
| **Target overlap with B** | ~20–30% (emotion and insight are usually different moments in a video) |
| **Unique discovery hypothesis** | **Emotion First will find clips that Hook calls "emotional opening" but only as surface level. Emotion First selects the full emotional arc — the story behind the tears, the personal revelation that makes the moment relatable. These clips have higher connection potential and shareability.** |

---

## Generator D — Authority First

| Attribute | Value |
|-----------|-------|
| **Status** | 📋 Planned (Phase 2.5) |
| **Core objective** | Find clips where the speaker establishes credibility or delivers authoritative statements — expert opinions, predictions, data-driven claims |
| **Positive signals** | authority, numbers/statistics, predictions_forecasting, strong_claims (when data-backed), quotations, debate_arc (when expert), business_entrepreneurship (insider knowledge) |
| **Negative signals** | personal anecdotes without evidence, pure comedy, reactions, banter, overused "trust me" without substance |
| **Signal weight range** | authority: 5, numbers: 4, predictions: 4, strong_claim: 3, quotation: 3 |
| **Output** | 15 raw candidates → local top 5 |
| **Avg candidate duration** | 20–45s (authority statements are punchy) |
| **Known weakness** | Risk of over-selecting "expert" content that's actually generic. May reinforce authority bias. Indonesian content: many guests defer to "profesional" — need careful signal tuning to distinguish genuine authority from performative expertise. |
| **Target overlap with A** | ~30% (authority overlaps with surprising_claim and strong_opinion) |
| **Target overlap with B** | ~40% (authority and insight share educational/explanatory territory — authority delivers the explanation, insight structures it) |
| **Target overlap with C** | ~10% (authority is rational, emotion is emotional — they rarely overlap) |
| **Unique discovery hypothesis** | **Authority First will find clips where an expert drops a data-backed claim that changes the viewer's understanding. These clips have high credibility value — they make the content shareable as "truth" rather than "entertainment." V1 pipeline undervalues authority because its scoring weights comedy and emotion higher.** |

---

## Strategic Overlap Matrix

| | Hook (A) | Insight (B) | Emotion (C) | Authority (D) |
|---|---|---|---|---|
| **Hook (A)** | — | 30–40% | 40–50% | 30% |
| **Insight (B)** | 30–40% | — | 20–30% | 40% |
| **Emotion (C)** | 40–50% | 20–30% | — | 10% |
| **Authority (D)** | 30% | 40% | 10% | — |

Pool target: 20 candidates from 4 generators → dedup to **~12–16 unique clips** → Judge V2 → top 5–10 output.

## Success Criteria

| Generator | Must beat Phase 1 on | Key metric |
|-----------|---------------------|------------|
| **A** Hook | New discoveries vs V1 | ≥80% new clips in top 5 |
| **B** Insight | Overlap with Hook <40% | <40% pairwise overlap with A's top 5 |
| **C** Emotion | New discoveries vs A+B | ≥50% of Emotion's top 5 not found by A or B |
| **D** Authority | Pool diversity contribution | A+B+C+D pool must have ≥3 strategies in final top 10 |
