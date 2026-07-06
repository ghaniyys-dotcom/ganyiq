#!/usr/bin/env python3
"""
transcribe.py — Word-level speech-to-text for GANYIQ subtitle system V2.

Produces word-level timestamps for karaoke subtitle rendering.

Strategies (tried in order):
  1. Whisper (small model) — word-level timestamps
  2. Deepgram nova-2 API — word-level timestamps (requires --deepgram-key)
  3. Returns empty (no fallback available)

Usage:
  python3 transcribe.py <audio_path> <output_json>
    [--deepgram-key KEY] [--skip-extract]
"""

import json
import sys
import os
import argparse
import subprocess
from pathlib import Path

# Allow import from speaker-hybrid package
_SELF_PARENT = str(Path(__file__).resolve().parent / "speaker-hybrid")
if _SELF_PARENT not in sys.path:
    sys.path.insert(0, _SELF_PARENT)

from core.logger import log
from utils.ffmpeg_utils import resolve_ffmpeg, extract_audio


def transcribe_whisper(audio_path: str) -> dict:
    """Transcribe using Whisper with word-level timestamps."""
    try:
        import whisper
        import numpy as np

        model = whisper.load_model("tiny")  # ~400MB RAM, ~0.5x real-time on CPU
        log("TRANSCRIBE", f"Whisper model loaded (tiny)")

        result = model.transcribe(
            audio_path,
            word_timestamps=True,
            language="id",  # Indonesian, adjust as needed
            verbose=False,
        )

        words = []
        for segment in result.get("segments", []):
            for word_info in segment.get("words", []):
                word_text = word_info.get("word", "").strip()
                if word_text:
                    words.append({
                        "word": word_text,
                        "start": round(word_info.get("start", 0), 3),
                        "end": round(word_info.get("end", 0), 3),
                        "confidence": round(word_info.get("confidence", 1.0), 3),
                    })

        # Build segments (for backward compat)
        segments = []
        for segment in result.get("segments", []):
            seg_words = []
            for word_info in segment.get("words", []):
                w = word_info.get("word", "").strip()
                if w:
                    seg_words.append(w)
            if seg_words:
                segments.append({
                    "start": round(segment.get("start", 0), 2),
                    "end": round(segment.get("end", 0), 2),
                    "text": " ".join(seg_words),
                })

        log("TRANSCRIBE", f"Whisper: {len(words)} words, {len(segments)} segments, "
              f"language={result.get('language', 'unknown')}")

        return {
            "words": words,
            "segments": segments,
            "full_transcript": result.get("text", ""),
            "source": "whisper",
        }

    except ImportError:
        log("TRANSCRIBE", "whisper not installed, skipping — try 'pip install openai-whisper'")
        return {"words": [], "segments": [], "full_transcript": "", "source": "none"}
    except Exception as e:
        log("TRANSCRIBE", f"Whisper transcription failed — skipping: {e}")
        return {"words": [], "segments": [], "full_transcript": "", "source": "none"}


def transcribe_deepgram(audio_path: str, api_key: str) -> dict:
    """Transcribe using Deepgram nova-2 API with word-level timestamps."""
    import urllib.request
    import urllib.parse

    try:
        # Read audio file
        with open(audio_path, 'rb') as f:
            audio_data = f.read()

        # Determine content type from file extension
        ext = Path(audio_path).suffix.lower()
        content_type = {
            '.wav': 'audio/wav',
            '.mp3': 'audio/mp3',
            '.m4a': 'audio/mp4',
            '.mp4': 'audio/mp4',
            '.webm': 'audio/webm',
        }.get(ext, 'audio/wav')

        # Build Deepgram API URL
        params = urllib.parse.urlencode({
            'model': 'nova-2',
            'language': 'id',
            'smart_format': 'true',
            'punctuate': 'true',
            'utterances': 'true',
            'paragraphs': 'true',
        })
        url = f'https://api.deepgram.com/v1/listen?{params}'

        # API request
        req = urllib.request.Request(
            url,
            data=audio_data,
            headers={
                'Authorization': f'Token {api_key}',
                'Content-Type': content_type,
            },
            method='POST',
        )

        log("TRANSCRIBE", f"Deepgram: sending {len(audio_data)} bytes...")
        with urllib.request.urlopen(req, timeout=600) as resp:
            response_data = json.loads(resp.read().decode('utf-8'))

        # Parse response
        alt = (response_data.get('results', {})
               .get('channels', [{}])[0]
               .get('alternatives', [{}])[0])

        if not alt:
            log("TRANSCRIBE", "WARN: Deepgram returned no alternatives")
            return {"words": [], "segments": [], "full_transcript": "", "source": "none"}

        raw_words = alt.get('words', [])
        if not raw_words:
            log("TRANSCRIBE", "WARN: Deepgram returned zero words")
            return {"words": [], "segments": [], "full_transcript": "", "source": "none"}

        # Extract word-level timestamps (same format as Whisper)
        words = []
        for w in raw_words:
            word_text = w.get('punctuated_word', w.get('word', '')).strip()
            if word_text:
                words.append({
                    "word": word_text,
                    "start": round(w.get('start', 0), 3),
                    "end": round(w.get('end', 0), 3),
                    "confidence": round(w.get('confidence', 1.0), 3),
                })

        # Build segments
        segments = []
        utterances = (response_data.get('results', {})
                      .get('channels', [{}])[0]
                      .get('alternatives', [{}])[0]
                      .get('paragraphs', {})
                      .get('paragraphs', []))

        if utterances:
            for para in utterances:
                para_words = [s.get('text', '') for s in para.get('sentences', [])]
                if para_words:
                    sentences = para.get('sentences', [])
                    seg_start = sentences[0].get('start', 0) if sentences else 0
                    seg_end = sentences[-1].get('end', 0) if sentences else 0
                    segments.append({
                        "start": round(seg_start, 2),
                        "end": round(seg_end, 2),
                        "text": ' '.join(para_words),
                    })

        # If no paragraphs, build segments from words directly
        if not segments:
            seg_start = words[0]['start']
            seg_text = []
            for w in words:
                seg_text.append(w['word'])
                if w['end'] - seg_start >= 5.0:
                    segments.append({
                        "start": round(seg_start, 2),
                        "end": round(w['end'], 2),
                        "text": ' '.join(seg_text),
                    })
                    seg_start = w['end']
                    seg_text = []
            if seg_text:
                segments.append({
                    "start": round(seg_start, 2),
                    "end": round(words[-1]['end'], 2),
                    "text": ' '.join(seg_text),
                })

        confidence = alt.get('confidence', 0)
        full_transcript = alt.get('transcript', alt.get('paragraphs', {}).get('transcript', ''))

        log("TRANSCRIBE", f"Deepgram: {len(words)} words, {len(segments)} segments, "
              f"confidence={confidence:.3f}")

        return {
            "words": words,
            "segments": segments,
            "full_transcript": full_transcript,
            "source": "deepgram",
        }

    except Exception as e:
        # Non-fatal — return empty result, caller handles gracefully
        log("TRANSCRIBE", f"Deepgram transcription unavailable: {e}")
        return {"words": [], "segments": [], "full_transcript": "", "source": "none"}


def main() -> None:
    parser = argparse.ArgumentParser(description='Word-level transcription')
    parser.add_argument('input_path', help='Path to video or audio file')
    parser.add_argument('output_json', help='Output transcription JSON')
    parser.add_argument('--skip-extract', action='store_true',
                        help='Input is already audio (skip extraction)')
    parser.add_argument('--deepgram-key', type=str, default='',
                        help='Deepgram API key for fallback transcription')
    parser.add_argument('--clip-start', type=float, default=None,
                        help='Clip start time in seconds (extract only this segment)')
    parser.add_argument('--clip-end', type=float, default=None,
                        help='Clip end time in seconds (extract only this segment)')

    args = parser.parse_args()

    audio_path = args.input_path
    cleanup_audio = False

    if not args.skip_extract:
        ext = Path(args.input_path).suffix.lower()
        if ext in ['.mp4', '.mkv', '.webm', '.mov', '.avi']:
            audio_path = args.input_path + '_transcribe.wav'
            clip_info = ''
            if args.clip_start is not None and args.clip_end is not None:
                clip_info = f' [clip {args.clip_start}s-{args.clip_end}s ({args.clip_end - args.clip_start:.0f}s)]'
            log("TRANSCRIBE", f"Extracting audio from {args.input_path}{clip_info}...")
            if not extract_audio(args.input_path, audio_path, args.clip_start, args.clip_end):
                log("TRANSCRIBE", "WARN: Audio extraction failed")
                audio_path = args.input_path
            else:
                cleanup_audio = True
                audio_size_mb = os.path.getsize(audio_path) / (1024 * 1024)
                log("TRANSCRIBE", f"Extracted audio: {audio_size_mb:.1f}MB")

    if not os.path.exists(audio_path):
        print(f"Error: input not found: {audio_path}")
        sys.exit(1)

    # Strategy 1: Whisper
    result = transcribe_whisper(audio_path)
    if result['source'] != 'none':
        log("TRANSCRIBE", f"strategy=whisper words={len(result['words'])} segments={len(result['segments'])} confidence={result.get('confidence', 'N/A')}", file=sys.stderr)

    # Strategy 2: Deepgram fallback (if Whisper failed and we have a key)
    if result['source'] == 'none' and args.deepgram_key:
        print("[TRANSCRIBE] strategy=deepgram (whisper unavailable)", file=sys.stderr)
        result = transcribe_deepgram(audio_path, args.deepgram_key)
        if result['source'] != 'none':
            log("TRANSCRIBE", f"strategy=deepgram words={len(result['words'])} segments={len(result['segments'])} confidence={result.get('confidence', 'N/A')}", file=sys.stderr)

    # Strategy 3: Both failed — write empty result, don't fail
    if result['source'] == 'none':
        print("[TRANSCRIBE] strategy=FAILED — no transcription available, writing empty result", file=sys.stderr)
        with open(args.output_json, 'w') as f:
            json.dump(result, f)
        if cleanup_audio and os.path.exists(audio_path):
            try:
                os.remove(audio_path)
            except:
                pass
        # Exit 0 so caller doesn't log ugly errors — TS side handles [] gracefully
        sys.exit(0)

    with open(args.output_json, 'w') as f:
        json.dump(result, f)

    print(f"[DONE] Source: {result['source']}, {len(result['words'])} words, "
          f"{len(result['segments'])} segments")

    if cleanup_audio and os.path.exists(audio_path):
        try:
            os.remove(audio_path)
        except:
            pass


if __name__ == '__main__':
    main()
