# GANYIQ — Opus Audit Briefing

## For Claude Opus — Full System Audit Package

---

## What Is GANYIQ?

GANYIQ is a **clip discovery engine** — an automated system that:
1. Ingests YouTube videos (primarily Indonesian podcasts like Deddy Corbuzier, etc.)
2. Analyzes transcripts using AI to find viral clip-worthy moments
3. Generates short-form vertical (9:16) videos with face-tracking camera

**Target:** Compete with Opus Clip — an AI tool that automatically clips and formats podcast moments for TikTok/Shorts/Reels.

**Current state:** MVP/working prototype. Functional but rough. Single VPS, one active worker, manual deploy.

---

## Product Target

GANYIQ aims to be an **Opus Clip alternative** with these capabilities:

| Feature | GANYIQ (Current) | Opus Clip (Target) |
|---|---|---|
| Transcript acquisition | ✅ 3-path fallback | ✅ |
| AI moment scoring | ✅ V2 candidate extraction | ✅ |
| Vertical shorts | ✅ V2.4A face tracking | ✅ |
| Speaker-aware camera | ❌ Not started | ✅ |
| Split screen | ❌ Not started | ✅ |
| Reaction tracking | ❌ Not started | ✅ |
| Subtitle burn-in | ❌ Not started | ✅ |
| Batch rendering | ❌ Not started | ✅ |
| CDN delivery | ❌ Nginx direct | ✅ Cloudflare |
| Multi-worker | ⚠️ 1 active | ✅ Auto-scale |
| CI/CD | ❌ Manual deploy | ✅ Auto |

---

## Technical Stack

| Layer | Technology |
|---|---|
| **Frontend** | Next.js 16, React 19, TypeScript, CSS |
| **Server** | Node v20.20.2 (PM2), Nginx reverse proxy |
| **Database** | Neon PostgreSQL (serverless, Singapore) |
| **LLM** | DeepSeek V4 Flash (primary) → Mimo → Qwen (fallback) via OpenCode Go API |
| **STT** | Deepgram Nova-2 (Indonesian language model) |
| **Video** | yt-dlp, FFmpeg, OpenCV Haar Cascade |
| **Workers** | Residential PCs running Node.js/tsx |
| **Infra** | DigitalOcean VPS (2 CPU, 4GB RAM, 77GB SSD) |
| **Domain** | ganyiq.ganys.me (Let's Encrypt SSL) |

---

## Codebase at a Glance

| Directory | Files | LOC (approx) |
|---|---|---|
| `/app/` (routes) | 15 files | ~1,500 |
| `/lib/` (core logic) | 15 files | ~4,500 |
| `/db/` (database) | 10 files | ~1,000 |
| `/worker/` (agent) | 7 files | ~3,000 |
| `/worker-package/` | 8 files | ~3,000 |
| `/docs/` | 20 files | ~30,000 |
| `/scripts/` | 9 files | ~3,000 |
| **Total (excl. docs)** | **~64 files** | **~16,000 LOC** |

---

## Audit Questions

Please answer these 14 audit questions. Provide detailed analysis for each.

### Q1: Architecture Audit
**Is the current 2-location (source → production) deployment model appropriate?**
- Should we keep `/root/GANYIQ/` + `/var/www/ganyiq/` + rsync?
- Would Git-based deploy (git pull on production) be better?
- Should we containerize (Docker) for consistency?
- Are there any fundamental architectural flaws?

### Q2: Queue System Audit
**Is the current job queue implementation production-ready?**
- `FOR UPDATE SKIP LOCKED` — any race conditions we're missing?
- 15-minute stale timeout — appropriate?
- 30-second poll interval — optimal?
- What happens when we have 10+ workers?
- Should we use Redis/BullMQ instead of PostgreSQL?

### Q3: Worker Lifecycle Audit
**Is the worker lifecycle robust?**
- Registration returns API key once — acceptable?
- Heartbeat every 60s — frequency correct?
- Auto-recovery on crash (stale job timeout)?
- Cross-platform (Windows worker, Linux server) — pain points?
- How should workers handle yt-dlp/Deepgram rate limits?

### Q4: Race Conditions
**Where are the race conditions in the current system?**
- Multiple workers claiming same job (SKIP LOCKED protects this)
- Worker crashes mid-upload after cache update
- Concurrent analysis of the same video
- Rate limit counter race (SELECT → INSERT gap)
- Frontend polling vs worker completion timing

### Q5: Rendering Pipeline Audit
**Is the rendering pipeline efficient and correct?**
- yt-dlp format selection — `best[height<=720]` — best choice?
- Face tracking overhead vs benefit (30% threshold)?
- Per-segment encode + concat vs single encode with dynamic crop?
- CRF 18 vs 23 vs CRF+maxrate?
- Keyframe alignment issue with fast seek?
- Upload retry strategy?

### Q6: Face Tracking Audit
**How good is the current face tracking?**
- Haar Cascade vs MediaPipe vs MTCNN vs DLIB — which should we use?
- Identity tracking stability (Euclidean distance with 100px threshold)?
- Dominance scoring weights (40/30/30) — are these optimal?
- Dead zone (30px X-only) — good enough?
- Hold logic (1s min, 1.2× ratio) — prevents flicker?
- No-face fallback (last known position) — smooth enough?

### Q7: Speaker Tracking Design
**Design the optimal speaker tracking system.**
- Should we use Deepgram diarization (speaker labels)?
- How to correlate diarized speakers with tracked faces?
- What confidence threshold for speaker-face mapping?
- How to handle overlapping speakers?
- Should we add lip movement detection (MediaPipe)?
- What about VAD (Voice Activity Detection) correlation?

### Q8: Split-Screen Design
**Design the optimal split-screen system.**
- When should split-screen activate? (overlap threshold, duration, etc.)
- Vertical stack vs side-by-side for 9:16 format?
- What minimum face size to prevent over-zooming?
- How to transition smoothly between split and single-crop?
- FFmpeg filter chain design?

### Q9: Scalability Audit
**How will the system scale?**
- Bottlenecks at 10 workers, 100 workers?
- Database connection pool limits with Neon?
- VPS bandwidth for clip serving?
- LLM API rate limits (OpenCode Go)?
- Deepgram concurrent request limits?
- Single VPS failure mode?

### Q10: Production-Grade Architecture
**Design the ideal production architecture.**
- Containerization (Docker/K8s)?
- Microservices vs monolith?
- CDN strategy for video delivery?
- Queue system (Redis/BullMQ + PostgreSQL)?
- Database sharding/read replicas?
- Monitoring/observability stack?
- CI/CD pipeline design?

### Q11: Roadmap to Opus Clip Quality
**Design the roadmap from current state to Opus Clip quality.**
- What's the single biggest improvement to make?
- Order of feature implementation for maximum impact?
- What can we cut or postpone?
- What metrics should define "good enough"?

### Q12: Biggest Bottleneck
**What is the single biggest bottleneck right now?**
- Consider: worker polling, face detection, LLM latency, FFmpeg encoding, upload speed, database queries

### Q13: Biggest Technical Debt
**What is the single biggest technical debt item?**
- Consider: code quality, testing, architecture, documentation, deployment process

### Q14: Scale Risk
**What is the biggest risk at scale (10+ workers, 1000+ clips/day)?**
- Consider: race conditions, database pressure, bandwidth, cost, worker management

---

## Package Contents

```
GANYIQ_OPUS_AUDIT_PACKAGE/
├── tree_root_GANYIQ.txt        # Source directory tree
├── tree_var_www_ganyiq.txt     # Production directory tree
├── ARCHITECTURE.md             # Full system architecture
├── DATABASE.md                 # Complete DB schema documentation
├── API_REFERENCE.md            # All API routes documented
├── WORKER_ARCHITECTURE.md      # Worker agent flow documentation
├── DEPLOYMENT.md               # Deployment flow documentation
├── INFRASTRUCTURE.md           # VPS, Nginx, PM2 documentation
├── FACE_TRACKING.md            # V1→V2→V2.4A pipeline documentation
├── KNOWN_ISSUES.md             # All known bugs and issues
├── ROADMAP.md                  # Current and planned roadmap
└── OPUS_BRIEFING.md            # This file — audit briefing
```

---

## Additional Context

**Key constraint:** Everything runs on a single 2-core VPS with 4GB RAM. Workers are residential Windows PCs (PC-GANY, LAPTOP-GANY) connected via internet.

**Cost sensitivity:** This is a bootstrapped project. Opus Clip costs $20-40/user/month. GANYIQ must be cheaper to operate.

**Language focus:** Indonesian content. All prompts, transcripts, and UI are in Indonesian/Bahasa. Deepgram is configured with `language: id`.

**Development style:** Single developer (Gany). Iterative, evidence-driven, Telegram-based workflow with Hermes Agent.

**No testing framework:** Zero unit tests, zero integration tests. Only manual validation and e2e scripts.

---

*Begin audit. Analyze each of the 14 questions above with technical depth.*
