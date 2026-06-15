#!/usr/bin/env python3
"""
eval/judge-v2-misranking-audit.py — Clip-Level Misranking Audit

Compares Human Top 10 vs V2 Top 10 (before and after Cycle 1 tuning).
Identifies root cause of NDCG@5 drop.

Usage:
  python3 eval/judge-v2-misranking-audit.py
"""

import csv
from collections import defaultdict

# ===========================================================================
# Load data
# ===========================================================================

def load_csv(path):
    with open(path, newline='', encoding='utf-8') as f:
        return list(csv.DictReader(f))

# Original (pre-tune) results
orig_rows = load_csv('/root/GANYIQ/eval/gold-dataset/ganyiq-gold-dataset-v2-labeled.csv')

# Tuned results  
tuned_rows = load_csv('/root/GANYIQ/eval/gold-dataset/ganyiq-gold-dataset-v2-tuned.csv')

# Build lookup by clipId
orig_by_id = {}
for r in orig_rows:
    cid = r.get('clipId', '').strip()
    if cid:
        orig_by_id[cid] = r

tuned_by_id = {}
for r in tuned_rows:
    cid = r.get('clipId', '').strip()
    if cid:
        tuned_by_id[cid] = r

# ===========================================================================
# Helper
# ===========================================================================

def safe_float(v, default=0.0):
    try:
        return float(v) if v else default
    except (ValueError, TypeError):
        return default

def safe_int(v, default=0):
    try:
        return int(float(v)) if v else default
    except (ValueError, TypeError):
        return default

# ===========================================================================
# Build comparison dataset
# ===========================================================================

clips = []
for cid, o in orig_by_id.items():
    t = tuned_by_id.get(cid)
    if not t:
        continue
    
    # Skip anchors and duplicates
    is_anchor = o.get('isAnchor', '').strip().upper() == 'YES'
    is_dup = o.get('isDuplicate', '').strip().upper() == 'YES'
    if is_anchor or is_dup:
        continue
    
    human = safe_int(o.get('HUMAN_SCORE_1_10', 0))
    
    # Before tuning
    v1_before = safe_float(o.get('v1Score', 0))
    v2_hook_before = safe_float(o.get('v2Hook', 0))
    v2_coh_before = safe_float(o.get('v2Coherence', 0))
    v2_conn_before = safe_float(o.get('v2Connection', 0))
    v2_trend_before = safe_float(o.get('v2Trend', 0))
    v2_curved_before = safe_float(o.get('v2Curved', 0))
    
    # After tuning
    v2_hook_after = safe_float(t.get('v2Hook', 0))
    v2_coh_after = safe_float(t.get('v2Coherence', 0))
    v2_conn_after = safe_float(t.get('v2Connection', 0))
    v2_trend_after = safe_float(t.get('v2Trend', 0))
    v2_curved_after = safe_float(t.get('v2Curved', 0))
    
    # Weighted raw scores
    raw_before = v2_hook_before + v2_coh_before + v2_conn_before + v2_trend_before
    raw_after = (v2_hook_after * 1.25 + v2_coh_after * 0.5 + 
                 v2_conn_after * 1.5 + v2_trend_after * 0.75)
    
    clips.append({
        'cid': cid,
        'project': o.get('projectId', ''),
        'category': o.get('category', ''),
        'excerpt': (o.get('transcriptExcerpt', '') or '')[:80],
        'human': human,
        'v1': v1_before,
        'before': {
            'hook': v2_hook_before, 'coh': v2_coh_before,
            'conn': v2_conn_before, 'trend': v2_trend_before,
            'raw': raw_before, 'curved': v2_curved_before,
        },
        'after': {
            'hook': v2_hook_after, 'coh': v2_coh_after,
            'conn': v2_conn_after, 'trend': v2_trend_after,
            'raw': raw_after, 'curved': v2_curved_after,
        },
    })

# ===========================================================================
# Rank
# ===========================================================================

# Sort by score descending to get ranks
def rank_key(x, system):
    if system == 'human':
        return -x['human']
    elif system == 'v1':
        return -x['v1']
    elif system == 'v2_before':
        return -x['before']['curved']
    elif system == 'v2_after':
        return -x['after']['curved']

def get_ranks(clips_list, system):
    sorted_clips = sorted(clips_list, key=lambda c: rank_key(c, system))
    ranks = {}
    for pos, c in enumerate(sorted_clips):
        ranks[c['cid']] = pos + 1
    return ranks

human_ranks = get_ranks(clips, 'human')
v2_before_ranks = get_ranks(clips, 'v2_before')
v2_after_ranks = get_ranks(clips, 'v2_after')

# ===========================================================================
# Human Top 10
# ===========================================================================

human_top10 = sorted(clips, key=lambda c: -c['human'])[:10]

print("=" * 80)
print("HUMAN TOP 10 CLIPS — Detail Analysis")
print("=" * 80)

print(f"\n{'Rank':>5} {'Clip':>30} {'Human':>6} {'V2 Bef':>7} {'V2 Aft':>7} {'Δ Bef':>6} {'Δ Aft':>6} {'Category':>25}")
print("-" * 90)
for hc in human_top10:
    cid = hc['cid']
    hr = human_ranks[cid]
    v2b = v2_before_ranks[cid]
    v2a = v2_after_ranks[cid]
    delta_b = v2b - hr
    delta_a = v2a - hr
    label = (hc['excerpt'][:28] + '..') if len(hc['excerpt']) > 28 else hc['excerpt']
    cat = hc['category'][:23]
    print(f"{hr:>5} {label:>30} {hc['human']:>6} {v2b:>7} {v2a:>7} {delta_b:>+6} {delta_a:>+6} {cat:>25}")

print(f"\n{'─' * 90}")

# ===========================================================================
# V2 Top 10 comparison (before vs after)
# ===========================================================================

v2_before_top10 = sorted(clips, key=lambda c: -c['before']['curved'])[:10]
v2_after_top10 = sorted(clips, key=lambda c: -c['after']['curved'])[:10]

print("\n\nV2 TOP 10 BEFORE TUNING:")
print(f"{'Rank':>5} {'Clip':>30} {'Human':>6} {'Hook':>5} {'Coh':>5} {'Conn':>5} {'Trend':>5} {'Raw':>5} {'Curved':>7}")
print("-" * 75)
for i, c in enumerate(v2_before_top10):
    b = c['before']
    label = (c['excerpt'][:28] + '..') if len(c['excerpt']) > 28 else c['excerpt']
    print(f"{i+1:>5} {label:>30} {c['human']:>6} {b['hook']:>5.1f} {b['coh']:>5.1f} {b['conn']:>5.1f} {b['trend']:>5.1f} {b['raw']:>5.1f} {b['curved']:>7.0f}")

print("\n\nV2 TOP 10 AFTER TUNING:")
print(f"{'Rank':>5} {'Clip':>30} {'Human':>6} {'Hook':>5} {'Coh':>5} {'Conn':>5} {'Trend':>5} {'RawW':>5} {'Curved':>7}")
print("-" * 75)
for i, c in enumerate(v2_after_top10):
    a = c['after']
    label = (c['excerpt'][:28] + '..') if len(c['excerpt']) > 28 else c['excerpt']
    print(f"{i+1:>5} {label:>30} {c['human']:>6} {a['hook']:>5.1f} {a['coh']:>5.1f} {a['conn']:>5.1f} {a['trend']:>5.1f} {a['raw']:>5.1f} {a['curved']:>7.0f}")

# ===========================================================================
# Human Top 10: Which clips dropped in V2 after tuning?
# ===========================================================================

print("\n\n" + "=" * 80)
print("HUMAN TOP 10 — Dimensional Change Analysis")
print("=" * 80)

for hc in human_top10:
    cid = hc['cid']
    hr = human_ranks[cid]
    v2b = v2_before_ranks[cid]
    v2a = v2_after_ranks[cid]
    
    b = hc['before']
    a = hc['after']
    
    print(f"\n--- Human #{hr}: {hc['excerpt'][:60]} ---")
    print(f"    Human={hc['human']} | V1={hc['v1']:.0f}")
    print(f"    V2 Rank: Before=#{v2b} → After=#{v2a} (Δ={v2a - v2b:>+d})")
    print(f"")
    print(f"    {'Dimension':>12} {'Before':>8} {'After':>8} {'Δ':>8} {'Weight':>8}")
    print(f"    {'─'*12:>12} {'─'*8:>8} {'─'*8:>8} {'─'*8:>8} {'─'*8:>8}")
    print(f"    {'Hook':>12} {b['hook']:>8.1f} {a['hook']:>8.1f} {(a['hook']-b['hook']):>+8.1f} {'1.25x':>8}")
    print(f"    {'Coherence':>12} {b['coh']:>8.1f} {a['coh']:>8.1f} {(a['coh']-b['coh']):>+8.1f} {'0.5x':>8}")
    print(f"    {'Connection':>12} {b['conn']:>8.1f} {a['conn']:>8.1f} {(a['conn']-b['conn']):>+8.1f} {'1.5x':>8}")
    print(f"    {'Trend':>12} {b['trend']:>8.1f} {a['trend']:>8.1f} {(a['trend']-b['trend']):>+8.1f} {'0.75x':>8}")
    
    raw_b = b['raw']
    raw_a = a['raw']
    
    print(f"")
    print(f"    Raw (unweighted): {b['hook']+b['coh']+b['conn']+b['trend']:.1f} → {a['hook']+a['coh']+a['conn']+a['trend']:.1f}")
    print(f"    Raw (weighted):   {raw_b:.1f} → {raw_a:.1f}")
    print(f"    Curved:           {b['curved']:.0f} → {a['curved']:.0f}")
    
    # Root cause analysis
    causes = []
    if a['hook'] < b['hook'] - 1:
        causes.append(f"Hook turun {b['hook']:.0f}→{a['hook']:.0f}")
    if a['conn'] < b['conn'] - 1:
        causes.append(f"Connection turun {b['conn']:.0f}→{a['conn']:.0f}")
    if a['trend'] < b['trend'] - 1:
        causes.append(f"Trend turun {b['trend']:.0f}→{a['trend']:.0f}")
    
    # Check if prompt changes caused penalization
    text = (hc.get('excerpt', '') or '').lower()
    penalized_triggers = []
    if 'hari ini' in text or 'selamat datang' in text:
        penalized_triggers.append('intro/greeting')
    if 'makasih' in text or 'jangan lupa' in text:
        penalized_triggers.append('outro')
    if 'bersama' in text and ('panji' in text or 'reza' in text or 'tom' in text or 'fajar' in text):
        penalized_triggers.append('guest intro')
    if '? ' in text or text.endswith('?'):
        if not any(kw in text for kw in ['sih', 'ya', 'kan', 'kah']):
            pass  # genuine question
    
    if penalized_triggers:
        print(f"    ⚠ PENALIZE HIT: {', '.join(penalized_triggers)}")
        causes.append(f"prompt penalized {', '.join(penalized_triggers)}")
    
    if v2a > v2b:
        print(f"    ❌ Rank DROPPED from #{v2b} to #{v2a}. Causes: {'; '.join(causes)}")
    elif v2a < v2b:
        print(f"    ✅ Rank IMPROVED from #{v2b} to #{v2a}")
    else:
        print(f"    ➡ Rank unchanged (#{v2b})")

# ===========================================================================
# NDCG@5 root cause analysis
# ===========================================================================

print("\n\n" + "=" * 80)
print("NDCG@5 ROOT CAUSE ANALYSIS")
print("=" * 80)

# NDCG@5 calculation
def ndcg_at_k(system_ranking, human_scores_dict, k=5):
    """Calculate NDCG@K"""
    def gain(h):
        if h >= 9: return 3
        if h >= 7: return 2
        if h >= 5: return 1
        return 0
    
    # DCG of system ranking
    dcg = 0.0
    for pos, cid in enumerate(system_ranking[:k]):
        g = gain(human_scores_dict[cid])
        if pos == 0:
            dcg += g
        else:
            dcg += g / (pos + 1).bit_length()  # log2(pos+1) approx
    
    # IDCG (ideal)
    ideal = sorted(human_scores_dict.values(), reverse=True)[:k]
    idcg = 0.0
    for pos, h in enumerate(ideal):
        g = gain(h)
        if pos == 0:
            idcg += g
        else:
            idcg += g / (pos + 1).bit_length()
    
    return dcg / idcg if idcg > 0 else 0.0

# Build human score lookup
human_lookup = {c['cid']: c['human'] for c in clips}

# V2 before top-5
v2b_top5 = sorted(clips, key=lambda c: -c['before']['curved'])[:5]
v2b_top5_cids = [c['cid'] for c in v2b_top5]

# V2 after top-5
v2a_top5 = sorted(clips, key=lambda c: -c['after']['curved'])[:5]
v2a_top5_cids = [c['cid'] for c in v2a_top5]

print(f"\nV2 Before Top-5:")
for i, c in enumerate(v2b_top5):
    print(f"  #{i+1} Human={c['human']} V2={c['before']['curved']:.0f} | {c['excerpt'][:60]}")

print(f"\nV2 After Top-5:")
for i, c in enumerate(v2a_top5):
    print(f"  #{i+1} Human={c['human']} V2={c['after']['curved']:.0f} | {c['excerpt'][:60]}")

print(f"\nHuman Ideal Top-5:")
human_top5 = sorted(clips, key=lambda c: -c['human'])[:5]
for i, c in enumerate(human_top5):
    print(f"  #{i+1} Human={c['human']} | {c['excerpt'][:60]}")

# Gain analysis
print(f"\n--- Gain Analysis ---")
print(f"\nV2 Before Top-5 Gains:")
for i, c in enumerate(v2b_top5):
    h = c['human']
    g = 3 if h >= 9 else 2 if h >= 7 else 1 if h >= 5 else 0
    disc = 1 if i == 0 else (i + 1).bit_length()
    print(f"  #{i+1}: human={h} gain={g} discount={disc:.2f} contrib={g/disc:.2f}")

print(f"\nV2 After Top-5 Gains:")
for i, c in enumerate(v2a_top5):
    h = c['human']
    g = 3 if h >= 9 else 2 if h >= 7 else 1 if h >= 5 else 0
    disc = 1 if i == 0 else (i + 1).bit_length()
    print(f"  #{i+1}: human={h} gain={g} discount={disc:.2f} contrib={g/disc:.2f}")

print(f"\nHuman Ideal Top-5 Gains:")
for i, c in enumerate(human_top5):
    h = c['human']
    g = 3 if h >= 9 else 2 if h >= 7 else 1 if h >= 5 else 0
    disc = 1 if i == 0 else (i + 1).bit_length()
    print(f"  #{i+1}: human={h} gain={g} discount={disc:.2f} contrib={g/disc:.2f}")

# Calculate actual NDCG@5
v2b_ndcg = ndcg_at_k(v2b_top5_cids, human_lookup)
v2a_ndcg = ndcg_at_k(v2a_top5_cids, human_lookup)
print(f"\nNDCG@5 Before: {v2b_ndcg:.3f}")
print(f"NDCG@5 After:  {v2a_ndcg:.3f}")
print(f"Delta:         {v2a_ndcg - v2b_ndcg:+.3f}")

# ===========================================================================
# Summary
# ===========================================================================

print("\n\n" + "=" * 80)
print("ROOT CAUSE SUMMARY")
print("=" * 80)

# Count how many human top-10 clips dropped in V2 after
drops = sum(1 for hc in human_top10 if v2_after_ranks[hc['cid']] > v2_before_ranks[hc['cid']])
improves = sum(1 for hc in human_top10 if v2_after_ranks[hc['cid']] < v2_before_ranks[hc['cid']])
same = sum(1 for hc in human_top10 if v2_after_ranks[hc['cid']] == v2_before_ranks[hc['cid']])

print(f"\nHuman Top 10 rank changes (Before → After tuning):")
print(f"  Rank improved: {improves}")
print(f"  Rank dropped:  {drops}")
print(f"  Rank same:     {same}")

print("\nClips with BIG rank drops (≥5 positions lost):")
big_drops = [hc for hc in human_top10 if v2_after_ranks[hc['cid']] > v2_before_ranks[hc['cid']] + 5]
if big_drops:
    for hc in big_drops:
        cid = hc['cid']
        print(f"  {hc['excerpt'][:50]}")
        print(f"    Human #{human_ranks[cid]}, V2: Before #{v2_before_ranks[cid]} → After #{v2_after_ranks[cid]} (Δ={v2_after_ranks[cid]-v2_before_ranks[cid]:+d})")
        print(f"    Before: Hook={hc['before']['hook']:.1f} Coh={hc['before']['coh']:.1f} Conn={hc['before']['conn']:.1f} Trend={hc['before']['trend']:.1f}")
        print(f"    After:  Hook={hc['after']['hook']:.1f} Coh={hc['after']['coh']:.1f} Conn={hc['after']['conn']:.1f} Trend={hc['after']['trend']:.1f}")
else:
    print("  (none)")

print("\nClips with BIG rank improves (≥5 positions gained):")
big_ups = [hc for hc in human_top10 if v2_after_ranks[hc['cid']] < v2_before_ranks[hc['cid']] - 5]
if big_ups:
    for hc in big_ups:
        cid = hc['cid']
        print(f"  {hc['excerpt'][:50]}")
        print(f"    Human #{human_ranks[cid]}, V2: Before #{v2_before_ranks[cid]} → After #{v2_after_ranks[cid]} (Δ={v2_after_ranks[cid]-v2_before_ranks[cid]:+d})")
        print(f"    Before: Hook={hc['before']['hook']:.1f} Coh={hc['before']['coh']:.1f} Conn={hc['before']['conn']:.1f} Trend={hc['before']['trend']:.1f}")
        print(f"    After:  Hook={hc['after']['hook']:.1f} Coh={hc['after']['coh']:.1f} Conn={hc['after']['conn']:.1f} Trend={hc['after']['trend']:.1f}")
else:
    print("  (none)")

print(f"\n{'='*80}")
