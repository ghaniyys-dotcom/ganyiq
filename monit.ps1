param(
    [string]$ApiUrl = $(if ($env:GANYIQ_API_URL) { $env:GANYIQ_API_URL } else { "https://ganyiq.ganys.me" }),
    [string]$WorkerName = $(if ($env:WORKER_NAME) { $env:WORKER_NAME } else { "LAPTOP-GANY" })
)

$importantPatterns = @("ENCODER","SUBTITLE","TRANSCRIBE","SPLIT","CLIP","CACHE","ERROR","FAILED","FATAL","YOLO","V2","FACE","FFMPEG","OUTPUT","SOURCE","UPLOAD")
$sendQueue = @()
$lastSend = (Get-Date).AddSeconds(-60)
$sendInterval = 15
$batchSize = 100

Write-Host "[MONITOR] GANYIQ Worker Log Monitor" -ForegroundColor Cyan
Write-Host "[MONITOR] Sending to: $ApiUrl" -ForegroundColor Cyan
Write-Host "[MONITOR] Starting worker as child process..." -ForegroundColor Cyan

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = "npx"
$psi.Arguments = "tsx index.ts"
$psi.UseShellExecute = $false
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.CreateNoWindow = $true

$proc = New-Object System.Diagnostics.Process
$proc.StartInfo = $psi

function Send-Logs {
    param($lines)
    if ($lines.Count -eq 0) { return }
    $linesToSend = $lines[0..([Math]::Min($lines.Count-1, $batchSize-1))]
    $body = @{
        worker_name = $WorkerName
        lines = $linesToSend
        timestamp = (Get-Date -Format "yyyy-MM-ddTHH:mm:ssZ")
    } | ConvertTo-Json
    try {
        $null = Invoke-RestMethod -Uri "$ApiUrl/api/workers/logs" -Method Post -Body $body -ContentType "application/json" -TimeoutSec 10
        $script:sendQueue = @()
        Write-Host "[MONITOR] Sent $($linesToSend.Count) lines" -ForegroundColor DarkGray
    } catch {
        Write-Host "[MONITOR] Send failed: $($_.Exception.Message)" -ForegroundColor DarkRed
    }
    $script:lastSend = Get-Date
}

$proc.Start() | Out-Null

$reader = $proc.StandardOutput
$errorReader = $proc.StandardError

while (-not $reader.EndOfStream -or -not $errorReader.EndOfStream) {
    $line = $null
    if (-not $reader.EndOfStream) {
        $line = $reader.ReadLine()
    }
    if (-not $line -and -not $errorReader.EndOfStream) {
        $line = $errorReader.ReadLine()
        if ($line) { $line = "[STDERR] $line" }
    }
    if (-not $line) { Start-Sleep -Milliseconds 100; continue }

    $isImportant = $false
    foreach ($p in $importantPatterns) {
        if ($line -match $p) { $isImportant = $true; break }
    }

    if ($isImportant) {
        if ($line -match "ERROR|FAILED|FATAL") { Write-Host $line -ForegroundColor Red }
        elseif ($line -match "ENCODER|CACHE") { Write-Host $line -ForegroundColor Green }
        elseif ($line -match "SUBTITLE|TRANSCRIBE") { Write-Host $line -ForegroundColor Yellow }
        else { Write-Host $line -ForegroundColor Cyan }
        $script:sendQueue += $line
    }

    $elapsed = (Get-Date) - $script:lastSend
    if ($elapsed.TotalSeconds -ge $sendInterval -and $script:sendQueue.Count -gt 0) {
        Send-Logs $script:sendQueue
    }

    if ($Host.UI.RawUI.KeyAvailable) { Write-Host "[MONITOR] Key pressed, stopping..."; break }
}

$proc.WaitForExit()
Write-Host "[MONITOR] Worker exited with code $($proc.ExitCode)" -ForegroundColor Magenta
