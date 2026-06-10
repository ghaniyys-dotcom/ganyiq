# DEPLOYMENT.md — GANYIQ Deployment Reference

## Architecture

```
/root/GANYIQ/       → rsync →    /var/www/ganyiq/
(source + git)                    (production runtime)
                                 build: npm ci → next build
                                 serve: pm2 (port 3003)
                                 proxy: nginx (ganyiq.ganys.me)
```

## Commands

### Full deploy (recommended)
```bash
cd /root/GANYIQ
bash deploy.sh
```
Syncs source → production, installs deps, builds Next.js, restarts PM2.

### Quick deploy (no build)
```bash
cd /root/GANYIQ
bash deploy.sh --quick
```
Syncs source only, restarts PM2. Use for static/style-only changes.

### Build only
```bash
cd /root/GANYIQ
bash deploy.sh --build
```
Builds Next.js in production directory without syncing.

### Rollback
```bash
cd /root/GANYIQ
bash deploy.sh --rollback HEAD~1
```
Reverts source to previous commit, then full deploy.

## What deploy.sh does

1. `rsync -av --delete` (excludes: .git, node_modules, .next, .env*, cookies.txt, public/clips)
2. `npm ci --omit=dev` at production target
3. `npx next build` at production target
4. `pm2 restart ganyiq`
5. Health check via `/api/health`

## Verification

```bash
curl https://ganyiq.ganys.me/api/health
# Expected: HTTP 200, JSON with status
```

## Important

- **Never edit files in `/var/www/ganyiq/` directly.** The next deploy will overwrite them.
- **Always test locally first** before deploying to production.
- **Monitor PM2 logs** after deploy for any startup errors:
  ```bash
  pm2 logs ganyiq --lines 50
  ```
