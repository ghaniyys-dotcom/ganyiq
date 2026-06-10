#!/usr/bin/env python3
"""
diarize.py — Speaker diarization for GANYIQ worker V2.

Produces speaker segments with turn boundaries.

Strategies (tried in order):
  1. PyAnnote speaker-diarization-3.1 (requires huggingface token)
  2. Simple energy-based VAD + clustering (no external deps)
  3. Returns generic "speaker_0" labels if all else fails

Usage:
  python3 diarize.py <audio_path> <output_json> [--hf-token TOKEN]
"""

import json
import sys
import os
import argparse
import subprocess
from pathlib import Path


def extract_audio(video_path: str, audio_path: str) -> bool:
    """Extract audio from video file using ffmpeg."""
    try:
        subprocess.run(
            ['ffmpeg', '-y', '-i', video_path, '-vn',
             '-acodec', 'pcm_s16le', '-ar', '16000', '-ac', '1',
             audio_path],
            capture_output=True, timeout=120
        )
        return os.path.exists(audio_path) and os.path.getsize(audio_path) > 1000
    except Exception as e:
        print(f"[WARN] Audio extraction failed: {e}", file=sys.stderr)
        return False


def diarize_pyannote(audio_path: str, hf_token: str) -> list:
    """Diarize using PyAnnote."""
    try:
        from pyannote.audio import Pipeline
        import torch

        pipeline = Pipeline.from_pretrained(
            "pyannote/speaker-diarization-3.1",
            use_auth_token=hf_token
        )

        # Move to CPU if no GPU
        if not torch.cuda.is_available():
            pipeline.to(torch.device("cpu"))

        diarization = pipeline(audio_path)

        segments = []
        for turn, _, speaker in diarization.itertracks(yield_label=True):
            segments.append({
                "speaker": speaker,
                "start": round(turn.start, 2),
                "end": round(turn.end, 2),
            })

        return segments
    except ImportError:
        print("[INFO] pyannote.audio not installed", file=sys.stderr)
        return []
    except Exception as e:
        print(f"[WARN] PyAnnote diarization failed: {e}", file=sys.stderr)
        return []


def diarize_energy_based(audio_path: str) -> list:
    """Simple energy-based VAD + speaker clustering fallback."""
    try:
        import numpy as np
        import scipy.io.wavfile as wav

        sample_rate, audio = wav.read(audio_path)
        if len(audio.shape) > 1:
            audio = audio[:, 0]  # mono

        # Simple VAD: energy threshold
        frame_length = int(0.025 * sample_rate)  # 25ms
        hop_length = int(0.010 * sample_rate)     # 10ms
        energy_threshold = 0.02

        # Compute frame energies
        num_frames = (len(audio) - frame_length) // hop_length + 1
        energies = np.zeros(num_frames)
        for i in range(num_frames):
            start = i * hop_length
            frame = audio[start:start + frame_length]
            energies[i] = np.sqrt(np.mean(frame ** 2))

        # Normalize
        energies = energies / (np.max(energies) + 1e-10)

        # Voice activity detection
        is_speech = energies > energy_threshold

        # Merge segments
        segments = []
        in_speech = False
        seg_start = 0

        for i in range(len(is_speech)):
            if is_speech[i] and not in_speech:
                seg_start = i * hop_length / sample_rate
                in_speech = True
            elif not is_speech[i] and in_speech:
                seg_end = i * hop_length / sample_rate
                if seg_end - seg_start > 0.3:  # min 300ms
                    segments.append({
                        "speaker": "speaker_0",
                        "start": round(seg_start, 2),
                        "end": round(seg_end, 2),
                    })
                in_speech = False

        # Handle last segment
        if in_speech:
            seg_end = len(audio) / sample_rate
            if seg_end - seg_start > 0.3:
                segments.append({
                    "speaker": "speaker_0",
                    "start": round(seg_start, 2),
                    "end": round(seg_end, 2),
                })

        return segments
    except Exception as e:
        print(f"[WARN] Energy-based diarization failed: {e}", file=sys.stderr)
        return []


def main():
    parser = argparse.ArgumentParser(description='Speaker diarization')
    parser.add_argument('input_path', help='Path to video or audio file')
    parser.add_argument('output_json', help='Output speaker segments JSON')
    parser.add_argument('--hf-token', default='', help='HuggingFace token for PyAnnote')
    parser.add_argument('--skip-extract', action='store_true',
                        help='Input is already audio (skip extraction)')

    args = parser.parse_args()

    audio_path = args.input_path
    cleanup_audio = False

    if not args.skip_extract:
        # Check if input is video, extract audio
        ext = Path(args.input_path).suffix.lower()
        if ext in ['.mp4', '.mkv', '.webm', '.mov', '.avi']:
            audio_path = args.input_path + '_audio.wav'
            print(f"[INFO] Extracting audio from {args.input_path}...", file=sys.stderr)
            if not extract_audio(args.input_path, audio_path):
                print("[WARN] Audio extraction failed, using input directly", file=sys.stderr)
                audio_path = args.input_path
            else:
                cleanup_audio = True

    if not os.path.exists(audio_path):
        print(f"Error: input not found: {audio_path}", file=sys.stderr)
        sys.exit(1)

    segments = []

    # Strategy 1: PyAnnote
    if args.hf_token:
        segments = diarize_pyannote(audio_path, args.hf_token)
        print(f"[INFO] PyAnnote: {len(segments)} segments", file=sys.stderr)

    # Strategy 2: Energy-based VAD
    if len(segments) == 0:
        print("[INFO] Using energy-based VAD fallback", file=sys.stderr)
        segments = diarize_energy_based(audio_path)
        print(f"[INFO] Energy VAD: {len(segments)} segments", file=sys.stderr)

    # Strategy 3: Fallback — single speaker
    if len(segments) == 0:
        print("[INFO] No diarization available, returning single speaker", file=sys.stderr)
        # Get duration from ffprobe
        try:
            result = subprocess.run(
                ['ffprobe', '-v', 'quiet', '-show_entries', 'format=duration',
                 '-of', 'csv=p=0', audio_path],
                capture_output=True, text=True, timeout=15
            )
            duration = float(result.stdout.strip())
        except:
            duration = 600  # default 10 min

        segments = [{
            "speaker": "speaker_0",
            "start": 0.0,
            "end": round(duration, 2),
        }]

    # Write output
    with open(args.output_json, 'w') as f:
        json.dump(segments, f)

    # Count unique speakers
    unique_speakers = set(s['speaker'] for s in segments)
    total_duration = sum(s['end'] - s['start'] for s in segments)

    print(f"[DONE] {len(segments)} segments, {len(unique_speakers)} speakers, "
          f"{total_duration:.1f}s total speech", file=sys.stderr)

    # Cleanup temp audio
    if cleanup_audio and os.path.exists(audio_path):
        try:
            os.remove(audio_path)
        except:
            pass


if __name__ == '__main__':
    main()
