$apiUrl = if ($env:GANYIQ_API_URL) { $env:GANYIQ_API_URL } else { "https://ganyiq.ganys.me" }
$workerName = if ($env:WORKER_NAME) { $env:WORKER_NAME } else { "LAPTOP-GANY" }

$importantPatterns = @("ENCODER","SUBTITLE","TRANSCRIBE","SPLIT","CLIP","CACHE","ERROR","FAILED","WARN","FATAL","YOLO","V2","FACE","FFMPEG","OUTPUT","SOURCE","UPLOAD","DEBUG [")
$sendQueue = @()
$lastSend = (Get-Date).AddSeconds(-60)
$sendInterval = 15
$batchSize = 100

Write-Host "GANYIQ Worker Log Monitor — sending to $apiUrl" -ForegroundColor Cyan

while ($true) {
    if ($Host.UI.RawUI.KeyAvailable) { break }
    $line = Read-Host
    if (-not $line) { continue }

    $isImportant = $false
    foreach ($p in $importantPatterns) { if ($line -match $p) { $isImportant = $true; break } }

    if ($isImportant) {
        if ($line -match "ERROR|FAILED|FATAL") { Write-Host $line -ForegroundColor Red }
        elseif ($line -match "ENCODER|CACHE") { Write-Host $line -ForegroundColor Green }
        elseif ($line -match "SUBTITLE|TRANSCRIBE") { Write-Host $line -ForegroundColor Yellow }
        else { Write-Host $line -ForegroundColor Cyan }
        $sendQueue += $line
    }

    $elapsed = (Get-Date) - $lastSend
    if ($elapsed.TotalSeconds -ge $sendInterval -and $sendQueue.Count -gt 0) {
        $body = @{worker_name=$workerName; lines=$sendQueue[0..([Math]::Min($sendQueue.Count-1,$batchSize-1))]; timestamp=(Get-Date -Format "yyyy-MM-ddTHH:mm:ssZ")} | ConvertTo-Json
        try { Invoke-RestMethod -Uri "$apiUrl/api/workers/logs" -Method Post -Body $body -ContentType "application/json" -TimeoutSec 10 | Out-Null; Write-Host "[MONITOR] Sent $($sendQueue.Count) lines" -ForegroundColor DarkGray; $sendQueue=@() }
        catch { Write-Host "[MONITOR] Send failed: $($_.Exception.Message)" -ForegroundColor DarkRed }
        $lastSend = Get-Date
    }
}
