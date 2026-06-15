#!/usr/bin/env python3
"""
eval/judge-v2-evaluate.py — Judge V2 Evaluation Script

Loads completed gold dataset CSV, runs QC checks, computes all metrics,
and generates markdown report.

Usage:
  python3 eval/judge-v2-evaluate.py --csv /tmp/ganyiq-gold-dataset-v2.csv

Output:
  /tmp/judge-v2-evaluation-report.md

No Judge Engine, prompt, or scoring modifications.
"""

import argparse
import csv
import math
import sys
from collections import defaultdict
from datetime import datetime

# ===========================================================================
# CSV Loader
# ===========================================================================

def load_csv(path: str) -> list[dict]:
    with open(path, newline='', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        rows = []
        for i, row in enumerate(reader):
            row['_row'] = i + 2  # 1-indexed + header
            rows.append(row)
    return rows


def safe_float(val, default=0.0):
    try:
        return float(val) if val else default
    except (ValueError, TypeError):
        return default


def safe_int(val, default=0):
    try:
        return int(float(val)) if val else default
    except (ValueError, TypeError):
        return default


# ===========================================================================
# QC Checks
# ===========================================================================

def check_anchors(rows: list[dict]) -> dict:
    """Verify anchor ordering: BAD < AVG < EXCELLENT."""
    anchors = [r for r in rows if r.get('isAnchor', '').strip().upper() == 'YES']
    result = {
        'anchors_found': len(anchors),
        'ordering_correct': False,
        'scores': {},
        'details': [],
    }

    for a in anchors:
        cid = a.get('clipId', '?')
        human = safe_float(a.get('HUMAN_SCORE_1_10', 0))
        level = a.get('anchorLevel', '?')
        result['scores'][cid] = {'human': human, 'level': level}
        result['details'].append(f"{cid} ({level}): human={human}")

    # Check ordering
    bad_key = next((k for k, v in result['scores'].items() if 'bad' in v.get('level', '').lower()), None)
    avg_key = next((k for k, v in result['scores'].items() if 'average' in v.get('level', '').lower()), None)
    exc_key = next((k for k, v in result['scores'].items() if 'excellent' in v.get('level', '').lower()), None)

    if bad_key and avg_key and exc_key:
        bad_s = result['scores'][bad_key]['human']
        avg_s = result['scores'][avg_key]['human']
        exc_s = result['scores'][exc_key]['human']
        result['ordering_correct'] = (bad_s < avg_s < exc_s)
        result['order'] = f"BAD={bad_s} < AVG={avg_s} < EXCELLENT={exc_s}"

    return result


def check_duplicates(rows: list[dict]) -> dict:
    """Check consistency of duplicate pairs."""
    dups = [r for r in rows if r.get('isDuplicate', '').strip().upper() == 'YES']
    result = {
        'duplicates_found': len(dups),
        'pairs': [],
        'pass_count': 0,
        'fail_count': 0,
        'pass_rate': 0.0,
        'overall_pass': False,
    }

    for dup in dups:
        orig_id = dup.get('originalClipId', '')
        human_dup = safe_float(dup.get('HUMAN_SCORE_1_10', 0))

        # Find original
        orig = next((r for r in rows if r.get('clipId', '') == orig_id), None)
        if orig:
            human_orig = safe_float(orig.get('HUMAN_SCORE_1_10', 0))
            delta = abs(human_dup - human_orig)
            pair = {
                'dup_id': dup.get('clipId', '?'),
                'orig_id': orig_id,
                'dup_score': human_dup,
                'orig_score': human_orig,
                'delta': delta,
                'pass': delta <= 1.0,
            }
            result['pairs'].append(pair)
            if pair['pass']:
                result['pass_count'] += 1
            else:
                result['fail_count'] += 1

    n = len(result['pairs'])
    result['pass_rate'] = result['pass_count'] / n if n > 0 else 0
    result['overall_pass'] = result['pass_rate'] >= 0.80
    return result


def check_fatigue(rows: list[dict]) -> dict:
    """Compare first 20 vs last 20 scores for fatigue."""
    real = [r for r in rows if r.get('isAnchor', '').strip().upper() != 'YES']
    scores = [safe_float(r.get('HUMAN_SCORE_1_10', 0)) for r in real]

    result = {'n_total': len(scores)}

    if len(scores) < 40:
        result['first_20_mean'] = 0
        result['last_20_mean'] = 0
        result['delta'] = 0
        result['pass'] = True
        result['warning'] = 'Insufficient data for fatigue check'
        return result

    first_20 = scores[:20]
    last_20 = scores[-20:]
    f_mean = sum(first_20) / len(first_20)
    l_mean = sum(last_20) / len(last_20)
    delta = abs(f_mean - l_mean)

    result['first_20_mean'] = round(f_mean, 2)
    result['last_20_mean'] = round(l_mean, 2)
    result['delta'] = round(delta, 2)
    result['pass'] = delta <= 1.0
    if delta > 1.0:
        result['warning'] = f'Fatigue detected: Δ={delta:.2f}'
    return result


def check_category_bias(rows: list[dict]) -> dict:
    """Per-category mean vs overall mean."""
    real = [r for r in rows if r.get('isAnchor', '').strip().upper() != 'YES']
    scores = [safe_float(r.get('HUMAN_SCORE_1_10', 0)) for r in real]
    overall_mean = sum(scores) / len(scores) if scores else 0

    by_cat: dict[str, list[float]] = defaultdict(list)
    for r in real:
        cat = r.get('category', 'Unknown')
        s = safe_float(r.get('HUMAN_SCORE_1_10', 0))
        by_cat[cat].append(s)

    result = {
        'overall_mean': round(overall_mean, 2),
        'n_total': len(scores),
        'categories': {},
        'max_deviation': 0.0,
        'biased_categories': [],
        'pass': True,
    }

    for cat, cat_scores in sorted(by_cat.items()):
        cat_mean = sum(cat_scores) / len(cat_scores)
        dev = abs(cat_mean - overall_mean)
        result['categories'][cat] = {
            'n': len(cat_scores),
            'mean': round(cat_mean, 2),
            'deviation': round(dev, 2),
            'biased': dev > 1.0,
        }
        if dev > result['max_deviation']:
            result['max_deviation'] = dev
        if dev > 1.0:
            result['biased_categories'].append(cat)

    result['pass'] = len(result['biased_categories']) == 0
    return result


# ===========================================================================
# Statistical Functions
# ===========================================================================

def spearman_rho(x: list[float], y: list[float]) -> float:
    """Spearman rank correlation coefficient."""
    n = len(x)
    if n < 3:
        return 0.0

    def rank(vals):
        indexed = sorted([(v, i) for i, v in enumerate(vals)], reverse=True)
        ranks = [0] * n
        for pos, (_, idx) in enumerate(indexed):
            ranks[idx] = pos + 1
        return ranks

    rx = rank(x)
    ry = rank(y)
    d2 = sum((rx[i] - ry[i]) ** 2 for i in range(n))
    return 1 - (6 * d2) / (n * (n * n - 1))


def kendall_tau(x: list[float], y: list[float]) -> float:
    """Kendall Tau rank correlation coefficient."""
    n = len(x)
    if n < 2:
        return 0.0

    concordant = 0
    discordant = 0
    for i in range(n):
        for j in range(i + 1, n):
            dx = x[i] - x[j]
            dy = y[i] - y[j]
            if dx * dy > 0:
                concordant += 1
            elif dx * dy < 0:
                discordant += 1
    total = concordant + discordant
    return (concordant - discordant) / total if total > 0 else 0.0


def pearson_r(x: list[float], y: list[float]) -> float:
    """Pearson correlation coefficient."""
    n = len(x)
    if n < 3:
        return 0.0

    mx = sum(x) / n
    my = sum(y) / n
    num = sum((x[i] - mx) * (y[i] - my) for i in range(n))
    den = math.sqrt(sum((x[i] - mx) ** 2 for i in range(n)) *
                    sum((y[i] - my) ** 2 for i in range(n)))
    return num / den if den != 0 else 0.0


def ndcg_at_k(ranking_scores: list[float], human_scores: list[int], k: int, gain_map: dict[int, int] = None) -> float:
    """NDCG@K: Normalized Discounted Cumulative Gain."""
    if gain_map is None:
        gain_map = {9: 3, 10: 3, 7: 2, 8: 2, 5: 1, 6: 1}

    def gain(hs):
        for threshold, g in sorted(gain_map.items(), reverse=True):
            if hs >= threshold:
                return g
        return 0

    # Sort by system score descending, take top-k
    indexed = sorted(enumerate(ranking_scores), key=lambda x: -x[1])
    top_k = indexed[:k]

    dcg = 0.0
    for pos, (idx, _) in enumerate(top_k):
        g = gain(human_scores[idx])
        if pos == 0:
            dcg += g
        else:
            dcg += g / math.log2(pos + 1)

    # Ideal: sort by human score descending, take top-k
    ideal = sorted(human_scores, reverse=True)[:k]
    idcg = 0.0
    for pos, g in enumerate([gain(h) for h in ideal]):
        if pos == 0:
            idcg += g
        else:
            idcg += g / math.log2(pos + 1)

    return dcg / idcg if idcg > 0 else 0.0


def precision_at_k(system_ranking: list[float], human_ranking: list[float], k: int) -> float:
    """Precision@K: proportion of system's top-k that overlap with human's top-k."""
    n = len(system_ranking)
    sys_top = set(sorted(range(n), key=lambda i: -system_ranking[i])[:k])
    human_top = set(sorted(range(n), key=lambda i: -human_ranking[i])[:k])
    overlap = len(sys_top & human_top)
    return overlap / k


# ===========================================================================
# NDCG Gain Mapping
# ===========================================================================

def human_to_gain(score: float) -> int:
    if score >= 9:
        return 3
    elif score >= 7:
        return 2
    elif score >= 5:
        return 1
    return 0


# ===========================================================================
# Main Evaluation
# ===========================================================================

def evaluate(path: str):
    rows = load_csv(path)

    # -----------------------------------------------------------------------
    # 1. Separate anchors, duplicates, and real data
    # -----------------------------------------------------------------------
    anchors = [r for r in rows if r.get('isAnchor', '').strip().upper() == 'YES']
    duplicate_flags = {r.get('originalClipId', '') for r in rows if r.get('isDuplicate', '').strip().upper() == 'YES'}
    duplicates = [r for r in rows if r.get('isDuplicate', '').strip().upper() == 'YES']
    duplicate_originals = [r for r in rows if r.get('clipId', '') in duplicate_flags and r.get('isDuplicate', '').strip().upper() != 'YES']

    # Real: non-anchor, non-duplicate, non-duplicate-original
    dup_clip_ids = set(r.get('clipId', '') for r in duplicates)
    dup_orig_ids = set(r.get('clipId', '') for r in duplicate_originals)
    real = [r for r in rows
            if r.get('isAnchor', '').strip().upper() != 'YES'
            and r.get('clipId', '') not in dup_clip_ids
            and r.get('clipId', '') not in dup_orig_ids]

    # -----------------------------------------------------------------------
    # 2. Quick validation
    # -----------------------------------------------------------------------
    missing_human = [r for r in real if not r.get('HUMAN_SCORE_1_10', '').strip()]
    if missing_human:
        print(f"\n❌ ERROR: {len(missing_human)} clips missing HUMAN_SCORE_1_10:")
        for m in missing_human[:5]:
            print(f"   Row {m['_row']}: {m.get('clipId', '?')}")
        sys.exit(1)

    # -----------------------------------------------------------------------
    # 3. QC Checks
    # -----------------------------------------------------------------------
    print("Running QC checks...")
    qc_anchors = check_anchors(rows)
    qc_dups = check_duplicates(rows)
    qc_fatigue = check_fatigue(rows)
    qc_category = check_category_bias(rows)

    # -----------------------------------------------------------------------
    # 4. Extract scores
    # -----------------------------------------------------------------------
    human_scores_raw = [safe_float(r.get('HUMAN_SCORE_1_10', 0)) for r in real]
    human_scores_int = [round(s) for s in human_scores_raw]
    v1_scores = [safe_float(r.get('v1Score', 0)) for r in real]
    v2_scores = [safe_float(r.get('v2Curved', 0)) for r in real]
    hook_scores = [safe_float(r.get('v2Hook', 0)) for r in real]
    coh_scores = [safe_float(r.get('v2Coherence', 0)) for r in real]
    conn_scores = [safe_float(r.get('v2Connection', 0)) for r in real]
    trend_scores = [safe_float(r.get('v2Trend', 0)) for r in real]

    n = len(real)

    # -----------------------------------------------------------------------
    # 5. Compute metrics
    # -----------------------------------------------------------------------
    print("Computing metrics...")
    metrics = {}

    # Spearman
    metrics['spearman_v1'] = spearman_rho(human_scores_raw, v1_scores)
    metrics['spearman_v2'] = spearman_rho(human_scores_raw, v2_scores)
    metrics['spearman_delta'] = metrics['spearman_v2'] - metrics['spearman_v1']
    metrics['spearman_hook'] = spearman_rho(human_scores_raw, hook_scores)
    metrics['spearman_coh'] = spearman_rho(human_scores_raw, coh_scores)
    metrics['spearman_conn'] = spearman_rho(human_scores_raw, conn_scores)
    metrics['spearman_trend'] = spearman_rho(human_scores_raw, trend_scores)

    # Kendall Tau
    metrics['kendall_v1'] = kendall_tau(human_scores_raw, v1_scores)
    metrics['kendall_v2'] = kendall_tau(human_scores_raw, v2_scores)
    metrics['kendall_delta'] = metrics['kendall_v2'] - metrics['kendall_v1']

    # Pearson
    metrics['pearson_v1'] = pearson_r(human_scores_raw, v1_scores)
    metrics['pearson_v2'] = pearson_r(human_scores_raw, v2_scores)
    metrics['pearson_delta'] = metrics['pearson_v2'] - metrics['pearson_v1']
    metrics['pearson_hook'] = pearson_r(human_scores_raw, hook_scores)
    metrics['pearson_coh'] = pearson_r(human_scores_raw, coh_scores)
    metrics['pearson_conn'] = pearson_r(human_scores_raw, conn_scores)
    metrics['pearson_trend'] = pearson_r(human_scores_raw, trend_scores)

    # NDCG@5
    metrics['ndcg5_v1'] = ndcg_at_k(v1_scores, human_scores_int, 5)
    metrics['ndcg5_v2'] = ndcg_at_k(v2_scores, human_scores_int, 5)

    # Precision@3
    metrics['precision3_v1'] = precision_at_k(v1_scores, human_scores_raw, 3)
    metrics['precision3_v2'] = precision_at_k(v2_scores, human_scores_raw, 3)

    # Top-3 Overlap
    n_idx = n
    v1_top3 = set(sorted(range(n_idx), key=lambda i: -v1_scores[i])[:3])
    v2_top3 = set(sorted(range(n_idx), key=lambda i: -v2_scores[i])[:3])
    human_top3 = set(sorted(range(n_idx), key=lambda i: -human_scores_raw[i])[:3])
    metrics['top3_v1_overlap'] = len(v1_top3 & human_top3) / 3
    metrics['top3_v2_overlap'] = len(v2_top3 & human_top3) / 3

    # -----------------------------------------------------------------------
    # 6. Per-category metrics (exploratory)
    # -----------------------------------------------------------------------
    cat_scores: dict[str, dict] = {}
    for r in real:
        cat = r.get('category', 'Unknown')
        if cat not in cat_scores:
            cat_scores[cat] = {'human': [], 'v1': [], 'v2': []}
        cat_scores[cat]['human'].append(safe_float(r.get('HUMAN_SCORE_1_10', 0)))
        cat_scores[cat]['v1'].append(safe_float(r.get('v1Score', 0)))
        cat_scores[cat]['v2'].append(safe_float(r.get('v2Curved', 0)))

    cat_metrics = {}
    for cat, data in sorted(cat_scores.items()):
        if len(data['human']) >= 3:
            cat_metrics[cat] = {
                'n': len(data['human']),
                'human_mean': round(sum(data['human']) / len(data['human']), 2),
                'v1_spearman': round(spearman_rho(data['human'], data['v1']), 3),
                'v2_spearman': round(spearman_rho(data['human'], data['v2']), 3),
            }

    # -----------------------------------------------------------------------
    # 7. Score distribution stats
    # -----------------------------------------------------------------------
    def distribution_stats(vals):
        mn = sum(vals) / len(vals)
        sd = math.sqrt(sum((x - mn) ** 2 for x in vals) / (len(vals) - 1)) if len(vals) > 1 else 0
        return {
            'mean': round(mn, 2),
            'std': round(sd, 2),
            'min': round(min(vals), 1),
            'max': round(max(vals), 1),
            'range': round(max(vals) - min(vals), 1),
        }

    score_stats = {
        'human': distribution_stats(human_scores_raw),
        'v1': distribution_stats(v1_scores),
        'v2': distribution_stats(v2_scores),
        'hook': distribution_stats(hook_scores),
        'coherence': distribution_stats(coh_scores),
        'connection': distribution_stats(conn_scores),
        'trend': distribution_stats(trend_scores),
    }

    # -----------------------------------------------------------------------
    # 8. Generate Report
    # -----------------------------------------------------------------------
    report = []
    report.append(f"# Judge V2 Evaluation Report")
    report.append(f"")
    report.append(f"**Generated:** {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    report.append(f"**Dataset:** {path}")
    report.append(f"**N (real clips):** {n}")
    report.append(f"**Total rows:** {len(rows)}")
    report.append(f"")

    # QC Section
    report.append(f"---")
    report.append(f"## 1. Quality Control")
    report.append(f"")

    # Anchors
    report.append(f"### 1.1 Anchor Calibration")
    report.append(f"")
    for d in qc_anchors['details']:
        report.append(f"- {d}")
    if qc_anchors['ordering_correct']:
        report.append(f"- ✅ **PASS:** BAD < AVG < EXCELLENT ({qc_anchors['order']})")
    else:
        report.append(f"- ❌ **FAIL:** Anchor ordering incorrect ({qc_anchors.get('order', 'N/A')})")
    report.append(f"")

    # Duplicates
    report.append(f"### 1.2 Duplicate Consistency")
    report.append(f"")
    report.append(f"| Pair | Dup Score | Orig Score | Delta | Pass (≤1) |")
    report.append(f"|------|-----------|------------|-------|-----------|")
    for p in qc_dups['pairs']:
        check = "✅" if p['pass'] else "❌"
        report.append(f"| {p['dup_id'][:30]} | {p['dup_score']} | {p['orig_score']} | {p['delta']:.1f} | {check} |")
    report.append(f"")
    rate_pct = qc_dups['pass_rate'] * 100
    if qc_dups['overall_pass']:
        report.append(f"- ✅ **PASS:** {qc_dups['pass_count']}/{len(qc_dups['pairs'])} pairs consistent ({rate_pct:.0f}%)")
    else:
        report.append(f"- ❌ **FAIL:** {qc_dups['pass_count']}/{len(qc_dups['pairs'])} pairs consistent ({rate_pct:.0f}%) — need ≥ 80%")
    report.append(f"")

    # Fatigue
    report.append(f"### 1.3 Fatigue Check")
    report.append(f"")
    report.append(f"- First 20 human mean: {qc_fatigue.get('first_20_mean', 'N/A')}")
    report.append(f"- Last 20 human mean: {qc_fatigue.get('last_20_mean', 'N/A')}")
    report.append(f"- Delta: {qc_fatigue.get('delta', 'N/A')}")
    fatig = qc_fatigue.get('warning', '')
    if qc_fatigue.get('pass', False):
        report.append(f"- ✅ PASS: No significant fatigue (Δ={qc_fatigue.get('delta', 0):.2f})")
    else:
        report.append(f"- ⚠ WARNING: {fatig}")
    report.append(f"")

    # Category bias
    report.append(f"### 1.4 Category Bias")
    report.append(f"")
    report.append(f"Overall human mean: {qc_category['overall_mean']}")
    report.append(f"")
    report.append(f"| Category | N | Mean | Deviation | Biased (>1.0) |")
    report.append(f"|----------|---|------|-----------|----------------|")
    for cat, data in sorted(qc_category['categories'].items()):
        biased = "⚠" if data['biased'] else "✅"
        report.append(f"| {cat} | {data['n']} | {data['mean']} | +{data['deviation']:.2f} | {biased} |")
    report.append(f"")
    if qc_category['pass']:
        report.append(f"- ✅ PASS: No category bias detected (max deviation = {qc_category['max_deviation']:.2f})")
    else:
        biased_list = ', '.join(qc_category['biased_categories'])
        report.append(f"- ⚠ WARNING: Bias in: {biased_list}")
    report.append(f"")

    # Score Distribution
    report.append(f"## 2. Score Distribution")
    report.append(f"")
    report.append(f"| Source | Mean | Std | Min | Max | Range |")
    report.append(f"|--------|------|-----|-----|-----|-------|")
    for key in ['human', 'v1', 'v2', 'hook', 'coherence', 'connection', 'trend']:
        s = score_stats[key]
        report.append(f"| {key.capitalize()} | {s['mean']} | {s['std']} | {s['min']} | {s['max']} | {s['range']} |")
    report.append(f"")

    # Metrics
    report.append(f"## 3. Evaluation Metrics")
    report.append(f"")

    # 3a. Correlation
    report.append(f"### 3.1 Correlation (Full Dataset, n={n})")
    report.append(f"")
    report.append(f"| System | Spearman ρ | Kendall τ | Pearson r |")
    report.append(f"|--------|-----------|-----------|-----------|")
    report.append(f"| **V1** (worthClippingScore) | {metrics['spearman_v1']:.3f} | {metrics['kendall_v1']:.3f} | {metrics['pearson_v1']:.3f} |")
    report.append(f"| **V2** (curvedScore) | {metrics['spearman_v2']:.3f} | {metrics['kendall_v2']:.3f} | {metrics['pearson_v2']:.3f} |")
    delta_sign = "+" if metrics['spearman_delta'] >= 0 else ""
    report.append(f"| **Δ (V2 - V1)** | **{delta_sign}{metrics['spearman_delta']:.3f}** | **{delta_sign}{metrics['kendall_delta']:.3f}** | **{delta_sign}{metrics['pearson_delta']:.3f}** |")
    report.append(f"")

    # 3b. Dimensional
    report.append(f"### 3.2 Per-Dimension Correlation")
    report.append(f"")
    report.append(f"| Dimension | Spearman ρ vs Human | Pearson r vs Human |")
    report.append(f"|-----------|-------------------|-------------------|")
    dims = [
        ('Hook', metrics['spearman_hook'], metrics['pearson_hook']),
        ('Coherence', metrics['spearman_coh'], metrics['pearson_coh']),
        ('Connection', metrics['spearman_conn'], metrics['pearson_conn']),
        ('Trend', metrics['spearman_trend'], metrics['pearson_trend']),
    ]
    # Sort by Spearman descending
    dims_sorted = sorted(dims, key=lambda x: -x[1])
    for name, sp, pr in dims_sorted:
        report.append(f"| {name} | {sp:.3f} | {pr:.3f} |")
    report.append(f"")

    best_dim = dims_sorted[0][0]
    worst_dim = dims_sorted[-1][0]
    report.append(f"**Strongest dimension:** {best_dim} (ρ={dims_sorted[0][1]:.3f})")
    report.append(f"**Weakest dimension:** {worst_dim} (ρ={dims_sorted[-1][1]:.3f})")
    report.append(f"")

    # 3c. Ranking
    report.append(f"### 3.3 Ranking Metrics")
    report.append(f"")
    report.append(f"| Metric | V1 | V2 | Better? |")
    report.append(f"|--------|----|----|---------|")
    ndcg_delta = metrics['ndcg5_v2'] - metrics['ndcg5_v1']
    ndcg_better = "✅ V2" if ndcg_delta > 0 else ("✅ V1" if ndcg_delta < 0 else "=")
    report.append(f"| NDCG@5 | {metrics['ndcg5_v1']:.3f} | {metrics['ndcg5_v2']:.3f} | {ndcg_better} |")
    prec_better = "✅ V2" if metrics['precision3_v2'] > metrics['precision3_v1'] else ("✅ V1" if metrics['precision3_v1'] > metrics['precision3_v2'] else "=")
    report.append(f"| Precision@3 | {metrics['precision3_v1']:.3f} | {metrics['precision3_v2']:.3f} | {prec_better} |")
    top3_better = "✅ V2" if metrics['top3_v2_overlap'] > metrics['top3_v1_overlap'] else ("✅ V1" if metrics['top3_v1_overlap'] > metrics['top3_v2_overlap'] else "=")
    report.append(f"| Top-3 Overlap | {metrics['top3_v1_overlap']:.1f}/3 | {metrics['top3_v2_overlap']:.1f}/3 | {top3_better} |")
    report.append(f"")

    # 4. Category breakdown
    if cat_metrics:
        report.append(f"## 4. Per-Category Breakdown")
        report.append(f"")
        report.append(f"| Category | N | Human μ | V1 ρ | V2 ρ | V2 Better? |")
        report.append(f"|----------|---|---------|------|------|------------|")
        for cat, data in sorted(cat_metrics.items()):
            v2_better = ""
            if 'v1_spearman' in data and 'v2_spearman' in data:
                delta_cat = data['v2_spearman'] - data['v1_spearman']
                v2_better = "✅" if delta_cat > 0 else ("⚠" if delta_cat == 0 else "❌")
                data['v1_spearman'] = round(data['v1_spearman'], 3)
                data['v2_spearman'] = round(data['v2_spearman'], 3)
            report.append(f"| {cat} | {data['n']} | {data['human_mean']} | {data.get('v1_spearman', 'N/A')} | {data.get('v2_spearman', 'N/A')} | {v2_better} |")
        report.append(f"")

    # 5. Top-3 Clips comparison
    report.append(f"## 5. Top-3 Clips")
    report.append(f"")
    report.append(f"### Human Top-3")
    report.append(f"")
    for pos, i in enumerate(sorted(human_top3, key=lambda i: -human_scores_raw[i])[:3]):
        r = real[i]
        excerpt = r.get('transcriptExcerpt', '')[:80]
        report.append(f"{pos+1}. Human={human_scores_raw[i]:.0f} | V1={v1_scores[i]:.0f} | V2={v2_scores[i]:.0f} | \"{excerpt}...\"")
    report.append(f"")
    report.append(f"### V1 Top-3")
    report.append(f"")
    for pos, i in enumerate(sorted(v1_top3, key=lambda i: -v1_scores[i])[:3]):
        r = real[i]
        excerpt = r.get('transcriptExcerpt', '')[:80]
        report.append(f"{pos+1}. V1={v1_scores[i]:.0f} | Human={human_scores_raw[i]:.0f} | V2={v2_scores[i]:.0f} | \"{excerpt}...\"")
    report.append(f"")
    report.append(f"### V2 Top-3")
    report.append(f"")
    for pos, i in enumerate(sorted(v2_top3, key=lambda i: -v2_scores[i])[:3]):
        r = real[i]
        excerpt = r.get('transcriptExcerpt', '')[:80]
        report.append(f"{pos+1}. V2={v2_scores[i]:.0f} | Human={human_scores_raw[i]:.0f} | V1={v1_scores[i]:.0f} | \"{excerpt}...\"")
    report.append(f"")

    # 6. Decision
    sp_v2 = metrics['spearman_v2']
    ndcg5_v2 = metrics['ndcg5_v2']
    delta = metrics['spearman_delta']

    report.append(f"## 6. Decision")
    report.append(f"")

    # Go/No-Go Logic
    qc_all_pass = (
        qc_anchors['ordering_correct']
        and qc_dups['overall_pass']
        and qc_fatigue.get('pass', False)
        and qc_category['pass']
    )

    if not qc_all_pass:
        decision = "INVALID"
        rationale = "QC checks failed. See sections above for details."
    elif sp_v2 >= 0.70 and ndcg5_v2 >= 0.85 and delta > 0:
        decision = "✅ GO"
        rationale = "Spearman ≥ 0.70, NDCG@5 ≥ 0.85, V2 > V1. Production ready."
    elif sp_v2 >= 0.70 and ndcg5_v2 < 0.85 and delta > 0:
        decision = "⚠ GO-CONDITIONAL"
        rationale = "Spearman ≥ 0.70, but NDCG@5 < 0.85. Deploy with monitoring."
    elif sp_v2 >= 0.50 and delta > 0:
        decision = "⚠ TUNE"
        rationale = f"Spearman = {sp_v2:.2f} (moderate). Improving V2 over V1 (+{delta:.3f}), but not strong enough."
    elif sp_v2 >= 0.50 and delta <= 0:
        decision = "⚠ TUNE-LOW"
        rationale = f"Spearman = {sp_v2:.2f} but V2 does not improve over V1 (Δ={delta:.3f}). Consider hybrid approach."
    elif sp_v2 < 0.50:
        decision = "❌ NO-GO"
        rationale = f"Spearman = {sp_v2:.2f} < 0.50. V2 does not reliably capture human preference."
    else:
        decision = "❌ NO-GO"
        rationale = "Insufficient evidence for production."

    report.append(f"**Decision: {decision}**")
    report.append(f"")
    report.append(f"**Rationale:** {rationale}")
    report.append(f"")
    report.append(f"| Gate | Value | Threshold | Status |")
    report.append(f"|------|-------|-----------|--------|")
    report.append(f"| Spearman ρ(V2) | {sp_v2:.3f} | ≥ 0.70 | {'✅' if sp_v2 >= 0.70 else '⚠' if sp_v2 >= 0.50 else '❌'} |")
    report.append(f"| NDCG@5 | {ndcg5_v2:.3f} | ≥ 0.85 | {'✅' if ndcg5_v2 >= 0.85 else '⚠' if ndcg5_v2 >= 0.70 else '❌'} |")
    report.append(f"| Δρ (V2-V1) | {delta:.3f} | > 0 | {'✅' if delta > 0 else '❌'} |")
    report.append(f"| QC All Pass | {'Yes' if qc_all_pass else 'No'} | — | {'✅' if qc_all_pass else '❌'} |")
    report.append(f"")

    # If TUNE: recommendations
    if 'TUNE' in decision:
        report.append(f"### Recommended Tuning Actions")
        report.append(f"")
        dims_sorted_names = [d[0] for d in dims_sorted]
        worst = dims_sorted_names[-1]
        report.append(f"1. **Fix weakest dimension:** {worst} (ρ={dims_sorted[-1][1]:.3f})")
        report.append(f"2. **Prompt tuning:** Add anchor examples to encourage 0-10 range usage")
        if worst == 'Trend':
            report.append(f"3. **Trend context:** Inject current_date + trending topics into trend prompt")
        report.append(f"4. **Re-weight dimensions:** Prioritize Hook + Coherence over Connection + Trend")
        report.append(f"5. **Re-evaluate** after each change")

    report.append(f"")
    report.append(f"---")
    report.append(f"*Report generated by eval/judge-v2-evaluate.py*")

    return '\n'.join(report), decision, metrics


# ===========================================================================
# CLI Entry Point
# ===========================================================================

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Judge V2 Evaluation Script')
    parser.add_argument('--csv', required=True, help='Path to completed gold dataset CSV')
    parser.add_argument('--output', default='/tmp/judge-v2-evaluation-report.md', help='Output report path')
    args = parser.parse_args()

    print(f"Loading: {args.csv}")
    report_text, decision, metrics = evaluate(args.csv)

    with open(args.output, 'w') as f:
        f.write(report_text)
    print(f"\nReport written: {args.output}")
    print(f"Decision: {decision}")
    print(f"\nKey metrics:")
    print(f"  Spearman ρ(V1): {metrics['spearman_v1']:.3f}")
    print(f"  Spearman ρ(V2): {metrics['spearman_v2']:.3f}")
    print(f"  Δρ: {metrics['spearman_delta']:.3f}")
    print(f"  Kendall τ(V2): {metrics['kendall_v2']:.3f}")
    print(f"  NDCG@5(V2): {metrics['ndcg5_v2']:.3f}")
    print(f"  Precision@3(V2): {metrics['precision3_v2']:.3f}")
    print(f"  Top-3 Overlap(V2): {metrics['top3_v2_overlap']:.1f}/3")
