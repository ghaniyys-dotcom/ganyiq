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


def transcribe_whisper(audio_path: str) -> dict:
    """Transcribe using Whisper with word-level timestamps."""
    try:
        import whisper
        import numpy as np

        model = whisper.load_model("small")  # ~2GB RAM, ~3x real-time on CPU
        print(f"[INFO] Whisper model loaded (small)", file=sys.stderr)

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

        print(f"[INFO] Whisper: {len(words)} words, {len(segments)} segments, "
              f"language={result.get('language', 'unknown')}", file=sys.stderr)

        return {
            "words": words,
            "segments": segments,
            "full_transcript": result.get("text", ""),
            "source": "whisper",
        }

    except ImportError:
        print("[INFO] whisper not installed, skipping", file=sys.stderr)
        return {"words": [], "segments": [], "full_transcript": "", "source": "none"}
    except Exception as e:
        print(f"[WARN] Whisper transcription failed: {e}", file=sys.stderr)
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

        print(f"[INFO] Deepgram: sending {len(audio_data)} bytes...", file=sys.stderr)
        with urllib.request.urlopen(req, timeout=600) as resp:
            response_data = json.loads(resp.read().decode('utf-8'))

        # Parse response
        alt = (response_data.get('results', {})
               .get('channels', [{}])[0]
               .get('alternatives', [{}])[0])

        if not alt:
            print("[WARN] Deepgram returned no alternatives", file=sys.stderr)
            return {"words": [], "segments": [], "full_transcript": "", "source": "none"}

        raw_words = alt.get('words', [])
        if not raw_words:
            print("[WARN] Deepgram returned zero words", file=sys.stderr)
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

        print(f"[INFO] Deepgram: {len(words)} words, {len(segments)} segments, "
              f"confidence={confidence:.3f}", file=sys.stderr)

        return {
            "words": words,
            "segments": segments,
            "full_transcript": full_transcript,
            "source": "deepgram",
        }

    except Exception as e:
        print(f"[WARN] Deepgram transcription failed: {e}", file=sys.stderr)
        return {"words": [], "segments": [], "full_transcript": "", "source": "none"}


def main():
    parser = argparse.ArgumentParser(description='Word-level transcription')
    parser.add_argument('input_path', help='Path to video or audio file')
    parser.add_argument('output_json', help='Output transcription JSON')
    parser.add_argument('--skip-extract', action='store_true',
                        help='Input is already audio (skip extraction)')
    parser.add_argument('--deepgram-key', type=str, default='',
                        help='Deepgram API key for fallback transcription')

    args = parser.parse_args()

    audio_path = args.input_path
    cleanup_audio = False

    if not args.skip_extract:
        ext = Path(args.input_path).suffix.lower()
        if ext in ['.mp4', '.mkv', '.webm', '.mov', '.avi']:
            audio_path = args.input_path + '_transcribe.wav'
            print(f"[INFO] Extracting audio from {args.input_path}...", file=sys.stderr)
            if not extract_audio(args.input_path, audio_path):
                print("[WARN] Audio extraction failed", file=sys.stderr)
                audio_path = args.input_path
            else:
                cleanup_audio = True

    if not os.path.exists(audio_path):
        print(f"Error: input not found: {audio_path}", file=sys.stderr)
        sys.exit(1)

    # Strategy 1: Whisper
    result = transcribe_whisper(audio_path)

    # Strategy 2: Deepgram fallback (if Whisper failed and we have a key)
    if result['source'] == 'none' and args.deepgram_key:
        print("[INFO] Whisper unavailable — falling back to Deepgram API", file=sys.stderr)
        result = transcribe_deepgram(audio_path, args.deepgram_key)

    with open(args.output_json, 'w') as f:
        json.dump(result, f)

    print(f"[DONE] Source: {result['source']}, {len(result['words'])} words, "
          f"{len(result['segments'])} segments", file=sys.stderr)

    if cleanup_audio and os.path.exists(audio_path):
        try:
            os.remove(audio_path)
        except:
            pass


if __name__ == '__main__':
    main()
