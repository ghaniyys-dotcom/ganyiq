#!/usr/bin/env python3
"""
Split Decision Engine

Decides optimal visual layout (fullscreen, PIP, side-by-side, split)
for every video segment based on:
  - Active speaker(s)
  - Reaction intensity of non-speaking participants
  - Timeline coverage & transitions
  
Integrates with:
  - identification/audio-visual-matcher.py  → TrackedSpeaker[]
  - reaction/reaction-detector.py           → ReactionTimeline[]

Usage:
  python split/split-decision-engine.py --speakers <json> --reactions <json> --video <path>
  python split/split-decision-engine.py --video sample.mp4  # full pipeline
"""

import argparse
import json
import math
import sys
from dataclasses import dataclass, field, asdict
from typing import Optional
from pathlib import Path


# ---------------------------------------------------------------------------
# Output types
# ---------------------------------------------------------------------------

@dataclass
class SplitScene:
    """Single scene segment with a fixed layout."""
    start_sec: float
    end_sec: float
    duration_sec: float
    layout: str               # 'fullscreen' | 'pip' | 'side_by_side' | 'split_screen' | 'reaction'
    primary_speaker: Optional[str]
    secondary_speaker: Optional[str]
    reaction_speaker: Optional[str]
    reason: str
    confidence: float
    speakers_visible: list[str] = field(default_factory=list)

@dataclass
class SplitResult:
    scenes: list[SplitScene] = field(default_factory=list)
    total_duration_sec: float = 0.0
    layout_distribution: dict = field(default_factory=dict)
    split_count: int = 0
    warnings: list[str] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Scoring helpers
# ---------------------------------------------------------------------------

def _layout_to_score(layout: str) -> float:
    """Higher = more visually dynamic (more complex to render)."""
    return {
        'fullscreen': 0.0,
        'pip': 1.0,
        'side_by_side': 2.0,
        'split_screen': 2.5,
        'reaction': 2.0,
    }.get(layout, 0.0)


LAYOUT_SIZE_MAP = {
    'fullscreen': 1,
    'pip': 2,
    'side_by_side': 2,
    'split_screen': 3,
    'reaction': 2,
}


# ---------------------------------------------------------------------------
# Main engine
# ---------------------------------------------------------------------------

class SplitDecisionEngine:
    """
    Analyzes speaker tracks + reaction timelines and generates
    scene-by-scene optimal layout decisions.
    """

    MIN_SEGMENT = 0.8          # seconds — anything shorter is noise
    MIN_STABLE = 2.0           # minimum desired scene duration
    MIN_SPEAKING_OVERLAP = 0.4 # min fraction of a segment a speaker must be active
    REACTION_LOOKAHEAD = 0.5   # seconds before a reaction to trigger PIP

    def __init__(
        self,
        reaction_weight: float = 0.3,
        max_speakers_full: int = 1,
        max_speakers_split: int = 3,
        transition_smoothness: float = 1.0,
    ):
        self.reaction_weight = reaction_weight
        self.max_speakers_full = max_speakers_full
        self.max_speakers_split = max_speakers_split
        self.transition_smoothness = transition_smoothness  # unused yet

    # ── public API ──────────────────────────────────────────────

    def decide(
        self,
        speakers: list[dict],
        reactions: list[dict],
        video_duration: Optional[float] = None,
    ) -> SplitResult:
        """
        Main entry point.

        Parameters
        ----------
        speakers : list[dict]
            TrackedSpeaker list from audio-visual-matcher.py
        reactions : list[dict]
            ReactionTimeline list from reaction-detector.py
        video_duration : float, optional
            Total video duration in seconds (used for edge segments).

        Returns
        -------
        SplitResult
        """
        parsed_speakers = self._parse_speakers(speakers)
        parsed_reactions = self._parse_reactions(reactions)

        if not parsed_speakers:
            return SplitResult(warnings=["No speakers provided — fullscreen only"])

        # 1. Build segment timeline
        segments = self._build_segments(parsed_speakers, parsed_reactions)

        # 2. Score each segment for optimal layout
        scored = self._score_segments(segments, parsed_speakers, parsed_reactions)

        # 3. Merge short/adjacent segments with same layout
        merged = self._merge_segments(scored)

        # 4. Convert to SplitScene list
        scenes = self._to_scenes(merged)

        # 5. Stats
        total_dur = sum(s.duration_sec for s in scenes) if video_duration is None else video_duration
        dist: dict[str, float] = {}
        for s in scenes:
            dist[s.layout] = dist.get(s.layout, 0.0) + s.duration_sec

        return SplitResult(
            scenes=scenes,
            total_duration_sec=total_dur or (scenes[-1].end_sec if scenes else 0.0),
            layout_distribution={k: round(v / total_dur, 3) if total_dur else 0 for k, v in dist.items()},
            split_count=sum(1 for s in scenes if s.layout != 'fullscreen'),
        )

    # ── internal helpers ────────────────────────────────────────

    def _parse_speakers(self, raw: list[dict]) -> list[dict]:
        """Normalize and filter speaker data."""
        out = []
        for s in raw:
            segs = s.get('segments') or s.get('timeline') or []
            if not segs:
                continue
            out.append({
                'speaker_id': s.get('speaker_id', s.get('id', 'unknown')),
                'name': s.get('name', s.get('speaker_id', 'unknown')),
                'segments': sorted(segs, key=lambda x: x.get('start', 0)),
                'total_speaking': sum(
                    seg.get('end', 0) - seg.get('start', 0)
                    for seg in segs
                ),
            })
        return out

    def _parse_reactions(self, raw: list[dict]) -> dict[str, list[dict]]:
        """Index reactions by speaker_id → list of reaction events."""
        indexed: dict[str, list[dict]] = {}
        for r in raw:
            sid = r.get('speaker_id', r.get('id', 'unknown'))
            reactions = r.get('reactions') or r.get('timeline') or []
            if not reactions:
                continue
            indexed.setdefault(sid, []).extend(reactions)
        return indexed

    def _build_segments(
        self, speakers: list[dict], reactions: dict[str, list[dict]]
    ) -> list[dict]:
        """
        Chop timeline into atomic candidate segments.
        Each segment has a single set of active speakers.
        """
        # Collect all unique time boundaries from speaker segments + reactions
        boundaries = {0.0}

        for sp in speakers:
            for seg in sp['segments']:
                boundaries.add(seg.get('start', 0))
                boundaries.add(seg.get('end', 0))

        for sid, events in reactions.items():
            for ev in events:
                boundaries.add(ev.get('time', 0) - self.REACTION_LOOKAHEAD)
                boundaries.add(ev.get('time', 0) + 0.3)

        boundaries = sorted(b for b in boundaries if b >= 0)

        # Build segments
        segments = []
        for i in range(len(boundaries) - 1):
            t0, t1 = boundaries[i], boundaries[i + 1]
            if t1 - t0 < self.MIN_SEGMENT / 2:
                continue

            # Which speakers are active?
            active = []
            for sp in speakers:
                for seg in sp['segments']:
                    s_start = seg.get('start', 0)
                    s_end = seg.get('end', 0)
                    overlap = max(0, min(t1, s_end) - max(t0, s_start))
                    if overlap / (t1 - t0) > self.MIN_SPEAKING_OVERLAP:
                        active.append(sp['speaker_id'])
                        break

            # What reactions are happening?
            active_reactions = []
            for sid, events in reactions.items():
                for ev in events:
                    evt = ev.get('time', 0)
                    if t0 <= evt < t1:
                        active_reactions.append({
                            'speaker_id': sid,
                            'reaction_type': ev.get('type', 'unknown'),
                            'intensity': ev.get('intensity', ev.get('confidence', 0.5)),
                            'time': evt,
                        })

            segments.append({
                'start': t0,
                'end': t1,
                'duration': t1 - t0,
                'active_speakers': active,
                'reactions': active_reactions,
                'n_speakers': len(active),
            })

        return segments

    def _score_segments(
        self,
        segments: list[dict],
        speakers: list[dict],
        reactions_all: dict[str, list[dict]],
    ) -> list[dict]:
        """Assign optimal layout and confidence score to each segment."""
        speaker_lookup = {s['speaker_id']: s for s in speakers}

        for seg in segments:
            n = seg['n_speakers']
            reactions = seg['reactions']

            # -- find best layout --

            if n == 0:
                # No one speakng — check for reactions worth showing
                if reactions:
                    best_reaction = max(reactions, key=lambda r: r['intensity'])
                    if best_reaction['intensity'] >= 0.5:
                        seg['layout'] = 'reaction'
                        seg['layout_score'] = _layout_to_score('reaction')
                        seg['reaction_speaker'] = best_reaction['speaker_id']
                        seg['confidence'] = best_reaction['intensity']
                        seg['reason'] = f"Reaction: {best_reaction['reaction_type']} by {best_reaction['speaker_id']}"
                        continue

                seg['layout'] = 'fullscreen'
                seg['layout_score'] = _layout_to_score('fullscreen')
                seg['confidence'] = 0.3
                seg['reason'] = 'Silence — default fullscreen'
                continue

            if n == 1:
                speaker_id = seg['active_speakers'][0]
                speaker = speaker_lookup.get(speaker_id, {})

                # Check if anyone else is reacting to this speaker
                notable_reactions = [r for r in reactions if r['speaker_id'] != speaker_id]
                if notable_reactions:
                    best_reaction = max(notable_reactions, key=lambda r: r['intensity'])
                    if best_reaction['intensity'] >= 0.6:
                        seg['layout'] = 'pip'
                        seg['layout_score'] = _layout_to_score('pip')
                        seg['confidence'] = 0.5 + best_reaction['intensity'] * 0.3
                        seg['primary_speaker'] = speaker_id
                        seg['reaction_speaker'] = best_reaction['speaker_id']
                        seg['reason'] = f"Main speaker {speaker_id} + reaction PIP ({best_reaction['speaker_id']})"
                        continue

                # Default: fullscreen for solo speaker
                seg['layout'] = 'fullscreen'
                seg['layout_score'] = _layout_to_score('fullscreen')
                seg['confidence'] = 0.8
                seg['primary_speaker'] = speaker_id
                seg['reason'] = f"Solo speaker {speaker_id}"
                continue

            if n == 2:
                # Two speakers — side by side or PIP with reaction
                sid1, sid2 = seg['active_speakers'][:2]

                # Check if one is reacting strongly to the other
                cross_reactions = [
                    r for r in reactions
                    if r['speaker_id'] in (sid1, sid2) 
                    and r['speaker_id'] != seg.get('_reacted_to')
                ]
                has_strong_cross = any(r['intensity'] >= 0.7 for r in cross_reactions)

                if has_strong_cross:
                    seg['layout'] = 'side_by_side'
                    seg['confidence'] = 0.75
                    seg['primary_speaker'] = sid1
                    seg['secondary_speaker'] = sid2
                    seg['reason'] = f"Dual conversation {sid1} ↔ {sid2}"
                else:
                    seg['layout'] = 'side_by_side'
                    seg['confidence'] = 0.6
                    seg['primary_speaker'] = sid1
                    seg['secondary_speaker'] = sid2
                    seg['reason'] = f"Two speakers — side view"
                seg['layout_score'] = _layout_to_score('side_by_side')
                continue

            if n >= 3:
                # Check if one speaker is lip-dominant (actually talking)
                speaker_lip_scores: dict[str, float] = {}
                for r in reactions:
                    sid = r.get('speaker_id', r.get('speaker'))
                    lip = r.get('scores', {}).get('lip_movement', 0)
                    if sid:
                        speaker_lip_scores[sid] = max(speaker_lip_scores.get(sid, 0), lip)

                if speaker_lip_scores:
                    best_lip_speaker = max(speaker_lip_scores, key=speaker_lip_scores.get)
                    best_lip_score = speaker_lip_scores[best_lip_speaker]
                    sorted_lip = sorted(speaker_lip_scores.values(), reverse=True)
                    lip_dominance = (sorted_lip[0] - (sorted_lip[1] if len(sorted_lip) > 1 else 0)) if sorted_lip else 0

                    if best_lip_score >= 0.3 and lip_dominance >= 0.15:
                        seg['layout'] = 'fullscreen'
                        seg['layout_score'] = _layout_to_score('fullscreen')
                        seg['primary_speaker'] = best_lip_speaker
                        seg['confidence'] = 0.5 + min(best_lip_score, 0.4)
                        seg['reason'] = f"Lip-dominant {best_lip_speaker} (lip={best_lip_score:.2f})"
                        continue

                seg['layout'] = 'split_screen'
                seg['layout_score'] = _layout_to_score('split_screen')
                seg['confidence'] = 0.5
                seg['speakers_visible'] = seg['active_speakers'][:self.max_speakers_split]
                seg['reason'] = f"{n} speakers active — multi-split"
                continue

        return segments

    def _merge_segments(self, segments: list[dict]) -> list[dict]:
        """Merge adjacent segments with the same layout and speaker config.
           Also absorbs very short scenes (< MIN_STABLE) into neighbors."""
        if not segments:
            return []

        # Pass 1: merge same-layout segments
        merged = [dict(segments[0])]
        for cur in segments[1:]:
            prev = merged[-1]
            same_layout = cur['layout'] == prev['layout']
            same_primary = cur.get('primary_speaker') == prev.get('primary_speaker')
            short_next = cur['duration'] < self.MIN_SEGMENT
            short_prev = prev['duration'] < self.MIN_SEGMENT

            if same_layout and (same_primary or short_next or short_prev):
                prev['end'] = cur['end']
                prev['duration'] = prev['end'] - prev['start']
                total = prev['duration'] + cur['duration']
                prev['confidence'] = (
                    prev['confidence'] * prev['duration'] + cur['confidence'] * cur['duration']
                ) / total if total else prev['confidence']
                prev['reactions'] = (prev.get('reactions') or []) + (cur.get('reactions') or [])
            else:
                merged.append(dict(cur))

        # Pass 2: absorb very short scenes into longer neighbors
        if len(merged) > 1:
            i = 1
            while i < len(merged):
                cur = merged[i]
                prev = merged[i - 1]

                # If current scene is very short, merge into neighbor
                if cur['duration'] < self.MIN_STABLE:
                    # Merge into whichever neighbor is longer (or previous if same)
                    if i < len(merged) - 1:
                        nxt = merged[i + 1]
                        if nxt['duration'] >= prev['duration']:
                            # Merge into next
                            nxt['start'] = cur['start']
                            nxt['duration'] = nxt['end'] - nxt['start']
                            nxt['confidence'] = (nxt['confidence'] * nxt['duration'] + cur['confidence'] * cur['duration']) / (nxt['duration'] + cur['duration'] + 0.001)
                            nxt['reactions'] = (nxt.get('reactions') or []) + (cur.get('reactions') or [])
                            merged.pop(i)
                            continue
                    # Merge into previous
                    prev['end'] = cur['end']
                    prev['duration'] = prev['end'] - prev['start']
                    prev['confidence'] = (prev['confidence'] * prev['duration'] + cur['confidence'] * cur['duration']) / (prev['duration'] + cur['duration'] + 0.001)
                    prev['reactions'] = (prev.get('reactions') or []) + (cur.get('reactions') or [])
                    merged.pop(i)
                    continue

                # Also check if next scene is very short (pre-emptive merge backward)
                if i < len(merged) - 1:
                    nxt = merged[i + 1]
                    if nxt['duration'] < self.MIN_STABLE:
                        # Just let the next iteration handle it by skipping i increment
                        i += 1
                        continue

                i += 1

        return merged

    def _to_scenes(self, segments: list[dict]) -> list[SplitScene]:
        scenes = []
        for seg in segments:
            scene = SplitScene(
                start_sec=round(seg['start'], 2),
                end_sec=round(seg['end'], 2),
                duration_sec=round(seg['duration'], 2),
                layout=seg.get('layout', 'fullscreen'),
                primary_speaker=seg.get('primary_speaker'),
                secondary_speaker=seg.get('secondary_speaker'),
                reaction_speaker=seg.get('reaction_speaker'),
                reason=seg.get('reason', ''),
                confidence=round(seg.get('confidence', 0.5), 3),
                speakers_visible=seg.get('active_speakers', [])[:self.max_speakers_split],
            )
            scenes.append(scene)
        return scenes


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description='Split Decision Engine for GANYIQ')
    parser.add_argument('--speakers', help='Path to speakers JSON (TrackedSpeaker[])')
    parser.add_argument('--reactions', help='Path to reactions JSON (ReactionTimeline[])')
    parser.add_argument('--video', help='Path to video (auto-run hybrid pipeline)')
    parser.add_argument('--output', '-o', help='Output JSON path (default: stdout)')
    parser.add_argument('--reaction-weight', type=float, default=0.3)
    args = parser.parse_args()

    engine = SplitDecisionEngine(reaction_weight=args.reaction_weight)

    if args.video:
        # Delegate full pipeline to SpeakerIdentifier orchestrator
        # (this module handles split decisions only)
        sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
        from identification.speaker_identifier import SpeakerIdentifier
        si = SpeakerIdentifier(reaction_weight=args.reaction_weight)
        pipeline_result = si.process_video(
            video_path=args.video,
            visual_only=True,
        )
        if "error" in pipeline_result:
            print(json.dumps(pipeline_result), file=sys.stderr)
            sys.exit(1)

        # Extract just the split plan
        result = SplitResult(
            scenes=[SplitScene(**s) for s in pipeline_result.get("split_plan", {}).get("scenes", [])],
            total_duration_sec=pipeline_result.get("split_plan", {}).get("total_duration_sec", 0),
            layout_distribution=pipeline_result.get("split_plan", {}).get("layout_distribution", {}),
            split_count=pipeline_result.get("split_plan", {}).get("split_count", 0),
            warnings=pipeline_result.get("split_plan", {}).get("warnings", []),
        )

    elif args.speakers and args.reactions:
        with open(args.speakers) as f:
            speakers = json.load(f)
        with open(args.reactions) as f:
            reactions = json.load(f)
        result = engine.decide(speakers, reactions)
    else:
        print("Usage: python split_decision.py [--speakers <json> --reactions <json> | --video <path>]")
        sys.exit(1)

    output = {
        'scenes': [asdict(s) for s in result.scenes],
        'total_duration_sec': round(result.total_duration_sec, 2),
        'layout_distribution': result.layout_distribution,
        'split_count': result.split_count,
        'warnings': result.warnings,
    }

    if args.output:
        with open(args.output, 'w') as f:
            json.dump(output, f, indent=2)
        print(f"Split plan written to {args.output}")
    else:
        print(json.dumps(output, indent=2))


if __name__ == '__main__':
    main()
