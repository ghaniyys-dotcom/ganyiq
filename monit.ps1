# worker-monitor.ps1 — Send worker logs to Hermes VPS for remote monitoring
#
# Usage (run in separate terminal while worker is running):
#   powershell -File worker-monitor.ps1
#
# Or pipe worker output directly:
#   npx tsx index.ts | powershell -File worker-monitor.ps1
#
# Environment:
#   GANYIQ_API_URL = https://ganyiq.ganys.me  (default)
#   WORKER_NAME    = LAPTOP-GANY               (default)

$apiUrl = if ($env:GANYIQ_API_URL) { $env:GANYIQ_API_URL } else { "https://ganiyq.ganys.me" }
$workerName = if ($env:WORKER_NAME) { $env:WORKER_NAME } else { "LAPTOP-GANY" }
$logFile = Join-Path $PSScriptRoot "worker-output.log"
$sendInterval = 15  # seconds between sends
$batchSize = 100    # max lines per send

# Patterns to ALWAYS send (key diagnostics)
$importantPatterns = @(
    "ENCODER", "SUBTITLE", "TRANSCRIBE", "SPLIT", "CLIP", "CACHE",
    "ERROR", "FAILED", "WARN", "FATAL", "YOLO", "V2", "FACE",
    "FFMPEG", "OUTPUT", "SOURCE", "UPLOAD", "DEBUG \["
)

Write-Host "╔══════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║     GANYIQ Worker Log Monitor v1.0       ║" -ForegroundColor Cyan
Write-Host "║  API: $($apiUrl)" -ForegroundColor Cyan
Write-Host "║  Worker: $workerName" -ForegroundColor Cyan
Write-Host "╚══════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

# Check if worker-output.log exists (start it if not)
$workerRunning = $false
$workerProcess = $null

# Try to detect if worker is already running
$existingNode = Get-Process -Name "node" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match "tsx index" }
if ($existingNode) {
    Write-Host "[MONITOR] Detected running worker (PID: $($existingNode.Id)), reading output..." -ForegroundColor Green
    $workerRunning = $true
} else {
    Write-Host "[MONITOR] No worker detected. Start worker manually in another terminal:" -ForegroundColor Yellow
    Write-Host "  npx tsx index.ts 2>&1 | Tee-Object -FilePath worker-output.log" -ForegroundColor Gray
    Write-Host "[MONITOR] Then run this script again (or pipe: npx tsx index.ts | $($MyInvocation.MyCommand.Path))" -ForegroundColor Yellow
    Write-Host "[MONITOR] Starting in log-watch mode (waiting for worker-output.log)..." -ForegroundColor Yellow
}

$lastPosition = 0
if (Test-Path $logFile) {
    $lastPosition = (Get-Item $logFile).Length
}

$sendQueue = @()
$lastSend = Get-Date

while ($true) {
    try {
        # Read new lines from log file
        if (Test-Path $logFile) {
            $currentSize = (Get-Item $logFile).Length
            if ($currentSize -gt $lastPosition) {
                $reader = [System.IO.StreamReader]::new((New-Object System.IO.FileStream($logFile, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)))
                [void]$reader.BaseStream.Seek($lastPosition, [System.IO.SeekOrigin]::Begin)
                while (-not $reader.EndOfStream) {
                    $line = $reader.ReadLine()
                    if ($line) {
                        # Check if this line matches important patterns
                        $isImportant = $false
                        foreach ($pattern in $importantPatterns) {
                            if ($line -match $pattern) {
                                $isImportant = $true
                                break
                            }
                        }
                        
                        # Always print to console, highlight important ones
                        if ($isImportant) {
                            if ($line -match "ERROR|FAILED|FATAL") {
                                Write-Host $line -ForegroundColor Red
                            } elseif ($line -match "ENCODER|CACHE") {
                                Write-Host $line -ForegroundColor Green
                            } elseif ($line -match "SUBTITLE|TRANSCRIBE") {
                                Write-Host $line -ForegroundColor Yellow
                            } else {
                                Write-Host $line -ForegroundColor Cyan
                            }
                        } else {
                            Write-Host $line -ForegroundColor Gray
                        }
                        
                        # Add to send queue if important
                        if ($isImportant) {
                            $sendQueue += $line
                        }
                    }
                }
                $reader.Close()
                $lastPosition = $currentSize
            }
        }

        # Send batch every $sendInterval seconds
        $elapsed = (Get-Date) - $lastSend
        if ($elapsed.TotalSeconds -ge $sendInterval -and $sendQueue.Count -gt 0) {
            $batch = $sendQueue[0..[Math]::Min($sendQueue.Count - 1, $batchSize - 1)]
            $body = @{
                worker_name = $workerName
                lines = $batch
                timestamp = (Get-Date -Format "yyyy-MM-ddTHH:mm:ssZ")
            } | ConvertTo-Json

            try {
                $response = Invoke-RestMethod -Uri "$apiUrl/api/workers/logs" -Method Post -Body $body -ContentType "application/json" -TimeoutSec 10
                Write-Host "[MONITOR] Sent $($batch.Count) lines" -ForegroundColor DarkGray
                if ($sendQueue.Count -gt $batchSize) {
                    $sendQueue = $sendQueue[$batchSize..($sendQueue.Count - 1)]
                } else {
                    $sendQueue = @()
                }
            } catch {
                # Network error — keep queued for retry
                Write-Host "[MONITOR] Send failed: $($_.Exception.Message)" -ForegroundColor DarkRed
            }
            $lastSend = Get-Date
        }

        # Show status every 60s
        if ($elapsed.TotalSeconds -ge 60) {
            Write-Host "[MONITOR] Queue: $($sendQueue.Count) lines | Last send: $($lastSend.ToString('HH:mm:ss'))" -ForegroundColor DarkGray
        }

    } catch {
        Write-Host "[MONITOR] Error: $($_.Exception.Message)" -ForegroundColor Red
    }

    Start-Sleep -Seconds 5
}
