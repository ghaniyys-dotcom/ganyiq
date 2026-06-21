# Production Validation Report V1

**Dataset**: production-validation-dataset-v1.csv (315 clips)
**Evaluator**: Frozen (no changes to prompt, validator, or formula)
**Scoring**: final_score = (information_gain * 5) + (attention_capture * 2) - (harm * 4)

## Distribution Summary

- IG Mean: 4.1
- % IG >= 6: 19.7%
- StdDev: ~1.7 (healthy variance)

## TOP 50 Clips (by final_score)

### Top 10
- PROD_SCI_178 | science | IG:8 AC:6 H:0 | final:52
- PROD_EDU_011 | educational | IG:7 AC:6 H:0 | final:47
- PROD_EDU_017 | educational | IG:8 AC:5 H:1 | final:46
- PROD_MAR_216 | marketing | IG:7 AC:5 H:0 | final:45
- PROD_EDU_031 | educational | IG:8 AC:2 H:0 | final:44
- PROD_TEC_298 | technology | IG:7 AC:4 H:0 | final:43
- PROD_SCI_142 | science | IG:7 AC:4 H:0 | final:43
- PROD_MAR_183 | marketing | IG:7 AC:6 H:1 | final:43
- PROD_TEC_297 | technology | IG:6 AC:6 H:0 | final:42
- PROD_SCI_170 | science | IG:7 AC:5 H:1 | final:41

*(Full TOP 50 available in evaluations file sorted by final_score)*

## BOTTOM 50 Clips (by final_score)

### Bottom 10
- PROD_PRO_094 | productivity | IG:0 AC:1 H:0 | final:2
- PROD_BUS_049 | business | IG:1 AC:3 H:2 | final:3
- PROD_EDU_008 | educational | IG:1 AC:3 H:2 | final:3
- PROD_MAR_194 | marketing | IG:1 AC:2 H:1 | final:5
- PROD_TEC_296 | technology | IG:1 AC:2 H:1 | final:5
- PROD_PRO_095 | productivity | IG:2 AC:4 H:3 | final:6
- PROD_BUS_062 | business | IG:2 AC:2 H:2 | final:6
- PROD_TEC_272 | technology | IG:1 AC:3 H:1 | final:7
- PROD_MAR_186 | marketing | IG:0 AC:4 H:0 | final:8
- PROD_MAR_192 | marketing | IG:2 AC:3 H:2 | final:8

## Manual Quality Audit

### A. Do top-ranked clips genuinely deserve to rank higher?

**Yes, in most cases.**

The top clips contain concrete, specific, and actionable scientific or educational facts (e.g., "The hippocampus consolidates...", "The testing effect...", "Compound interest..."). These have high information density and clear utility. The scoring correctly rewards them with IG 7-8.

### B. Are there obvious false positives?

**Few obvious ones.**

Most top 50 clips have legitimate informational value. However, a small number of marketing clips with strong hooks but medium substance made it into the upper ranks (e.g., PROD_MAR_216). These benefit from high attention_capture combined with decent IG.

### C. Are there obvious false negatives?

**Yes, some exist.**

A few high-quality science and technology clips received lower scores than expected (IG 3-4) despite containing precise mechanisms. This appears to happen when the transcript is very concise and lacks emotional or hook language, lowering attention_capture.

### D. Are there categories systematically favored or penalized?

**Observations:**

- **Favored**: Science and Educational categories frequently appear in the top 30. They tend to contain precise mechanisms and explanations that the evaluator rewards with higher IG.
- **Penalized**: Productivity and some Business clips appear more often in the bottom ranks. Many productivity clips in the dataset are principle-based rather than technique-heavy, leading to lower IG.
- Marketing shows high variance — strong hook + decent fact can rank high, while pure hype ranks low.
- Technology is mixed: implementation details score well; high-level descriptions score average.

**Overall Assessment**

The frozen evaluator is ranking based on actual information density rather than hype or emotional language. Top clips are genuinely more valuable for learning. The main weakness is that very concise but high-signal clips can be under-ranked if they lack strong attention elements.

No tuning was performed. This is a pure evaluation of the current frozen system on a diverse real-world-style dataset.