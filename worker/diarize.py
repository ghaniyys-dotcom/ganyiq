#!/usr/bin/env python3
"""
diarize.py — Speaker diarization for GANYIQ worker V4.

Produces speaker segments with unique speaker labels.

Strategies (tried in order, with EXPLICIT logging):
  1. Deepgram Nova-2 API (most reliable, requires API key)
  2. PyAnnote speaker-diarization-3.1 (with num_speakers hint)
  3. Single-speaker fallback (assumes 1 speaker if all else fails)

All strategies are post-processed by diarization_postprocess.py to
clean overlaps, merge fragments, and cap speaker count.

Usage:
  python3 diarize.py <audio_path> <output_json> [--hf-token TOKEN] [--num-speakers N]
"""

import json
import sys
import os
import argparse
import subprocess
import tempfile
from pathlib import Path
from diarization_postprocess import postprocess as diarize_postprocess
def load_env_vars(filename=".env.local"):
    """Manually parse a .env file and set environment variables."""
    try:
        with open(filename, 'r') as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith('#'):
                    key, value = line.split('=', 1)
                    os.environ.setdefault(key.strip(), value.strip())
    except FileNotFoundError:
        log(f"Info: {filename} not found, relying on system environment variables.")
    except Exception as e:
        log(f"Warning: Could not parse {filename}: {e}")

# Load env vars at script start
load_env_vars(Path(__file__).resolve().parent / '.env.local')


def log(msg: str):
    """Emit structured log for GANYIQ to capture."""
    print(f"[DIARIZE] {msg}", file=sys.stderr, flush=True)


def resolve_ffmpeg() -> str:
    """Return the full path to ffmpeg, checking FFMPEG_LOCATION env var first.

    FFMPEG_LOCATION can contain either:
      - A DIRECTORY (e.g., "C:\\ffmpeg\\bin") → appends "ffmpeg.exe"
      - A FULL PATH to ffmpeg.exe → uses directly
    """
    ffmpeg_location = os.environ.get('FFMPEG_LOCATION')
    if ffmpeg_location:
        ffmpeg_location = ffmpeg_location.rstrip('/\\')  # strip trailing slashes
        # If location already IS ffmpeg.exe or ffmpeg, use it directly
        for exe_name in ['ffmpeg.exe', 'ffmpeg']:
            if ffmpeg_location.endswith(exe_name):
                if os.path.exists(ffmpeg_location):
                    log(f"ffmpeg found at: {ffmpeg_location}")
                    return ffmpeg_location
        # Otherwise, treat as directory and append binary name
        for exe_name in ['ffmpeg.exe', 'ffmpeg']:
            candidate = os.path.join(ffmpeg_location, exe_name)
            if os.path.exists(candidate):
                log(f"ffmpeg found at: {candidate}")
                return candidate
    # On Windows, check WinGet install location
    if sys.platform == 'win32':
        home = os.environ.get('LOCALAPPDATA', '')
        if home:
            candidate = os.path.join(home, 'Microsoft', 'WinGet', 'Packages',
                                     'Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe',
                                     'ffmpeg-8.1.1-full_build', 'bin', 'ffmpeg.exe')
            if os.path.exists(candidate):
                log(f"ffmpeg found via WinGet: {candidate}")
                return candidate
    log("ffmpeg not found via FFMPEG_LOCATION or WinGet — falling back to PATH default")
    return 'ffmpeg'


def extract_audio(video_path: str, audio_path: str) -> bool:
    """Extract audio from video file using ffmpeg."""
    ffmpeg_bin = resolve_ffmpeg()
    try:
        subprocess.run(
            [ffmpeg_bin, '-y', '-i', video_path, '-vn',
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

def diarize_pyannote(audio_path: str, hf_token: str, num_speakers: int = 0) -> list:
    """Diarize using PyAnnote speaker-diarization-3.1 with speaker count hints."""
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

        # Build kwargs with speaker count hints for better accuracy
        pipeline_kwargs = {}
        if num_speakers > 0:
            pipeline_kwargs["num_speakers"] = num_speakers
            log(f"using num_speakers hint: {num_speakers}")
        else:
            # Default constraints for podcast/interview content
            pipeline_kwargs["min_speakers"] = 1
            pipeline_kwargs["max_speakers"] = 6
            log("using default speaker range: 1-6")

        log(f"running diarization on {audio_path}...")
        diarization = pipeline(audio_path, **pipeline_kwargs)

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


# ── Strategy 3: Single Speaker Fallback ────────────────────────────────────────

def diarize_single_speaker(audio_path: str) -> list:
    """Last-resort fallback: assume entire audio is one speaker.

    This is more honest than MFCC+KMeans (which produces unreliable
    multi-speaker output) or energy-based VAD (which only detects silence).
    If both Deepgram and PyAnnote fail, it's better to give downstream
    modules a single consistent speaker than noisy random clusters.
    """
    try:
        log("strategy=single_speaker_fallback")
        import subprocess

        # Get audio duration via ffprobe
        ffmpeg_bin = resolve_ffmpeg().replace('ffmpeg', 'ffprobe')
        result = subprocess.run(
            [ffmpeg_bin, '-v', 'error', '-show_entries', 'format=duration',
             '-of', 'csv=p=0', audio_path],
            capture_output=True, text=True, timeout=30
        )
        duration = float(result.stdout.strip()) if result.stdout.strip() else 0.0

        if duration <= 0:
            # Fallback: try reading wav header
            try:
                import wave
                with wave.open(audio_path, 'r') as wf:
                    duration = wf.getnframes() / wf.getframerate()
            except Exception:
                duration = 60.0  # assume 1 minute
                log(f"could not determine duration, assuming {duration}s")

        segments = [{
            "speaker": "SPEAKER_00",
            "start": 0.0,
            "end": round(duration, 2),
        }]

        log(f"strategy=single_speaker_fallback duration={duration:.1f}s")
        return segments

    except Exception as e:
        log(f"strategy=single_speaker_fallback FAILED — {e}")
        return []


# ── Main ────────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description='Speaker diarization')
    parser.add_argument('input_path', help='Path to video or audio file')
    parser.add_argument('output_json', help='Output speaker segments JSON')
    parser.add_argument('--hf-token', default=None, help='HuggingFace token for PyAnnote')
    parser.add_argument('--deepgram-key', default=None, help='Deepgram API key')
    parser.add_argument('--num-speakers', type=int, default=0, help='Num speakers (0=auto)')
    parser.add_argument('--skip-extract', action='store_true', help='Input is audio')
    args = parser.parse_args()

    audio_path = args.input_path
    cleanup_audio_path = None
    if not args.skip_extract:
        temp_dir = tempfile.mkdtemp(prefix="diarize_")
        temp_audio_path = os.path.join(temp_dir, "temp_audio.wav")
        if not extract_audio(args.input_path, temp_audio_path):
            sys.exit(1)
        audio_path = temp_audio_path
        cleanup_audio_path = temp_audio_path
    
    segments = []
    strategy_used = "none"

    # Strategy 1: Deepgram (most reliable)
    deepgram_key = args.deepgram_key or os.getenv("DEEPGRAM_API_KEY")
    if deepgram_key:
        segments = diarize_deepgram(audio_path, deepgram_key)
        if segments: strategy_used = "deepgram"

    # Strategy 2: PyAnnote (with speaker count hints)
    if not segments:
        hf_token = args.hf_token or os.getenv("HF_TOKEN")
        if hf_token:
            segments = diarize_pyannote(audio_path, hf_token, num_speakers=args.num_speakers)
            if segments: strategy_used = "pyannote"

    # Strategy 3: Single speaker fallback (honest minimal output)
    if not segments:
        segments = diarize_single_speaker(audio_path)
        if segments: strategy_used = "single_speaker_fallback"

    # ── Post-processing: clean all outputs regardless of strategy ──
    if segments:
        log(f"raw output: {len(segments)} segments, "
            f"{len(set(s['speaker'] for s in segments))} speakers")
        segments = diarize_postprocess(
            segments,
            max_speakers=max(args.num_speakers, 6) if args.num_speakers > 0 else 6,
            min_segment_duration=0.5,
            max_silence_gap=1.5,
        )

    num_speakers_found = len(set(s['speaker'] for s in segments))
    total_speech_dur = sum(s['end'] - s['start'] for s in segments)
    
    log(f"[DONE] {len(segments)} segments, {num_speakers_found} speakers, "
        f"strategy={strategy_used}, {total_speech_dur:.1f}s total speech")

    output_data = {
        "metadata": {"strategy": strategy_used, "num_speakers": num_speakers_found, "total_speech_duration_sec": total_speech_dur},
        "segments": segments
    }
    with open(args.output_json, 'w') as f:
        json.dump(output_data, f, indent=2)

    if cleanup_audio_path:
        try:
            os.remove(cleanup_audio_path)
            os.rmdir(os.path.dirname(cleanup_audio_path))
        except OSError as e:
            log(f"Failed to cleanup temp audio: {e}")

if __name__ == "__main__":
    main()
