#!/usr/bin/env bash
# worker/setup.sh — GANYIQ Worker V2 Python Dependencies (Linux)
# Run this on the worker machine after pulling the latest code.

set -e

echo "╔══════════════════════════════════════╗"
echo "║   GANYIQ Worker V2 Setup (Linux)    ║"
echo "╚══════════════════════════════════════╝"
echo ""

# Check Python
PYTHON=""
if command -v python3 &>/dev/null; then
    PYTHON="python3"
elif command -v python &>/dev/null; then
    PYTHON="python"
else
    echo "ERROR: Python not found. Install Python 3.8+ and try again."
    exit 1
fi

echo "[✓] Python: $($PYTHON --version 2>&1)"
echo ""

# Check pip
if ! command -v pip3 &>/dev/null && ! command -v pip &>/dev/null; then
    echo "ERROR: pip not found. Install pip and try again."
    exit 1
fi
PIP="pip3" || "pip"

echo "[✓] Installing Python packages..."

# Core packages for V2 pipeline
$PIP install --upgrade pip setuptools wheel

# Face detection (YOLOv8-face ONNX)
$PIP install opencv-python-headless numpy onnxruntime

# Face tracking
$PIP install scipy

# Speaker diarization (optional — better quality with PyAnnote)
# Requires huggingface token: https://huggingface.co/pyannote/speaker-diarization-3.1
# $PIP install torch torchaudio pyannote.audio

# Word-level transcription (optional — enables karaoke subtitles)
# $PIP install whisper openai-whisper

echo ""
echo "[✓] Core packages installed!"
echo ""
echo "Optional packages (for premium features):"
echo "  Speaker diarization: pip install torch torchaudio pyannote.audio"
echo "  Word transcription:  pip install openai-whisper"
echo ""
echo "Next steps:"
echo "  1. Ensure yt-dlp and ffmpeg are in PATH"
echo "  2. Start the worker: npx tsx worker/index.ts"
echo "  3. Check logs to confirm V2 pipeline is active"
echo ""
