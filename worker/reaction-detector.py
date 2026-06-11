#!/usr/bin/env python3
"""
reaction-detector.py — Audio-based reaction event detection for GANYIQ V3.

Detects non-verbal audio events in video clips using signal processing:
  - Laughter: rhythmic high-frequency energy bursts (3-8 Hz modulation)
  - Applause: broadband noise burst with characteristic spectral centroid rise
  - Gasp/surprise: sudden broadband spike with fast attack
  - Silence: low-energy periods that could indicate tension/anticipation
  - Emotion peak: sudden energy change + spectral shift

This REPLACES the text-only keyword matching in speaker-detector.ts
that could only detect reactions when someone SAID "haha" or "wow".

Strategies (tried in order):
  1. librosa-based spectral analysis (full feature set when available)
  2. numpy/scipy energy-based fallback (no librosa required)
  3. Empty events (graceful degradation)

Usage:
  python3 reaction-detector.py <video_path> <output_json>
    [--sample-rate HZ] [--skip-extract]

Output format:
  {
    "source": "librosa" | "energy" | "none",
    "sample_rate_hz": 22050,
    "events": [
      {
        "time": 12.5,
        "event_type": "laughter",
        "confidence": 0.78,
        "duration": 1.2
      },
      ...
    ],
    "time_series": {
      "times": [0.0, 0.1, ...],
      "energy": [0.01, 0.05, ...],
      "spectral_centroid": [1200, 1500, ...],
      "zero_crossing_rate": [0.12, 0.08, ...],
      "event_labels": [0, 0, 3, 3, 1, ...]  // -1=silence, 0=normal, 1=laughter, 2=gasp, 3=applause, 4=peak
    }
  }

Event type encoding:
  0 = normal
  1 = laughter
  2 = gasp
  3 = applause
  4 = emotion_peak
  -1 = silence
"""

import json
import sys
import os
import argparse
import subprocess
from pathlib import Path
from typing import List, Dict, Any, Optional, Tuple

# ---------------------------------------------------------------------------
# Event type constants
# ---------------------------------------------------------------------------

EVENT_NORMAL = 0
EVENT_LAUGHTER = 1
EVENT_GASP = 2
EVENT_APPLAUSE = 3
EVENT_EMOTION_PEAK = 4
EVENT_SILENCE = -1

EVENT_NAMES = {
    EVENT_NORMAL: 'normal',
    EVENT_LAUGHTER: 'laughter',
    EVENT_GASP: 'gasp',
    EVENT_APPLAUSE: 'applause',
    EVENT_EMOTION_PEAK: 'emotion_peak',
    EVENT_SILENCE: 'silence',
}

# ---------------------------------------------------------------------------
# Audio extraction
# ---------------------------------------------------------------------------

def extract_audio(video_path: str, audio_path: str) -> bool:
    """Extract audio from video file using ffmpeg. Converts to mono 22kHz WAV."""
    try:
        subprocess.run(
            ['ffmpeg', '-y', '-i', video_path, '-vn',
             '-acodec', 'pcm_s16le', '-ar', '22050', '-ac', '1',
             audio_path],
            capture_output=True, timeout=120
        )
        return os.path.exists(audio_path) and os.path.getsize(audio_path) > 1000
    except Exception as e:
        print(f"[WARN] Audio extraction failed: {e}", file=sys.stderr)
        return False


# ---------------------------------------------------------------------------
# Librosa-based detection (Strategy 1)
# ---------------------------------------------------------------------------

def detect_events_librosa(audio_path: str, sample_rate: int = 22050) -> Tuple[List[Dict], Dict]:
    """
    Full-featured event detection using librosa spectral analysis.

    Detection methods:
      - Laughter: rhythmic modulation of spectral centroid + high ZCR
      - Applause: rising spectral centroid + broadband energy envelope
      - Gasp: fast-attack broadband spike followed by energy dip
      - Emotion peak: simultaneous energy + spectral centroid spike
      - Silence: RMS energy below adaptive threshold
    """
    try:
        import librosa
        import numpy as np
    except ImportError:
        print("[INFO] librosa not available", file=sys.stderr)
        return [], {}

    print(f"[INFO] Librosa-based detection on {audio_path}", file=sys.stderr)

    try:
        # Load audio at target sample rate
        y, sr = librosa.load(audio_path, sr=sample_rate, mono=True)
        duration = len(y) / sr

        if len(y) < sr:  # Less than 1 second — can't analyze
            print(f"[WARN] Audio too short ({len(y)/sr:.1f}s)", file=sys.stderr)
            return [], {}

        # ── Compute features ──
        hop_length = int(0.020 * sr)  # 20ms frames
        frame_length = int(0.050 * sr)  # 50ms windows

        # RMS energy
        rms = librosa.feature.rms(y=y, frame_length=frame_length, hop_length=hop_length)[0]
        rms = rms / (np.max(rms) + 1e-10)  # normalize

        # Spectral centroid
        centroid = librosa.feature.spectral_centroid(y=y, sr=sr, hop_length=hop_length)[0]

        # Zero-crossing rate
        zcr = librosa.feature.zero_crossing_rate(y, frame_length=frame_length, hop_length=hop_length)[0]

        # Spectral bandwidth
        bandwidth = librosa.feature.spectral_bandwidth(y=y, sr=sr, hop_length=hop_length)[0]

        # Mel-spectrogram for laughter detection
        mel_spec = librosa.feature.melspectrogram(y=y, sr=sr, hop_length=hop_length, n_mels=64)
        mel_spec_db = librosa.power_to_db(mel_spec, ref=np.max)

        # High-frequency energy ratio (> 4kHz)
        hf_ratio = np.sum(mel_spec[-16:, :], axis=0) / (np.sum(mel_spec, axis=0) + 1e-10)

        # Build time axis
        times = librosa.frames_to_time(np.arange(len(rms)), sr=sr, hop_length=hop_length)

        # ── Adaptive silence threshold ──
        # Use median + std as threshold (more robust than fixed value)
        rms_sorted = np.sort(rms)
        noise_floor = np.median(rms_sorted[:max(10, len(rms_sorted)//10)])
        speech_floor = np.median(rms[rms > noise_floor])
        silence_threshold = noise_floor + (speech_floor - noise_floor) * 0.15

        # ── Laughter Detection ──
        # Laughter has: high ZCR, high centroid, rhythmic modulation in 3-8 Hz band
        # 1. Compute modulation energy in 3-8 Hz band
        from scipy import signal as scipy_signal

        # Bandpass filter the RMS envelope to extract 3-8 Hz modulation
        sos = scipy_signal.butter(4, [3 / (sr / hop_length), 8 / (sr / hop_length)], btype='band', output='sos')
        rms_modulation = scipy_signal.sosfilt(sos, rms)
        modulation_energy = np.abs(rms_modulation)

        # Laughter score: high centroid + high ZCR + strong 3-8 Hz modulation + high HF ratio
        laughter_score = (
            (centroid / (np.max(centroid) + 1e-10)) * 0.2 +
            zcr * 0.25 +
            (modulation_energy / (np.max(modulation_energy) + 1e-10)) * 0.35 +
            hf_ratio * 0.2
        )

        # ── Applause Detection ──
        # Applause has: rising centroid, wide bandwidth, sustained energy
        # Compute spectral centroid slope
        centroid_slope = np.diff(centroid, prepend=centroid[0])
        centroid_rise = np.maximum(centroid_slope, 0)

        applause_score = (
            (bandwidth / (np.max(bandwidth) + 1e-10)) * 0.3 +
            (centroid_rise / (np.max(centroid_rise) + 1e-10)) * 0.25 +
            rms * 0.25 +
            (zcr > 0.1).astype(float) * 0.2
        )

        # ── Gasp Detection ──
        # Gasp: very fast attack (sharp energy rise), then quick decay
        rms_diff = np.diff(rms, prepend=rms[0])
        fast_rise = np.maximum(rms_diff, 0)  # positive energy changes
        # Normalize rise rate
        fast_rise_norm = fast_rise / (np.max(fast_rise) + 1e-10)
        # Gasp = simultaneous fast rise + high centroid jump + short duration
        centroid_diff = np.diff(centroid / (np.max(centroid) + 1e-10), prepend=(centroid[0] / (np.max(centroid) + 1e-10)))
        centroid_diff = np.maximum(centroid_diff, 0)

        gasp_score = (
            fast_rise_norm * 0.4 +
            centroid_diff * 0.3 +
            (1.0 - rms) * 0.15 +  # followed by silence
            zcr * 0.15
        )
        # Gasp is typically short (< 0.5s), so we'll enforce duration constraints later

        # ── Emotion Peak Detection ──
        # Broad: any strong simultaneous energy + spectral change
        rms_norm = rms / (np.max(rms) + 1e-10)
        centroid_norm = centroid / (np.max(centroid) + 1e-10)

        emotion_peak_score = (
            rms_norm * 0.35 +
            centroid_norm * 0.25 +
            (bandwidth / (np.max(bandwidth) + 1e-10)) * 0.2 +
            hf_ratio * 0.2
        )

        # ── Frame-by-frame classification ──
        num_frames = len(rms)
        frame_labels = np.full(num_frames, EVENT_NORMAL, dtype=int)
        frame_confidences = np.zeros(num_frames)
        frame_scores = {
            'laughter': laughter_score,
            'applause': applause_score,
            'gasp': gasp_score,
            'emotion_peak': emotion_peak_score,
        }

        for i in range(num_frames):
            if rms[i] < silence_threshold:
                frame_labels[i] = EVENT_SILENCE
                frame_confidences[i] = 1.0 - rms[i] / (silence_threshold + 1e-10)
                continue

            scores = {
                EVENT_LAUGHTER: laughter_score[i],
                EVENT_APPLAUSE: applause_score[i],
                EVENT_GASP: gasp_score[i],
                EVENT_EMOTION_PEAK: emotion_peak_score[i],
            }

            best_event = max(scores, key=scores.get)
            best_score = scores[best_event]

            # Only classify if score exceeds threshold
            thresholds = {
                EVENT_LAUGHTER: 0.35,
                EVENT_APPLAUSE: 0.40,
                EVENT_GASP: 0.45,
                EVENT_EMOTION_PEAK: 0.50,
            }

            if best_score >= thresholds[best_event]:
                frame_labels[i] = best_event
                frame_confidences[i] = best_score
            else:
                frame_labels[i] = EVENT_NORMAL
                frame_confidences[i] = 1.0 - rms[i]

        # ── Post-process: Merge contiguous frames into events ──
        events = merge_contiguous_events(
            frame_labels, frame_confidences, frame_scores,
            times, num_frames, sr, hop_length
        )

        # Build time series data for integration with visual pipeline
        time_series = {
            "times": [round(t, 2) for t in times.tolist()],
            "energy": [round(float(e), 6) for e in rms.tolist()],
            "spectral_centroid": [round(float(c), 1) for c in centroid.tolist()],
            "zero_crossing_rate": [round(float(z), 6) for z in zcr.tolist()],
            "event_labels": [int(l) for l in frame_labels.tolist()],
        }

        print(f"[DONE] Librosa: {len(events)} events, {num_frames} frames, "
              f"{duration:.1f}s audio", file=sys.stderr)

        return events, time_series

    except Exception as e:
        print(f"[WARN] Librosa detection failed: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc(file=sys.stderr)
        return [], {}


def merge_contiguous_events(
    frame_labels: 'np.ndarray',
    frame_confidences: 'np.ndarray',
    frame_scores: Dict[str, 'np.ndarray'],
    times: 'np.ndarray',
    num_frames: int,
    sr: int,
    hop_length: int,
) -> List[Dict]:
    """Merge contiguous frames with the same event label into single events."""
    import numpy as np

    events = []
    min_event_duration = 0.2  # minimum event duration (200ms)
    max_gap_frames = 2  # allow small gaps within same event (40ms)

    i = 0
    while i < num_frames:
        current_label = frame_labels[i]
        if current_label == EVENT_NORMAL or current_label == EVENT_SILENCE:
            i += 1
            continue

        # Start of an event
        event_start = i
        event_end = i
        total_conf = 0.0
        conf_count = 0

        # Find the end of this event (allow small gaps)
        gap_count = 0
        j = i + 1
        while j < num_frames:
            if frame_labels[j] == current_label:
                event_end = j
                total_conf += frame_confidences[j]
                conf_count += 1
                gap_count = 0
            elif frame_labels[j] != EVENT_NORMAL and frame_labels[j] != EVENT_SILENCE:
                # Different event — stop
                break
            else:
                gap_count += 1
                if gap_count > max_gap_frames:
                    break
            j += 1

        duration = times[min(event_end + 1, num_frames - 1)] - times[event_start]
        if duration >= min_event_duration:
            avg_confidence = total_conf / max(conf_count, 1)
            # Clamp confidence to [0, 1]
            avg_confidence = min(1.0, max(0.1, avg_confidence))

            event_type = EVENT_NAMES.get(current_label, 'normal')
            start_time = times[event_start]
            end_time = times[min(event_end, num_frames - 1)]

            events.append({
                "time": round(start_time, 2),
                "event_type": event_type,
                "confidence": round(avg_confidence, 3),
                "duration": round(end_time - start_time, 2),
                "end_time": round(end_time, 2),
            })

        i = event_end + 1 if event_end > i else i + 1

    # Deduplicate overlapping events of same type
    deduped = []
    for evt in events:
        if deduped and evt['event_type'] == deduped[-1]['event_type']:
            prev = deduped[-1]
            # Merge if close in time (< 0.3s gap)
            gap = evt['time'] - (prev['time'] + prev['duration'])
            if gap < 0.3:
                prev['duration'] = evt['time'] + evt['duration'] - prev['time']
                prev['confidence'] = max(prev['confidence'], evt['confidence'])
                prev['end_time'] = evt['end_time']
                continue
        deduped.append(evt)

    return deduped


# ---------------------------------------------------------------------------
# Energy-based fallback (Strategy 2 — no librosa required)
# ---------------------------------------------------------------------------

def detect_events_energy(audio_path: str) -> Tuple[List[Dict], Dict]:
    """
    Lightweight event detection using only numpy/scipy energy analysis.

    This is a fallback when librosa is not available.
    It detects energy bursts and silence but cannot differentiate
    between laughter, applause, and gasp as accurately.
    """
    try:
        import numpy as np
        import scipy.io.wavfile as wav
        from scipy import signal as scipy_signal
    except ImportError:
        print("[INFO] numpy/scipy not available for energy detection", file=sys.stderr)
        return [], {}

    print(f"[INFO] Energy-based detection (fallback) on {audio_path}", file=sys.stderr)

    try:
        sample_rate, audio = wav.read(audio_path)
        if len(audio.shape) > 1:
            audio = audio[:, 0]  # mono

        audio = audio.astype(np.float32) / (np.max(np.abs(audio)) + 1e-10)
        duration = len(audio) / sample_rate

        if duration < 1.0:
            return [], {}

        # Frame-level energy
        hop_length = int(0.020 * sample_rate)
        frame_length = int(0.050 * sample_rate)
        num_frames = (len(audio) - frame_length) // hop_length + 1

        energies = np.zeros(num_frames)
        for i in range(num_frames):
            start = i * hop_length
            frame = audio[start:start + frame_length]
            energies[i] = np.sqrt(np.mean(frame ** 2))

        # Normalize
        energies = energies / (np.max(energies) + 1e-10)

        # Time axis
        times = np.arange(num_frames) * hop_length / sample_rate

        # Silence threshold
        energy_sorted = np.sort(energies)
        noise_floor = np.median(energy_sorted[:max(10, len(energy_sorted)//10)])
        speech_floor = np.median(energies[energies > noise_floor])
        silence_threshold = noise_floor + (speech_floor - noise_floor) * 0.2

        # Simple ZCR (zero crossing rate)
        zcr = np.zeros(num_frames)
        for i in range(num_frames):
            start = i * hop_length
            frame = audio[start:min(start + frame_length, len(audio))]
            if len(frame) > 1:
                zcr[i] = np.sum(np.abs(np.diff(np.sign(frame)))) / (2 * len(frame))

        # Energy derivative (for burst detection)
        energy_diff = np.diff(energies, prepend=energies[0])
        fast_rise = np.maximum(energy_diff, 0)

        # Classify frames
        frame_labels = np.full(num_frames, EVENT_NORMAL, dtype=int)
        frame_confidences = np.zeros(num_frames)

        for i in range(num_frames):
            if energies[i] < silence_threshold:
                frame_labels[i] = EVENT_SILENCE
                frame_confidences[i] = 1.0 - energies[i] / max(silence_threshold, 1e-10)
                continue

            # Energy burst detection (high energy + fast rise + high ZCR)
            burst_score = energies[i] * 0.4 + fast_rise[i] * 0.3 + zcr[i] * 0.3

            if burst_score > 0.55:
                # Could be laughter, applause, or gasp
                # Use energy rise rate to differentiate:
                if fast_rise[i] > 0.15 and energies[i] > 0.7:
                    # Very fast rise = could be gasp
                    frame_labels[i] = EVENT_GASP
                    frame_confidences[i] = burst_score * 0.8
                elif energies[i] > 0.6 and zcr[i] > 0.08:
                    # High energy + high ZCR = laughter/applause
                    # Since we can't differentiate without spectral analysis,
                    # assign laughter (it's the more common reaction type)
                    frame_labels[i] = EVENT_LAUGHTER
                    frame_confidences[i] = burst_score * 0.7
                else:
                    frame_labels[i] = EVENT_EMOTION_PEAK
                    frame_confidences[i] = burst_score * 0.6
            else:
                frame_labels[i] = EVENT_NORMAL
                frame_confidences[i] = 0.0

        # Merge into events
        events = merge_contiguous_events(
            frame_labels, frame_confidences,
            {}, times, num_frames, sample_rate, hop_length
        )

        time_series = {
            "times": [round(t, 2) for t in times.tolist()],
            "energy": [round(float(e), 6) for e in energies.tolist()],
            "zero_crossing_rate": [round(float(z), 6) for z in zcr.tolist()],
            "event_labels": [int(l) for l in frame_labels.tolist()],
        }

        print(f"[DONE] Energy: {len(events)} events, {num_frames} frames, "
              f"{duration:.1f}s audio", file=sys.stderr)

        return events, time_series

    except Exception as e:
        print(f"[WARN] Energy-based detection failed: {e}", file=sys.stderr)
        return [], {}


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description='Detect audio reaction events (laughter, gasp, applause, silence)'
    )
    parser.add_argument('input_path', help='Path to video or audio file')
    parser.add_argument('output_json', help='Output events JSON')
    parser.add_argument('--sample-rate', type=int, default=22050,
                        help='Target sample rate in Hz (default: 22050)')
    parser.add_argument('--skip-extract', action='store_true',
                        help='Input is already audio (skip extraction)')
    parser.add_argument('--force-energy', action='store_true',
                        help='Skip librosa, use energy-based detector')

    args = parser.parse_args()

    audio_path = args.input_path
    cleanup_audio = False

    # Extract audio if needed
    if not args.skip_extract:
        ext = Path(args.input_path).suffix.lower()
        if ext in ['.mp4', '.mkv', '.webm', '.mov', '.avi']:
            audio_path = args.input_path + '_reaction.wav'
            print(f"[INFO] Extracting audio from {args.input_path}...", file=sys.stderr)
            if not extract_audio(args.input_path, audio_path):
                print("[WARN] Audio extraction failed, using input directly", file=sys.stderr)
                audio_path = args.input_path
            else:
                cleanup_audio = True

    if not os.path.exists(audio_path):
        print(f"Error: input not found: {audio_path}", file=sys.stderr)
        sys.exit(1)

    events = []
    time_series = {}
    source = "none"

    # Strategy 1: Librosa (full feature set)
    if not args.force_energy:
        events, time_series = detect_events_librosa(audio_path, args.sample_rate)
        if events:
            source = "librosa"

    # Strategy 2: Energy-based fallback
    if not events:
        print("[INFO] Using energy-based fallback", file=sys.stderr)
        events, time_series = detect_events_energy(audio_path)
        if events:
            source = "energy"

    if not events:
        print("[INFO] No events detected (empty audio?)", file=sys.stderr)
        source = "none"

    # Count event types
    type_counts = {}
    for evt in events:
        t = evt['event_type']
        type_counts[t] = type_counts.get(t, 0) + 1

    if type_counts:
        print(f"[INFO] Events: {json.dumps(type_counts)}", file=sys.stderr)

    # Write output
    output = {
        "source": source,
        "sample_rate_hz": args.sample_rate,
        "events": events,
        "time_series": time_series,
    }

    with open(args.output_json, 'w') as f:
        json.dump(output, f)

    print(f"[DONE] {len(events)} events, source={source}", file=sys.stderr)

    # Cleanup temp audio
    if cleanup_audio and os.path.exists(audio_path):
        try:
            os.remove(audio_path)
        except:
            pass


if __name__ == '__main__':
    main()
