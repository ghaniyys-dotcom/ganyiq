# GANYIQ — High-Fidelity UI/UX Specification

> **Status:** Design Review Only · **Version:** 1.0
> **Designer:** Hermes Agent (Staff Product Designer)
> **References:** Linear, Raycast, Readwise Reader, Notion Calendar, Arc Browser

---

## SECTION 1 — VISUAL DIRECTION

### 1.1 Design Philosophy

GANYIQ is a **professional content studio**, not an AI tool.

The interface should feel like walking into an editor's suite — dark, focused, every surface purposeful. Content emerges from darkness like film in a darkroom. The product doesn't advertise itself as AI; it lets the quality of the curated clips speak.

**Decision: Dark Studio, Not Dark Mode**

Most dark UIs are light UIs with inverted colors — they feel like "dark mode." GANYIQ should feel native-dark, like Linear or Arc Browser: born in darkness, with every surface color chosen for the dark first, not converted from light.

### 1.2 Brand Personality

| Attribute | Expression |
|---|---|
| **Curatorial** | Results feel hand-picked, not algorithmically dumped |
| **Fast** | No spinners — skeleton reveals, instant transitions |
| **Calm** | Dark canvas absorbs attention, no visual shouting |
| **Premium** | Generous spacing, precise typography, restrained color |
| **Professional** | Clear hierarchy, every pixel has a job |

### 1.3 Color Psychology

**Why Warm Gold Instead of Purple?**

Purple (`#8b5cf6`) is the default color of "AI startup" — it signals:
- "I am an AI company"
- "I was built by developers"
- "I look like every other AI tool"

Gold (`#e8c76a`) signals:
- "Curated selection"
- "Editorial judgment"
- "Premium content"
- "Film festival / award winner"

Gold on dark is the color of **editorial photography** — it says these clips have been chosen, not generated.

**Full Palette:**

```css
/* Surface — the studio dark, not generic dark mode */
--surface-page: #0a0a0b;       /* Page background — deepest darkness */
--surface-panel: #121213;       /* Card/panel surface — one step up */
--surface-elevated: #1c1c1e;   /* Hover/focus surface */
--surface-input: #18181b;      /* Input fields */

/* Borders — ultra-subtle, like Linear */
--border-subtle: rgba(255,255,255,0.06);
--border-default: rgba(255,255,255,0.10);
--border-accent: rgba(232,199,106,0.20);

/* Text — never pure white */
--text-primary: #f4f4f5;       /* Headlines, key content */
--text-secondary: #a1a1aa;     /* Body, descriptions */
--text-tertiary: #71717a;      /* Timestamps, metadata */
--text-quaternary: #52525b;    /* Placeholders, disabled */

/* Accent — editorial gold */
--accent: #e8c76a;             /* Primary interaction color */
--accent-hover: #f0d878;       /* Hover state */
--accent-subtle: rgba(232,199,106,0.12);  /* Tag bg, subtle highlights */
--accent-text: #f4e8b0;        /* Text on gold backgrounds */

/* Status — confident, not loud */
--status-success: #5bb98a;     /* Completed, ready */
--status-error: #e06b6b;       /* Failed */
--status-info: #6b9ec4;        /* Informational */

/* Score bar — gradient from low to high */
--score-low: rgba(255,255,255,0.08);
--score-mid: rgba(232,199,106,0.50);
--score-high: var(--accent);
```

### 1.4 Typography Philosophy

**Decision: Geist as Primary**

Geist is already in the project (`layout.tsx` imports it). It is:
- Designed by Vercel for editorial + technical content
- Has aggressive negative tracking at display sizes — feels compressed, engineered
- Weight 500 is the perfect "medium-plus" for UI text
- Geist Mono for timestamps and scores — creates a technical editorial contrast

**Why this feels premium:**
- Geist at display sizes (`28px+`) uses negative letter-spacing: `-0.03em` at 42px, `-0.02em` at 28px — this compression creates visual density that signals intentional design
- At body sizes (`14px-16px`), letter-spacing normalizes to `0` for readability
- The contrast between compressed headlines and open body text creates editorial rhythm

**Current problem:** The existing CSS uses system font stack (`-apple-system, BlinkMacSystemFont...`) — this is the most generic choice possible. Geist variables are already defined in `layout.tsx` but never applied.

---

## SECTION 2 — HOMEPAGE MOCKUP (Desktop)

### 2.1 Overall Layout

```
┌──────────────────────────────────────────────────────────────────┐
│                                                                  │
│   ┌────────────────────────────────────────────────────────┐     │
│   │  GANYIQ                                          v1.0  │     │  ← Header: 64px
│   └────────────────────────────────────────────────────────┘     │
│                                                                  │
│   ┌────────────────────────────────────────────────────────┐     │
│   │                                                        │     │
│   │  ┌──────────────────────────────────────────────┐      │     │
│   │  │  Paste a YouTube link                    ▶   │      │     │  ← Input zone: 140px
│   │  └──────────────────────────────────────────────┘      │     │
│   │                                                        │     │
│   └────────────────────────────────────────────────────────┘     │
│                                                                  │
│   ┌────────────────────────────────────────────────────────┐     │
│   │  Recent Analyses                                       │     │  ← Section label: 20px pad
│   │                                                        │     │
│   │  ┌──────┬────────────────────────────────────────────┐ │     │
│   │  │  img │  Andre Taulany Marah-Marah!...      12 min │ │     │  ← History row: 64px
│   │  │      │  VINDES  ·  15 clips  ·  Avg 90     ▶    │ │     │
│   │  ├──────┼────────────────────────────────────────────┤ │     │
│   │  │  img │  Andre Taulany Marah-Marah!...      12 min │ │     │
│   │  │      │  VINDES  ·  15 clips  ·  Avg 79     ▶    │ │     │
│   │  └──────┴────────────────────────────────────────────┘ │     │
│   │                                                        │     │
│   └────────────────────────────────────────────────────────┘     │
│                                                                  │
│   ┌────────────────────────────────────────────────────────┐     │
│   │                                                        │     │
│   │              No analyses yet — paste a link             │     │  ← Empty state
│   │              above to get started                       │     │
│   │                                                        │     │
│   └────────────────────────────────────────────────────────┘     │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘

Total width: 896px (centered in viewport)
Content padding: 32px horizontal
Section gap: 48px
```

### 2.2 Header Component

```
┌──────────────────────────────────────────────────────────────┐
│  GANYIQ                                              v1.0  │
│  --font-geist-sans weight 500, 20px, -0.02em               │
│  left: logo, right: version tag                             │
│  border-bottom: 1px solid rgba(255,255,255,0.06)            │
│  height: 48px (compact)                                     │
└──────────────────────────────────────────────────────────────┘
```

| Property | Value |
|---|---|
| Height | 48px |
| Padding | 0 32px |
| Logo font | Geist, 20px, weight 500, `-0.02em` |
| Logo color | `var(--text-primary)` |
| Version | Geist Mono, 11px, weight 400, `var(--text-quaternary)` |
| Border bottom | `1px solid var(--border-subtle)` |
| Background | `var(--surface-page)` |

**No tagline.** The tagline "Find clip-worthy moments in any YouTube video" is removed. The product should be self-evident. Premium products don't explain themselves in the header.

### 2.3 Input Component

```
┌──────────────────────────────────────────────────────────────┐
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  Paste a YouTube link                           ▶    │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
└──────────────────────────────────────────────────────────────┘

Height: 48px input + 32px surrounding padding = 112px total section
```

| Property | Value |
|---|---|
| Input height | 48px |
| Input padding | 0 16px |
| Input background | `var(--surface-input)` |
| Input border | `1px solid var(--border-default)` |
| Input border-radius | 10px |
| Input font | Geist, 15px, weight 400 |
| Input color | `var(--text-primary)` |
| Placeholder | `var(--text-quaternary)`, "Paste a YouTube link" |
| Focus border | `1px solid var(--accent)` |
| Submit button | Positioned inside input (right side), 36px × 36px, `var(--accent)` bg, rounded 8px |
| Submit hover | `var(--accent-hover)` |
| Submit disabled | `rgba(232,199,106,0.3)` |
| Container | `display: flex; align-items: center;` |
| Container background | `var(--surface-panel)` |
| Container border | `1px solid var(--border-subtle)` |
| Container border-radius | 12px |
| Container padding | 16px |

**States:**
- **Empty:** Placeholder visible, submit button disabled (low opacity)
- **Valid URL:** Submit button active (full gold)
- **Invalid URL:** On submit, show error inline below input — `color: var(--status-error)`, 13px, with shake animation
- **Loading:** Input disabled (opacity 0.5), submit shows subtle pulse

### 2.4 History Section

```
┌──────────────────────────────────────────────────────────────┐
│  Recent Analyses                                     see all │
│                                                              │
│  ┌──────┬────────────────────────────────────────────┐       │
│  │  img │  Andre Taulany Marah-Marah!...              │       │
│  │ 72px │  VINDES  ·  15 clips  ·  Avg 90     Open  │       │
│  │ 54px │                            Yesterday       │       │
│  └──────┴────────────────────────────────────────────┘       │
└──────────────────────────────────────────────────────────────┘
```

| Property | Value |
|---|---|
| Section title | Geist, 13px, weight 500, `0.04em` letter-spacing, uppercase, `var(--text-tertiary)` |
| Row height | 64px |
| Row background | `var(--surface-panel)` |
| Row border | `1px solid var(--border-subtle)` |
| Row border-radius | 10px |
| Row padding | 12px |
| Row gap (internal) | 12px |
| Thumbnail | 72×54px, `border-radius: 6px`, `object-fit: cover` |
| Title font | Geist, 14px, weight 500, single-line ellipsis |
| Meta font | Geist, 12px, weight 400, `var(--text-tertiary)` |
| Avg score color | `var(--accent)`, weight 600 |
| Date | `var(--text-quaternary)`, right-aligned |
| Open button | Ghost: transparent bg, `1px solid rgba(255,255,255,0.08)`, 8px 14px, rounded 8px, 13px |
| Open hover | Border brightens to `rgba(255,255,255,0.2)` |
| Row gap (between) | 8px |
| Max visible | 5 rows (expandable) |
| "see all" link | Only if >5 items, 13px, `var(--text-tertiary)`, hover → `var(--text-secondary)` |

**Empty state (no history):** Hidden entirely. The "Recent Analyses" section only appears when there are items.

### 2.5 Empty State

```
┌──────────────────────────────────────────────────────────────┐
│                                                              │
│                                                              │
│                    ◇  (Minimal icon, 24px)                   │
│                    16px                                      │
│                    No analyses yet                            │
│                    Paste a YouTube link above to start        │
│                                                              │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

| Property | Value |
|---|---|
| Icon | Simple outline circle/dot, 24px, `var(--text-quaternary)`, no SVG complexity |
| Text | Geist, 14px, weight 400, `var(--text-tertiary)` |
| Spacing | Centered, 80px padding top |
| Visibility | Only when `stage === 'idle'` AND no result AND no history items |

**Why remove the large SVG?** The current page has a 64×64 SVG video icon. It feels like a generic SaaS empty state. Premium products keep empty states minimal — the input IS the primary CTA, not the empty state.

### 2.6 Loading State (Initial Submit)

When user submits URL:

1. Input immediately shows loading state (disabled, subtle pulse on button)
2. No full-screen loader — the input IS the interaction point
3. After 2 seconds (if no status update), transition to Analysis Experience (Section 3)

---

## SECTION 3 — ANALYSIS STATE MOCKUP (Desktop)

### 3.1 During Analysis — Full Screen

```
┌──────────────────────────────────────────────────────────────┐
│  GANYIQ                                              v1.0  │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│                        Analyzing                             │
│                        ────────                              │
│                        Your video                             │
│                                                              │
│              ●─────────○─────────○─────────○                  │
│        Fetching   Extracting   Analyzing   Ranking            │
│                                                              │
│                       Elapsed: 2m 47s                        │
│                                                              │
│               ┌────┐  ┌────┐  ┌────┐  ┌────┐                │
│               │    │  │    │  │    │  │    │                │
│               │    │  │    │  │    │  │    │                │
│               │    │  │    │  │    │  │    │                │
│               └────┘  └────┘  └────┘  └────┘                │
│                    12 moments discovered                     │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### 3.2 Stage Timeline Component

```
  ●─────────○─────────○─────────○
Fetching   Extracting  Analyzing  Ranking
```

| Property | Value |
|---|---|
| Layout | Horizontal flex, centered, gap 0 |
| Stage dot (active) | 8px circle, `var(--accent)` fill, subtle pulse animation |
| Stage dot (completed) | 8px circle, `var(--accent)` fill, checkmark inside |
| Stage dot (upcoming) | 8px circle, `rgba(255,255,255,0.15)` border, no fill |
| Connecting line | 48px wide, 2px tall, `rgba(255,255,255,0.08)` |
| Connecting line (completed) | `var(--accent)` at 0.4 opacity |
| Label | Geist, 12px, weight 500, centered below dot |
| Label (active) | `var(--text-primary)` |
| Label (completed) | `var(--text-tertiary)` |
| Label (upcoming) | `var(--text-quaternary)` |

**Stage mapping (backend → frontend):**

| Backend Stage | Timeline Label | Icon |
|---|---|---|
| `fetching_transcript` | Fetching | Download arrow |
| `extracting_candidates` | Extracting | Grid/signal icon |
| `batch_analysis` | Analyzing | Brain/sparkle icon |
| `multi_pass` | Analyzing | (same as above — merged) |
| `ranking` | Ranking | Bars/triangle icon |
| `storing_results` | Ranking | (same as above — merged) |

**Why merge multi_pass into Analyzing and storing_results into Ranking?** Showing 6 stages would be too many for the timeline. 4 stages is the maximum for quick comprehension. The longest stages (batch_analysis + multi_pass) share one label.

### 3.3 Elapsed Timer

```
Elapsed: 2m 47s
```

| Property | Value |
|---|---|
| Font | Geist Mono, 14px, weight 400 |
| Color | `var(--text-tertiary)` |
| Alignment | Center, below timeline, 24px gap |
| Update | Every second, smooth number transition |

### 3.4 Discovery Counter

```
12 moments discovered
```

| Property | Value |
|---|---|
| Font | Geist, 15px, weight 500 |
| Color | `var(--text-secondary)` |
| Alignment | Center, below skeleton cards, 16px gap |
| Count source | Increment based on stage progress polling — not fake |
| Transition | Number changes with a subtle scale pulse on update |

**Implementation:** This is not a fake "generating" counter. It updates when the status endpoint reports a new stage that implies more moments were found. Specifically:
- After `batch_analysis` completes → show total from `candidates_validated` metric (known from debug logs)
- During `ranking` → show count approaching final number

### 3.5 Skeleton Cards

```
  ┌────┐  ┌────┐  ┌────┐  ┌────┐
  │    │  │    │  │    │  │    │
  │    │  │    │  │    │  │    │
  │    │  │    │  │    │  │    │
  └────┘  └────┘  └────┘  └────┘
```

| Property | Value |
|---|---|
| Card width | 180px |
| Card height | 120px |
| Card background | `var(--surface-panel)` |
| Card border | `1px solid var(--border-subtle)` |
| Card border-radius | 10px |
| Cards per row | 4 (based on 896px ÷ (180px + 12px gap)) |
| Gap | 12px |
| Animation | Subtle shimmer — `linear-gradient` sweep at `-45deg` over `rgba(255,255,255,0.03)` base |
| Shimmer color | `rgba(255,255,255,0.06)` |
| Shimmer duration | 2s, infinite |
| Count | Start with 4, grow to 8 after `batch_analysis` stage |

**Why skeleton cards instead of a spinner?** A spinner says "wait." Skeleton cards say "content is coming." During a 10-minute analysis, the user has something to look at — a preview of the grid that will soon contain their clips.

---

## SECTION 4 — RESULTS PAGE MOCKUP (Desktop)

### 4.1 Overall Layout

```
┌──────────────────────────────────────────────────────────────┐
│  GANYIQ                                              v1.0  │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  Picks of the Analysis                                       │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  #1                                            ● Elite │  │
│  │  12:13 — 14:10                         Duration 1m 57s │  │
│  │                                                        │  │
│  │  Immediately defensive with 'Why am I being judged?'   │  │  ← Elite Hero Card
│  │  sparking intrigue and conflict in the first seconds.  │  │     352px tall
│  │                                                        │  │
│  │  [hookPower] [shock] [curiosity]                       │  │
│  │                                                        │  │
│  │  "Iya. Maaf. Kenapa aku dijudge? Siapa yang            │  │
│  │  nge-judge? Gua semes badeja l badeja..."              │  │
│  │                                                        │  │
│  │  Score                                  ━━━━━━━ 100   │  │
│  │                           [Generate Clip        ▶   ] │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│  More Picks                                                  │
│                                                              │
│  ┌────┐  ┌────┐  ┌────┐  ┌────┐  ┌────┐                    │
│  │ #2 │  │ #3 │  │ #4 │  │ #5 │  │ #6 │                    │  ← Elite Row (compact)
│  │100 │  │100 │  │ 99 │  │100 │  │ 95 │                    │     5 cards
│  │18:2│  │58:0│  │38:0│  │1:01│  │ 3:1│                    │
│  │hook│  │vuln│  │shoc│  │cont│  │stor│                    │
│  └────┘  └────┘  └────┘  └────┘  └────┘                    │
│                                                              │
│  Also Notable                                                │
│                                                              │
│  ┌──────┬──────┬──────┬──────┬──────┬──────┬──────┐         │
│  │  #7  │  #8  │  #9  │ #10  │ #11  │ #12  │ #13  │         │  ← Secondary Row
│  │  79  │  77  │  74  │  74  │  73  │  75  │  73  │         │     7 compact cards
│  │  curi│  cont│  curi│  curi│  humor│  humor│  curi│         │
│  └──────┴──────┴──────┴──────┴──────┴──────┴──────┘         │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### 4.2 Elite Hero Card (#1 Clip)

**Dimensions:** Full width (832px content area), approximately 352px tall.

```
┌──────────────────────────────────────────────────────────────┐
│  #1                                            ● Elite      │
│  12:13 — 14:10                         Duration 1m 57s      │
│                                                              │
│  Reasoning text in full... displays the complete reasoning   │
│  from the LLM. This is the editorial justification.          │
│                                                              │
│  [hookPower] [shock] [curiosity]                             │  ← DNA tags (pills)
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  "Iya. Maaf. Kenapa aku dijudge? Siapa yang             │  │
│  │  nge-judge? Gua semes badeja l badeja..."               │  │  ← Transcript block
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│  Score                                     ━━━━━━  100       │  ← Score bar + number
│                          [Generate Clip              ▶    ]  │  ← CTA
└──────────────────────────────────────────────────────────────┘
```

| Region | Element | Spec |
|---|---|---|
| **Top row** | Rank | Geist, 24px, weight 600, `-0.02em`, `var(--text-primary)` |
| Top row | Tier badge | 8px × 8px dot in `var(--accent)`, + "Elite" label in Geist 12px 500 |
| Top row | Timestamp | Geist Mono, 13px, `var(--text-tertiary)` |
| Top row | Duration | Geist Mono, 13px, `var(--text-quaternary)`, right-aligned |
| | **Divider** | 1px `var(--border-subtle)`, 8px above/below |
| **Body** | Reasoning | Geist, 15px, weight 400, `1.6` line-height, `var(--text-secondary)`, 3 lines max |
| Body | DNA tags | Row of pills, 12px Geist 500, `var(--accent-subtle)` bg, `var(--accent-text)` text, 8px horizontal padding, 6px radius, 6px gap |
| Body | Transcript block | Geist, 13px, weight 400, `1.5` line-height, `var(--text-tertiary)`, `var(--surface-input)` bg, 12px padding, 8px radius, 3 lines max with ellipsis + "Show more" toggle |
| **Bottom row** | Score label | Geist, 12px, weight 500, `var(--text-tertiary)` |
| Bottom row | Score bar | 120px wide, 4px tall, rounded 2px, gradient from `var(--score-low)` → `var(--score-high)`, filled proportionally |
| Bottom row | Score number | Geist Mono, 20px, weight 600, `var(--accent)` |
| Bottom row | CTA button | Geist, 14px, weight 500, 10px 20px padding, rounded 8px, `var(--accent)` bg, white text, hover → `var(--accent-hover)` |
| | **Card border** | `1px solid rgba(232,199,106,0.15)`, 12px radius |
| | **Card bg** | `var(--surface-panel)` |
| | **Card padding** | 24px |
| | **Left accent** | 3px solid `var(--accent)`, `border-radius: 12px 0 0 12px` |

### 4.3 Elite Row (Compact Cards — Ranks 2-6)

```
┌──────┐  ┌──────┐  ┌──────┐  ┌──────┐  ┌──────┐
│  #2  │  │  #3  │  │  #4  │  │  #5  │  │  #6  │
│ 100  │  │ 100  │  │  99  │  │ 100  │  │  95  │
│ 18:29│  │ 58:01│  │ 38:00│  │1:01:27│  │ 3:11 │
│hookPow│  │vulner│  │shock │  │contro│  │storyt│
└──────┘  └──────┘  └──────┘  └──────┘  └──────┘
```

| Property | Value |
|---|---|
| Card width | 144px |
| Card height | 160px |
| Background | `var(--surface-panel)` |
| Border | `1px solid var(--border-subtle)` |
| Border-radius | 10px |
| Padding | 16px |
| Gap (between cards) | 12px |
| Rank | Geist, 14px, weight 500, `var(--text-tertiary)` |
| Score | Geist, 28px, weight 600, `-0.02em`, `var(--accent)` |
| Timestamp | Geist Mono, 12px, `var(--text-quaternary)` |
| First DNA tag | Geist, 11px, weight 500, truncated to 6 chars, `var(--text-tertiary)` |
| Hover | Border brightens to `rgba(232,199,106,0.2)`, cursor pointer |
| Click | Expands that clip into the hero card position (or scrolls to full view) |

**Section label above:** "More Picks" — Geist, 13px, weight 500, `0.04em` uppercase, `var(--text-tertiary)`, 20px bottom margin.

### 4.4 Secondary Row (Compact Cards — Ranks 7-15)

```
┌──────┬──────┬──────┬──────┬──────┬──────┬──────┐
│  #7  │  #8  │  #9  │ #10  │ #11  │ #12  │ #13  │
│  79  │  77  │  74  │  74  │  73  │  75  │  73  │
│ curi │ cont │ curi │ curi │ humor│ humor│ curi │
└──────┴──────┴──────┴──────┴──────┴──────┴──────┘
```

| Property | Value |
|---|---|
| Card width | 108px |
| Card height | 100px |
| Score color | `var(--text-secondary)` (neutral, not gold) |
| Font sizes | Score: 20px weight 600, Rank: 12px weight 400, Tag: 10px |
| Border | `1px solid var(--border-subtle)` |
| No hover elevation | Secondary cards don't elevate — visual hierarchy |
| Gap | 8px |

**Section label above:** "Also Notable" — same style as "More Picks".

### 4.5 Score Bar (Inline Detail)

```
Score                           ━━━━━━━━━━━━━━━━━━━━━░░░  82
```

| Property | Value |
|---|---|
| Bar width | 120px (or 160px in hero card) |
| Bar height | 4px |
| Bar background | `var(--score-low)` |
| Bar fill | Background gradient: `var(--score-low)` → `var(--score-high)` or solid `var(--accent)` |
| Fill width | Proportional to `score / 100` |
| Border-radius | 2px |
| Number | Geist Mono, 20px, weight 600 |

### 4.6 Generate Clip Button States

| State | Visual |
|---|---|
| **Idle** | `var(--accent)` bg, "Generate Clip" text, 8px 16px, rounded 8px |
| **Generating** | Same bg, text changes to "Generating..." with subtle dot animation (⋯), disabled |
| **Ready** | `var(--status-success)` bg, "Download MP4" text, same shape |
| **Failed** | `var(--status-error)` border (transparent bg), "Retry" text |

---

## SECTION 5 — MOBILE MOCKUP

### 5.1 Mobile Homepage

```
┌──────────────────────┐
│  GANYIQ              │  ← 48px header
├──────────────────────┤
│                      │
│  ┌────────────────┐  │
│  │ Paste a      ▶ │  │  ← Full-width input
│  └────────────────┘  │
│                      │
│  Recent Analyses     │
│                      │
│  ┌────┬───────────┐  │
│  │ img│ Title...  │  │
│  │72x5│ VINDES    │  │
│  │ 4  │ 15 clips  │  │
│  └────┴───────────┘  │
│                      │
│  (empty — hidden)    │
│                      │
└──────────────────────┘

Width: 100% (fluid, padding 16px)
Max width: 480px
```

**Changes from desktop:**
- Input is full width (no interior padding)
- History rows stack vertically, full tap targets
- Thumbnail: 64×48px (smaller)
- Open button moves to right edge of row
- No floating elements

### 5.2 Mobile Analysis

```
┌──────────────────────┐
│  GANYIQ              │
├──────────────────────┤
│                      │
│       Analyzing      │
│                      │
│  ●────○────○────○    │  ← Smaller dots, shorter lines
│                                                              │
│                      │
│    Elapsed: 2m 47s   │
│                      │
│  ┌──┐  ┌──┐  ┌──┐   │
│  │  │  │  │  │  │   │  ← 3 skeleton cards
│  └──┘  └──┘  └──┘   │
│                      │
│  12 moments found    │
└──────────────────────┘
```

**Changes from desktop:**
- Timeline fits in single row (shorter connecting lines, 32px each)
- 3 skeleton cards instead of 4 (130px width each)
- Discovery counter below cards

### 5.3 Mobile Results

```
┌──────────────────────┐
│  GANYIQ              │
├──────────────────────┤
│                      │
│  Picks of the        │
│  Analysis            │
│                      │
│  ┌────────────────┐  │
│  │ #1  ● Elite    │  │
│  │ 12:13           │  │
│  │ Reason...       │  │
│  │ [hook] [shock]  │  │
│  │ Score ━━━ 100   │  │
│  │ [Generate ▶]   │  │
│  └────────────────┘  │
│                      │
│  More Picks          │
│  ┌──┬──┬──┬──┐       │
│  │#2│#3│#4│#5│       │  ← Horizontal scroll
│  └──┴──┴──┴──┘       │
│                      │
│  Also Notable        │
│  ┌──┬──┬──┬──┐       │  ← Horizontal scroll
│  │#7│#8│#9│#10│      │
│  └──┴──┴──┴──┘       │
└──────────────────────┘
```

**Changes from desktop:**
- Hero card is full width, compact padding (16px)
- Elite row is horizontally scrollable (overflow-x: auto, no scrollbar)
- Secondary row is horizontally scrollable
- Score bar: 80px wide (less space)
- Generate button: full width (easier tap target)
- Transcript excerpt hidden by default, togglable

---

## SECTION 6 — COMPONENT LIBRARY

### 6.1 Input

```
┌──────────────────────────────────┐
│  Paste a YouTube link        ▶  │
└──────────────────────────────────┘
```

| Property | Value |
|---|---|
| Height | 48px |
| Min-width | 320px (desktop) |
| Border-radius | 10px |
| Background | `var(--surface-input)` |
| Border | `1px solid var(--border-default)` |
| Focus border | `1px solid var(--accent)` |
| Error border | `1px solid var(--status-error)` |
| Font | Geist, 15px, weight 400 |
| Color | `var(--text-primary)` |
| Placeholder | `var(--text-quaternary)` |
| Padding | 0 16px |
| Transition | border-color 200ms ease |

**Right-button (submit):**
| Property | Value |
|---|---|
| Width | 36px |
| Height | 36px |
| Margin-right | 6px |
| Border-radius | 8px |
| Background | `var(--accent)` |
| Disabled bg | `rgba(232,199,106,0.25)` |
| Hover bg | `var(--accent-hover)` |
| Icon | Arrow right (SVG, 16px, white) |
| Transition | background 150ms ease |

### 6.2 Button

| Property | Primary | Ghost | Pill |
|---|---|---|---|
| Height | 36px | 36px | 28px |
| Padding | 10px 20px | 8px 16px | 6px 14px |
| Radius | 8px | 8px | 9999px |
| Background | `var(--accent)` | transparent | `var(--surface-panel)` |
| Border | none | `1px solid rgba(255,255,255,0.10)` | `1px solid var(--border-subtle)` |
| Font | Geist 14px 500 | Geist 14px 500 | Geist 12px 500 |
| Color | `#0a0a0b` | `var(--text-secondary)` | `var(--text-secondary)` |
| Hover bg | `var(--accent-hover)` | `rgba(255,255,255,0.04)` | `rgba(255,255,255,0.04)` |
| Disabled | `opacity: 0.35` | `opacity: 0.35` | `opacity: 0.35` |

### 6.3 Card (Standard)

| Property | Value |
|---|---|
| Background | `var(--surface-panel)` |
| Border | `1px solid var(--border-subtle)` |
| Border-radius | 10px |
| Padding | 20px |
| Transition | border-color 200ms ease |

### 6.4 Stage Timeline

| Property | Value |
|---|---|
| Dot size | 8px |
| Line width | 48px (desktop), 32px (mobile) |
| Line height | 2px |
| Font | Geist, 12px, weight 500 |
| Gap (dot to label) | 8px |
| Container | `display: flex; align-items: center;` |

### 6.5 DNA Tag Pill

| Property | Value |
|---|---|
| Height | 22px |
| Padding | 0 8px |
| Border-radius | 6px |
| Background | `var(--accent-subtle)` |
| Font | Geist, 11px, weight 500 |
| Color | `var(--accent-text)` |
| Gap (between pills) | 6px |

### 6.6 Score Bar

| Property | Value |
|---|---|
| Height | 4px |
| Width | 120px (card), 160px (hero card), 80px (mobile) |
| Border-radius | 2px |
| Background | `rgba(255,255,255,0.06)` |
| Fill | `var(--accent)` at score% width |
| Number companion | Geist Mono, 20px weight 600 (hero), 14px weight 500 (compact) |

### 6.7 Skeleton

| Property | Value |
|---|---|
| Background | `var(--surface-panel)` |
| Border | `1px solid var(--border-subtle)` |
| Border-radius | 10px |
| Shimmer | `linear-gradient(110deg, transparent 30%, rgba(255,255,255,0.04) 50%, transparent 70%)` |
| Shimmer animation | `skeleton-shimmer 2s ease-in-out infinite` |
| Shimmer size | card width × card height |

```css
@keyframes skeleton-shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
```

### 6.8 History Row

| Property | Value |
|---|---|
| Height | 64px |
| Background | `var(--surface-panel)` |
| Border | `1px solid var(--border-subtle)` |
| Border-radius | 10px |
| Padding | 12px |
| Internal gap | 12px |
| Thumbnail | 72×54px, border-radius 6px |
| Hover | border → `rgba(255,255,255,0.12)` |

---

## SECTION 7 — MICRO INTERACTIONS

### 7.1 Interaction Rules

1. **No animation without purpose.** Every motion must communicate state change.
2. **Fast is premium.** 150-200ms for UI transitions. 300ms maximum for expressive transitions.
3. **No decorative animation.** No parallax, no floating, no confetti, no particle effects.

### 7.2 Specific Animations

| Element | Trigger | Animation | Duration | Easing |
|---|---|---|---|---|
| Input focus | `:focus` | Border color shift `var(--border-default)` → `var(--accent)` | 200ms | ease |
| Input submit | Click | Button slight scale 1→0.97→1 | 150ms | ease-out |
| Stage dot change | Status poll | Dot fill color transition | 300ms | ease-in-out |
| Timeline line fill | Stage completes | Line color shift `rgba(255,255,255,0.08)` → `var(--accent)` | 400ms | ease-in-out |
| Results appear | Analysis done | Staggered fade + slide-up, 50ms delay per card | 200ms per card | ease-out |
| Card hover | `:hover` | Border brightens `var(--border-subtle)` → `rgba(232,199,106,0.20)` | 150ms | ease |
| Skeleton pulse | Page mount | Shimmer sweep | 2s infinite | ease-in-out |
| Score bar fill | Results mount | Width animates `0` → `score%` | 500ms | ease-out |
| Elapsed timer | Each second | Number changes with 0.5s cross-fade | — | — |
| Stage transition | Status updates | Content cross-fade | 200ms | ease |
| DNA tags appear | Results mount | Fade in, 30ms stagger | 150ms | ease-out |
| History row hover | `:hover` | Border brightens | 150ms | ease |
| Discovery counter | Updates | Number scales 1→1.05→1 | 200ms | ease-out |
| Button click | `:active` | Slight scale 1→0.97 | 100ms | ease-out |

### 7.3 Cursor States

- All clickable cards: `cursor: pointer`
- Input: `cursor: text`
- Timeline: not interactive (informational)
- Tags: not interactive (informational)

---

## SECTION 8 — DESIGN CRITIQUE

### 8.1 Risks

| Risk | Mitigation |
|---|---|
| **Gold accent may look financial/investment** | Gold was chosen for its editorial connotation, not financial. Pair with dark studio background to avoid "wealth management" feel. If gold tests poorly, swap to a cool steel-blue (`#6b8ec4`) |
| **Ultra-minimal header without tagline confuses first-time users** | The input IS the instruction. "Paste a YouTube link" placeholder + "Analyze" button is self-explanatory. Add a short subtitle below input if analytics show confusion |
| **Skeleton cards during 10-min analysis may feel like fake progress** | Counter shows real discovery count — not a fake animation. Cards appear based on actual pipeline progress |
| **Horizontal scroll on mobile is non-standard** | Used by Readwise Reader, Linear, Arc — it's becoming a standard pattern for content browsing. Add scroll-snap for precision |
| **Removing purple completely may feel like losing brand identity** | The current purple accent was never intentionally chosen — it was the default "AI startup" purple. Gold creates a stronger, more differentiated identity |

### 8.2 Weaknesses

| Weakness | Reasoning |
|---|---|
| **Only 5 compact cards in elite row** | With MAX_ELITE=10, only showing 5 compact cards + 1 hero = 6 visible. The remaining 4 elite are in the "Also Notable" secondary section. This is intentional hierarchy — not all clips need equal visual weight |
| **Score bar doesn't work for 99 vs 100** | True — the difference between 99 and 100 is 1px on the bar. But the number is still displayed numerically for precision. The bar is for gestalt at scale |
| **No visual distinction between "Controversy" and "HookPower" DNA tags** | Tags are intentionally uniform — they communicate categories, not emotional weight. If distinction is needed later, use subtle icon prefixes instead of tag color |

### 8.3 Potential User Confusion

| Scenario | Solution |
|---|---|
| User returns to page, sees history, clicks "Open" | Opens full results immediately (already implemented) |
| User submits video that's already been analyzed | The backend creates a new analysis. The history shows both. No dedup on frontend — backend handles this |
| User doesn't understand stages | "Analyzing" covers 80% of the wait time. The timeline is informational, not actionable |

### 8.4 What May Still Feel Generic

| Element | Risk | Fix |
|---|---|---|
| History rows with thumbnail + text | Common pattern | The compact row layout + typography system saves it. Alternative: full-width hero history card for most recent analysis |
| Gold accent color | Could trend toward "premium fintech" | Ensure the gold is warm (yellow-leaning) not metallic. Pair with dark surfaces to prevent "gold on white" which looks cheap |
| Skeleton loading | Common pattern | The shimmer direction (110deg diagonal) and color (barely visible) keeps it tasteful. Avoid the heavy gray skeleton look |

---

## SECTION 9 — IMPLEMENTATION PLAN

### Phase A: Foundation
**Files:** `globals.css`, `layout.tsx`

| Task | Detail | Difficulty | Risk |
|---|---|---|---|
| A1. Replace CSS variables | New color palette (gold accent, dark studio tones) | Easy | Low — pure CSS |
| A2. Apply Geist fonts | Font variables already exist in `layout.tsx` — just use them in CSS | Easy | Low — add `font-family: var(--font-geist-sans)` |
| A3. Add base typography styles | `body`, headings, mono defaults | Easy | Low |
| A4. Add animation keyframes | Skeleton shimmer, stage dot pulse, score bar fill | Easy | Low |
| A5. Expand max-width | 640px → 896px | Easy | Low |
| **Subtotal** | **5 files touched, ~50 lines changed** | **Easy** | **Low** |

### Phase B: Homepage
**Files:** `page.tsx`, `globals.css`

| Task | Detail | Difficulty | Risk |
|---|---|---|---|
| B1. Restructure header | Remove tagline, add version, compact height | Easy | Low |
| B2. Restyle input | New visual: gold button integrated into input field | Medium | Low — no logic change |
| B3. Redesign history rows | Compact, thumbnail + meta + button | Medium | Low |
| B4. Simplify empty state | Remove large SVG, minimal text | Easy | Low |
| B5. Add responsive padding | Fluid padding 16px → 32px | Easy | Low |
| **Subtotal** | **2 files touched, ~100 lines changed** | **Medium** | **Low** |

### Phase C: Analysis Experience
**Files:** `page.tsx`, `globals.css`

| Task | Detail | Difficulty | Risk |
|---|---|---|---|
| C1. Build stage timeline component | 4 dots + lines + labels, active tracking | Medium | Medium — new logic |
| C2. Add elapsed timer | Mono counter, updates every second | Easy | Low |
| C3. Add skeleton cards | 4 card placeholders with shimmer | Medium | Low |
| C4. Add discovery counter | Live count from status API | Medium | Low |
| C5. Remove old progress bar | Delete indeterminate bar code | Easy | Low |
| **Subtotal** | **2 files touched, ~150 lines changed** | **Medium** | **Medium** |

### Phase D: Results Page
**Files:** `page.tsx`, `globals.css`

| Task | Detail | Difficulty | Risk |
|---|---|---|---|
| D1. Build elite hero card | Full-width featured card with left accent | Medium | Low |
| D2. Build compact card component | Reusable card for rows | Medium | Low |
| D3. Build scrollable elite row | Horizontal flex with 5 compact cards | Medium | Low |
| D4. Build secondary row | 7 smaller compact cards | Medium | Low |
| D5. Add score bar | Horizontal bar + number component | Medium | Low |
| D6. Restyle generate button | New states (idle/generating/ready/failed) | Medium | Low |
| D7. Add staggered mount animation | Cards slide up on appear | Medium | Low |
| D8. Remove old moment cards | Delete old card JSX structure | Easy | Medium — verify no regression |
| **Subtotal** | **2 files touched, ~250 lines changed** | **Medium-Hard** | **Medium** |

### Phase E: Polish
**Files:** `globals.css`, `page.tsx`

| Task | Detail | Difficulty | Risk |
|---|---|---|---|
| E1. Mobile responsive | Verify all breakpoints work | Medium | Low |
| E2. Micro-interactions | Add hover/active/focus transitions | Easy | Low |
| E3. Test all states | Idle, submitting, analyzing, completed, failed, error | Medium | Low |
| E4. Performance check | CLS, paint time, interaction delay | Medium | Low |
| E5. Accessibility audit | Keyboard nav, focus rings, contrast | Medium | Low |
| **Subtotal** | **2 files touched, ~50 lines changed** | **Medium** | **Low** |

### Total Estimate

| Metric | Value |
|---|---|
| Files modified | 2 (`globals.css`, `page.tsx`) — no new files |
| New CSS | ~400 lines |
| Changed JSX | ~200 lines |
| New components | 6 (Timeline, Skeleton, CompactCard, HeroCard, ScoreBar, StageDot) |
| Total effort | 5 phases, approximately 2-3 hours of focused implementation |
| Backend changes | **Zero** |
| API changes | **Zero** |

---

## Appendix: Data Shape Reference

All data shapes are frozen — these are the exact API responses the frontend receives:

### POST /api/analyze (202)
```json
{ "analysisId": "uuid", "status": "processing" }
```

### GET /api/analyze/:id/status (processing)
```json
{ "analysisId": "uuid", "status": "processing", "stage": "fetching_transcript" }
```

### GET /api/analyze/:id/status (completed)
```json
{
  "analysisId": "uuid",
  "videoId": "youtube_id",
  "status": "completed",
  "moments": [
    {
      "startTime": 733.6,
      "endTime": 850.3,
      "worthClippingScore": 100,
      "confidence": "high",
      "dnaTags": ["hookPower", "shock", "curiosity"],
      "reasoning": "Immediately defensive...",
      "rank": 1,
      "tier": "elite",
      "startTimestamp": "12:13",
      "endTimestamp": "14:10",
      "transcriptExcerpt": "Iya. Maaf. Kenapa..."
    }
  ]
}
```

### GET /api/history
```json
{
  "analyses": [
    {
      "analysisId": "uuid",
      "videoId": "youtube_id",
      "title": "Video Title",
      "channelName": "Channel",
      "thumbnailUrl": "https://img.youtube.com/vi/.../mqdefault.jpg",
      "createdAt": "2026-06-09T09:37:20.182Z",
      "totalMoments": 15,
      "avgScore": 90
    }
  ]
}
```
