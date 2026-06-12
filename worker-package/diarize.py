#!/usr/bin/env python3
"""
diarize.py — Speaker diarization for GANYIQ worker V3.

Produces speaker segments with unique speaker labels.

Strategies (tried in order, with EXPLICIT logging):
  1. PyAnnote speaker-diarization-3.1 (requires huggingface token)
  2. MFCC + KMeans clustering (scikit-learn, no external deps)
  3. Energy-based VAD + KMeans clustering (ultra-lightweight, no GPU)
  4. Returns generic "speaker_0" labels if all else fails

Usage:
  python3 diarize.py <audio_path> <output_json> [--hf-token TOKEN] [--num-speakers N]
"""

import json
import sys
import os
import argparse
import subprocess
from pathlib import Path


def log(msg: str):
    """Emit structured log for GANYIQ to capture."""
    print(f"[DIARIZE] {msg}", file=sys.stderr, flush=True)


def extract_audio(video_path: str, audio_path: str) -> bool:
    """Extract audio from video file using ffmpeg."""
    try:
        subprocess.run(
            ['ffmpeg', '-y', '-i', video_path, '-vn',
             '-acodec', 'pcm_s16le', '-ar', '16000', '-ac', '1',
             audio_path],
            capture_output=True, timeout=120
        )
        exists = os.path.exists(audio_path) and os.path.getsize(audio_path) > 1000
        if exists:
            log(f"audio extracted: {os.path.getsize(audio_path)} bytes")
        else:
            log("audio extraction produced empty output")
        return exists
    except Exception as e:
        log(f"audio extraction FAILED: {e}")
        return False


# ── Strategy 1: Deepgram Diarization ──────────────────────────────────────────

def diarize_deepgram(audio_path: str, api_key: str) -> list:
    """Diarize using Deepgram Nova-2 API with speaker detection."""
    import urllib.request
    import urllib.parse
    try:
        log("strategy=deepgram attempting query to Deepgram API...")
        with open(audio_path, 'rb') as f:
            audio_data = f.read()

        ext = Path(audio_path).suffix.lower()
        content_type = {
            '.wav': 'audio/wav',
            '.mp3': 'audio/mp3',
            '.m4a': 'audio/mp4',
            '.mp4': 'audio/mp4',
            '.webm': 'audio/webm',
        }.get(ext, 'audio/wav')

        # Request nova-2 with diarize parameter
        params = urllib.parse.urlencode({
            'model': 'nova-2',
            'language': 'id',
            'diarize': 'true',
            'punctuate': 'true',
            'smart_format': 'true',
        })
        url = f'https://api.deepgram.com/v1/listen?{params}'

        req = urllib.request.Request(
            url,
            data=audio_data,
            headers={
                'Authorization': f'Token {api_key}',
                'Content-Type': content_type,
            },
            method='POST',
        )

        with urllib.request.urlopen(req, timeout=300) as resp:
            response_data = json.loads(resp.read().decode('utf-8'))

        alt = (response_data.get('results', {})
               .get('channels', [{}])[0]
               .get('alternatives', [{}])[0])

        if not alt:
            log("strategy=deepgram failed — no alternatives returned")
            return []

        raw_words = alt.get('words', [])
        if not raw_words:
            log("strategy=deepgram failed — zero words returned")
            return []

        segments = []
        # Group contiguous words by speaker, splitting if gap > 1.5s
        current_speaker = raw_words[0].get('speaker', 0)
        seg_start = raw_words[0]['start']
        prev_end = raw_words[0]['end']

        for i in range(1, len(raw_words)):
            w = raw_words[i]
            speaker = w.get('speaker', 0)
            start = w['start']
            end = w['end']

            if speaker != current_speaker or (start - prev_end) > 1.5:
                duration = prev_end - seg_start
                if duration > 0.1:
                    segments.append({
                        "speaker": f"SPEAKER_{current_speaker:02d}",
                        "start": round(seg_start, 2),
                        "end": round(prev_end, 2),
                    })
                current_speaker = speaker
                seg_start = start

            prev_end = end

        # Add the last segment
        if prev_end - seg_start > 0.1:
            segments.append({
                "speaker": f"SPEAKER_{current_speaker:02d}",
                "start": round(seg_start, 2),
                "end": round(prev_end, 2),
            })

        unique_speakers = set(s['speaker'] for s in segments)
        log(f"strategy=deepgram segments={len(segments)} speakers={len(unique_speakers)}")
        return segments

    except Exception as e:
        log(f"strategy=deepgram FAILED — {type(e).__name__}: {e}")
        return []


# ── Strategy 2: PyAnnote ──────────────────────────────────────────────────────

def diarize_pyannote(audio_path: str, hf_token: str) -> list:
    """Diarize using PyAnnote speaker-diarization-3.1."""
    try:
        log("strategy=pyannote attempting import...")
        from pyannote.audio import Pipeline
        import torch
        log("pyannote.audio imported successfully")

        log("loading pipeline pyannote/speaker-diarization-3.1...")
        pipeline = Pipeline.from_pretrained(
            "pyannote/speaker-diarization-3.1",
            use_auth_token=hf_token
        )
        log("pipeline loaded")

        # Move to CPU if no GPU
        if not torch.cuda.is_available():
            log("CUDA not available — moving pipeline to CPU")
            pipeline.to(torch.device("cpu"))
        else:
            log(f"CUDA available: {torch.cuda.get_device_name(0)}")

        log(f"running diarization on {audio_path}...")
        diarization = pipeline(audio_path)

        segments = []
        speaker_set = set()
        for turn, _, speaker in diarization.itertracks(yield_label=True):
            segments.append({
                "speaker": speaker,
                "start": round(turn.start, 2),
                "end": round(turn.end, 2),
            })
            speaker_set.add(speaker)

        log(f"strategy=pyannote segments={len(segments)} speakers={len(speaker_set)}")
        return segments

    except ImportError as e:
        log(f"strategy=pyannote SKIPPED — import failed: {e}")
        return []
    except Exception as e:
        log(f"strategy=pyannote FAILED — {type(e).__name__}: {e}")
        # Write error detail to a sidecar file for post-mortem
        try:
            error_path = os.path.join(os.path.dirname(audio_path), 'pyannote_error.json')
            with open(error_path, 'w') as f:
                json.dump({"error": str(e), "type": type(e).__name__}, f)
        except:
            pass
        return []


# ── Strategy 2: MFCC + KMeans Clustering ──────────────────────────────────────

def diarize_clustering(audio_path: str, num_speakers: int = 0) -> list:
    """
    Speaker diarization via MFCC + KMeans clustering.

    Extract MFCC features per frame, cluster by similarity,
    merge contiguous frames with same cluster → speaker segments.

    Requires: scikit-learn, scipy, numpy (all available on PC-GANY)
    """
    try:
        log(f"strategy=clustering num_speakers={num_speakers}")
        import numpy as np
        import scipy.io.wavfile as wav
        from sklearn.cluster import KMeans
    except ImportError as e:
        log(f"strategy=clustering SKIPPED — import failed: {e}")
        return []

    try:
        sample_rate, audio = wav.read(audio_path)
        if len(audio.shape) > 1:
            audio = audio[:, 0]  # mono
        audio = audio.astype(np.float64)
        log(f"audio loaded: {sample_rate}Hz, {len(audio)} samples ({len(audio)/sample_rate:.1f}s)")

        # ── Extract MFCC features ──
        frame_length = int(0.025 * sample_rate)  # 25ms
        hop_length = int(0.010 * sample_rate)     # 10ms
        num_frames = (len(audio) - frame_length) // hop_length + 1

        # Pre-emphasis
        audio = np.append(audio[0], audio[1:] - 0.97 * audio[:-1])

        # Hanning window
        window = np.hanning(frame_length)

        mfcc_features = []
        energy_features = []
        for i in range(num_frames):
            start = i * hop_length
            frame = audio[start:start + frame_length]
            if len(frame) < frame_length:
                frame = np.pad(frame, (0, frame_length - len(frame)))

            # Apply window
            frame = frame * window

            # Energy
            energy = np.sqrt(np.mean(frame ** 2))
            energy_features.append(energy)

            # 13 MFCC coefficients (simplified: FFT → log → DCT)
            spectrum = np.abs(np.fft.rfft(frame))
            spectrum = np.maximum(spectrum, 1e-10)
            log_spectrum = np.log(spectrum)

            # Mel filterbank (13 filters)
            n_mels = 13
            n_fft = len(spectrum)
            mel_basis = np.zeros((n_mels, n_fft))
            mel_min = 0
            mel_max = 2595 * np.log10(1 + sample_rate / 2 / 700)

            for m in range(1, n_mels + 1):
                f_m = 700 * (10 ** (m * mel_max / (n_mels + 1) / 2595) - 1)
                f_m1 = 700 * (10 ** ((m - 1) * mel_max / (n_mels + 1) / 2595) - 1)
                f_m2 = 700 * (10 ** ((m + 1) * mel_max / (n_mels + 1) / 2595) - 1)

                f_bin = int(f_m * n_fft / sample_rate)
                f_bin1 = int(f_m1 * n_fft / sample_rate)
                f_bin2 = int(f_m2 * n_fft / sample_rate)

                if f_bin2 > f_bin1:
                    mel_basis[m - 1, f_bin1:f_bin] = np.linspace(0, 1, f_bin - f_bin1)
                    mel_basis[m - 1, f_bin:f_bin2] = np.linspace(1, 0, f_bin2 - f_bin)

            mel_spec = np.dot(mel_basis, log_spectrum)
            # Use scipy's DCT if available
            try:
                from scipy.fft import dct
                mfcc = dct(mel_spec, type=2, norm='ortho')[:13]
            except ImportError:
                # Manual DCT-II approximation
                n_mfcc = len(mel_spec)
                dct_out = np.zeros(13)
                for k in range(13):
                    dct_out[k] = np.sum(mel_spec * np.cos(np.pi * (np.arange(n_mfcc) + 0.5) * k / n_mfcc))
                    if k == 0:
                        dct_out[k] *= np.sqrt(1 / n_mfcc)
                    else:
                        dct_out[k] *= np.sqrt(2 / n_mfcc)
                mfcc = dct_out

            mfcc_features.append(mfcc[:13])

        X = np.array(mfcc_features)
        energies = np.array(energy_features)

        # ── Voice activity detection ──
        energy_threshold = np.percentile(energies, 15) + 0.005
        is_speech = energies > energy_threshold
        speech_ratio = np.mean(is_speech)
        log(f"speech frames: {speech_ratio*100:.0f}% ({np.sum(is_speech)}/{num_frames})")

        if np.sum(is_speech) < 5:
            log("strategy=clustering FAILED — too few speech frames")
            return []

        # Only cluster speech frames
        speech_features = X[is_speech]
        speech_indices = np.where(is_speech)[0]

        # Determine number of speakers
        if num_speakers <= 0:
            # Estimate: max(2, min(6, speech_duration / 30))
            speech_duration = len(speech_indices) * hop_length / sample_rate
            num_speakers = max(2, min(6, int(speech_duration / 25)))
            log(f"auto-estimated speakers: {num_speakers} (speech_dur={speech_duration:.0f}s)")

        # KMeans clustering
        n_clusters = max(2, min(num_speakers, 8))
        if len(speech_features) < n_clusters * 3:
            n_clusters = max(2, len(speech_features) // 3)
            log(f"reducing clusters to {n_clusters} (insufficient speech frames)")

        if n_clusters < 2:
            log("strategy=clustering FAILED — only 1 cluster possible")
            return []

        kmeans = KMeans(n_clusters=n_clusters, random_state=42, n_init=3)
        labels = kmeans.fit_predict(speech_features)
        log(f"clustering done: {n_clusters} clusters, inertia={kmeans.inertia_:.2f}")

        # ── Build segments ──
        # Merge contiguous frames with same label
        segments = []
        current_label = labels[0]
        seg_start_frame = speech_indices[0]

        for idx_in_cluster, frame_idx in enumerate(speech_indices):
            label = labels[idx_in_cluster]

            if label != current_label:
                # End previous segment
                seg_end = (frame_idx * hop_length) / sample_rate
                seg_start = (seg_start_frame * hop_length) / sample_rate
                duration = seg_end - seg_start
                if duration > 0.3:  # min 300ms
                    segments.append({
                        "speaker": f"SPEAKER_{current_label:02d}",
                        "start": round(seg_start, 2),
                        "end": round(seg_end, 2),
                    })
                current_label = label
                seg_start_frame = frame_idx

        # Last segment
        last_frame_idx = speech_indices[-1]
        seg_end = (last_frame_idx * hop_length + frame_length) / sample_rate
        seg_start = (seg_start_frame * hop_length) / sample_rate
        duration = seg_end - seg_start
        if duration > 0.3:
            segments.append({
                "speaker": f"SPEAKER_{current_label:02d}",
                "start": round(seg_start, 2),
                "end": round(seg_end, 2),
            })

        unique_speakers = set(s['speaker'] for s in segments)
        total_dur = sum(s['end'] - s['start'] for s in segments)
        log(f"strategy=clustering segments={len(segments)} speakers={len(unique_speakers)} duration={total_dur:.1f}s")
        return segments

    except Exception as e:
        log(f"strategy=clustering FAILED — {type(e).__name__}: {e}")
        return []


# ── Strategy 3: Energy-based VAD (ultra-fallback) ───────────────────────────

def diarize_energy_fallback(audio_path: str) -> list:
    """Simple energy-based VAD. Returns generic speaker_0 labels."""
    try:
        log("strategy=energy_fallback (no clustering)")
        import numpy as np
        import scipy.io.wavfile as wav

        sample_rate, audio = wav.read(audio_path)
        if len(audio.shape) > 1:
            audio = audio[:, 0]
        audio = audio.astype(np.float64)

        frame_length = int(0.025 * sample_rate)
        hop_length = int(0.010 * sample_rate)
        num_frames = (len(audio) - frame_length) // hop_length + 1

        energies = np.zeros(num_frames)
        for i in range(num_frames):
            start = i * hop_length
            frame = audio[start:start + frame_length]
            energies[i] = np.sqrt(np.mean(frame ** 2))

        energies = energies / (np.max(energies) + 1e-10)
        is_speech = energies > 0.02

        segments = []
        in_speech = False
        seg_start = 0

        for i in range(len(is_speech)):
            if is_speech[i] and not in_speech:
                seg_start = i * hop_length / sample_rate
                in_speech = True
            elif not is_speech[i] and in_speech:
                seg_end = i * hop_length / sample_rate
                if seg_end - seg_start > 0.3:
                    segments.append({
                        "speaker": "speaker_0",
                        "start": round(seg_start, 2),
                        "end": round(seg_end, 2),
                    })
                in_speech = False

        if in_speech:
            seg_end = len(audio) / sample_rate
            if seg_end - seg_start > 0.3:
                segments.append({
                    "speaker": "speaker_0",
                    "start": round(seg_start, 2),
                    "end": round(seg_end, 2),
                })

        total_dur = sum(s['end'] - s['start'] for s in segments)
        log(f"strategy=energy_fallback segments={len(segments)} all=single_speaker duration={total_dur:.1f}s")
        return segments

    except Exception as e:
        log(f"strategy=energy_fallback FAILED — {e}")
        return []


# ── Main ────────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description='Speaker diarization')
    parser.add_argument('input_path', help='Path to video or audio file')
    parser.add_argument('output_json', help='Output speaker segments JSON')
    parser.add_argument('--hf-token', default='', help='HuggingFace token for PyAnnote')
    parser.add_argument('--deepgram-key', default='', help='Deepgram API key for diarization')
    parser.add_argument('--num-speakers', type=int, default=0,
                        help='Estimated number of speakers (0=auto)')
    parser.add_argument('--skip-extract', action='store_true',
                        help='Input is already audio (skip extraction)')

    args = parser.parse_args()

    audio_path = args.input_path
    cleanup_audio = False

    if not args.skip_extract:
        ext = Path(args.input_path).suffix.lower()
        if ext in ['.mp4', '.mkv', '.webm', '.mov', '.avi']:
            audio_path = args.input_path + '_diarize.wav'
            log(f"extracting audio from {args.input_path}...")
            if not extract_audio(args.input_path, audio_path):
                log("audio extraction failed — using input directly")
                audio_path = args.input_path
            else:
                cleanup_audio = True

    if not os.path.exists(audio_path):
        log(f"ERROR: input not found: {audio_path}")
        # Write fallback output so caller doesn't crash
        with open(args.output_json, 'w') as f:
            json.dump([{"speaker": "speaker_0", "start": 0.0, "end": 600.0}], f)
        sys.exit(1)

    segments = []
    strategy_used = "none"

    # ── Strategy 1: Deepgram ──
    if args.deepgram_key:
        log(f"deepgram_key present (length={len(args.deepgram_key)}) — trying Deepgram Diarization")
        segments = diarize_deepgram(audio_path, args.deepgram_key)
        if len(segments) > 0:
            strategy_used = "deepgram"
            log("[DG] Deepgram diarization success")

    # ── Strategy 2: PyAnnote ──
    if len(segments) == 0:
        if args.hf_token:
            log(f"hf_token present (length={len(args.hf_token)}) — trying PyAnnote")
            segments = diarize_pyannote(audio_path, args.hf_token)
            if len(segments) > 0:
                strategy_used = "pyannote"
                log("[HF] pyannote initialized and diarization success")
        else:
            log("[HF] token not loaded — skipping PyAnnote")
            log("hf_token not provided — skipping PyAnnote")

    # ── Strategy 3: MFCC + KMeans clustering ──
    if len(segments) == 0:
        log("Deepgram/PyAnnote unavailable — trying clustering fallback")
        segments = diarize_clustering(audio_path, args.num_speakers)
        if len(segments) > 0:
            strategy_used = "clustering"

    # ── Strategy 4: Energy VAD fallback ──
    if len(segments) == 0:
        log("clustering unavailable — trying energy VAD fallback")
        segments = diarize_energy_fallback(audio_path)
        if len(segments) > 0:
            strategy_used = "energy_fallback"

    # ── Strategy 5: Single speaker emergency ──
    if len(segments) == 0:
        log("strategy=single_speaker EMERGENCY — no diarization method worked")
        strategy_used = "single_speaker"
        try:
            result = subprocess.run(
                ['ffprobe', '-v', 'quiet', '-show_entries', 'format=duration',
                 '-of', 'csv=p=0', audio_path],
                capture_output=True, text=True, timeout=15
            )
            duration = float(result.stdout.strip())
        except:
            duration = 600.0

        segments = [{
            "speaker": "speaker_0",
            "start": 0.0,
            "end": round(duration, 2),
        }]

    # ── Write output with metadata ──
    unique_speakers = set(s['speaker'] for s in segments)
    total_duration = sum(s['end'] - s['start'] for s in segments)

    output = {
        "segments": segments,
        "metadata": {
            "strategy": strategy_used,
            "num_segments": len(segments),
            "num_speakers": len(unique_speakers),
            "total_speech_duration": round(total_duration, 1),
        }
    }

    with open(args.output_json, 'w') as f:
        json.dump(output, f)

    log(f"strategy={strategy_used} segments={len(segments)} speakers={len(unique_speakers)} "
        f"speech={total_duration:.1f}s")
    print(f"[DONE] {len(segments)} segments, {len(unique_speakers)} speakers, "
          f"strategy={strategy_used}, {total_duration:.1f}s total speech",
          file=sys.stderr, flush=True)

    # Cleanup temp audio
    if cleanup_audio and os.path.exists(audio_path):
        try:
            os.remove(audio_path)
        except:
            pass


if __name__ == '__main__':
    main()
