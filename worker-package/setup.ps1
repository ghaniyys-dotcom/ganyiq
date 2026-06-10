# worker/setup.ps1 — GANYIQ Worker V2 Python Dependencies (Windows)
# Run this in PowerShell on PC-GANY / LAPTOP-GANY after pulling the latest code.

Write-Host "╔══════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║   GANYIQ Worker V2 Setup (Windows)   ║" -ForegroundColor Cyan
Write-Host "╚══════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

# Check Python
$python = $null
try {
    $python = (Get-Command python).Source
    $version = & python --version 2>&1
    Write-Host "[✓] Python: $version" -ForegroundColor Green
} catch {
    Write-Host "ERROR: Python not found. Install Python 3.8+ and ensure it's in PATH." -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "Installing Python packages..." -ForegroundColor Yellow

# Upgrade pip
python -m pip install --upgrade pip setuptools wheel

# Core packages for V2 pipeline
python -m pip install opencv-python numpy onnxruntime

# Face tracking (ByteTrack + Hungarian matching)
python -m pip install scipy

# Speaker diarization (optional — requires huggingface token)
# python -m pip install torch torchaudio pyannote.audio

# Word-level transcription (optional — enables karaoke subtitles)
# python -m pip install openai-whisper

Write-Host ""
Write-Host "[✓] Core packages installed!" -ForegroundColor Green
Write-Host ""
Write-Host "Optional packages (for premium features):" -ForegroundColor Yellow
Write-Host "  Speaker diarization: pip install torch torchaudio pyannote.audio"
Write-Host "  Word transcription:  pip install openai-whisper"
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "  1. Ensure yt-dlp and ffmpeg are in PATH"
Write-Host "  2. Start the worker: npx tsx worker\index.ts"
Write-Host "  3. Check logs to confirm V2 pipeline is active"
Write-Host ""
