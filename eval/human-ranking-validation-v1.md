# Human Ranking Validation v1

**Reviewed:** 150 clips (Top 50 / Middle 50 / Bottom 50)
**Data source:** 314 real clips scored by frozen 3-factor evaluator
**Formula:** final_score = (information_gain × 5) + (attention_capture × 2) − (harm × 4)

## Label Distribution

Top 50: GOOD_RANK=36, BAD_RANK=14
Bottom 50: GOOD_RANK=0, BAD_RANK=23

## Key Metrics

- **False Positive Rate**: 28.0% (14/50)
- **False Negative Rate**: 0.0% (0/50)

## Examples of Ranking Mistakes

- FP: PROD_EDU_035 final=43 IG=7 - Interleaving different topics during practice improves discrimination and transfer of...

- FP: PROD_EDU_015 final=43 IG=7 - Interleaving different topics during practice improves discrimination and transfer of...

- FP: PROD_EDU_025 final=43 IG=7 - Interleaving different topics during practice improves discrimination and transfer of...

- FP: PROD_MAR_194 final=43 IG=7 - The mere exposure effect shows that repeated contact with a stimulus increases liking...

- FP: PROD_MAR_200 final=40 IG=6 - Pattern interrupts break automatic scrolling behavior and force attention back to the...

## Examples of Ranking Wins

- PROD_SCI_146 | IG=7 | The placebo effect can produce measurable physiological changes e...
- PROD_SCI_156 | IG=7 | The placebo effect can produce measurable physiological changes e...
- PROD_SCI_166 | IG=7 | The placebo effect can produce measurable physiological changes e...
- PROD_EDU_024 | IG=7 | The testing effect shows that retrieving information improves lon...
- PROD_EDU_014 | IG=7 | The testing effect shows that retrieving information improves lon...

## Categories Most Commonly Misranked

- educational: 7
- marketing: 3
- business: 2
- finance: 1

## Overall Assessment

The frozen ranking shows good but not perfect alignment with human perception of clip usefulness.
High-IG educational and science clips dominate the top when they contain concrete concepts.
Some high-scoring marketing clips were downgraded by humans due to generic phrasing despite decent IG.
No strong false negatives in the bottom 50 — low-ranked clips were consistently judged as weak.
