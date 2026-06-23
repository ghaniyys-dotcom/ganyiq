param(
    [string]$ApiUrl = $(if ($env:GANYIQ_API_URL) { $env:GANYIQ_API_URL } else { "https://ganyiq.ganys.me" }),
    [string]$WorkerName = $(if ($env:WORKER_NAME) { $env:WORKER_NAME } else { "LAPTOP-GANY" }),
    [switch]$Help
)

if ($Help) {
    Write-Host @"
GANYIQ Log Monitor
USAGE:  npx tsx index.ts | powershell -File monit.ps1
        type worker.log | powershell -File monit.ps1
        powershell -File monit.ps1 -WorkerName LAPTOP-GANY
"@ -ForegroundColor Cyan
    exit 0
}

$importantPatterns = @("ENCODER","SUBTITLE","TRANSCRIBE","SPLIT","CLIP","CACHE","ERROR","FAILED","FATAL","YOLO","V2","FACE","FFMPEG","OUTPUT","SOURCE","UPLOAD")
$sendQueue = @()
$lastSend = (Get-Date).AddSeconds(-60)
$sendInterval = 15
$batchSize = 100

Write-Host "[MONITOR] GANYIQ Worker Log Monitor" -ForegroundColor Cyan
Write-Host "[MONITOR] Sending to: $ApiUrl" -ForegroundColor Cyan
Write-Host "[MONITOR] Worker: $WorkerName" -ForegroundColor Cyan
Write-Host "[MONITOR] Watching stdin... (Ctrl+C to stop)" -ForegroundColor Cyan

foreach ($line in $input) {
    $line = $line.Trim()
    if (-not $line) { continue }

    $isImportant = $false
    foreach ($p in $importantPatterns) {
        if ($line -match $p) { $isImportant = $true; break }
    }

    if ($isImportant) {
        if ($line -match "ERROR|FAILED|FATAL") { Write-Host $line -ForegroundColor Red }
        elseif ($line -match "ENCODER|CACHE") { Write-Host $line -ForegroundColor Green }
        elseif ($line -match "SUBTITLE|TRANSCRIBE") { Write-Host $line -ForegroundColor Yellow }
        else { Write-Host $line -ForegroundColor Cyan }
        $sendQueue += $line
    }

    $elapsed = (Get-Date) - $lastSend
    if ($elapsed.TotalSeconds -ge $sendInterval -and $sendQueue.Count -gt 0) {
        $linesToSend = $sendQueue[0..([Math]::Min($sendQueue.Count-1, $batchSize-1))]
        $body = @{
            worker_name = $WorkerName
            lines = $linesToSend
            timestamp = (Get-Date -Format "yyyy-MM-ddTHH:mm:ssZ")
        } | ConvertTo-Json

        try {
            $null = Invoke-RestMethod -Uri "$ApiUrl/api/workers/logs" -Method Post -Body $body -ContentType "application/json" -TimeoutSec 10
            $remaining = $sendQueue.Count - $linesToSend.Count
            if ($remaining -gt 0) { $sendQueue = $sendQueue[$linesToSend.Count..($sendQueue.Count-1)] } else { $sendQueue = @() }
        } catch {
            Write-Host "[MONITOR] Send failed: $($_.Exception.Message)" -ForegroundColor DarkRed
        }
        $lastSend = Get-Date
    }
}
