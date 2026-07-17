# Repository Cleanup Summary

**Date:** 2026-07-17  
**Branch:** `cleanup/final-repository-layout`  
**Baseline Tag:** `cleanup-baseline-20260717-1022`  
**Commits:** 3 cleanup commits

---

## Changes Made

### Deleted Folders (30M+ cleaned)
- `OPUS-AUDIT/` (28M) — Old audit artifacts, no active references
- `legacy/` (1.5M) — Explicitly legacy code
- `proof/` (844K) — Proof-of-concept experiments
- `eval/` (1.2M) — Moved to `docs/archive/eval-data/`
- `audit/`, `audits/`, `backups/`, `documents/`, `infrastructure/`, `production/` (988K total)
- Root `speaker-hybrid/` — Duplicate cache folder, canonical version in `worker/speaker-hybrid/`
- Root `__pycache__/` — Generated Python bytecode

### Archived Documentation
Moved 26 root .md files to `docs/archive/`:
- ARCHITECTURE_VPS_WORKER_SPLIT.md
- AUDIT_SUMMARY.md, DECISIONS.md, FINAL_VERIFICATION.md
- GIT_ARCHITECTURE_AUDIT.md, LAUNCH_CHECKLIST.md
- MIGRATION_FINAL.md, MIGRATION_REPORT.md
- OPUSCLIP_GAP_REPORT.md, PRE_EXECUTION_VERIFICATION_REPORT.md
- PROJECT_MAP.md, RENDER_PIPELINE_ROOT_CAUSE_ANALYSIS.md
- RUNTIME_VERIFICATION.md, SPEAKER_ASSOCIATION_COMPLETE.md
- SPEAKER_HYBRID_ARCHITECTURE.md, SPRINT1_AUDIT_REPORT.md
- SPRINT1_PROGRESS.md, SPRINT2_PROGRESS.md
- TRANSCRIPT_FLOW.md, VERIFICATION_SUMMARY.md
- VIBEVOICE_INTEGRATION_REPORT.md
- WORKER-STABILIZATION-AUDIT.md, WORKER-STABILIZATION-ROADMAP.md
- WORKER-STABILIZATION-VALIDATION.md, WORKER_GAP_REPORT.md
- _V2_PLAN.md

### Root Files Kept
- **AGENTS.md** — AI agent context
- **README.md** — Project overview
- **ARCHITECTURE.md** — System architecture

### Repository Root Now
```
/root/GANYIQ/
├── app/              # Next.js web application
├── db/               # Database schema
├── docs/             # Documentation (34 files)
│   └── archive/      # Historical docs (28 files)
├── lib/              # Shared libraries
├── scripts/          # Utility scripts (11 files)
├── worker/           # ALL worker source code
│   ├── speaker-hybrid/  # Canonical speaker pipeline
│   ├── index.ts      # Worker TS entrypoint
│   ├── run.py        # Worker Python entrypoint
│   └── ...
├── public/           # Web assets
├── AGENTS.md
├── ARCHITECTURE.md
├── README.md
├── package.json      # Web dependencies
├── tsconfig.json     # Web TS config
└── ecosystem.config.cjs
```

### Updated .gitignore
Added entries for:
- `__pycache__/`, `*.pyc`, `*.pyo`, `*.pyd`
- `*.onnx`, `*.task`, `*.pth`, `*.pt` (models)
- `*.mp4`, `*.webm`, `*.avi`, `*.mov` (media)
- `temp/`, `cache/`, `output/`, `logs/`, `*.log`
- `.env.local`, `yt_cookies.txt`

### Script Path Updates
- `scripts/batch-analyze.ts` — Updated eval/ paths
- `scripts/export-results.ts` — Updated eval/ paths

### External Cleanup
- Removed `/root/ganyiq-worker-new.stale` (341M stale clone)
- Removed `ganyiq-worker-phaseA-stable.zip` (127K backup)
- Removed `ganyiq.db` (0 byte empty file)

---

## Statistics

- **Files deleted:** 281
- **Lines removed:** 59,774
- **Lines added:** 324 (documentation)
- **Net cleanup:** 59,450 lines
- **Disk space freed:** ~30M (excluding stale clone)

---

## Verification Passed

✓ Python compilation: `worker/run.py`, `worker/diarize.py`  
✓ TypeScript check: `worker/index.ts` (no new errors)  
✓ Import test: `from worker import run` works  
✓ PM2 config: `ecosystem.config.cjs` references correct path  
✓ No stale `ganyiq-worker` references outside `worker/` namespace  
✓ Git status: clean, all changes committed

---

## Next Steps

1. **Push cleanup branch:**
   ```bash
   cd /root/GANYIQ
   git push origin cleanup/final-repository-layout
   ```

2. **Review diff on GitHub:**
   - Compare `cleanup/final-repository-layout` with `cleanup/production-codepath`
   - Verify no production code was accidentally removed

3. **Merge to worker-v2:**
   ```bash
   git checkout worker-v2
   git merge cleanup/final-repository-layout --no-ff
   git push origin worker-v2
   ```

4. **Update Windows worker:**
   ```powershell
   cd C:\ganyiq-worker
   git fetch origin
   git checkout worker-v2
   git pull origin worker-v2
   ```

---

## Rollback Instructions

If issues found after merge:

```bash
cd /root/GANYIQ
git checkout cleanup-baseline-20260717-1022
git checkout -b rollback-from-cleanup
# Verify everything works
git push origin rollback-from-cleanup
```

Or restore from backup:
```bash
tar -tzf /tmp/ganyiq-backup-20260717-1022.tar.gz | head -20
# Extract specific files if needed
```

---

## Documentation

See `docs/REPOSITORY_WORKFLOW.md` for:
- Branch strategy
- VPS workflow
- Windows sparse-checkout setup
- Common issues and fixes
- Hermes agent rules
