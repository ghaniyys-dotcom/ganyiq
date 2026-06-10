# GANYIQ — Opus Master Briefing

## Complete System Audit — Architecture Review & Production Redesign

---

## For Claude Opus

This briefing is your entry point to the full GANYIQ audit package. It contains:
1. What this system is and what it needs to become
2. All files in the package and what they contain
3. 15 specific deliverables requested from your audit

---

## What Is GANYIQ?

GANYIQ is a **clip discovery engine** that:
- Ingests YouTube videos (Indonesian podcasts)
- Finds clip-worthy moments using AI transcript analysis
- Generates vertical shorts (9:16) with face-tracking camera

**Target:** Compete with Opus Clip — automated podcast clipping for TikTok/Shorts/Reels.

**Current state:** Working MVP. Single VPS (2 CPU, 4GB). One active worker. Manual deploy. ~7,000 lines of TypeScript + Python. Zero tests.

**Domain:** `ganyiq.ganys.me` (Nginx → PM2 → Next.js 16 on port 3003)
**Database:** Neon PostgreSQL (Singapore, serverless, free tier)
**Workers:** Residential Windows PCs (PC-GANY) running `npx tsx index.ts`
**LLM:** DeepSeek V4 Flash → Mimo → Qwen via OpenCode Go API
**STT:** Deepgram Nova-2 (Indonesian)
**Video:** yt-dlp + FFmpeg + OpenCV Haar Cascade

---

## Package Contents

```
GANYIQ_OPUS_AUDIT_PACKAGE_V2/
│
├── [NEW] SOURCE_SNAPSHOT/           # 71 files — actual source code
│   ├── worker/                      # Worker agent source
│   ├── worker-package/              # Distribution copy (drifted)
│   ├── app/api/                     # All 15 API routes
│   ├── lib/                         # Core business logic
│   ├── db/                          # Database layer + migrations
│   ├── scripts/                     # Utility scripts
│   ├── package.json
│   ├── tsconfig.json
│   ├── next.config.ts
│   └── deploy.sh
│
├── [NEW] CODE_DRIFT_REPORT.md       # Source vs Production comparison
├── [NEW] DATABASE_SCHEMA.sql        # Actual pg_dump schema export
├── [NEW] LOGS/                      # Sanitized production logs
│   ├── README.md
│   ├── server_out.log             # PM2 stdout (600 lines)
│   ├── worker_poll.log            # Worker polling behavior
│   ├── worker_render.log          # Face tracking render flow
│   ├── worker_upload.log          # File upload history
│   └── worker_error.log           # All worker errors
├── [NEW] FACE_TRACKING_FORENSICS.md # 24 bugs discovered with line numbers
├── [NEW] PERFORMANCE.md            # All timing data & bottlenecks
├── [NEW] KNOWN_ISSUES_FORENSIC.md  # 17 NEW issues beyond the original 30+
├── [NEW] OPUS_MASTER_BRIEFING.md   # THIS FILE — your audit briefing
│
├── ARCHITECTURE.md                 # Full system architecture + diagrams
├── DATABASE.md                     # Complete database schema doc
├── API_REFERENCE.md                # All 15 endpoints documented
├── WORKER_ARCHITECTURE.md          # Worker lifecycle documentation
├── DEPLOYMENT.md                   # Deploy flow + infrastructure
├── INFRASTRUCTURE.md               # VPS, Nginx, PM2, Neon
├── FACE_TRACKING.md                # V1→V2→V2.4A pipeline doc
├── KNOWN_ISSUES.md                 # 30+ previously known issues
├── ROADMAP.md                      # V2.4A → V2.4B → V2.5 → V3
└── OPUS_BRIEFING.md                # Original audit briefing (14 questions)
```

**Total: ~100+ files, ~1.1 MB uncompressed, ~140 KB compressed.**

---

## 15 Deliverables Requested from Claude Opus

Please produce analysis and recommendations for each of the following 15 areas:

### D1: Complete Architecture Review
**What we need:** Full review of the current architecture.
- Is the 2-location (source + production rsync) model appropriate?
- Should we containerize (Docker)?
- Microservices vs monolith at this scale?
- Are there fundamental architectural flaws?
- Review the Next.js App Router setup for this use case

### D2: Production-Ready Architecture Design
**What we need:** The ideal architecture for a production video clipping service.
- Target: 10 workers, 1000 clips/day, <5 min average render time
- Should we use Redis/BullMQ for the job queue?
- CDN strategy for video delivery
- Database scaling (read replicas, connection pooling)
- CI/CD pipeline design
- Container orchestration strategy

### D3: Face Tracking Redesign
**What we need:** The optimal face tracking system.
- Current: OpenCV Haar Cascade (inadequate for production)
- Replace with: MediaPipe? MTCNN? DLIB? YOLO-face?
- Identity tracking: current Euclidean distance matching — better alternatives?
- Camera target selection: current size+center+stability scoring — better formula?
- Smoothing: current per-face moving average (window=3) — Kalman filter?
- The forensic report (FACE_TRACKING_FORENSICS.md) found 24 bugs. Design fixes for each.
- Review the 30% face ratio gate — design a per-segment fallback instead

### D4: Speaker Tracking Architecture
**What we need:** Complete design for speaker-aware camera.
- Should use Deepgram Nova-2 diarization (speaker labels)?
- How to correlate diarized speakers with tracked facial identities?
- Confidence thresholds for speaker→face mapping
- Handling overlapping speech
- Lip movement detection (MediaPipe) as supplementary signal?
- VAD (Voice Activity Detection) integration
- Design the data flow from raw video → diarized transcript → face IDs → camera target

### D5: Split-Screen Architecture
**What we need:** Complete design for dynamic split-screen.
- Activation criteria (overlap threshold, duration, min speakers)
- Vertical stack vs side-by-side for 9:16 format
- Minimum face size constraint
- Transition animation between split ↔ single modes
- FFmpeg complex filter chain design
- When to split (both talking in last 2s) vs when to single-crop

### D6: Queue System Redesign
**What we need:** Production-grade job queue.
- Current: PostgreSQL-based with `FOR UPDATE SKIP LOCKED`
- Should we migrate to Redis/BullMQ?
- Job prioritization (transcript vs clip jobs)
- Queue depth monitoring
- Graceful worker shutdown
- Dead letter queue for permanently failed jobs
- Stale job detection and recovery

### D7: Worker System Redesign
**What we need:** Robust, self-healing worker architecture.
- Current: polling every 30s via HTTP
- Better: WebSocket connection? Long polling?
- Auto-scaling worker pool
- Worker health beyond heartbeat (stuck detection)
- Graceful shutdown (finish current job)
- Windows/Linux cross-platform strategy
- yt-dlp format selection strategy for reliability
- Upload retry with exponential backoff

### D8: Observability & Monitoring Design
**What we need:** Complete observability stack.
- Current: PM2 logs + Nginx logs only. No error tracking.
- Error tracking: Sentry? DataDog? OpenTelemetry?
- Metrics: queue depth, render times, fallback rates, LLM latency
- Logging: structured logging (JSON)? Log aggregation?
- Dashboards: what to monitor, where to display
- Alerting: what triggers alerts, to whom

### D9: Scaling Strategy
**What we need:** How to scale from current to 10x and 100x.
- Database: Neon free tier → what upgrade path?
- VPS: Single → load-balanced cluster?
- Workers: 1 → 10 → 100 registration and management
- LLM provider: single OpenCode → multi-provider failover?
- Deepgram: concurrent request limits
- Video storage: VPS filesystem → CDN (Cloudflare R2/S3)?
- Cost projection at 10x, 100x scale

### D10: Cost Optimization
**What we need:** Minimize per-clip cost.
- Current cost breakdown (est.):
  - Deepgram STT: $0.0204/min of audio
  - LLM (OpenCode): ~$0.0013/analysis
  - VPS: ~$12/month (2 CPU, 4GB)
  - Bandwidth: included in VPS (est.)
- Where to optimize:
  - Cache more aggressively (avoid re-transcription)
  - Use faster/cheaper STT (Whisper.cpp on worker?)
  - Batch LLM calls more efficiently
  - Reduce polling overhead

### D11: Security Review
**What we need:** Full security audit.
- PM2 running as root → migrate to non-privileged user
- Worker API key management (returned once, lost forever)
- No rate limiting on worker endpoints
- Active .env probing from bot networks
- Nginx config: hidden file blocking, HSTS
- CORS policy
- Dependency vulnerability scan
- SSL/TLS configuration review

### D12: Implementation Roadmap
**What we need:** Ordered, actionable migration plan.
- What's the #1 priority to fix (biggest impact)?
- Phased rollout: MVP→V2→V3 transition
- What can be deferred indefinitely?
- Risk assessment per phase
- Testing strategy (unit, integration, e2e) — currently ZERO tests

### D13: Anti-Regression Plan
**What we need:** How to prevent old bugs from returning.
- The face tracking system has 24 known bugs (documented in FACE_TRACKING_FORENSICS.md)
- How to ensure "camera stuck in middle" never returns
- Regression test suite design
- Deployment gating (smoke tests, canary deploys)

### D14: Risk Analysis
**What we need:** Identify and quantify all risks.
| Risk | Probability | Impact | Mitigation |
|---|---|---|---|
| Worker crashes mid-render | Medium | High | |
| Deepgram rate limit hit | Low | High | |
| LLM provider downtime | Medium | Critical | |
| VPS failure | Low | Critical | |
| Bot attack / DDoS | Medium | Medium | |
| Data loss (Neon) | Low | High | |
| yt-dlp YouTube changes | Medium | High | |

### D15: Critical Bug Fix Review
**What we need:** Review of the biggest bugs found.
- **Camera stuck in middle** (3 compounding bugs)
- **No valid segments produced** (zero-duration segment drop)
- **Slow face detection** (96.7% wasted frame decode)
- **Production 20 commits behind source** (confidence threshold fix not deployed)
- **Worker-package code drift** (renderClip signature differs)
- **tsserver memory leak** (2 GB consumed by orphaned LSP processes)
- **Non-idempotent job completion** (duplicate processing risk)

---

## Key Numbers for Context

| Metric | Value |
|---|---|
| Total lines of code | ~16,000 (TypeScript + Python) |
| Number of files | ~100+ (incl. snapshot) |
| Database tables | 8 (7 user + 1 internal) |
| API endpoints | 15 |
| Known bugs (original) | 30+ |
| New bugs found (forensic) | 17 |
| Face tracking bugs | 24 |
| Commits production is behind | 20 |
| Active workers | 1 (PC-GANY) |
| Registered workers | 2 (PC-GANY + LAPTOP-GANY) |
| Total analyses | ~200 |
| Total rendered clips | 8 |
| Deployment model | Manual rsync |
| Test coverage | 0% |

---

## How to Use This Package

1. **Start with this file** — understand the scope and deliverables
2. **Read ARCHITECTURE.md** and the original OPUS_BRIEFING.md — understand the system
3. **Read FACE_TRACKING_FORENSICS.md** — 24 bugs documented with line numbers
4. **Read KNOWN_ISSUES_FORENSIC.md** — 17 new issues found
5. **Review SOURCE_SNAPSHOT/** for actual code evidence
6. **Review LOGS/** for system behavior evidence
7. **Read DATABASE_SCHEMA.sql** for actual schema
8. **Read CODE_DRIFT_REPORT.md** for deployment differences
9. **Produce all 15 deliverables** from D1 through D15

**Mandatory constraint:** This is a bootstrapped project with limited budget (single developer, ~$50/month infra cost). All recommendations must be cost-aware — prefer simpler solutions over enterprise-grade tooling where the tradeoff justifies it.
