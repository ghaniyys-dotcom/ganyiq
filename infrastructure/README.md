# GANYIQ Infrastructure Reference

This folder contains reference copies of infrastructure configuration files.
**The original files are the source of truth.** This folder is for discoverability only.

## Nginx

| Item | Location |
|------|----------|
| Original config | `/etc/nginx/sites-enabled/ganyiq` |
| Reference copy | `nginx/ganiyq.conf` |

Domain: `ganyiq.ganys.me` → reverse proxy to `http://127.0.0.1:3003`
SSL certificate: Let's Encrypt (SAN cert, expires 2026-08-30)

## Cookies

| Item | Location |
|------|----------|
| YouTube cookies | `/etc/ganyiq/youtube-cookies.txt` |
| Instructions | `/etc/ganyiq/README_COOKIES.txt` |

These cookies are used by `yt-dlp` for authenticated video downloads.
Never commit cookies to git. `/etc/ganyiq/` is outside the repo.

## PM2

| Item | Detail |
|------|--------|
| Process name | `ganiyq` |
| Process ID | 5 |
| Working directory | `/var/www/ganyiq` |
| Script | `npm start -- -p 3003` |
| Restarts | ~57 (at time of writing) |
| Logs | `/root/.pm2/logs/ganiyq-{out,error}.log` |
| PID | `/root/.pm2/pids/ganiyq-5.pid` |

## PostgreSQL

| Item | Detail |
|------|--------|
| Database | `ganiyq` |
| User | `ganiyq` |
| Port | 5432 (localhost) |
| Connection string | `DATABASE_URL` in `.env.local` |
