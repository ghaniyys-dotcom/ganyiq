# Phase 3B — Shadow Rollback Guide

## Quick Rollback (30 seconds)

```bash
# Disable shadow execution
export V2_MULTI_GENERATOR_SHADOW=false

# Or in .env.local:
# V2_MULTI_GENERATOR_SHADOW=false

# Restart PM2
pm2 restart ganyiq
```

## Complete Rollback (5 minutes)

If shadow mode caused issues despite being user-invisible:

```bash
# 1. Disable flag
sed -i 's/V2_MULTI_GENERATOR_SHADOW=true/V2_MULTI_GENERATOR_SHADOW=false/' .env.local

# 2. Revert analyze-pipeline.ts changes
git checkout -- lib/analyze-pipeline.ts

# 3. Optionally drop shadow table (data is non-critical)
# psql "$DATABASE_URL" -c "DROP TABLE IF EXISTS v2_shadow_results;"

# 4. Rollback migration
# psql "$DATABASE_URL" -c "DELETE FROM _migrations WHERE filename='009_create_shadow_results.sql';"

# 5. Deploy
bash deploy.sh
```

## What Gets Rolled Back

| Component | Rollback action |
|-----------|----------------|
| V2 shadow execution | Set flag=false |
| Shadow results table | Keep (read-only, never queried for production) |
| Cron jobs | `cronjob remove <id>` |
| Code changes | `git checkout HEAD~1` |
| Feature flags | Revert .env changes |

## Rollback Scenarios

| Scenario | Action | Impact |
|----------|--------|--------|
| Latency increase >1s | Set flag=false | Zero — V1 unaffected |
| DB write contention | Set flag=false | Shadow table stays |
| Any unexpected behavior | Set flag=false | Shadow is invisible to users |
| Deploy bug | `bash deploy.sh --rollback HEAD~1` | Full revert |
