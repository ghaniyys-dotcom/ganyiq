"""
ffmpeg_utils.py — Unified FFmpeg helpers for GANYIQ.

Replaces duplicate resolve_ffmpeg() and extract_audio() in diarize.py and transcribe.py.
"""

import os
import subprocess
import sys
from pathlib import Path


def resolve_ffmpeg() -> str:
    """Return the full path to ffmpeg, checking FFMPEG_LOCATION env var first.

    FFMPEG_LOCATION can contain either:
      - A DIRECTORY (e.g., "C:\\ffmpeg\\bin") → appends "ffmpeg.exe"
      - A FULL PATH to ffmpeg.exe → uses directly
    """
    ffmpeg_location = os.environ.get('FFMPEG_LOCATION')
    if ffmpeg_location:
        ffmpeg_location = ffmpeg_location.rstrip('/\\')
        for exe_name in ['ffmpeg.exe', 'ffmpeg']:
            if ffmpeg_location.endswith(exe_name):
                if os.path.exists(ffmpeg_location):
                    return ffmpeg_location
        for exe_name in ['ffmpeg.exe', 'ffmpeg']:
            candidate = os.path.join(ffmpeg_location, exe_name)
            if os.path.exists(candidate):
                return candidate
    # On Windows, check WinGet install location
    if sys.platform == 'win32':
        home = os.environ.get('LOCALAPPDATA', '')
        if home:
            candidate = os.path.join(
                home, 'Microsoft', 'WinGet', 'Packages',
                'Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe',
                'ffmpeg-8.1.1-full_build', 'bin', 'ffmpeg.exe',
            )
            if os.path.exists(candidate):
                return candidate
    return 'ffmpeg'


def extract_audio(
    video_path: str,
    audio_path: str,
    clip_start: float | None = None,
    clip_end: float | None = None,
    sample_rate: int = 16000,
    channels: int = 1,
    codec: str = "pcm_s16le",
    timeout: int = 120,
) -> bool:
    """Extract audio from video file using ffmpeg. Optionally trim to clip window."""
    ffmpeg_bin = resolve_ffmpeg()
    try:
        cmd = [ffmpeg_bin, '-y']
        if clip_start is not None:
            cmd.extend(['-ss', str(clip_start)])
        cmd.extend(['-i', video_path])
        if clip_end is not None:
            cmd.extend(['-to', str(clip_end)])
        cmd.extend([
            '-vn',
            '-acodec', codec,
            '-ar', str(sample_rate),
            '-ac', str(channels),
            audio_path,
        ])
        subprocess.run(cmd, capture_output=True, timeout=timeout)
        exists = os.path.exists(audio_path) and os.path.getsize(audio_path) > 1000
        return exists
    except Exception:
        return False
