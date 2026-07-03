# worker/setup.ps1 - GANYIQ Worker V2 Python Dependencies (Windows)
param([switch]$Quiet)

$C = "Cyan"; $G = "Green"; $Y = "Yellow"; $R = "Red"

if (-not $Quiet) {
    Write-Host "==================================" -ForegroundColor $C
    Write-Host "  GANYIQ Worker V2 Setup (Windows) " -ForegroundColor $C
    Write-Host "==================================" -ForegroundColor $C
    Write-Host ""
}

# Check Python
try {
    $v = & python --version 2>&1
    if (-not $Quiet) { Write-Host "[OK] Python: $v" -ForegroundColor $G }
} catch {
    Write-Host "ERROR: Python not found in PATH. Install Python 3.8+." -ForegroundColor $R
    exit 1
}

if (-not $Quiet) { Write-Host ""; Write-Host "Installing packages..." -ForegroundColor $Y }

python -m pip install --upgrade pip setuptools wheel --quiet
python -m pip install opencv-python numpy onnxruntime --quiet
python -m pip install scipy --quiet

if (-not $Quiet) {
    Write-Host ""
    Write-Host "[OK] Core packages installed!" -ForegroundColor $G
    Write-Host ""
    Write-Host "Optional: pip install torch torchaudio pyannote.audio" -ForegroundColor $Y
    Write-Host "Optional: pip install openai-whisper" -ForegroundColor $Y
    Write-Host ""
    Write-Host "Next: npx tsx index.ts" -ForegroundColor $C
}
