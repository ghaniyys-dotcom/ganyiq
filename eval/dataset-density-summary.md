# Dataset Information Density Audit — Summary

## Overall Statistics

- Total clips audited: 80
- Average transcript length: ~120 characters
- Average word count: ~22 words
- Average sentence count: ~2.1 sentences

## Information Element Prevalence

| Element              | % of Clips | Count |
|----------------------|------------|-------|
| Specific facts       | 6.3%       | 5     |
| Actionable advice    | 2.5%       | 2     |
| Frameworks           | 0.0%       | 0     |
| Techniques           | 0.0%       | 0     |
| Novel insights       | 0.0%       | 0     |

**Key observation**: 93.7% of clips contain **zero** of the five high-value information elements.

## Density Distribution

- Clips with density score 0/5: **75** (93.75%)
- Clips with density score 1/5: **5** (6.25%)
- Clips with density score ≥ 2/5: **0**

## Top 20 Highest-Density Clips

All top clips have only **1/5** elements (mostly "specific fact"). No clip reached 2+ elements.

## Bottom 20 Lowest-Density Clips

All have **0/5** elements.

## Human vs Evaluator Alignment

Human high-score clips (humanScore 8–10) appear in both top and bottom density groups, showing weak correlation between human labels and actual information density.

---

## ROOT CAUSE

**B. Dataset quality issue**

**Evidence**:
- 93.75% of the dataset contains **zero** high-value information elements.
- Zero clips contain frameworks, techniques, or novel insights.
- Only 2.5% contain actionable advice.
- The evaluator (both numeric and categorical) is correctly reflecting the low information density of the dataset.

**Conclusion**:
The benchmark is currently measuring **engagement + emotional value** rather than **information value**. The Gold Dataset V2 is not suitable for testing an information-gain evaluator because it lacks sufficient informational content.