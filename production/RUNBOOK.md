# RUNBOOK.md — GANYIQ Operations Guide

## Restart PM2

```bash
pm2 restart ganyiq
```

Verify:
```bash
pm2 status
# Expected: online, uptime reset
```

## Check Logs

```bash
# Live tail (follow)
pm2 logs ganyiq

# Last 100 lines
pm2 logs ganyiq --lines 100

# Error log file
tail -100 /root/.pm2/logs/ganyiq-error.log

# Output log file
tail -100 /root/.pm2/logs/ganyiq-out.log
```

## Health Check

```bash
# HTTP health endpoint
curl https://ganyiq.ganys.me/api/health

# Expected: HTTP 200, JSON body with status

# PM2 process status
pm2 status

# Process details
pm2 show ganyiq
```

## Deploy

```bash
# Standard full deploy
cd /root/GANYIQ
bash deploy.sh

# Quick deploy (static/style changes only, no build)
bash deploy.sh --quick

# Build only
bash deploy.sh --build
```

**Important:** If deploy fails with a build error, the old build continues running. PM2 is only restarted after a successful build.

## Rollback

```bash
# Rollback source by 1 commit
cd /root/GANYIQ
bash deploy.sh --rollback HEAD~1

# Or manual rollback:
git log --oneline -10          # Pick the commit to revert to
git reset --hard <commit-hash> # or git revert HEAD
bash deploy.sh                 # Full deploy
```

## Database Backup

```bash
# Full database backup
pg_dump -U ganyiq ganyiq > /root/GANYIQ/backups/pg/ganiyq_$(date +%Y%m%d_%H%M%S).sql

# Restore from backup
psql -U ganyiq -d ganyiq < /root/GANYIQ/backups/pg/ganiyq_20260604_080101.sql
```

## Worker Troubleshooting

### Symptom: Worker goes stale / heartbeat not received
**Root cause:** `execSync` in worker code blocks the event loop, preventing `setInterval` for heartbeat from firing.

**Fix:** 
1. Replace `execSync` with async `exec()` from `child_process`
2. Add explicit `sendHeartbeatNow()` calls after long operations
3. Increase VPS stale timeout if needed (config: `MAX_HEARTBEAT_INTERVAL`)

### Symptom: Clip generation stuck / not progressing
**Check:**
```bash
# Check PM2 for any error logs
pm2 logs ganyiq --lines 50

# Check if PC-GANY worker pulled latest code
# On PC-GANY: cd C:\ganyiq-worker\worker\ && git pull

# Check worker registration
# POST /api/workers/register should have returned a worker_id
```

### Symptom: Analysis stuck in "processing" status
**Check zombie cleanup:**
The app runs `lib/zombie-cleanup.ts` on startup to clean stuck analyses.
```sql
-- Manual check
SELECT id, video_id, status, created_at 
FROM analyses 
WHERE status = 'processing' 
  AND updated_at < NOW() - INTERVAL '1 hour';
```

## PM2 Process Management

```bash
# Monitor resource usage
pm2 monit

# List all processes
pm2 status

# View detailed process info
pm2 show ganyiq

# Restart with environment update
pm2 restart ganyiq --update-env

# Save process list (if you change PM2 config)
pm2 save
```

## Quick Reference

```bash
# Everything you need in one place
alias ganyiq-status='pm2 status && curl -s https://ganyiq.ganys.me/api/health && echo "" && pm2 logs ganyiq --lines 5'
```
