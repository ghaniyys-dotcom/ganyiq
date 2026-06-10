# GANYIQ Frontend Redesign Proposal

## Current State Assessment

The existing frontend is a functional MVP with generic AI aesthetics:
- Purple accent (`#8b5cf6`) — most overused "AI" color
- System font stack — no typographic identity
- 640px max-width — feels cramped, not editorial
- Simple indeterminate progress bar
- Moment cards as uniform database rows
- Generic dark theme indistinguishable from AI startup templates

---

## 1. Design System

### Positioning

Not an AI tool. A professional content studio.

The interface should feel like opening a producer's edit bay — dark, focused, with content as the hero. Every element should communicate that the clips inside have been curated, not generated.

### Visual Language

| Quality | Expression |
|---|---|
| **Editorial** | Generous whitespace, serif/scaled typography, pull-quote moments |
| **Professional** | Precision spacing, restrained color, clear hierarchy |
| **Fast** | No spinners — skeleton reveals, instant transitions, micro-optimistic UI |
| **Calm** | Dark canvas, minimal chrome, content-first |

### Strict Avoid List
- Purple gradients ❌
- Neon glows ❌
- Floating particles ❌
- Glassmorphism ❌
- Robot icons ❌
- Circuit patterns ❌
- Animated AI brains ❌

---

## 2. Color System

### Dark Studio Palette

| Token | Hex | Role |
|---|---|---|
| `--surface-page` | `#0a0a0b` | Page canvas — deep studio dark |
| `--surface-panel` | `#121213` | Card/panel surface |
| `--surface-elevated` | `#1a1a1c` | Hovered/focused surfaces |
| `--surface-input` | `#18181b` | Input backgrounds |
| `--border-subtle` | `rgba(255,255,255,0.06)` | Card borders |
| `--border-default` | `rgba(255,255,255,0.10)` | Input borders |
| `--text-primary` | `#f4f4f5` | Primary content |
| `--text-secondary` | `#a1a1aa` | Supporting text |
| `--text-tertiary` | `#71717a` | Metadata, timestamps |
| `--accent` | `#e8c76a` | Warm gold — editorial highlight, NOT purple |
| `--accent-subtle` | `rgba(232,199,106,0.12)` | Tag backgrounds, subtle highlights |
| `--accent-emerald` | `#5bb98a` | Success states, confidence indicators |
| `--accent-ruby` | `#e06b6b` | Errors, destructive actions |

**Why warm gold?** Gold says "curated selection," "editorial pick," "premium." It's the opposite of purple-AI. Gold on dark feels like a film festival award, not a dashboard.

---

## 3. Typography System

### Font Stack

| Role | Font | Source |
|---|---|---|
| Display / Headings | **Geist** weight 500-600 | Google Fonts |
| Body / UI | **Geist** weight 400-500 | Google Fonts |
| Monospace (timestamps, scores) | **Geist Mono** weight 400-500 | Google Fonts |

### Hierarchy

| Element | Size | Weight | Letter-Spacing | Line-Height |
|---|---|---|---|---|
| Logo / Brand | 28px | 600 | -0.02em | 1.0 |
| Section title | 15px | 500 | 0.06em | 1.0 — uppercase |
| Analysis stage label | 18px | 500 | -0.01em | 1.3 |
| Clip rank number | 42px | 600 | -0.03em | 1.0 |
| Clip title (reasoning) | 16px | 400 | 0 | 1.5 |
| Score number | 28px | 600 | -0.02em | 1.0 |
| DNA tag | 12px | 500 | 0.01em | 1.0 |
| Timestamp | 14px | 500 | 0 | 1.3 |
| Caption / meta | 12px | 400 | 0.02em | 1.4 |
| Transcript excerpt | 14px | 400 | 0 | 1.6 |

### Typography Principles
- Weight 500 is the workhorse — 400 for reading, 600 for emphasis only
- No uppercase except for section labels
- Letter-spacing tightens at larger sizes (Geist's native behavior)
- Everything in sentence case (not Title Case, not ALL CAPS)

---

## 4. Layout System

### Grid

Based on **8px unit**. Key measurements:

| Breakpoint | Max Width | Columns | Gutter |
|---|---|---|---|
| Mobile | 100% | 1 | 16px |
| Tablet | 672px | 1 | 24px |
| Desktop | 896px | 1 (wide editorial) | 32px |

**Why 896px?** Not 640px (too narrow for editorial). Not 1200px (too wide for content cards). 896px = optimal reading width for card-based content with generous padding.

### Spacing Scale

`4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 80`

- Section gaps: 48px
- Card padding: 20px
- Card gap: 12px
- Inset spacing: 16px

---

## 5. Motion System

### Principles
- **Fast**: 150-200ms for UI transitions
- **Purposeful**: Only animate when it communicates state change
- **No decorative animation**: No floating, no parallax, no confetti

### Specific Motions

| Element | Trigger | Animation | Duration | Easing |
|---|---|---|---|---|
| Stage transition | Status poll | Cross-fade content | 200ms | ease-out |
| Progress bar | Stage update | Width slide | 300ms | ease-in-out |
| Clip cards appear | Results load | Staggered fade-slide-up | 150ms per card | ease-out |
| Button hover | Hover | Background brighten | 100ms | ease |
| Page load | Mount | Fade in | 300ms | ease-out |

### Progress Experience (Not a Spinner)

Replace the generic progress bar with a **stage timeline**:

```
[● Fetching transcript] ─── [○ Extracting] ─── [○ Analyzing] ─── [○ Ranking]
```

Each stage is a dot connected by a line. Current stage pulses. Completed stages show a checkmark. This answers "What is happening right now?" at a glance.

---

## 6. Dashboard Redesign — Current Page

### Layout

```
┌──────────────────────────────────────────┐
│  GANYIQ                               → │  <- Minimal header, no tagline clutter
├──────────────────────────────────────────┤
│                                          │
│  ┌────────────────────────────────────┐  │
│  │  Paste YouTube URL               ▶ │  │  <- Clean input, full width
│  └────────────────────────────────────┘  │
│                                          │
│  Recent Analyses                         │  <- Section label, compact
│  ┌──────────────┬─────────────────────┐  │
│  │  [thumbnail] │ Title               │  │
│  │              │ Channel • 12 clips  │  │
│  ├──────────────┼─────────────────────┤  │
│  │  [thumbnail] │ Title               │  │
│  │              │ Channel • 8 clips   │  │
│  └──────────────┴─────────────────────┘  │
│                                          │
│  (center: empty state, minimal icon)     │
│                                          │
└──────────────────────────────────────────┘
```

### Key Changes from Current
- **Remove** purple "GANY" accent — use gold or keep white with badge
- **Remove** tagline ("Find clip-worthy moments...") — product should be self-evident
- **Widen** from 640px to 896px
- **History cards** become horizontal rows with thumbnail, not cards
- **Empty state** minimal — one line, no large SVG

---

## 7. Analysis Experience Redesign

### Stage Timeline (Replaces Progress Bar)

```
  ┌───●───○───○───○───┐
  │                    │
  Fetching transcript  12s
```

Active stage: filled circle with label below
Completed stages: checkmark in circle
Upcoming stages: outlined circle
Elapsed time shown prominently

### During Analysis

```
┌──────────────────────────────────────────┐
│  ● Fetching transcript   ─── ○ Analyzing │
│  ○ Extracting candidates ─── ○ Ranking   │
│                                          │
│  Elapsed: 47s                            │
│                                          │
│  (skeleton cards fade in as moments      │
│   are discovered — shows "12 moments     │
│    found so far" live counter)           │
└──────────────────────────────────────────┘
```

### Live Discovery Counter

As the backend finds moments, the UI shows a **live-growing count**:
- "12 moments discovered" → "24 moments discovered" → "48 moments discovered"
- This gives the user a sense of progress even during the long analysis

### Skeleton Cards

During analysis, show placeholder card outlines that gradually fill in. When results arrive, the skeletons transition smoothly into real content. This feels faster than a blank → full-content jump.

---

## 8. Results Page Redesign

### Editorial Clip Grid

The current card layout feels like database rows. Replace with an **editorial grid** that communicates curation.

### Elite Section (Hero)

```
┌──────────────────────────────────────────────┐
│  Picks of the Analysis                       │  <- Editorial label
│                                              │
│  ┌────────────────────────────────────────┐  │
│  │  #1                         100  ★     │  │
│  │  12:13 — 13:25                        │  │
│  │  "Why am I being judged right now..."  │  │
│  │  [hookPower] [shock] [curiosity]       │  │
│  │                          [Generate ▶]  │  │
│  └────────────────────────────────────────┘  │
│                                              │
│  ┌──────┬──────┬──────┬──────┬──────┐        │
│  │ #2   │ #3   │ #4   │ #5   │ #6   │        │
│  │ 100  │ 100  │ 99   │ 100  │ 95   │        │
│  │ 18:29│ 58:01│ 38:00│1:01:27│ 3:11 │        │
│  └──────┴──────┴──────┴──────┴──────┘        │
│                                              │
│  Also Notable                                │  <- Secondary section
│  ┌──────┬──────┬──────┬──────┬──────┐        │
│  │ #7   │ #8   │ #9   │ #10  │ #11  │        │
│  │ 79   │ 77   │ 74   │ 74   │ 73   │        │
│  └──────┴──────┴──────┴──────┴──────┘        │
└──────────────────────────────────────────────┘
```

### Key Changes

1. **Hero clip** — The #1 elite pick gets a large featured card with full reasoning + transcript excerpt
2. **Thumbnail strip** — Remaining elite clips shown as compact cards in a horizontal scroll row
3. **Secondary grid** — Secondary clips in a compact grid, not full cards
4. **Score visualization** — Replace number with a thin horizontal bar (like a histogram). At a glance you see the score distribution.
5. **Generate CTA** — Per-clip button moves to card bottom-right, labeled "Generate Clip" or showing download state

### Clip Card (Expanded)

```
┌──────────────────────────────────────────────┐
│  #1  ● Elite                    Score  ━━━━  │  <- Rank + tier badge (left), score bar (right)
│                                              │
│  12:13 — 13:25                   2m 14s      │  <- Timestamp + duration
│                                              │
│  "Why am I being judged right now for        │  <- Reasoning (first sentence, editorial)
│   curating my car collection?"               │
│                                              │
│  [hookPower] [shock] [curiosity]             │  <- DNA tags as subtle pills
│                                              │
│  "But seriously, why am I being judged...    │  <- Transcript excerpt (collapsible)
│   I spend my money on cars..."               │
│                                              │
│  ┌────────────────────────────────────────┐  │
│  │  Generate Clip                    ▶    │  │  <- CTA button
│  └────────────────────────────────────────┘  │
└──────────────────────────────────────────────┘
```

### Score Bars

Replace the numeric score with a thin horizontal bar:

```
Score  ━━━━━━━━━━━━━━━━━━░░░░░░░░░░░░  82
```

The bar fills proportionally. Elite clips get a gold bar. Secondary clips get a neutral bar. This makes the score distribution visual at a glance — you can see which clips scored close together without reading numbers.

---

## 9. Component Specs (Ready for Implementation)

### Input Component
- Full-width text input with inset search icon
- Rounded: 10px
- Background: `#18181b`
- Border: `1px solid rgba(255,255,255,0.10)`
- Focus: `1px solid var(--accent)`
- Submit button: pill shape, 32px padding horizontal, gold accent
- Placeholder: "Paste a YouTube link"

### Stage Timeline Component
- Horizontal flex, dot-line-dot-line-dot pattern
- Active dot: 10px filled circle in `var(--accent)` with pulse animation
- Completed dot: 10px filled circle with checkmark
- Incomplete dot: 10px outlined circle at `rgba(255,255,255,0.2)`
- Connecting line: 2px solid, `rgba(255,255,255,0.08)`, 48px wide
- Stage label: 13px Geist weight 500, `var(--text-secondary)`
- Active stage label: `var(--text-primary)`
- Elapsed time: 12px Geist Mono, `var(--text-tertiary)`, right-aligned

### Elite Hero Card
- Background: `var(--surface-panel)`
- Border: `1px solid rgba(232,199,106,0.15)`
- Border-radius: 12px
- Padding: 24px
- Left accent: 3px solid `var(--accent)`
- Layout: Two-column on desktop (reasoning left, score+tags right)
- "Picks of the Analysis" label above: 12px uppercase, 0.06em spacing

### Compact Clip Card (Elite Row)
- 140px wide, 180px tall
- Background: `var(--surface-panel)`
- Border-radius: 10px
- Shows: rank number, score, timestamp, first DNA tag
- Hover: slight lift and border brighten
- Click: expands to full view

### Clip Card (Standard)
- Background: `var(--surface-panel)`
- Border: `1px solid var(--border-subtle)`
- Border-radius: 10px
- Padding: 16px
- Score bar: 4px tall, `var(--accent)` for elite, `white 0.15 opacity` for secondary
- Tags: pill-shaped, `var(--accent-subtle)` background, `var(--accent)` text, 11px
- Reasoning: 14px, 1.5 line-height, `var(--text-secondary)`
- Timestamp: Geist Mono, 13px, `var(--text-tertiary)`
- Duration: computed from endTime - startTime, shown as "2m 14s"

### Generate Clip Button
- Default: ghost button, `1px solid rgba(255,255,255,0.1)`, 8px 16px, rounded 8px
- Generating: subtle pulse on text, disabled
- Ready: solid `var(--accent-emerald)` background, white text
- Failed: `var(--accent-ruby)` border, retry label

---

## Implementation Order

1. **Foundation**: CSS variables, typography, color tokens, layout grid
2. **Input section**: Hero input with stage timeline component
3. **Analysis experience**: Stage timeline + skeleton cards + live discovery counter
4. **Results page**: Elite hero card + compact card row + secondary grid + score bars
5. **History**: Compact horizontal rows with thumbnail
6. **Motion**: Micro-interactions, stage transitions, staggered card reveals
7. **Polish**: Empty state, error states, edge cases

All CSS changes. No new backend work. No new API endpoints.
