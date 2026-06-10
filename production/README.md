# GANYIQ Production

**This folder contains documentation only. No production files live here.**

| Item | Detail |
|------|--------|
| Production runtime | `/var/www/ganyiq/` |
| PM2 process | `ganyiq` (ID: 5, port 3003) |
| Domain | `ganyiq.ganys.me` |
| Nginx | Reverse proxy :443 → :3003 |
| Server | `68.183.231.223` (DigitalOcean, Singapore) |
| Database | PostgreSQL `ganyiq` @ localhost:5432 |

## Rules

1. **Never edit files in `/var/www/ganyiq/` directly.** Always use `deploy.sh`.
2. **Never modify production `.env.local`** without backup.
3. **Deploy only from `/root/GANYIQ/`** via `bash deploy.sh`.
4. **Never restart PM2 outside of `deploy.sh`** unless troubleshooting.

## Key Files

| File | Purpose |
|------|---------|
| `LIVE_SERVER.md` | Server specifications and connection details |
| `DEPLOYMENT.md` | Deployment reference |
| `RUNBOOK.md` | Operations guide (restart, logs, rollback, backup) |
