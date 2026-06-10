# GANYIQ — AI Agent Context

## What is GANYIQ?

GANYIQ is an AI-powered clip discovery engine. It analyzes long-form YouTube videos (podcasts, interviews, talks) and identifies the 15 most clip-worthy moments — ranked, scored, and ready to export.

**Product goal:** Surface the moments people actually remember.

## Product Philosophy

GANYIQ does not optimize for engagement.

GANYIQ optimizes for **clip-worthiness**.

A clip is valuable if:
- **Memorable** — sticks in your mind after watching
- **Emotionally resonant** — creates a feeling (laughter, surprise, reflection)
- **Insight dense** — packs meaningful information into seconds
- **Shareable** — you'd send it to a friend unprompted
- **Understandable without full context** — stands alone

**Not all viral clips are good clips.** A shouting match gets views but lacks substance.
**Not all educational clips are good clips.** A 15-minute lecture excerpt without context confuses more than it informs.

GANYIQ's ranking engine weights these factors deterministically — no LLM in the ranking path, no engagement metrics, no popularity bias. Every clip is scored on its intrinsic merit as a standalone moment.

## Stack

| Component | Technology |
|-----------|------------|
| Frontend | Next.js 14 (App Router) |
| Styling | Plain CSS (no Tailwind) — `app/globals.css` |
| Font | Geist (Google Fonts) |
| Database | PostgreSQL (localhost:5432) |
| LLM | OpenCode Go API — deepseek-v4-flash |
| STT | Deepgram (fallback) |
| Video | yt-dlp + ffmpeg |
| Runtime | PM2 + Nginx reverse proxy |
| Server | DigitalOcean VPS (68.183.231.223, Ubuntu 22.04, 6.8.0-124-generic) |

## Source of Truth

```
/root/GANYIQ/
```

This is the single git repository and development root. **All code lives here.**

## Production Runtime

```
/var/www/ganyiq/
```

PM2 runs from here (port 3003). Nginx proxies `ganyiq.ganys.me` → `:3003`.

**Never modify files in `/var/www/ganyiq/` directly.** Always deploy via `deploy.sh`.

## Worker Architecture

Two worker variants:

| Variant | Location | Purpose | Heartbeat |
|---------|----------|---------|-----------|
| `worker/` | VPS-side | Clip rendering (async) | Has heartbeat via `sendHeartbeatNow()` |
| `worker-package/` | PC-GANY (local) | Clip rendering from local machine | No heartbeat (legacy variant) |

The PC-GANY worker is deployed by pulling from GitHub on a Windows machine (C:\ganyiq-worker\worker\).

## Historical Decisions

These decisions were made deliberately and should not be reversed without discussion:

| Decision | Rationale | Date |
|----------|-----------|------|
| Production at `/var/www/ganyiq/` | PM2 cwd, Nginx configured, 1.2G runtime data | 2026-06 |
| Source of truth at `/root/GANYIQ/` | Single git repo for all source code | 2026-06 |
| Deploy only through `deploy.sh` | Rsync + build + restart. Never edit production directly | 2026-06 |
| `displayScore` is cosmetic only | Real scores in DB unchanged. Only UI spread | 2026-06-10 |
| Ranking is deterministic | No LLM calls in ranking path. Pure heuristic scoring | 2026-06-10 |
| Title generation is batched | 1 LLM call for all moments (was 15 separate calls) | 2026-06-10 |
| Scoring already runs in parallel | `Promise.allSettled` with concurrency 4 | 2026-06-10 |
| Worker heartbeat uses async `exec()` | `execSync` blocks event loop, causes heartbeat timeout | 2026-06-09 |
| Worker vs worker-package divergence | VPS worker has heartbeat; PC-GANY worker does not | 2026-06-09 |

## Deployment Flow

```bash
cd /root/GANYIQ
bash deploy.sh           # Full deploy: rsync → build → restart
bash deploy.sh --quick   # Quick: rsync only → restart (no build)
bash deploy.sh --rollback HEAD~1  # Rollback one commit
```

## Folder Guide

| Path | Contents |
|------|----------|
| `app/` | Next.js pages and API routes |
| `lib/` | All engine logic (24 files) |
| `db/` | PostgreSQL client and migrations |
| `audits/` | All audit reports and quality analysis |
| `docs/` | Design proposals, mockups, completion reports |
| `infrastructure/` | Reference: nginx config, deploy docs |
| `production/` | Reference docs for production server |
| `backups/` | Database snapshots |
| `legacy/` | Old audit packages (historical reference) |
| `PROJECT_MAP.md` | Quick-start: read this first |
| `ARCHITECTURE.md` | System flow and architecture |
| `AGENTS.md` | This file — AI agent onboarding |
| `DECISIONS.md` | All architectural decisions |

## Rules (do not violate)

1. **Never edit files in `/var/www/ganyiq/` directly.** Always use `deploy.sh`.
2. **Never change the database schema** without an additive migration.
3. **Never modify production `.env.local`** without backup and approval.
4. **Never change Nginx config** without testing on staging first.
5. **Never remove `displayScore` cosmetic layer** — it's separate from real scores by design.
6. **Never put LLM calls in the ranking path** — ranking must stay deterministic.
7. **Always use async `exec()` for worker commands** — `execSync` blocks the event loop.
8. **Always deploy via `deploy.sh`** — never `scp` or manual `rsync` to production.
