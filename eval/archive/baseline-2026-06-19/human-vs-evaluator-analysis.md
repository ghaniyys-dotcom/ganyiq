# Human vs Evaluator Analysis

## Summary

- Human Top 20 and Evaluator Top 20 show **very low overlap**.
- Many high-human-score clips (8–10) have density score **0/5**.
- Evaluator correctly identifies most clips as low-density.

## Key Mismatches (examples)

**High human score, low density**:
- P06_high_3_47s (human:9, density:0/5)
- P04_medium_0_175s (human:9, density:0/5)
- P01_negative_3_47s (human:9, density:0/5)
- P01_negative_2_79s (human:7, density:0/5)

These clips are likely motivational or emotional rather than informational.

**Low human score, relatively higher density**:
- P03_high_3_77s (human:7, density:1/5) — one of the few clips with a specific fact.

## Conclusion

Human labels in the current Gold Dataset V2 are **not aligned** with knowledge density. They appear to reward engagement, emotion, or hook strength more than actual information delivered.