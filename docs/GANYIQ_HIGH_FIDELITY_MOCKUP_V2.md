# GANYIQ — High-Fidelity Mockup V2

> **Status:** Design Review · **Version:** 2.0
> **Reference Products:** Linear, Readwise Reader, Arc Browser, Notion Calendar
> **Anti-Reference:** Opus Clip, Midjourney, generic AI startups, Web3 dashboards

---

## Revision Log

| # | Change | Rationale |
|---|---|---|
| R1 | Added subheadline under logo | User orientation for first-time visitors |
| R2 | Hero card compressed to 240–280px | More clips visible per viewport |
| R3 | Gold reduced to 5% usage (95% grayscale) | Lineage discipline, not fintech |
| R4 | DNA tags now use editorial symbols + monochrome | Quick scanability without color noise |

---

## SECTION 1 — VISUAL DIRECTION (Revised)

### 1.1 Color Discipline: 95% Grayscale, 5% Gold

**The palette is almost entirely grayscale. Gold is a punctuation mark, not a theme.**

```
Grayscale spectrum (95% of surfaces):
  #0a0a0b  ─  #121213  ─  #1c1c1e  ─  #18181b
  (page)       (panel)      (elevated)    (input)

  #f4f4f5  ─  #a1a1aa  ─  #71717a  ─  #52525b
  (primary)    (secondary)   (tertiary)    (quaternary)

  rgba(255,255,255,0.06)  ─  rgba(255,255,255,0.10)
  (border subtle)            (border default)

Gold permitted ONLY on:
  ✓ Active stage dot in timeline
  ✓ Elite tier badge (small dot, not text)
  ✓ Score bar fill + score number
  ✓ Primary CTA button
  ✓ Selected/hover state (border accent only)
  
Gold FORBIDDEN on:
  ✗ Card borders (always rgba(255,255,255,0.06))
  ✗ Section dividers (always rgba(255,255,255,0.06))
  ✗ Typography except score numbers
  ✗ Backgrounds
  ✗ Icons
  ✗ Loading states
  ✗ Everything else
```

**Rationale:** In Linear and Readwise Reader, the accent color appears on approximately 2-5% of the screen at any time. When you see it, it means something. By starving the interface of gold, the moments that DO carry gold (elite badge, score, CTA) become genuinely significant.

### 1.2 Subheadline

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  GANYIQ
  Surface the moments people actually remember.

  [ Paste a YouTube link                         ▶ ]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

| Element | Spec |
|---|---|
| Logo | Geist, 20px, weight 500, `-0.02em`, `var(--text-primary)` |
| Subheadline | Geist, 13px, weight 400, `var(--text-tertiary)`, 4px below logo |
| Visibility | Always visible on homepage idle state |
| Hidden during | Analysis (replaced by timeline) and Results (replaced by section title) |

**Why only on homepage idle state?** The subheadline is for first-time orientation. Once the user is in analysis or results, the interface communicates itself. Showing it everywhere would be redundant and take up space.

---

## SECTION 2 — HOMEPAGE DESKTOP MOCKUP

### 2.1 Full Layout Diagram

```
┌──────────────────────────────────────────────────────────────┐
│  GANYIQ                                                 v1.0│  ← 48px header
│  Surface the moments people actually remember.                │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌──────────────────────────────────────────────────────────┐│
│  │  Paste a YouTube link                              ▶    ││  ← Input zone
│  └──────────────────────────────────────────────────────────┘│    ~100px
│                                                              │
│  ┌──────────────────────────────────────────────────────────┐│
│  │  Recent Analyses                                 12 min ││  ← Section label
│  │                                                        ││
│  │  ┌────┬──────────────────────────────────────────┐     ││
│  │  │ img│ Andre Taulany Marah-Marah!...       ▶   │     ││  ← History row 64px
│  │  │72x │ VINDES · 15 clips · Avg 90  Jun 9     │     ││
│  │  └────┴──────────────────────────────────────────┘     ││
│  │  ┌────┬──────────────────────────────────────────┐     ││
│  │  │ img│ Andre Taulany Marah-Marah!...       ▶   │     ││
│  │  │72x │ VINDES · 15 clips · Avg 79  Jun 9     │     ││
│  │  └────┴──────────────────────────────────────────┘     ││
│  └──────────────────────────────────────────────────────────┘│
│                                                              │
│  ┌──────────────────────────────────────────────────────────┐│
│  │                                                        ││
│  │                 No analyses yet.                        ││  ← Empty state
│  │                 Paste a link above to begin.            ││    centered
│  │                                                        ││
│  └──────────────────────────────────────────────────────────┘│
│                                                              │
└──────────────────────────────────────────────────────────────┘

Canvas: #0a0a0b
Content width: 896px centered
Side padding: 32px
Section gap: 40px
```

### 2.2 Spacing System

```
896px content width
├── 32px padding ── 832px content ── 32px padding ──┤
```

| Element | Height | Notes |
|---|---|---|
| Header | 48px | Logo + subheadline |
| Input section | ~100px | 48px input + surrounding padding |
| History section | auto | 0 to 5 rows visible |
| History row | 64px | Thumbnail + text + CTA |
| Row gap | 8px | Between rows |
| Section label | 20px | "Recent Analyses" label padding |
| Empty state | centered | ~200px from top of content area |
| Section gap | 40px | Between input and history |

### 2.3 Component: History Row

```
┌────┬──────────────────────────────────────────────────────┐
│    │                                                      │
│ img│  Andre Taulany Marah-Marah! Mau Bubarin PREDIKSI!.. │
│72x5│  VINDES  ·  15 clips  ·  Avg 90         Open  ▶    │
│ 4  │                                      Jun 9, 2026    │
│    │                                                      │
└────┴──────────────────────────────────────────────────────┘

Row:  64px tall · #121213 bg · 1px rgba(255,255,255,0.06) border · 10px radius
      12px internal padding · flex row
      
Thumbnail:  72×54px · 6px radius · object-fit cover
Title:      Geist 14px 500 · #f4f4f5 · single-line ellipsis
Meta:       Geist 12px 400 · #71717a · inline bullets
Avg Score:  Geist 12px 600 · #e8c76a
Date:       Geist 12px 400 · #52525b · right-aligned
Button:     Ghost · 1px rgba(255,255,255,0.08) · 8px 14px · 8px radius · 13px
            Hover: border → rgba(255,255,255,0.2)
```

---

## SECTION 3 — ANALYSIS STATE DESKTOP MOCKUP

### 3.1 During Analysis — Full Screen

```
┌──────────────────────────────────────────────────────────────┐
│  GANYIQ                                                 v1.0│
├──────────────────────────────────────────────────────────────┤
│                                                              │
│                    Analyzing your video                       │
│                                                              │
│        ● ────────── ○ ────────── ○ ────────── ○             │
│     Fetching      Extracting   Analyzing     Ranking         │
│                                                              │
│                     Elapsed: 4m 12s                          │
│                                                              │
│  ┌──────┐  ┌──────┐  ┌──────┐  ┌──────┐                    │
│  │      │  │      │  │      │  │      │                    │
│  │      │  │      │  │      │  │      │                    │
│  │      │  │      │  │      │  │      │                    │
│  └──────┘  └──────┘  └──────┘  └──────┘                    │
│                                                              │
│                 24 moments discovered                        │
│                                                              │
└──────────────────────────────────────────────────────────────┘

Canvas: #0a0a0b
Label:  "Analyzing your video" · Geist 15px 500 · #a1a1aa · center
        (only visible during active analysis, not idle/results)
```

### 3.2 Stage Timeline Detail

```
        ● ────────── ○ ────────── ○ ────────── ○
     Fetching      Extracting   Analyzing     Ranking
```

| Element | Spec |
|---|---|
| Active dot | 8px circle, `#e8c76a` fill, subtle pulse |
| Completed dot | 8px circle, `#e8c76a` fill (no animation) |
| Upcoming dot | 8px circle, `rgba(255,255,255,0.12)` border, no fill |
| Connector line | 48px wide, 2px tall, `rgba(255,255,255,0.06)` |
| Connector (completed) | `rgba(232,199,106,0.3)` |
| Label | Geist 12px 500, centered 8px below dot |
| Active label | `#f4f4f5` |
| Completed label | `#71717a` |
| Upcoming label | `#52525b` |
| Pulse animation | `opacity 0.4 → 1 → 0.4`, 2s infinite, only on active dot |
| Container | `display: flex; justify-content: center; align-items: center;` |
| Gap | 0 (dots + lines fill the space) |

### 3.3 Skeleton Cards

```
┌──────┐  ┌──────┐  ┌──────┐  ┌──────┐
│██████│  │██████│  │██████│  │██████│
│██████│  │██████│  │██████│  │██████│
│██████│  │██████│  │██████│  │██████│
└──────┘  └──────┘  └──────┘  └──────┘
```

| Property | Value |
|---|---|
| Card size | 180 × 120px |
| Background | `#121213` with shimmer |
| Shimmer | `linear-gradient(110deg, transparent 30%, rgba(255,255,255,0.04) 50%, transparent 70%)` |
| Animation | `skeleton-shimmer 2s ease-in-out infinite` |
| Border | `1px solid rgba(255,255,255,0.06)`, 10px radius |
| Count | 4 cards, 12px gap |

---

## SECTION 4 — RESULTS PAGE DESKTOP MOCKUP

### 4.1 Full Layout

```
┌──────────────────────────────────────────────────────────────┐
│  GANYIQ                                                 v1.0│
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  Picks of the Analysis                                      │  ← Section: 20px
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ #1  12:13          ● Elite     Score  ━━━━━━━━━ 100    │  │  ← Hero card
│  │                                                        │  │    264px tall
│  │  Immediately defensive with 'Why am I being judged?'   │  │    (R2: reduced)
│  │  sparking intrigue and conflict in the first seconds.  │  │
│  │                                                        │  │
│  │  ◇ hookPower   ● shock   ▼ curiosity   [Generate ▶]  │  │  ← Tags + CTA
│  │                                                        │  │
│  │  "Iya. Maaf. Kenapa aku dijudge? Siapa yang            │  │
│  │  nge-judge?..."  [Show transcript]                     │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│  More Picks                                                  │  ← Section: 16px
│                                                              │
│  ┌────┐  ┌────┐  ┌────┐  ┌────┐  ┌────┐                    │
│  │ #2 │  │ #3 │  │ #4 │  │ #5 │  │ #6 │                    │  ← Compact row
│  │100 │  │100 │  │ 99 │  │100 │  │ 95 │                    │    160px tall
│  │18:2│  │58:0│  │38:0│  │1:01│  │ 3:1│                    │    5 cards
│  │ ◇  │  │ ♥  │  │ ●  │  │ ▲  │  │ ✦  │                    │
│  └────┘  └────┘  └────┘  └────┘  └────┘                    │
│                                                              │
│  Also Notable                                                │  ← Section: 16px
│                                                              │
│  ┌────┐  ┌────┐  ┌────┐  ┌────┐  ┌────┐  ┌────┐  ┌────┐    │
│  │ #7 │  │ #8 │  │ #9 │  │#10 │  │#11 │  │#12 │  │#13 │    │  ← Secondary row
│  │ 79 │  │ 77 │  │ 74 │  │ 74 │  │ 73 │  │ 75 │  │ 73 │    │    112px tall
│  │ ▼  │  │ ▲  │  │ ▼  │  │ ▼  │  │ ◇  │  │ ◇  │  │ ▼  │    │    7 cards
│  └────┘  └────┘  └────┘  └────┘  └────┘  └────┘  └────┘    │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### 4.2 Hero Card Detail (R2: Compressed to 264px)

```
┌──────────────────────────────────────────────────────────────┐
│ #1  12:13 — 14:10          ● Elite    Score  ━━━━━━━  100  │  ← Top row: 20px
│                                                              │
│  Immediately defensive with 'Why am I being judged?'         │  ← Reasoning: 40px
│  sparking intrigue...                                        │    2 lines max
│                                                              │
│  ◇ hookPower   ● shock   ▼ curiosity                         │  ← Tags: 22px
│                                                              │
│  "Iya. Maaf. Kenapa aku dijudge? Siapa yang            ▶    │  ← Transcript + CTA
│   nge-judge?..."  [Show]      [Generate Clip        ▶   ]  │    60px
│                                                              │
└──────────────────────────────────────────────────────────────┘
                    Total: ~264px
```

| Region | Content | Spec |
|---|---|---|
| **Row 1 (top)** | Rank + Timestamp + Tier dot + Score bar + Score number | 20px |
| **Row 2** | Reasoning text, 2 lines max, ellipsis | 40px |
| **Row 3** | DNA tags with symbols | 22px |
| **Row 4** | Transcript excerpt (collapsible) + Generate CTA | 60px |
| **Card padding** | 20px | |
| **Borders/gaps** | Internal 8px between rows | |
| **Total** | 20 + 8 + 40 + 8 + 22 + 8 + 60 + 20×2 = **~264px** | |

**Changes from V1 (was 352px):**
- Reasoning reduced from 3 lines to 2 lines
- Transcript excerpt collapsed by default (togglable)
- DNA tags row condensed (symbols replace full tag text)
- Score bar aligns right (inline with rank)
- Generate button moved to bottom-right, not centered

**Top Row Layout:**

```
#1  12:13 — 14:10                    ● Elite      Score  ━━━━━━━  100
↑                                  ↑                        ↑        ↑
Geist 18px 600                     Geist Mono 12px          4px bar  Geist Mono 18px
#f4f4f5                            #71717a                  #e8c76a  #e8c76a
```

**CTA Button (in hero card):**
Spec: Ghost button with gold accent on hover. Not a solid gold button — the CTA in hero card is secondary (user will likely scroll to see more clips first). The primary CTA per clip is on the compact cards.

Wait — I need to reconsider. The current design has "Generate Clip" button. This IS the primary action per clip. Let me think...

Actually, R3 says gold should be used sparingly. Having a gold CTA button on every card would violate 5% gold. 

**Revised CTA approach:** Only the #1 hero card gets a gold CTA button. Compact cards get ghost buttons (grayscale). This reinforces the hierarchy — the hero clip is the one you're most likely to want to clip.

### 4.3 Compact Card (Elite Row — Ranks 2-6)

```
┌───────────────┐
│  #2           │
│  100          │
│  18:29        │
│  ◇ hook       │  ← Symbol + abbreviated tag
│  [Generate]  │  ← Ghost button
└───────────────┘
144 × 160px
```

| Property | Value |
|---|---|
| Size | 144 × 160px |
| Background | `#121213` |
| Border | `1px solid rgba(255,255,255,0.06)`, 10px radius |
| Padding | 16px |
| Rank | Geist 11px 500, `#71717a` |
| Score | Geist 28px 600, `#e8c76a` |
| Timestamp | Geist Mono 11px, `#52525b` |
| Tag symbol | 12px, `#71717a`, + abbreviated name (max 6 chars) |
| CTA | Ghost button, 8px 12px, 6px radius, 11px |
| Hover | Border → `rgba(232,199,106,0.15)`, CTA border → `rgba(255,255,255,0.2)` |
| Gap (between) | 12px |

### 4.4 Compact Card (Secondary Row — Ranks 7-15)

```
┌─────────┐
│  #7     │
│  79     │
│  26:19  │
│  ▼ curi │
└─────────┘
108 × 112px
```

| Property | Value |
|---|---|
| Size | 108 × 112px |
| Score color | `#a1a1aa` (no gold — secondary tier) |
| Score size | 20px weight 600 |
| Tag symbol | 11px, `#71717a` |
| Padding | 12px |
| No CTA | Secondary cards don't get Generate buttons. Reduces visual noise. |
| Gap | 8px |

**Why no CTA on secondary cards?**
- Reduces clutter
- If user wants to generate a secondary clip, they can click the card to expand it (future enhancement)
- Primary CTA flow: hero card → elite row → scroll to bottom for "Analyze Another"

---

## SECTION 5 — DNA TAG SYSTEM (R4: Editorial Symbols)

### 5.1 Symbol Map

| DNA Tag | Symbol | Meaning | Unicode |
|---|---|---|---|
| hookPower | `◇` | Hook — opening, attention-grab | U+25C7 |
| curiosity | `▼` | Curiosity trigger, question, mystery | U+25BC |
| controversy | `▲` | Debate, argument, hot take | U+25B2 |
| emotion | `♥` | Emotional moment, vulnerability | U+2665 |
| humor | `◆` | Comedy, joke, funny moment | U+25C6 |
| storytelling | `✦` | Narrative, anecdote, story arc | U+2726 |
| educational | `■` | Learning, insight, information | U+25A0 |
| authority | `◈` | Expert opinion, credibility | U+25C8 |
| money | `¤` | Financial, wealth, business | U+00A4 |
| shock | `⚡` | Surprise, unexpected, revelation | U+26A1 |
| motivation | `↑` | Inspiring, uplifting, encouragement | U+2191 |
| relatability | `○` | Relatable, authentic, everyday | U+25CB |
| vulnerability | `♥` | (shares with emotion) | U+2665 |
| inspiration | `✦` | (shares with storytelling) | U+2726 |

### 5.2 Tag Display Rules

**In hero card (expanded):**
```
◇ hookPower   ● shock   ▼ curiosity
```
Symbol + truncated tag name (max 8 characters). Geist 11px 500, `#71717a`. 
If a tag has no symbol (not in map), show its name in full without symbol.

**In compact cards (elite row):**
```
◇ hook
```
Symbol + tag name truncated to 6 characters. Same style.

**In compact cards (secondary row):**
```
▼ curi
```
Symbol + tag name truncated to 5 characters. Smaller space.

**Color:** Always monochrome (`#71717a` tertiary text color). No tag coloring. Symbol carries the meaning, not color.

### 5.3 Why Symbols Instead of Colored Badges?

| Approach | Problem |
|---|---|
| Colorful tags | Rainbow = cheap. Removes 5% gold discipline. |
| Text-only tags | User must read every tag. No scanability. |
| Emoji tags | Inconsistent rendering across platforms. Unprofessional. |
| **Symbols** | **Universal, monochrome, scannable, editorial.** |

---

## SECTION 6 — MOBILE MOCKUPS

### 6.1 Mobile Homepage

```
┌─────────────────────┐
│  GANYIQ             │  ← 48px
│                     │
│  Surface the        │  ← subheadline
│  moments...         │
│                     │
│  ┌───────────────┐  │
│  │ Paste a    ▶  │  │  ← Input (full width)
│  └───────────────┘  │
│                     │
│  Recent Analyses    │
│                     │
│  ┌────┬──────────┐  │
│  │ img│ Title... │  │  ← History row
│  │64x4│ 15 clips │  │    60px tall
│  └────┴──────────┘  │
│  ┌────┬──────────┐  │
│  │ img│ Title... │  │
│  └────┴──────────┘  │
│                     │
└─────────────────────┘

Canvas: #0a0a0b
Width: 100% (max 480px)
Padding: 16px
Subheadline: 12px (smaller than desktop)
History row: 60px tall (slightly smaller)
Thumbnail: 64×48px
```

### 6.2 Mobile Analysis

```
┌─────────────────────┐
│  GANYIQ             │
│                     │
│  Analyzing video    │
│                     │
│  ●────○────○────○   │
│  Fetching           │  ← Only active label shown
│                     │      (no room for all 4)
│  Elapsed: 4m 12s    │
│                     │
│  ┌──┐  ┌──┐  ┌──┐  │
│  │  │  │  │  │  │  │  ← 3 skeletons
│  └──┘  └──┘  └──┘  │
│                     │
│  12 moments found   │
└─────────────────────┘

Mobile timeline simplification:
  - Show only ACTIVE stage label (others hidden)
  - Dots + lines still shown but without labels
  - 3 skeleton cards instead of 4
```

### 6.3 Mobile Results

```
┌───────────────────────────┐
│  GANYIQ                   │
│                           │
│  Picks of the Analysis    │
│                           │
│  ┌─────────────────────┐  │
│  │ #1  12:13  ● Elite  │  │  ← Hero card
│  │ Reasoning line...   │  │    240px tall
│  │ ◇ hook  ● shock ▼  │  │  
│  │ Score ━━━━ 100      │  │
│  │ [Generate Clip   ▶] │  │
│  └─────────────────────┘  │
│                           │
│  More Picks  ──────→     │  ← Scroll hint
│  ┌──┬──┬──┬──┬──┐        │
│  │#2│#3│#4│#5│#6│        │  ← Horizontal scroll
│  └──┴──┴──┴──┴──┘        │
│                           │
│  Also Notable ──────→    │
│  ┌──┬──┬──┬──┬──┬──┬──┐  │
│  │#7│#8│#9│10│11│12│13│  │
│  └──┴──┴──┴──┴──┴──┴──┘  │
└───────────────────────────┘

Hero card: 240px tall (compact mobile)
  - Reasoning: 1 line
  - Tags inline with score row
  - Transcript hidden by default, toggle with arrow

Compact cards: 130 × 140px (elite), 96 × 96px (secondary)

Scroll hint: "─→" after section label indicates horizontal scroll
```

---

## SECTION 7 — COMPONENT LIBRARY (Revised)

### 7.1 Input

```
┌──────────────────────────────────────┐
│  Paste a YouTube link            ▶  │
└──────────────────────────────────────┘
48px · #18181b · 1px rgba(255,255,255,0.10) · 10px radius
Focus: 1px solid #e8c76a
Placeholder: #52525b
Text: #f4f4f5 · Geist 15px 400
Submit btn: 36×36px · #e8c76a · 8px radius · inside input (right)
```

### 7.2 Button Variants

| Variant | Use | Spec |
|---|---|---|
| **Primary** | Hero CTA | `#e8c76a` bg, `#0a0a0b` text, Geist 14px 500, 10px 20px, 8px radius |
| **Ghost** | Compact card CTA | transparent, `1px solid rgba(255,255,255,0.10)`, `#a1a1aa` text |
| **Pill** | Section/See all | `#121213` bg, `1px solid rgba(255,255,255,0.06)`, `#71717a` text, 9999px radius |
| **Icon** | Close/Back | 32×32px, transparent, `#71717a` icon |

### 7.3 Card Hierarchy

| Type | Width | Height | Border | Radius | Gold? |
|---|---|---|---|---|---|
| Hero | 832px | ~264px | `1px rgba(255,255,255,0.06)` | 12px | Left accent `3px #e8c76a` |
| Elite compact | 144px | 160px | `1px rgba(255,255,255,0.06)` | 10px | Score number only |
| Secondary compact | 108px | 112px | `1px rgba(255,255,255,0.06)` | 10px | None |
| History row | 832px | 64px | `1px rgba(255,255,255,0.06)` | 10px | None |

### 7.4 DNA Tag

```
◇ hookPower
```
Symbol + name · Geist 11px 500 · #71717a · Inline with gap 6px
Background: none (inline text, not pill)
Appearance: Symbol first, then abbreviated name, space-separated

### 7.5 Score Bar

```
━━━━━━━━━━━━━━━━━━━━━━━━ 92
```
4px tall · 120px wide · rounded 2px
Fill: `#e8c76a` at score% width
Track: `rgba(255,255,255,0.06)`
Number: Geist Mono, right of bar

### 7.6 Stage Dot

```
●───○───○───○
```
8px circle · Active: `#e8c76a` fill with pulse · Completed: `#e8c76a` fill static
Upcoming: `rgba(255,255,255,0.12)` border, no fill
Connector: 48×2px · `rgba(255,255,255,0.06)` / completed: `rgba(232,199,106,0.3)`

---

## SECTION 8 — MICRO INTERACTIONS

| Element | Action | Effect | Duration | Easing |
|---|---|---|---|---|
| Input focus | click/tap | Border `rgba(255,255,255,0.10)` → `#e8c76a` | 200ms | ease |
| Button hover | mouse | Background or border brightens | 150ms | ease |
| Button click | mousedown | Scale `1 → 0.97` | 100ms | ease-out |
| Card hover | mouse | Border `0.06 → 0.15` opacity | 200ms | ease |
| Stage dot | status update | Fills in with subtle pulse | 400ms | ease-in-out |
| Skeleton | page mount | Diagonal shimmer sweep | 2s loop | ease-in-out |
| Score bar | results mount | Width `0 → score%` | 600ms | ease-out |
| Cards appear | results mount | `translateY(8px) + opacity 0→1`, staggered 60ms | 200ms each | ease-out |
| History list | page load | Same stagger, 40ms delay | 200ms each | ease-out |
| DNA tags | results mount | `opacity 0→1`, staggered 20ms | 150ms each | ease-out |

**No gold animations.** The gold color appears instantly (no fade-in for accent colors). Motion is reserved for structural changes (cards appearing, scores filling, stages progressing).

---

## SECTION 9 — DESIGN CRITIQUE (Revised)

### Risk Register

| Risk | Severity | Mitigation |
|---|---|---|
| **5% gold may look too muted for some users** | Medium | The grayscale-first approach is validated by Linear, Readwise, Arc. If user testing shows confusion, introduce ONE additional accent color (cool steel-blue `#6b8ec4`) for interactive elements only |
| **DNA symbols require learning** | Medium | Symbol + text label shown on first visit. After 2-3 visits, users will recognize symbols without reading text. Tooltip on hover for confirmation |
| **Hero card without transcript excerpt by default** | Low | Transcript is most important during clip generation decision. The "Show transcript" toggle is one click away |
| **No CTA on secondary cards** | Low | Secondary clips are discovery, not primary action. User can click card to expand (Phase F future) |
| **264px hero card may still feel large on mobile** | Medium | Mobile hero card is 240px with 1-line reasoning. If still too large, reduce to 200px by removing transcript toggle entirely on mobile |

### What Still Needs Verification

- [ ] Gold `#e8c76a` readability on `#0a0a0b` background for score numbers
- [ ] DNA symbol recognizability without tooltip
- [ ] Skeleton count: 4 cards on desktop during 10-min analysis (is 4 enough to feel alive?)
- [ ] Mobile timeline: single active label sufficient?

---

## SECTION 10 — IMPLEMENTATION PLAN (Revised for V2)

### Phase A — Foundation
**Files:** `globals.css`

| Task | Est. |
|---|---|
| A1. Replace all CSS variables (grayscale palette, gold accent) | 15 min |
| A2. Apply Geist + Geist Mono to body and components | 5 min |
| A3. Add `@keyframes` for skeleton, pulse, stagger animations | 10 min |
| A4. Expand max-width 640px → 896px | 5 min |
| A5. Add DNA symbol font support (unicode-safe) | 5 min |
| **Total** | **40 min** |

### Phase B — Homepage
**Files:** `page.tsx`, `globals.css`

| Task | Est. |
|---|---|
| B1. Restructure header (logo + subheadline, compact height) | 10 min |
| B2. Redesign input (gold button inside input, new styles) | 15 min |
| B3. Rewrite history section (compact rows, new meta layout) | 20 min |
| B4. Replace empty state (remove SVG, minimal text) | 10 min |
| B5. Add responsive padding | 10 min |
| **Total** | **65 min** |

### Phase C — Analysis Experience
**Files:** `page.tsx`, `globals.css`

| Task | Est. |
|---|---|
| C1. Build stage timeline component (4 dots + lines + labels) | 25 min |
| C2. Add elapsed timer (Geist Mono, 1s interval) | 10 min |
| C3. Build skeleton cards (4 placeholders, shimmer) | 15 min |
| C4. Add discovery counter (from status API) | 15 min |
| C5. Remove old progress bar + stage indicator code | 5 min |
| **Total** | **70 min** |

### Phase D — Results Page
**Files:** `page.tsx`, `globals.css`

| Task | Est. |
|---|---|
| D1. Build hero card (264px layout, left accent, score bar) | 30 min |
| D2. Build compact card component (reusable for both rows) | 20 min |
| D3. Build elite row (5 cards, horizontal flex) | 15 min |
| D4. Build secondary row (7 smaller cards) | 10 min |
| D5. Add DNA symbol mapping (tag → symbol in component) | 15 min |
| D6. Restyle Generate button (3 states: idle/generating/ready) | 10 min |
| D7. Add staggered mount animations | 15 min |
| D8. Remove old moment card code | 10 min |
| **Total** | **125 min** |

### Phase E — Mobile + Polish
**Files:** `globals.css`, `page.tsx`

| Task | Est. |
|---|---|
| E1. Mobile responsive (breakpoints, fluid padding, card resize) | 25 min |
| E2. All micro-interactions (hover/active/focus/transitions) | 15 min |
| E3. State testing (idle → submitting → analyzing → done → error) | 20 min |
| E4. Focus ring + keyboard navigation audit | 15 min |
| **Total** | **75 min** |

### Grand Total

| Metric | Value |
|---|---|
| Files modified | **2** (`globals.css`, `page.tsx`) |
| Estimated CSS added | ~350 lines |
| Estimated JSX changed | ~250 lines |
| New components | 6 (Timeline, Skeleton, HeroCard, CompactCard, ScoreBar, StageDot) |
| Total implementation time | **~6 hours** (spread across 5 phases) |
| Backend changes | **Zero** |
| API changes | **Zero** |

---

## Appendix: V1 → V2 Changes Summary

| Element | V1 | V2 |
|---|---|---|
| Subheadline | None | "Surface the moments people actually remember." |
| Hero card height | 352px | **264px** (-25%) |
| Gold usage | Borders, cards, tags, dividers | **5% only**: CTA, score, elite dot, active stage |
| Section dividers | Gold accent | `rgba(255,255,255,0.06)` |
| DNA tags | Purple pills `#8b5cf6` | **Symbols** `◇ ▼ ♥ ◆ ✦ ▲ ■` monochrome |
| Compact card CTA | All cards | **Elite row only** (secondary has no CTA) |
| Score bar | Gold bar, number | Same (kept) |
| Results mount | Stagger 50ms | Stagger 60ms |
| Skeleton count | 4 | 4 (unchanged) |
| Mobile hero card | 240px | 240px (unchanged) |
