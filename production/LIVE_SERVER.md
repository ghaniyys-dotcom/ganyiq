# LIVE_SERVER.md — GANYIQ Production Server

## Server

| Property | Value |
|----------|-------|
| IP | `68.183.231.223` |
| Provider | DigitalOcean (Singapore) |
| OS | Ubuntu 22.04 |
| Kernel | Linux 6.8.0-124-generic |
| Node | v22.22.3 |
| Hostname | (default DO hostname) |

## Services

| Service | Status | Port |
|---------|--------|------|
| Nginx | ✅ Active | 443 (SSL) |
| Next.js (PM2) | ✅ Online | 3003 |
| PostgreSQL | ✅ Active | 5432 |

## PM2

| Property | Value |
|----------|-------|
| Process name | `ganyiq` |
| Process ID | 5 |
| Exec cwd | `/var/www/ganyiq` |
| Script | `npm start -- -p 3003` |
| Restarts | ~57 |
| Logs | `/root/.pm2/logs/ganyiq-{out,error}.log` |

## Domain

| Property | Value |
|----------|-------|
| Primary domain | `ganyiq.ganys.me` |
| SSL | Let's Encrypt (SAN cert) |
| Expiry | 2026-08-30 |

## Database

| Property | Value |
|----------|-------|
| Engine | PostgreSQL |
| Database | `ganyiq` |
| User | `ganyiq` |
| Host | localhost |
| Port | 5432 |
