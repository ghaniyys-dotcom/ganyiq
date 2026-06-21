"""
worker/fasterwhisper-transcribe.py — FasterWhisper transcription for GANYIQ

Called as a subprocess by lib/transcript/providers/fasterwhisper-provider.ts.
Runs locally on VPS (CPU mode) or PC-GANY (CUDA mode).

Outputs JSON to stdout with the normalized ProviderResult schema.

Installation:
  pip install faster-whisper

Usage:
  python3 worker/fasterwhisper-transcribe.py /path/to/audio.mp3
  python3 worker/fasterwhisper-transcribe.py /path/to/audio.mp3 --model-size small --device cpu
"""

import argparse
import json
import sys
import os
import time


def transcribe(audio_path: str, model_size: str = "small", device: str = "cpu", compute_type: str = "int8", language: str = None) -> dict:
    """
    Transcribe audio using faster-whisper.
    
    Args:
        audio_path: Path to audio file
        model_size: Model size (tiny, base, small, medium, large-v3)
        device: cpu or cuda
        compute_type: int8, float16, float32
        language: Language hint (optional)
    
    Returns:
        ProviderResult dict
    """
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        return {
            "error": f"faster-whisper not installed. Run: pip install faster-whisper",
            "segments": [],
            "words": [],
            "transcript": "",
            "confidence": 0,
            "durationSeconds": 0,
            "speakers": [],
            "providerName": "fasterwhisper",
            "latencyMs": 0,
        }

    start_time = time.time()

    if not os.path.exists(audio_path):
        return {
            "error": f"Audio file not found: {audio_path}",
            "segments": [],
            "words": [],
            "transcript": "",
            "confidence": 0,
            "durationSeconds": 0,
            "speakers": [],
            "providerName": "fasterwhisper",
            "latencyMs": int((time.time() - start_time) * 1000),
        }

    try:
        # Run the model
        model = WhisperModel(model_size, device=device, compute_type=compute_type)
        segments, info = model.transcribe(audio_path, language=language, beam_size=5, word_timestamps=True)

        transcript_words = []
        transcript_segments = []
        full_text_parts = []

        for segment in segments:
            seg_words = []
            for word in segment.words:
                w = {
                    "word": word.word,
                    "start": round(word.start, 3),
                    "end": round(word.end, 3),
                    "confidence": round(word.probability, 4),
                    "speaker": None,  # No speaker diarization in FasterWhisper
                }
                seg_words.append(w)
                transcript_words.append(w)

            seg_text = " ".join(w["word"] for w in seg_words)
            full_text_parts.append(seg_text)

            transcript_segments.append({
                "start": round(segment.start, 3),
                "duration": round(segment.end - segment.start, 3),
                "text": seg_text,
                "speaker": None,
                "words": seg_words,
            })

        # Get audio duration from info if available
        duration = info.duration if info and hasattr(info, 'duration') else 0

        latency_ms = int((time.time() - start_time) * 1000)

        return {
            "error": None,
            "transcript": " ".join(full_text_parts),
            "segments": transcript_segments,
            "words": transcript_words,
            "confidence": round(info.language_probability if info and hasattr(info, 'language_probability') else 0.8, 4),
            "durationSeconds": round(duration, 2),
            "speakers": [],
            "providerName": "fasterwhisper",
            "latencyMs": latency_ms,
        }

    except Exception as e:
        return {
            "error": str(e),
            "segments": [],
            "words": [],
            "transcript": "",
            "confidence": 0,
            "durationSeconds": 0,
            "speakers": [],
            "providerName": "fasterwhisper",
            "latencyMs": int((time.time() - start_time) * 1000),
        }


def main():
    parser = argparse.ArgumentParser(description="FasterWhisper transcription for GANYIQ")
    parser.add_argument("audio_path", help="Path to audio file")
    parser.add_argument("--model-size", default="small", help="Model size (tiny, base, small, medium, large-v3)")
    parser.add_argument("--device", default="cpu", help="Device: cpu or cuda")
    parser.add_argument("--compute-type", default="int8", help="Compute type: int8, float16, float32")
    parser.add_argument("--language", default=None, help="Language hint (optional)")

    args = parser.parse_args()

    result = transcribe(
        audio_path=args.audio_path,
        model_size=args.model_size,
        device=args.device,
        compute_type=args.compute_type,
        language=args.language,
    )

    print(json.dumps(result))
    sys.exit(0 if result.get("error") is None else 1)


if __name__ == "__main__":
    main()
