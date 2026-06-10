# GANYIQ Frontend Master Roadmap

> **Source of Truth:** `GANYIQ_HIGH_FIDELITY_MOCKUP_V2.md`
> **Target:** 100% visual parity with V2 mockup
> **Execution:** Phase-gated → build → deploy → verify → report → next phase

---

## Coverage Checklist (71 Items)

### Foundation
- [ ] F1. CSS variable system — grayscale palette + gold accent tokens
- [ ] F2. Geist + Geist Mono applied globally (body, headings, UI, mono)
- [ ] F3. Layout width 640px → 896px, 32px side padding
- [ ] F4. Section gap system (40px body, 20px/16px section labels)
- [ ] F5. Animation `@keyframes`: skeleton-shimmer, stage-pulse, stagger-fade, score-fill
- [ ] F6. DNA symbol unicode support (14 symbols, 12 unique)
- [ ] F7. Gold discipline: 95% grayscale, 5% gold — CTA, score, elite dot, active stage only
- [ ] F8. All gold-forbidden rules enforced: borders, dividers, backgrounds, icons, typography

### Homepage
- [ ] H1. Header: 48px compact, logo Geist 20px 500, version tag right
- [ ] H2. Subheadline: "Surface the moments people actually remember." — idle only
- [ ] H3. Subheadline: Geist 13px 400, `#71717a`, 4px below logo
- [ ] H4. Subheadline: hidden during analysis (replaced by timeline label)
- [ ] H5. Subheadline: hidden during results (replaced by section title "Picks of the Analysis")
- [ ] H6. Input: 48px height, `#18181b` bg, `1px rgba(255,255,255,0.10)` border, 10px radius
- [ ] H7. Input: Geist 15px 400, `#f4f4f5` text, `#52525b` placeholder
- [ ] H8. Input: `#e8c76a` border on focus, 200ms transition
- [ ] H9. Input submit button: 36×36px, `#e8c76a` bg, 8px radius, inside input (right side)
- [ ] H10. Input: disabled state (opacity 0.5), error state (red border)
- [ ] H11. Section label style: Geist 13px 500, `0.04em` uppercase, `#71717a`
- [ ] H12. History row: 64px tall, `#121213` bg, `1px rgba(255,255,255,0.06)` border, 10px radius
- [ ] H13. History thumbnail: 72×54px, 6px radius, `object-fit: cover`
- [ ] H14. History title: Geist 14px 500, `#f4f4f5`, single-line ellipsis
- [ ] H15. History meta: Geist 12px 400, `#71717a`, inline bullets
- [ ] H16. History avg score: Geist 12px 600, `#e8c76a` (first gold use)
- [ ] H17. History date: Geist 12px 400, `#52525b`, right-aligned
- [ ] H18. History open button: ghost, `1px rgba(255,255,255,0.08)`, 8px 14px, 8px radius
- [ ] H19. History row hover: border → `rgba(255,255,255,0.2)`
- [ ] H20. History row gap: 8px between rows
- [ ] H21. Empty state: minimal, one-line text, no SVG icon
- [ ] H22. Section-to-section gap: 40px

### Analysis Experience
- [ ] A1. "Analyzing your video" label: Geist 15px 500, `#a1a1aa`, center — visible only during analysis
- [ ] A2. Stage timeline: 4 dots (Fetching · Extracting · Analyzing · Ranking)
- [ ] A3. Active dot: 8px circle, `#e8c76a` fill, pulse animation
- [ ] A4. Completed dot: 8px circle, `#e8c76a` fill, no animation
- [ ] A5. Upcoming dot: 8px circle, `rgba(255,255,255,0.12)` border, no fill
- [ ] A6. Connector line: 48px wide, 2px tall, `rgba(255,255,255,0.06)`
- [ ] A7. Connector (completed): `rgba(232,199,106,0.3)` fill
- [ ] A8. Stage label: Geist 12px 500, centered 8px below dot
- [ ] A9. Active label: `#f4f4f5`. Completed: `#71717a`. Upcoming: `#52525b`.
- [ ] A10. Stage dot pulse: `opacity 0.4→1→0.4`, 2s infinite
- [ ] A11. Stage transition: fill animation 400ms ease-in-out
- [ ] A12. Backend stage → timeline mapping (4 stages merged from 6)
- [ ] A13. Elapsed timer: Geist Mono 14px 400, `#71717a`, center, 1s interval
- [ ] A14. Skeleton cards: 4 cards, 180×120px each, 12px gap
- [ ] A15. Skeleton: `#121213` bg, `1px rgba(255,255,255,0.06)` border, 10px radius
- [ ] A16. Skeleton shimmer: `linear-gradient(110deg, transparent 30%, rgba(255,255,255,0.04) 50%, transparent 70%)`, 2s loop
- [ ] A17. Discovery counter: "24 moments discovered", Geist 15px 500, `#a1a1aa`, center
- [ ] A18. Discovery counter: updates based on real pipeline progress (not fake)
- [ ] A19. Mobile timeline: only active stage label shown, 3 skeletons
- [ ] A20. Remove old progress bar component and stage indicator code

### Results Page
- [ ] R1. "Picks of the Analysis" section label
- [ ] R2. Hero card: 832px × 264px, `#121213` bg, `1px rgba(255,255,255,0.06)` border, 12px radius
- [ ] R3. Hero card left accent: 3px solid `#e8c76a` (gold discipline — ONLY gold on card)
- [ ] R4. Hero top row: rank 18px + timestamp Geist Mono 12px + elite dot gold + score bar 120px + score number Geist Mono 18px gold
- [ ] R5. Hero reasoning: Geist 15px 400, 2 lines max, ellipsis
- [ ] R6. Hero DNA tags: symbol + truncated name (max 8 chars), Geist 11px 500, `#71717a`
- [ ] R7. Hero transcript: collapsed by default, "Show transcript" toggle
- [ ] R8. Hero CTA: ghost button with gold accent hover, "Generate Clip"
- [ ] R9. "More Picks" section label
- [ ] R10. Elite row: 5 compact cards, horizontal flex, 12px gap
- [ ] R11. Elite compact card: 144 × 160px, `#121213` bg, `1px rgba(255,255,255,0.06)` border, 10px radius
- [ ] R12. Elite card content: rank `#71717a`, score `#e8c76a` 28px, timestamp mono, tag symbol + 6 chars
- [ ] R13. Elite card CTA: ghost button, "Generate", 8px 12px, 6px radius
- [ ] R14. Elite card hover: border → `rgba(232,199,106,0.15)`
- [ ] R15. "Also Notable" section label
- [ ] R16. Secondary row: 7 compact cards, horizontal flex, 8px gap
- [ ] R17. Secondary compact card: 108 × 112px, similar bg/border/radius
- [ ] R18. Secondary card content: rank, score `#a1a1aa` (no gold), timestamp mono, tag symbol + 5 chars
- [ ] R19. Secondary card: NO CTA button
- [ ] R20. Score bar: 4px tall, 120px wide, 2px radius, `#e8c76a` fill, `rgba(255,255,255,0.06)` track
- [ ] R21. Generate button 3 states: idle (gold), generating (pulse+disabled), ready (green), failed (red)
- [ ] R22. Staggered card mount: `translateY(8px) + opacity 0→1`, 60ms stagger, 200ms each
- [ ] R23. Score bar fill animation: 0 → score%, 600ms ease-out
- [ ] R24. Remove old moment card JSX structure (database-row layout)
- [ ] R25. Old purple accent colors fully eliminated from CSS

### DNA Symbol System
- [ ] D1. Symbol map: 14 tags → 12 unique unicode symbols
- [ ] D2. hookPower → `◇`, curiosity → `▼`, controversy → `▲`, emotion/vulnerability → `♥`
- [ ] D3. humor → `◆`, storytelling/inspiration → `✦`, educational → `■`
- [ ] D4. authority → `◈`, money → `¤`, shock → `⚡`, motivation → `↑`, relatability → `○`
- [ ] D5. Hero card: symbol + 8 chars max, Geist 11px 500, `#71717a`
- [ ] D6. Elite card: symbol + 6 chars max, same style
- [ ] D7. Secondary card: symbol + 5 chars max, same style
- [ ] D8. Unmapped tag fallback: show full name without symbol
- [ ] D9. Always monochrome — no tag coloring, no pills

### Mobile
- [ ] M1. Responsive breakpoints: max-width 480px, 100% width
- [ ] M2. Mobile padding: 16px (vs 32px desktop)
- [ ] M3. Mobile subheadline: 12px
- [ ] M4. Mobile history row: 60px, thumbnail 64×48px
- [ ] M5. Mobile analysis: 3 skeleton cards (vs 4 desktop)
- [ ] M6. Mobile timeline: only active label shown (others hidden)
- [ ] M7. Mobile results: hero card 240px (vs 264px), 1-line reasoning
- [ ] M8. Mobile compact cards: 130×140px elite, 96×96px secondary
- [ ] M9. Mobile scroll hint: "─→" after section labels indicating horizontal scroll
- [ ] M10. No horizontal scroll on page body

### Micro-interactions
- [ ] I1. Input focus: border color transition 200ms ease
- [ ] I2. Button hover: bg/border brighten 150ms ease
- [ ] I3. Button click: scale 1→0.97 100ms ease-out
- [ ] I4. Card hover: border `0.06→0.15` opacity 200ms ease
- [ ] I5. Stage dot fill: 400ms ease-in-out
- [ ] I6. Skeleton shimmer loop: 2s ease-in-out infinite
- [ ] I7. Score bar fill: 0→score% 600ms ease-out
- [ ] I8. Card appear stagger: 60ms delay, 200ms each, ease-out
- [ ] I9. History list appear: 40ms delay, 200ms each, ease-out
- [ ] I10. DNA tag appear: 20ms delay, 150ms each, ease-out
- [ ] I11. No gold animations (gold appears instantly, no fade-in)

### Accessibility
- [ ] X1. Focus ring on all interactive elements
- [ ] X2. Keyboard navigation: Tab order, Enter/Space activation
- [ ] X3. Color contrast: 4.5:1 minimum for text
- [ ] X4. `prefers-reduced-motion` respected for animations

---

## Phase Breakdown

### Phase 1 — Foundation (CSS variables + Typography + Layout)

**Goal:** Establish the visual foundation without changing any component logic.

**Files affected:** `globals.css` only

**Items covered:** F1, F2, F3, F4, F5, F6, F7, F8, X1, X3, X4

| Task | Description | Est. | Depends on |
|---|---|---|---|
| 1.1 | Replace all CSS variables with new palette: grayscale spectrum + gold accent | 15m | None |
| 1.2 | Apply Geist + Geist Mono to `body`, headings, all text elements via CSS | 10m | 1.1 |
| 1.3 | Change max-width from 640px to 896px, add 32px side padding, section gaps | 10m | 1.1 |
| 1.4 | Add `@keyframes` for skeleton-shimmer, stage-pulse, stagger-fade, score-fill | 10m | 1.1 |
| 1.5 | Add CSS for focus-visible, `prefers-reduced-motion`, global transition defaults | 10m | 1.1 |
| 1.6 | Remove all purple `#8b5cf6`, `#7c3aed`, `#a1a1aa` alias references — replace with grayscale | 5m | 1.1 |

**Dependency:** None (first phase)
**Risk:** Low — CSS only, no component logic changes
**Rollback:** Revert `globals.css` from git

**Verification:** Build → Deploy → Screenshot homepage → Compare with V2 mockup Section 1 color samples

---

### Phase 2 — Homepage (Header + Input + History + Empty State)

**Goal:** Full homepage visual parity with V2 mockup Section 2.

**Files affected:** `globals.css`, `page.tsx`

**Items covered:** H1-H22, I2, I3, I4

| Task | Description | Est. | Depends on |
|---|---|---|---|
| 2.1 | Restructure header: 48px, logo left, version right, remove old tagline | 10m | Phase 1 |
| 2.2 | Add subheadline below logo, conditional visibility logic (idle only) | 15m | 2.1 |
| 2.3 | Redesign input: dark bg, gold submit button inside, focus border, error state | 20m | Phase 1 |
| 2.4 | Add input disabled state (opacity + cursor) + error state style | 10m | 2.3 |
| 2.5 | Add section label component style (13px uppercase, `0.04em`, `#71717a`) | 5m | Phase 1 |
| 2.6 | Rewrite history rows: compact 64px layout, thumbnail, title, meta, score, date, button | 25m | Phase 1 |
| 2.7 | Add ghost button component (Open CTA, hover brighten) | 10m | 2.6 |
| 2.8 | Replace empty state: remove 64×64 SVG, minimal text | 10m | Phase 1 |
| 2.9 | Add responsive padding (32px desktop → 16px mobile) | 10m | Phase 1 |
| 2.10 | Add button + card hover/click micro-interactions | 10m | 2.6, 2.7 |

**Dependency:** Phase 1 complete
**Risk:** Low — mostly CSS class swaps and JSX restructuring. Input functionality unchanged. History API unchanged. Empty state logic unchanged.
**Rollback:** Revert `page.tsx` + `globals.css`

**Verification:** Build → Deploy → Screenshot homepage → Compare with V2 mockup Section 2 (layout diagram, spacing system, history row component)

---

### Phase 3 — Analysis Experience (Timeline + Skeleton + Timer)

**Goal:** Replace the old progress bar with the stage timeline, skeleton cards, elapsed timer, and discovery counter.

**Files affected:** `globals.css`, `page.tsx`

**Items covered:** A1-A20, I5, I6

| Task | Description | Est. | Depends on |
|---|---|---|---|
| 3.1 | Add "Analyzing your video" label (visible only during analysis stages) | 5m | Phase 1 |
| 3.2 | Build stage dot component: 8px circle, 3 states (active/completed/upcoming) | 15m | Phase 1 |
| 3.3 | Build connector line: 48×2px, default + completed colors | 10m | 3.2 |
| 3.4 | Build stage timeline layout: 4 dots + 3 connectors + 4 labels, horizontal flex | 15m | 3.2, 3.3 |
| 3.5 | Add stage mapping logic: 6 backend stages → 4 timeline stages | 15m | 3.4 |
| 3.6 | Add elapsed timer: Geist Mono, 1s `setInterval`, centered below timeline | 10m | Phase 1 |
| 3.7 | Build skeleton card: 180×120px, shimmer animation, 10px radius | 15m | Phase 1 |
| 3.8 | Add skeleton row: 4 cards, 12px gap, horizontal flex | 10m | 3.7 |
| 3.9 | Add discovery counter: "N moments discovered", update from status API | 15m | Phase 1 |
| 3.10 | Remove old progress bar, stage indicator, stage-hint code | 10m | 3.4 |
| 3.11 | Add mobile timeline variant: only active label, 3 skeletons | 10m | Phase 2 (M1-M2) |

**Dependency:** Phase 1 complete, Phase 2 for mobile responsive base
**Risk:** Medium — new JSX components being created. Need to verify stage mapping is correct and Apollo state transitions work (idle → fetching → extracting → analyzing → ranking → done/error).
**Rollback:** Revert `page.tsx` + `globals.css`. Keep old progress bar component as fallback.

**Verification:** Build → Deploy → Submit a video → Screenshot during analysis → Verify stage dot progression matches actual backend stage → Compare with V2 mockup Section 3

---

### Phase 4 — Results Page (Hero Card + Elite Row + Secondary Row)

**Goal:** Full results page visual parity with V2 mockup Section 4.

**Files affected:** `globals.css`, `page.tsx`

**Items covered:** R1-R25, D1-D9, I7, I8, I10

| Task | Description | Est. | Depends on |
|---|---|---|---|
| 4.1 | Add section labels: "Picks of the Analysis", "More Picks", "Also Notable" | 5m | Phase 1 |
| 4.2 | Build hero card: 832px × 264px, left gold accent, 12px radius, 20px padding | 25m | Phase 1 |
| 4.3 | Hero top row: rank + timestamp + elite dot + score bar + score number, right-aligned | 15m | 4.2 |
| 4.4 | Hero reasoning: 2 lines max, ellipsis overflow | 10m | 4.2 |
| 4.5 | Hero DNA tag row: symbol + abbreviated name, inline, 6px gap | 15m | 4.2, Phase 1 |
| 4.6 | Hero transcript section: collapsed by default, "Show transcript" toggle | 15m | 4.2 |
| 4.7 | Hero CTA button: ghost style with gold hover | 10m | 4.2 |
| 4.8 | Build compact card (reusable): 144×160px base size, bg, border, radius | 20m | Phase 1 |
| 4.9 | Elite row: 5 compact cards, horizontal flex, 12px gap | 15m | 4.8 |
| 4.10 | Elite card internal: rank, score gold, timestamp, tag symbol, ghost CTA | 15m | 4.9 |
| 4.11 | Build secondary compact card variant: 108×112px, no CTA, score gray | 15m | 4.8 |
| 4.12 | Secondary row: 7 cards, horizontal flex, 8px gap, scrollable | 15m | 4.11 |
| 4.13 | Score bar component: 4px tall, 120px wide, gold fill proportional, number right | 15m | Phase 1 |
| 4.14 | Generate button: 3 states (gold idle / pulsing generating / green ready / red failed) | 15m | Phase 1 |
| 4.15 | DNA symbol map: implement lookup table with 14 tags → 12 symbols | 15m | Phase 1 |
| 4.16 | Add tag abbreviation logic: 8/6/5 chars by card type | 10m | 4.15 |
| 4.17 | Unmapped tag fallback: full name, no symbol | 5m | 4.15 |
| 4.18 | Add staggered card mount animation (translateY + opacity) | 15m | 4.2, 4.9, 4.12 |
| 4.19 | Add score bar fill animation (0 → score% on mount) | 10m | 4.13 |
| 4.20 | Add staggered DNA tag appear animation | 10m | 4.15 |
| 4.21 | Remove old moment card JSX (database-row card layout) | 15m | 4.2 |
| 4.22 | Remove old `.dna-tag` pill styles, `.tier-badge` purple, `.meta-value.score` purple | 10m | 4.15 |

**Dependency:** Phase 1 complete (all CSS vars, typography, layout exist), Phase 2 for consistency checking
**Risk:** Medium-High — largest phase by item count (22 items). Hero card has 6 sub-components. Card animation timing must be tuned to feel premium, not chaotic.
**Rollback:** Revert `page.tsx` + `globals.css`. Old card layout still in git history.

**Verification:** Build → Deploy → Submit video → Wait for completion → Screenshot results page → Compare with V2 mockup Section 4 (264px hero card, elite row, secondary row, score bars, DNA symbols)

---

### Phase 5 — Mobile + Polish + Verification

**Goal:** Full responsive parity, micro-interactions complete, a11y pass, production-ready.

**Files affected:** `globals.css`, `page.tsx`

**Items covered:** M1-M10, I9, I11, X2, remaining I items, final coverage check

| Task | Description | Est. | Depends on |
|---|---|---|---|
| 5.1 | Mobile homepage: 100% width, max 480px, 16px padding, 60px history rows | 15m | Phase 2 |
| 5.2 | Mobile analysis: 3 skeletons, single active label | 10m | Phase 3 |
| 5.3 | Mobile results: hero 240px, 1-line reasoning, compact cards smaller | 20m | Phase 4 |
| 5.4 | Mobile scroll hint "─→" after section labels | 10m | 5.3 |
| 5.5 | Verify no horizontal page scroll at any breakpoint | 10m | 5.1-5.4 |
| 5.6 | Add history list stagger animation (40ms delay) | 10m | Phase 2 |
| 5.7 | Add all remaining micro-interaction timings | 15m | Phase 4 |
| 5.8 | Keyboard navigation audit: Tab order, Enter/Space for all interactive elements | 15m | Phase 4 |
| 5.9 | Add focus-visible ring (2px solid `#e8c76a`) on all interactive elements | 10m | 5.8 |
| 5.10 | Verify `prefers-reduced-motion` disables all animations | 10m | Phase 1 |
| 5.11 | End-to-end state sequence test: idle → submit → processing → completed → error | 20m | All phases |
| 5.12 | Final coverage check: all 71 items verified against V2 mockup | 15m | 5.1-5.11 |
| 5.13 | Final screenshot set + comparison + report | 15m | 5.12 |

**Dependency:** All previous phases complete
**Risk:** Medium — responsive edge cases, timing tuning, a11y gaps
**Rollback:** Revert any single-phase file changes

**Verification:** Build → Deploy → Full screenshot set (desktop + mobile, all states) → Compare with V2 mockup all sections

---

## Dependency Graph

```
Phase 1 (Foundation)
  └── Phase 2 (Homepage)
       └── Phase 3 (Analysis)
            └── Phase 4 (Results)
                 └── Phase 5 (Mobile + Polish)
```

No parallel execution — each phase depends on the previous. This ensures rollback safety and prevents cascading failures.

---

## Effort Summary

| Phase | Items | Est. Time | Risk | Files |
|---|---|---|---|---|
| 1 — Foundation | 8 | 60 min | Low | 1 (`globals.css`) |
| 2 — Homepage | 16 | 115 min | Low | 2 |
| 3 — Analysis | 11 | 115 min | Medium | 2 |
| 4 — Results | 22 | 280 min | Medium-High | 2 |
| 5 — Mobile + Polish | 14 | 155 min | Medium | 2 |
| **Total** | **71** | **~11.5 hours** | — | **2 files** |

---

## Rollback Strategy

| Scenario | Action |
|---|---|
| Phase 1 breaks styles | `git checkout globals.css` |
| Phase 2 breaks homepage | `git checkout page.tsx globals.css` |
| Phase 3 breaks analysis | `git checkout page.tsx globals.css` |
| Phase 4 breaks results | `git checkout page.tsx globals.css` — old card layout restored |
| Phase 5 breaks mobile | Fix specific CSS breakpoint; worst case revert to Phase 4 state |
| Production incident | `pm2 deploy ecosystem.config.js --revert` or `git checkout -- .` on deployed path |

---

## Coverage Tracking

Will be updated after each phase:

```
Phase 1:  [x] 8/71
Phase 2:  [x] 24/71
Phase 3:  [x] 35/71 (1 blocked)
Phase 4:  [x] 57/71
Phase 5:  [x] 71/71 (1 blocked)
```

