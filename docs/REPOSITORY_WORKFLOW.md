# GANYIQ Repository Workflow

**Last Updated:** 2026-07-17  
**Canonical Location:** `/root/GANYIQ/`

---

## Repository Structure

```
/root/GANYIQ/                    # Single source of truth
├── app/                         # Next.js web application
├── lib/                         # Shared web libraries
├── db/                          # Database schema & migrations
├── public/                      # Web assets (clips, thumbnails)
├── worker/                      # ALL worker source code
│   ├── index.ts                 # Worker TypeScript entrypoint
│   ├── run.py                   # Worker Python entrypoint
│   ├── diarize.py               # Diarization module
│   ├── speaker-hybrid/          # Speaker identification pipeline
│   │   ├── pipeline.py          # Main rendering orchestrator
│   │   ├── director.py          # AI decision engine
│   │   ├── camera_planner.py    # Trajectory smoothing
│   │   ├── models/              # ML model files
│   │   └── ...
│   ├── package.json             # Worker TS dependencies
│   └── requirements.txt         # Worker Python dependencies
├── scripts/                     # Utility scripts
├── docs/                        # Documentation
│   └── archive/                 # Historical docs & audit reports
├── package.json                 # Web app dependencies
├── tsconfig.json                # Web app TypeScript config
├── ecosystem.config.cjs         # PM2 process manager config
└── deploy.sh                    # VPS deployment script
```

---

## Branch Strategy

### `main`
- **Purpose:** Production web application + full monorepo
- **Deployment:** VPS via `deploy.sh`
- **Protection:** Do not merge worker changes without review

### `worker-v2`
- **Purpose:** Worker development branch
- **Scope:** Modifications ONLY inside `worker/` folder
- **Usage:** All worker feature work happens here

### Hermes Development Rule
When working on worker code:
```bash
git checkout worker-v2
git add worker/
git commit -m "feat(worker): description"
git push origin worker-v2
```

**Pre-commit check:**
```bash
git diff --cached --name-only
# Verify ALL paths start with "worker/"
```

---

## VPS Workflow

### Location
- **Canonical repo:** `/root/GANYIQ/`
- **Production deployment:** `/var/www/ganyiq/` (PM2 cwd)
- **No other active worktrees or clones**

### PM2 Processes
```bash
pm2 list
# ganyiq: cwd=/root/GANYIQ, runs web app (npm run build && npm start)
```

### Daily Development
```bash
cd /root/GANYIQ
git checkout worker-v2
# Make changes inside worker/ only
git add worker/
git commit -m "fix: ..."
git push origin worker-v2
```

### Deploy to Production
```bash
cd /root/GANYIQ
bash deploy.sh                 # Full: rsync → npm ci → build → restart
bash deploy.sh --quick         # Restart only (no rebuild)
bash deploy.sh --rollback SHA  # Rollback + full build
```

Post-deploy verification:
```bash
curl https://ganyiq.ganys.me/api/health
```

---

## Windows Worker (PC-GANY)

### Sparse Checkout Setup (One-time)
```powershell
# Clone with sparse checkout
git clone --no-checkout https://github.com/ghaniyys-dotcom/ganyiq.git C:\ganyiq-worker
cd C:\ganyiq-worker
git checkout worker-v2
git sparse-checkout init --cone
git sparse-checkout set worker

# Verify only worker/ is visible
dir
# Should show only: .git, worker/
```

### Daily Update
```powershell
cd C:\ganyiq-worker
git pull origin worker-v2
# Only worker/ files update, app/lib/db stay invisible
```

### Running Worker
```powershell
cd C:\ganyiq-worker\worker
npx tsx index.ts
```

---

## Verification Commands

### Python Compilation
```bash
cd /root/GANYIQ/worker
python3 -m py_compile run.py diarize.py
python3 -m compileall speaker-hybrid/
```

### TypeScript Check
```bash
cd /root/GANYIQ/worker
npx tsc --noEmit
```

### Worker Import Test
```bash
cd /root/GANYIQ/worker
python3 -c "from speaker_hybrid import pipeline; print('OK')"
```

### Search for Stale References
```bash
cd /root/GANYIQ
grep -r "ganyiq-worker" . --exclude-dir=.git --exclude-dir=node_modules
grep -r "speaker-hybrid" . --exclude-dir=.git --exclude-dir=node_modules | grep -v worker/
```

---

## Rollback Procedure

### Safety Tags
Before risky changes:
```bash
cd /root/GANYIQ
git tag -a stable-pre-FEATURE -m "Safety checkpoint before FEATURE"
```

### Emergency Rollback
```bash
cd /root/GANYIQ
git log --oneline -10  # Find good commit SHA
git checkout GOOD_SHA
bash deploy.sh --rollback GOOD_SHA
```

### Restore from Backup
```bash
ls -lh /tmp/ganyiq-backup-*.tar.gz
tar -xzf /tmp/ganyiq-backup-YYYYMMDD-HHMM.tar.gz -C /tmp/restore/
# Review, then selectively restore needed files
```

---

## GitHub Workflow

### Push Worker Changes
```bash
cd /root/GANYIQ
git checkout worker-v2
git status  # Verify only worker/ paths staged
git push origin worker-v2
```

### Merge Worker to Main (Careful!)
```bash
# Only after worker testing complete AND web app compatibility verified
git checkout main
git merge worker-v2 --no-ff
git push origin main
```

### Never Force Push
```bash
# WRONG: git push --force origin worker-v2
# RIGHT: Create new branch if needed, preserve history
```

---

## Common Issues

### Import Errors on Windows
**Problem:** `ModuleNotFoundError: No module named 'speaker_hybrid'`  
**Fix:** Use `run.py` entrypoint, NOT direct `python pipeline.py`
```powershell
cd C:\ganyiq-worker\worker
npx tsx index.ts  # Correct: uses run.py wrapper
```

### Stale Worktree References
**Problem:** `fatal: 'ganyiq-worker-new' is not a working tree`  
**Fix:**
```bash
git worktree list
git worktree remove /path/to/stale
git worktree prune
```

### Model Files Missing
**Problem:** `FileNotFoundError: yolov8n-face.onnx`  
**Fix:** Models auto-download on first run. Ensure internet access.
```bash
cd /root/GANYIQ/worker/speaker-hybrid
ls -lh yolov8n-face.onnx models/face_landmarker.task
```

### PM2 Process Stale
**Problem:** Worker shows as "online" but not processing  
**Fix:**
```bash
pm2 restart ganyiq
pm2 logs ganyiq --lines 50
```

---

## Best Practices

1. **One Repository:** `/root/GANYIQ/` is the only active VPS repository
2. **Worker Isolation:** Modify only `worker/` when on `worker-v2` branch
3. **Small Commits:** Commit logical units, not massive refactors
4. **Test Before Push:** Verify Python/TS compilation before pushing
5. **Safety Tags:** Tag before destructive operations
6. **Never Edit Production:** Use `deploy.sh`, not manual `/var/www/ganyiq/` edits
7. **Documentation:** Update this file when workflow changes

---

## Hermes Agent Rules

When working on GANYIQ:

- ✅ **DO:** Modify files inside `worker/` for worker features
- ✅ **DO:** Use `git add worker/` to stage worker changes
- ✅ **DO:** Verify compilation before committing
- ✅ **DO:** Create safety tags before risky operations

- ❌ **DON'T:** Create new worktrees without explicit approval
- ❌ **DON'T:** Modify `app/` or `lib/` when on `worker-v2` branch
- ❌ **DON'T:** Force-push without backup
- ❌ **DON'T:** Merge `worker-v2` → `main` without testing

---

## Support

**VPS Repo:** `/root/GANYIQ/`  
**GitHub:** `https://github.com/ghaniyys-dotcom/ganyiq.git`  
**Owner:** Gany (@ghaniyys-dotcom)

For architecture details, see:
- `ARCHITECTURE.md` — System overview
- `AGENTS.md` — AI agent context
- `worker/README.md` — Worker-specific documentation
