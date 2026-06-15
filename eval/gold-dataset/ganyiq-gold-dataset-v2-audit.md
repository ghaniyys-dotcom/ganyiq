# GANYIQ Gold Dataset V2 — Audit Report

## 1. Komposisi

| Tier | Count | V1 Range | V2 Range |
|------|-------|----------|----------|
| negative | 27 | 35-95 | 38-100 |
| high | 26 | 82-95 | 61-100 |
| medium | 24 | 55-73 | 44-100 |
| Duplicates | 5 | — | — |
| Anchors | 3 | 30-95 | 24-100 |
| **Total** | **80** | — | — |

## 2. Score Distribution

**V1 Score:**
   30-39: █████ 5
   40-49: ███ 3
   50-59: ████████ 8
   60-69: ████ 4
   70-79: ████████████████████ 20
   80-89: ████████ 8
   90-99: █████████████████████████████ 29

**V2 Curved:**
   30-39: █ 1
   40-49: ██ 2
   50-59: ███ 3
   60-69: █████ 5
   70-79: █████████ 9
   80-89: ████████████████████████████ 28
   90-99: ████████████████████████ 24
  100-109: █████ 5

## 3. Category Distribution

| Comedy / Mental Health | 17 | H=5 M=4 N=8 |
| Controversy / Comedy | 17 | H=4 M=4 N=9 |
| Business / Entrepreneurship | 11 | H=5 M=4 N=2 |
| Motivation / Self-Help | 11 | H=4 M=4 N=3 |
| Finance / Politics | 10 | H=4 M=4 N=2 |
| Crime / Storytelling | 11 | H=4 M=4 N=3 |

## 4. Duration Distribution

  0-9s: ████ 4
  10-19s: ███████████████████████████████ 31
  20-29s: ██████████████████████████████ 30
  30-39s: ████████████ 12

## 5. Positive vs Negative Ratio

Positive (high + medium): 50 (65%)
Negative: 27 (35%)
Ratio: 1.9:1

## 6. Duplicate Check

Duplicate clip IDs: P01_negative_3_47s_DUP, P02_high_0_15s_DUP, P04_high_1_195s_DUP, P06_negative_1_12s_DUP, P05_negative_converted_3_35s_DUP
These 5 clips appear TWICE in the dataset.
After labeling: check if human score matches between original & duplicate.
Consistency target: ≥ 80% of duplicates within ±1 point.
