#!/usr/bin/env python3
"""
diarization_postprocess.py — Post-processing for GANYIQ diarization output.

Cleans and normalizes speaker segments from ANY diarization strategy
(Deepgram, PyAnnote, etc.) to fix three observed failure modes:

  1. "Terlalu Sensitif" — Too many speakers detected (15-20+)
     → merge_fragmented_speakers() consolidates co-occurring IDs
  2. "Bingung" — Overlapping segments from different speakers
     → resolve_overlaps() gives overlap time to dominant speaker
  3. Micro-segments — Noise/echo detected as speech
     → enforce_min_segment() removes segments < threshold

Usage:
    from diarization_postprocess import postprocess
    clean_segments = postprocess(raw_segments, max_speakers=6)
"""

import sys
from collections import defaultdict


def log(msg: str):
    print(f"[DIARIZE-PP] {msg}", file=sys.stderr, flush=True)


# ── Step 1: Remove micro-segments ──────────────────────────────────────────

def enforce_min_segment(segments: list[dict], min_duration: float = 0.5) -> list[dict]:
    """Remove segments shorter than min_duration seconds.

    Ultra-short segments (<0.5s) are almost always noise, echo, or
    misclassified silence.  Removing them before other processing
    prevents noise from corrupting the merge/overlap logic.
    """
    before = len(segments)
    result = [s for s in segments if (s["end"] - s["start"]) >= min_duration]
    removed = before - len(result)
    if removed > 0:
        log(f"enforce_min_segment: removed {removed}/{before} segments < {min_duration}s")
    return result


# ── Step 2: Fill silence gaps ──────────────────────────────────────────────

def fill_silence_gaps(segments: list[dict], max_gap: float = 1.5) -> list[dict]:
    """Merge consecutive segments from the same speaker separated by short gaps.

    When a speaker pauses briefly (<1.5s) for a breath or comma, the
    diarizer often splits it into two segments.  Merging these reduces
    fragmentation and produces more natural speaker blocks.
    """
    if len(segments) < 2:
        return list(segments)

    # Sort by start time first
    segments = sorted(segments, key=lambda s: s["start"])

    merged = [dict(segments[0])]
    merges = 0
    for seg in segments[1:]:
        last = merged[-1]
        if (seg["speaker"] == last["speaker"]
                and (seg["start"] - last["end"]) <= max_gap):
            last["end"] = max(last["end"], seg["end"])
            merges += 1
        else:
            merged.append(dict(seg))

    if merges > 0:
        log(f"fill_silence_gaps: merged {merges} gaps (< {max_gap}s)")
    return merged


# ── Step 3: Resolve overlapping segments ───────────────────────────────────

def resolve_overlaps(segments: list[dict]) -> list[dict]:
    """Resolve overlapping segments between different speakers.

    When two speakers appear to talk simultaneously, assign the overlap
    to the speaker with the longer surrounding context (dominant speaker).
    This fixes the "Bingung" mode where segments wrongly overlap.

    Strategy: for each pair of overlapping segments from different speakers,
    trim the shorter segment's overlap region.
    """
    if len(segments) < 2:
        return list(segments)

    segments = sorted(segments, key=lambda s: (s["start"], -(s["end"] - s["start"])))
    result = []
    overlap_fixes = 0

    for seg in segments:
        seg = dict(seg)  # copy
        for existing in result:
            if existing["speaker"] == seg["speaker"]:
                continue

            # Check overlap
            overlap_start = max(seg["start"], existing["start"])
            overlap_end = min(seg["end"], existing["end"])

            if overlap_start >= overlap_end:
                continue  # no overlap

            overlap_dur = overlap_end - overlap_start
            if overlap_dur < 0.1:
                continue  # trivial overlap, ignore

            # Dominant speaker = one with longer total duration around this point
            existing_dur = existing["end"] - existing["start"]
            seg_dur = seg["end"] - seg["start"]

            if existing_dur >= seg_dur:
                # Trim the new (shorter) segment
                if seg["start"] < overlap_start:
                    seg["end"] = overlap_start
                else:
                    seg["start"] = overlap_end
            else:
                # Trim the existing (shorter) segment
                if existing["start"] < overlap_start:
                    existing["end"] = overlap_start
                else:
                    existing["start"] = overlap_end

            overlap_fixes += 1

        # Only add if segment still has meaningful duration
        if (seg["end"] - seg["start"]) >= 0.3:
            result.append(seg)

    if overlap_fixes > 0:
        log(f"resolve_overlaps: fixed {overlap_fixes} overlapping regions")

    # Remove any segments that became too short after trimming
    result = [s for s in result if (s["end"] - s["start"]) >= 0.3]
    return sorted(result, key=lambda s: s["start"])


# ── Step 4: Merge fragmented speakers ──────────────────────────────────────

def merge_fragmented_speakers(
    segments: list[dict],
    max_speakers: int = 6,
) -> list[dict]:
    """Merge speaker IDs that likely belong to the same person.

    Fixes the "Terlalu Sensitif" mode where one person gets 5+ different
    speaker IDs.  Uses temporal co-occurrence analysis:

    Two speaker_ids are merged if:
    1. They NEVER speak at the same time (no temporal overlap)
    2. Their segments are temporally adjacent (one follows the other)

    This is based on the insight that a real person cannot speak as two
    different IDs simultaneously.  If SPEAKER_03 and SPEAKER_07 never
    overlap and alternate, they are the same person.
    """
    if not segments:
        return []

    unique_speakers = sorted(set(s["speaker"] for s in segments))
    if len(unique_speakers) <= max_speakers:
        return segments  # already within limit

    log(f"merge_fragmented: {len(unique_speakers)} speakers detected, target ≤ {max_speakers}")

    # Build per-speaker time ranges
    speaker_ranges: dict[str, list[tuple[float, float]]] = defaultdict(list)
    for seg in segments:
        speaker_ranges[seg["speaker"]].append((seg["start"], seg["end"]))

    # Compute total speaking time per speaker
    speaker_durations: dict[str, float] = {}
    for spk, ranges in speaker_ranges.items():
        speaker_durations[spk] = sum(e - s for s, e in ranges)

    # Check temporal overlap between pairs
    def has_overlap(spk_a: str, spk_b: str) -> bool:
        for (a_start, a_end) in speaker_ranges[spk_a]:
            for (b_start, b_end) in speaker_ranges[spk_b]:
                overlap = min(a_end, b_end) - max(a_start, b_start)
                if overlap > 0.3:  # >300ms simultaneous = different people
                    return True
        return False

    # Build merge map: short speakers → longest non-overlapping speaker
    # Sort speakers by total duration (longest first = most reliable)
    sorted_speakers = sorted(unique_speakers, key=lambda s: speaker_durations.get(s, 0), reverse=True)

    merge_map: dict[str, str] = {}
    canonical_speakers = []

    for spk in sorted_speakers:
        if spk in merge_map:
            continue

        # Try to find an existing canonical speaker to merge into
        merged = False
        for canon in canonical_speakers:
            if not has_overlap(spk, canon):
                merge_map[spk] = canon
                # Extend the canonical speaker's ranges with this speaker's ranges
                speaker_ranges[canon].extend(speaker_ranges[spk])
                merged = True
                break

        if not merged:
            canonical_speakers.append(spk)
            merge_map[spk] = spk

    # Apply merge map
    result = []
    merges = 0
    for seg in segments:
        new_seg = dict(seg)
        old_spk = new_seg["speaker"]
        new_spk = merge_map.get(old_spk, old_spk)
        if new_spk != old_spk:
            merges += 1
        new_seg["speaker"] = new_spk
        result.append(new_seg)

    if merges > 0:
        final_speakers = set(s["speaker"] for s in result)
        log(f"merge_fragmented: merged {len(unique_speakers)} → {len(final_speakers)} speakers ({merges} segment relabels)")

    return result


# ── Step 5: Cap speaker count (aggressive fallback) ───────────────────────

def cap_speaker_count(segments: list[dict], max_speakers: int = 6) -> list[dict]:
    """Hard cap on speaker count by merging smallest speakers.

    If merge_fragmented_speakers still leaves too many speakers,
    this function aggressively merges the least-speaking speakers
    into their most temporally adjacent neighbor.

    This is a last-resort safety net.
    """
    unique_speakers = sorted(set(s["speaker"] for s in segments))
    if len(unique_speakers) <= max_speakers:
        return segments

    log(f"cap_speaker_count: still {len(unique_speakers)} speakers, hard-capping to {max_speakers}")

    # Compute total duration per speaker
    speaker_dur: dict[str, float] = defaultdict(float)
    for seg in segments:
        speaker_dur[seg["speaker"]] += seg["end"] - seg["start"]

    # Keep top N speakers by total speaking time
    sorted_by_dur = sorted(speaker_dur.items(), key=lambda x: x[1], reverse=True)
    keep = set(spk for spk, _ in sorted_by_dur[:max_speakers])
    discard = set(spk for spk, _ in sorted_by_dur[max_speakers:])

    if not discard:
        return segments

    # Map discarded speakers to their nearest (by time) kept speaker
    discard_map: dict[str, str] = {}
    for d_spk in discard:
        d_segs = [s for s in segments if s["speaker"] == d_spk]
        if not d_segs:
            continue
        d_midpoint = (d_segs[0]["start"] + d_segs[-1]["end"]) / 2

        # Find closest kept speaker
        best_kept = None
        best_dist = float("inf")
        for k_spk in keep:
            k_segs = [s for s in segments if s["speaker"] == k_spk]
            if not k_segs:
                continue
            k_midpoint = (k_segs[0]["start"] + k_segs[-1]["end"]) / 2
            dist = abs(d_midpoint - k_midpoint)
            if dist < best_dist:
                best_dist = dist
                best_kept = k_spk

        if best_kept:
            discard_map[d_spk] = best_kept

    # Apply mapping
    result = []
    for seg in segments:
        new_seg = dict(seg)
        if new_seg["speaker"] in discard_map:
            new_seg["speaker"] = discard_map[new_seg["speaker"]]
        result.append(new_seg)

    final_count = len(set(s["speaker"] for s in result))
    log(f"cap_speaker_count: capped to {final_count} speakers (discarded {len(discard)})")
    return result


# ── Main pipeline ─────────────────────────────────────────────────────────

def postprocess(
    segments: list[dict],
    max_speakers: int = 6,
    min_segment_duration: float = 0.5,
    max_silence_gap: float = 1.5,
) -> list[dict]:
    """Run the full post-processing pipeline on diarization segments.

    Parameters
    ----------
    segments : list[dict]
        Raw diarization segments, each with 'speaker', 'start', 'end'.
    max_speakers : int
        Maximum allowed number of unique speakers.
    min_segment_duration : float
        Minimum segment duration in seconds.
    max_silence_gap : float
        Maximum gap between same-speaker segments to merge.

    Returns
    -------
    list[dict]
        Cleaned, normalized diarization segments.
    """
    if not segments:
        return []

    n_before = len(segments)
    spk_before = len(set(s["speaker"] for s in segments))
    log(f"postprocess START: {n_before} segments, {spk_before} speakers")

    # Step 1: Remove noise (micro-segments)
    segments = enforce_min_segment(segments, min_duration=min_segment_duration)

    # Step 2: Fill short silence gaps within same speaker
    segments = fill_silence_gaps(segments, max_gap=max_silence_gap)

    # Step 3: Resolve temporal overlaps between speakers
    segments = resolve_overlaps(segments)

    # Step 4: Merge fragmented speakers (temporal co-occurrence)
    segments = merge_fragmented_speakers(segments, max_speakers=max_speakers)

    # Step 5: Re-merge after relabeling (same speaker may now be adjacent)
    segments = fill_silence_gaps(segments, max_gap=max_silence_gap)

    # Step 6: Hard cap speaker count (last resort)
    segments = cap_speaker_count(segments, max_speakers=max_speakers)

    # Step 7: Final sort and cleanup
    segments = sorted(segments, key=lambda s: s["start"])

    n_after = len(segments)
    spk_after = len(set(s["speaker"] for s in segments))
    log(f"postprocess DONE: {n_before}→{n_after} segments, {spk_before}→{spk_after} speakers")

    return segments
