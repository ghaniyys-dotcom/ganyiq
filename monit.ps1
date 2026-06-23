param(
    [string]$ApiUrl = $(if ($env:GANYIQ_API_URL) { $env:GANYIQ_API_URL } else { "https://ganyiq.ganys.me" }),
    [string]$WorkerName = $(if ($env:WORKER_NAME) { $env:WORKER_NAME } else { "LAPTOP-GANY" })
)

$importantPatterns = @("ENCODER","SUBTITLE","TRANSCRIBE","SPLIT","CLIP","CACHE","ERROR","FAILED","FATAL","YOLO","V2","FACE","FFMPEG","OUTPUT","SOURCE","UPLOAD","HEARTBEAT","CONFIG","JOB")
$sendQueue = [System.Collections.ArrayList]@()
$lastSend = (Get-Date).AddSeconds(-60)
$sendInterval = 15
$batchSize = 100

Write-Host "[MONITOR] Worker: $WorkerName -> $ApiUrl" -ForegroundColor Cyan
Write-Host "[MONITOR] Ready" -ForegroundColor Cyan

# Process each line from stdin
$input | ForEach-Object {
    $line = $_.Trim()
    if (-not $line) { return }

    $isImportant = $false
    foreach ($p in $importantPatterns) {
        if ($line -match $p) { $isImportant = $true; break }
    }

    if ($isImportant) {
        if ($line -match "ERROR|FAILED|FATAL") { Write-Host $line -ForegroundColor Red }
        elseif ($line -match "ENCODER|CACHE") { Write-Host $line -ForegroundColor Green }
        elseif ($line -match "SUBTITLE|TRANSCRIBE|WHISPER") { Write-Host $line -ForegroundColor Yellow }
        else { Write-Host $line -ForegroundColor Cyan }
        [void]$sendQueue.Add($line)
    }

    $elapsed = (Get-Date) - $lastSend
    if ($elapsed.TotalSeconds -ge $sendInterval -and $sendQueue.Count -gt 0) {
        $endIdx = [Math]::Min($sendQueue.Count, $batchSize) - 1
        $linesToSend = $sendQueue[0..$endIdx]
        $body = @{
            worker_name = $WorkerName
            lines = $linesToSend
            timestamp = (Get-Date -Format "yyyy-MM-ddTHH:mm:ssZ")
        } | ConvertTo-Json

        try {
            $null = Invoke-RestMethod -Uri "$ApiUrl/api/workers/logs" -Method Post -Body $body -ContentType "application/json" -TimeoutSec 10
        } catch {
            Write-Host "[MONITOR] Send failed: $($_.Exception.Message)" -ForegroundColor DarkRed
        }
        $sendQueue.Clear()
        $lastSend = Get-Date
    }
}
