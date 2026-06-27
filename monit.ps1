param(
    [string]$ApiUrl = $(if ($env:GANYIQ_API_URL) { $env:GANYIQ_API_URL } else { "https://ganyiq.ganys.me" }),
    [string]$WorkerName = $(if ($env:WORKER_NAME) { $env:WORKER_NAME } else { "LAPTOP-GANY" })
)

$importantPatterns = @("ENCODER","SUBTITLE","TRANSCRIBE","SPLIT","CLIP","CACHE","ERROR","FAILED","FATAL","YOLO","V2","FACE","FFMPEG","OUTPUT","SOURCE","UPLOAD","HEARTBEAT","CONFIG","JOB")
$sendQueue = [System.Collections.ArrayList]@()
$lastSend = (Get-Date).AddSeconds(-60)
$sendInterval = 15
$batchSize = 100

Write-Host "[MONITOR] GANYIQ Worker Log Monitor" -ForegroundColor Cyan
Write-Host "[MONITOR] Sending to: $ApiUrl" -ForegroundColor Cyan
Write-Host "[MONITOR] Starting worker as child process..." -ForegroundColor Cyan

# Use ComSpec (cmd.exe) so npx.cmd resolves correctly from PATH
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $env:ComSpec
$psi.Arguments = "/c npx tsx index.ts"
$psi.UseShellExecute = $false
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.CreateNoWindow = $true
# No WorkingDirectory — inherit from current shell (C:\ganiyq-worker)
$psi.EnvironmentVariables["FORCE_COLOR"] = "0"

$proc = New-Object System.Diagnostics.Process
$proc.StartInfo = $psi
$proc.Start() | Out-Null

Write-Host "[MONITOR] Worker started, PID: $($proc.Id)" -ForegroundColor Cyan

# Read stdout line by line — ReadLine() blocks until data arrives, works in real-time
while ((-not $proc.HasExited) -or (-not $proc.StandardOutput.EndOfStream)) {
    $line = $proc.StandardOutput.ReadLine()
    if (-not $line) {
        if ($proc.HasExited) { break }
        Start-Sleep -Milliseconds 50
        continue
    }

    $line = $line.Trim()
    if (-not $line) { continue }

    # Color by pattern
    if ($line -match "ERROR|FAILED|FATAL") { Write-Host $line -ForegroundColor Red }
    elseif ($line -match "ENCODER|CACHE") { Write-Host $line -ForegroundColor Green }
    elseif ($line -match "SUBTITLE|TRANSCRIBE|WHISPER") { Write-Host $line -ForegroundColor Yellow }
    elseif ($line -match $importantPatterns -join "|") { Write-Host $line -ForegroundColor Cyan }

    # Queue for VPS
    [void]$sendQueue.Add($line)

    # Flush queue every 15s
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

# Send remaining logs
if ($sendQueue.Count -gt 0) {
    $body = @{
        worker_name = $WorkerName
        lines = $sendQueue
        timestamp = (Get-Date -Format "yyyy-MM-ddTHH:mm:ssZ")
    } | ConvertTo-Json
    try { $null = Invoke-RestMethod -Uri "$ApiUrl/api/workers/logs" -Method Post -Body $body -ContentType "application/json" -TimeoutSec 10 } catch {}
}

Write-Host "[MONITOR] Worker exited (code: $($proc.ExitCode))" -ForegroundColor Cyan

# Dump stderr (if any — usually Node warnings/errors)
$stderr = $proc.StandardError.ReadToEnd()
if ($stderr) {
    Write-Host "[MONITOR] STDERR:" -ForegroundColor Red
    Write-Host $stderr -ForegroundColor Red
}
