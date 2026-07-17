# GANYIQ — GIT ARCHITECTURE AUDIT & EXECUTION PLAN

**Audit Date:** 2026-07-06  
**Auditor Role:** Senior Git Architect, DevOps Engineer, Repository Architect  
**Repository:** https://github.com/ghaniyys-dotcom/ganyiq.git  
**Canonical Path:** `/root/GANYIQ`

---

## EXECUTIVE SUMMARY

Target arsitektur **MEMUNGKINKAN** dan **DIREKOMENDASIKAN**.

**Key Findings:**
- ✅ Single monorepo dengan worker subfolder adalah arsitektur yang SOLID
- ✅ Git Sparse Checkout adalah solusi OPTIMAL untuk Windows workflow
- ✅ Branch `worker-v2` sudah identik dengan `main` dan siap jadi Worker Source of Truth
- ⚠️ Terdapat **DUPLICATE** source code di root dan `worker/` folder
- ⚠️ PM2 config masih mengarah ke `/root/GANYIQ-worker` (path lama)
- ✅ Tidak ada blocking issue untuk implementasi

**Recommendation:** Proceed dengan Git Sparse Checkout strategy + consolidate duplicates.

---

## 1. CURRENT ARCHITECTURE

### 1.1 Repository State

```
Repository: GANYIQ (monorepo)
Location:   /root/GANYIQ
Remote:     https://github.com/ghaniyys-dotcom/ganyiq.git

Branches:
  main              → origin/main (up-to-date)
  worker            → origin/worker (ahead 1, behind 14) — STALE, merged to main
  worker-candidate  → origin/worker-candidate
* worker-v2         → origin/worker-v2 (up-to-date, IDENTIK dengan main)
```

**Critical Discovery:**
- Branch `worker-v2` dan `main` sudah **IDENTIK** (commit `80a94873`)
- Branch `worker` sudah **MERGED** ke `main` pada commit `aa5b2d9e`
- `/root/GANYIQ-worker/` masih ada sebagai **ORPHAN** directory (bukan git worktree lagi)

### 1.2 Directory Structure (Actual)

```
/root/GANYIQ/
├── app/                          # Next.js web app
├── lib/                          # Shared libraries
├── db/                           # Database migrations
├── public/                       # Static assets
├── docs/                         # Documentation
├── scripts/                      # Utility scripts
├── proof/                        # Testing/proof-of-concept
├── legacy/                       # Archive
├── worker/                       # 🔴 Worker source code (subfolder)
│   ├── index.ts
│   ├── clip-renderer.ts
│   ├── python-clip-renderer.ts
│   ├── tracker.py
│   ├── diarize.py
│   ├── run.py
│   ├── package.json             # Isolated TS project
│   ├── tsconfig.json
│   ├── requirements.txt
│   └── speaker-hybrid/          # Python pipeline subfolder
│       ├── pipeline.py
│       ├── director.py
│       ├── hybrid_face_detector.py
│       └── ...
├── speaker-hybrid/               # 🔴 DUPLICATE di root level
│   ├── pipeline.py
│   ├── director.py
│   └── ...
├── index.ts                      # 🔴 DUPLICATE worker index.ts di root
├── clip-renderer.ts              # 🔴 DUPLICATE worker clip-renderer.ts di root
├── tracker.py                    # 🔴 DUPLICATE worker tracker.py di root
├── diarize.py                    # 🔴 DUPLICATE worker diarize.py di root
├── run.py                        # 🔴 DUPLICATE worker run.py di root
├── package.json                  # Root package.json (Next.js)
└── ecosystem.config.cjs          # PM2 config for Next.js
```

**Observation:**
- Worker code ada **DUA KALI** — di `worker/` dan di root level
- `speaker-hybrid/` ada **DUA KALI** — di `worker/speaker-hybrid/` dan di root `speaker-hybrid/`

### 1.3 Orphan Directory `/root/GANYIQ-worker`

```
/root/GANYIQ-worker/
├── .git                          # Isinya: "gitdir: /root/GANYIQ/.git/worktrees/GANYIQ-worker"
├── index.ts
├── clip-renderer.ts
├── ...
└── (seluruh worker source code)
```

**Status:** 
- Dulunya git worktree dari branch `worker`
- Sekarang branch `worker` sudah merged ke `main`
- Directory ini jadi **ORPHAN** (tidak sinkron dengan main repo)
- PM2 config (`pm2.config.cjs`) masih mengarah ke sini

---

## 2. TARGET ARCHITECTURE

### 2.1 Desired Structure

```
/root/GANYIQ/                     # Single source of truth
├── app/
├── lib/
├── db/
├── public/
├── docs/
├── scripts/
├── worker/                       # 🎯 ONLY worker source of truth
│   ├── index.ts
│   ├── clip-renderer.ts
│   ├── python-clip-renderer.ts
│   ├── tracker.py
│   ├── diarize.py
│   ├── run.py
│   ├── package.json
│   ├── requirements.txt
│   └── speaker-hybrid/
│       ├── pipeline.py
│       ├── director.py
│       └── ...
├── package.json
└── ecosystem.config.cjs

# ROOT-LEVEL DUPLICATES REMOVED:
# ❌ index.ts (root)
# ❌ clip-renderer.ts (root)
# ❌ tracker.py (root)
# ❌ diarize.py (root)
# ❌ run.py (root)
# ❌ speaker-hybrid/ (root)
```

### 2.2 GitHub Branches

```
main          → Web production (Next.js app)
worker-v2     → Worker source of truth (only worker/ folder matters)
```

**Development Flow:**
- Hermes bekerja di VPS `/root/GANYIQ/worker/` pada branch `worker-v2`
- Commit & push ke `origin/worker-v2`
- Windows pull dari `worker-v2` dengan **Git Sparse Checkout** (hanya `worker/`)

### 2.3 Windows Sparse Checkout

```
C:\ganyiq-worker\
└── worker\
    ├── index.ts
    ├── clip-renderer.ts
    ├── tracker.py
    ├── diarize.py
    ├── run.py
    └── speaker-hybrid\
        └── ...

# Yang TIDAK muncul di Windows:
# ❌ app/
# ❌ lib/
# ❌ db/
# ❌ public/
# ❌ docs/
```

---

## 3. GIT WORKFLOW RECOMMENDATION

### 3.1 Solution Comparison Matrix

| Solution | Pros | Cons | Fit Score |
|----------|------|------|-----------|
| **Git Sparse Checkout** ✅ | ✅ Clone partial tree<br>✅ Windows hanya lihat `worker/`<br>✅ Native Git (no external tools)<br>✅ `git pull` otomatis update<br>✅ Simple untuk end user | ⚠️ Butuh initial setup<br>⚠️ Sedikit advanced | **10/10** |
| Partial Clone | ✅ Hemat bandwidth | ❌ Masih clone SEMUA folder structure<br>❌ Tidak cocok untuk use case ini | 3/10 |
| Git Worktree | ✅ Multiple working dirs | ❌ Butuh full repo di setiap worktree<br>❌ Tidak solve "Windows hanya worker" | 2/10 |
| Git Submodule | ✅ Separate repo | ❌ Harus bikin repo baru<br>❌ Complex management<br>❌ Melawan requirement "SATU repo" | 0/10 |
| Git Subtree | ✅ Inline history | ❌ Complex merge<br>❌ Bikin repo baru<br>❌ Melawan requirement | 1/10 |
| Branch khusus | ✅ Simple | ❌ Windows tetap clone semua folder<br>❌ Tidak solve "Windows hanya worker" | 4/10 |

### 3.2 Final Recommendation: **Git Sparse Checkout**

**Why:**
1. ✅ Memenuhi requirement "Windows HANYA lihat `worker/`"
2. ✅ Native Git feature (Git 2.25+)
3. ✅ `git pull` langsung update `worker/` folder saja
4. ✅ Folder lain (`app/`, `lib/`, dll) **TIDAK** muncul di Windows filesystem
5. ✅ Tetap satu repository GitHub
6. ✅ Sederhana untuk user: setup sekali, git pull selamanya

**Technical Principle:**
```
Sparse Checkout = "Checkout hanya sebagian working tree"
```

Git akan:
- Clone metadata lengkap (`.git/` folder)
- Populate working directory **HANYA** dengan folder yang diminta (`worker/`)
- `git pull` update **HANYA** `worker/` folder

---

## 4. REPOSITORY AUDIT

### 4.1 Branch Status

#### Branch `main`
- ✅ Up-to-date dengan `origin/main`
- ✅ Contains full monorepo (web + worker)
- ✅ Latest commit: `80a94873` (speaker-fusion Phase A+B)

#### Branch `worker-v2`
- ✅ Up-to-date dengan `origin/worker-v2`
- ✅ **IDENTIK** dengan `main` (same commit `80a94873`)
- ✅ Sudah layak jadi Worker Source of Truth
- ⚠️ Belum ada divergence dari `main`

**Verdict:** Branch `worker-v2` **READY** untuk jadi dedicated worker branch.

#### Branch `worker` (stale)
- ⚠️ Ahead 1, behind 14 commits dari origin
- ⚠️ Sudah merged ke `main` via commit `aa5b2d9e`
- ⚠️ Tidak perlu dipakai lagi

**Recommendation:** Biarkan `worker` branch apa adanya (sudah merged), gunakan `worker-v2` going forward.

### 4.2 Filesystem Audit

```bash
git ls-files | grep -E "(index\.ts|clip-renderer\.ts|tracker\.py|diarize\.py|run\.py)"
```

**Results:**
```
clip-renderer.ts                   # 🔴 ROOT (duplicate)
diarize.py                         # 🔴 ROOT (duplicate)
index.ts                           # 🔴 ROOT (duplicate)
run.py                             # 🔴 ROOT (duplicate)
tracker.py                         # 🔴 ROOT (duplicate)
worker/clip-renderer.ts            # ✅ WORKER (correct)
worker/diarize.py                  # ✅ WORKER (correct)
worker/index.ts                    # ✅ WORKER (correct)
worker/python-clip-renderer.ts     # ✅ WORKER (correct)
worker/run.py                      # ✅ WORKER (correct)
worker/tracker.py                  # ✅ WORKER (correct)
```

**Analysis:**
- Worker files tracked **DUA KALI** dalam Git
- Root-level duplicates harus dihapus via `git rm`

### 4.3 `.gitignore` Check

```bash
cat .gitignore
```

```
node_modules/
.next/
.env.local
*.pyc
__pycache__/
cache/
clips/
models/*.onnx
models/*.pth
setup.sh
setup.ps1
ganyiq.db
```

**Observation:**
- ✅ Standard ignores sudah ada
- ⚠️ Tidak ada ignore untuk root-level worker files (karena sekarang tracked)

---

## 5. DUPLICATE AUDIT

### 5.1 Critical Duplicates

| File/Folder | Location 1 | Location 2 | Action |
|-------------|------------|------------|--------|
| `index.ts` | `/root/GANYIQ/index.ts` | `/root/GANYIQ/worker/index.ts` | ❌ Remove root |
| `clip-renderer.ts` | `/root/GANYIQ/clip-renderer.ts` | `/root/GANYIQ/worker/clip-renderer.ts` | ❌ Remove root |
| `tracker.py` | `/root/GANYIQ/tracker.py` | `/root/GANYIQ/worker/tracker.py` | ❌ Remove root |
| `diarize.py` | `/root/GANYIQ/diarize.py` | `/root/GANYIQ/worker/diarize.py` | ❌ Remove root |
| `run.py` | `/root/GANYIQ/run.py` | `/root/GANYIQ/worker/run.py` | ❌ Remove root |
| `speaker-hybrid/` | `/root/GANYIQ/speaker-hybrid/` | `/root/GANYIQ/worker/speaker-hybrid/` | ❌ Remove root |

### 5.2 Duplicate Detection

```bash
diff -r worker/ speaker-hybrid/ --brief
```

**Results:**
- `worker/speaker-hybrid/` has DIFFERENT structure than root `speaker-hybrid/`
- Root `speaker-hybrid/` memiliki file tambahan:
  - `config.py`
  - `core/` subfolder (id_bridge.py, render_utils.py, logger.py, speaker_tracker.py)
  - `profiler/`, `utils/`

**Analysis:**
Root-level `speaker-hybrid/` adalah **DEVELOPMENT VERSION** yang lebih baru.
`worker/speaker-hybrid/` adalah version lama.

**Decision:**
- ❌ Remove root `speaker-hybrid/`
- ✅ Keep `worker/speaker-hybrid/`
- 🔧 Merge changes dari root `speaker-hybrid/` ke `worker/speaker-hybrid/` jika ada improvement

---

## 6. PATH AUDIT

### 6.1 Hardcoded Paths

```bash
grep -r "/root/GANYIQ" . --include="*.ts" --include="*.js" --include="*.cjs" --include="*.py" | grep -v node_modules
```

**Critical Findings:**

#### 1. PM2 Config — `/root/GANYIQ-worker` (STALE PATH)

**File:** `pm2.config.cjs`
```javascript
cwd: '/root/GANYIQ-worker',  // ❌ STALE — should be '/root/GANYIQ/worker'
```

**Impact:** PM2 worker akan fail start karena path sudah tidak relevan.

**Fix Required:** Change to `/root/GANYIQ/worker`

#### 2. Ecosystem Config — Correct

**File:** `ecosystem.config.cjs`
```javascript
cwd: '/root/GANYIQ',  // ✅ CORRECT (Next.js app)
```

#### 3. Python Scripts — Absolute Paths

Multiple scripts contain hardcoded `/root/GANYIQ/`:
- `lib/visual-quality-scorer.ts` → `/root/GANYIQ/worker/visual-quality-scorer.py`
- `lib/deepgram.ts` → `/root/GANYIQ/cookies.txt`
- `scripts/*.ts` → `/root/GANYIQ/.env.local`

**Analysis:**
These are **ACCEPTABLE** because:
- Run on VPS only
- Path is canonical and stable
- Not used on Windows worker

### 6.2 Import Path Analysis

**Cross-folder imports:**

```typescript
// lib/timeline-serializer.ts
import type { DecisionSegment, DecisionMode } from '../worker/decision-engine';
```

**Status:** ✅ VALID — relative import works fine in monorepo

**Proof imports:**

```typescript
// proof/preview-templates.ts
import { renderSubtitles } from '../worker/subtitle-renderer';
```

**Status:** ✅ VALID — proof/ adalah testing folder di VPS

### 6.3 PM2 Ecosystem

#### Current PM2 Setup

**Next.js App** (`ecosystem.config.cjs`):
```javascript
{
  name: 'ganyiq',
  script: 'npm',
  args: ['start', '--', '-p', '3003'],
  cwd: '/root/GANYIQ',  // ✅ CORRECT
}
```

**Worker** (`pm2.config.cjs`):
```javascript
{
  name: 'ganyiq-worker',
  script: 'npx',
  args: 'tsx index.ts',
  cwd: '/root/GANYIQ-worker',  // ❌ STALE
}
```

**Recommendation:** Update `pm2.config.cjs` untuk point ke `/root/GANYIQ/worker`.

---

## 7. WORKER-V2 AUDIT

### 7.1 Branch Readiness

```bash
git log --oneline worker-v2 ^main
# Output: (kosong)
```

**Analysis:**
- `worker-v2` dan `main` adalah **IDENTIK**
- Tidak ada divergence
- Tidak ada unique commits di `worker-v2`

**Conclusion:** ✅ Branch `worker-v2` siap digunakan sebagai Worker Source of Truth.

### 7.2 Recommended Workflow

Going forward, branch `worker-v2` akan:
1. Diverge dari `main` (karena development hanya di `worker/`)
2. Hermes commit ke `worker-v2`
3. Windows pull dari `worker-v2`
4. Merge ke `main` dilakukan manual (jika perlu sync web + worker)

### 7.3 Future Branch Strategy

**Option A: Keep `worker-v2` independent**
- Pro: Clean separation
- Con: Manual merge ke `main` jika perlu

**Option B: Periodic sync with `main`**
- Pro: Avoid massive divergence
- Con: Risk of merge conflicts jika web code berubah banyak

**Recommendation:** **Option A** — let `worker-v2` diverge, merge only when necessary.

---

## 8. GIT SPARSE CHECKOUT WORKFLOW

### 8.1 Technical Explanation

**Q: Apakah `git pull` hanya update folder `worker/` di Windows?**

**A: YA, secara teknis:**

1. Git Sparse Checkout bekerja di **working directory level**, bukan di Git object level
2. Saat `git pull`:
   - Git fetch semua objects dari remote
   - Git merge/update commit pointer
   - Git checkout **HANYA** files yang ada di sparse-checkout pattern
3. Folder lain (`app/`, `lib/`, dll) **TIDAK** di-checkout ke filesystem Windows

**Analogy:**
```
Git object database   = Full repo (all files)
Working directory     = Only worker/ (sparse checkout)
```

**Verification:**
```bash
ls C:\ganyiq-worker\
# Output:
# worker\

# app\, lib\, db\ TIDAK ADA di filesystem
```

### 8.2 Windows Setup Workflow

**Initial Setup (Once):**

```powershell
# 1. Clone with no-checkout
git clone --no-checkout https://github.com/ghaniyys-dotcom/ganyiq.git C:\ganyiq-worker
cd C:\ganyiq-worker

# 2. Switch to worker-v2 branch
git checkout worker-v2

# 3. Enable sparse-checkout
git sparse-checkout init --cone

# 4. Set sparse pattern (ONLY worker folder)
git sparse-checkout set worker

# 5. Verify
ls
# Output: worker\
```

**Daily Workflow:**

```powershell
cd C:\ganyiq-worker
git pull

# Git akan:
# 1. Fetch changes dari origin/worker-v2
# 2. Merge ke local worker-v2
# 3. Update HANYA worker\ folder di filesystem
# 4. Folder lain TIDAK muncul
```

**Testing Workflow:**

```powershell
cd C:\ganyiq-worker\worker
npm install
npx tsx index.ts
```

---

## 9. ASCII DIAGRAM

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         GANYIQ GIT ARCHITECTURE                         │
└─────────────────────────────────────────────────────────────────────────┘

┌──────────────┐
│   HERMES     │  VPS Developer (AI Agent)
│ (VPS Agent)  │
└──────┬───────┘
       │
       │ 1. Edit files
       ▼
┌─────────────────────────────────────────────────────┐
│  /root/GANYIQ/worker/                               │
│  ├── index.ts                                       │
│  ├── clip-renderer.ts                               │
│  ├── tracker.py                                     │
│  └── speaker-hybrid/                                │
│      └── pipeline.py                                │
│                                                     │
│  Branch: worker-v2                                  │
└──────┬──────────────────────────────────────────────┘
       │
       │ 2. git add worker/
       │ 3. git commit -m "feat: xyz"
       │ 4. git push origin worker-v2
       ▼
┌─────────────────────────────────────────────────────┐
│          GitHub: ghaniyys-dotcom/ganyiq             │
│                                                     │
│  Branch: worker-v2 (updated)                        │
│  Commit: abc1234                                    │
└──────┬──────────────────────────────────────────────┘
       │
       │ 5. git pull (from Windows)
       ▼
┌─────────────────────────────────────────────────────┐
│  C:\ganyiq-worker\                                  │
│  └── worker\         ← SPARSE CHECKOUT (ONLY THIS) │
│      ├── index.ts                                   │
│      ├── clip-renderer.ts                           │
│      ├── tracker.py                                 │
│      └── speaker-hybrid\                            │
│          └── pipeline.py                            │
│                                                     │
│  Branch: worker-v2 (local)                          │
│                                                     │
│  ❌ app\          ← NOT CHECKED OUT                 │
│  ❌ lib\          ← NOT CHECKED OUT                 │
│  ❌ db\           ← NOT CHECKED OUT                 │
└──────┬──────────────────────────────────────────────┘
       │
       │ 6. Testing
       ▼
┌─────────────────────────────────────────────────────┐
│  GANY (Windows User)                                │
│  1. cd C:\ganyiq-worker\worker                      │
│  2. npm install                                     │
│  3. npx tsx index.ts                                │
│  4. Test clip rendering                             │
└─────────────────────────────────────────────────────┘
       │
       │ Testing selesai
       │
       │ 7. Hermes edit lagi
       └─────────┐
                 │ LOOP
                 ▼
           ┌──────────┐
           │  HERMES  │
           └──────────┘

═══════════════════════════════════════════════════════
PULL BERIKUTNYA (Continuous Development)
═══════════════════════════════════════════════════════

Hermes (VPS):
  worker/index.ts → changed

  git add worker/index.ts
  git commit -m "fix: memory leak"
  git push origin worker-v2

GitHub:
  origin/worker-v2 → commit def5678

Windows:
  cd C:\ganyiq-worker
  git pull

  Git melakukan:
  1. Fetch commit def5678
  2. Merge ke local worker-v2
  3. Update C:\ganyiq-worker\worker\index.ts ✅
  4. Folder lain TIDAK tersentuh ✅

Gany:
  npm start → test changes ✅
```

---


## 10. DETAILED EXECUTION PLAN

### OVERVIEW

Execution plan dibagi menjadi **7 PHASES** dengan verification stops di setiap milestone.

**Estimated Total Time:** 30-45 minutes  
**Risk Level:** LOW (all operations reversible)  
**Rollback Complexity:** LOW (Git branches preserve all states)

---

### PHASE 0: PRE-FLIGHT BACKUP

**Tujuan:** Full backup sebelum perubahan apapun

**Steps:**

```bash
# 1. Backup repository state
cd /root
tar -czf GANYIQ-pre-consolidation-backup-$(date +%Y%m%d-%H%M%S).tar.gz GANYIQ/

# 2. Verify backup
ls -lh GANYIQ-pre-consolidation-backup-*.tar.gz

# 3. Create safety branch
cd /root/GANYIQ
git branch safety-backup-$(date +%Y%m%d-%H%M%S)
git push origin safety-backup-$(date +%Y%m%d-%H%M%S)
```

**Verification:**
- ✅ Backup file exists and > 100MB
- ✅ Safety branch exists di local dan remote

**Rollback:**
```bash
# Extract backup
cd /root
tar -xzf GANYIQ-pre-consolidation-backup-*.tar.gz -C /tmp/
# Manual inspection
```

**Risk:** ZERO — read-only operation

---

### PHASE 1: REPOSITORY CLEANUP

**Tujuan:** Remove duplicate files dari root level, keep only `worker/` versions

**Risk:** LOW — files tracked in Git, reversible via `git reset`

#### Step 1.1: Create Cleanup Branch

```bash
cd /root/GANYIQ
git checkout worker-v2
git pull origin worker-v2
git checkout -b cleanup/consolidate-worker
```

**Verification:**
```bash
git branch --show-current
# Expected: cleanup/consolidate-worker
```

#### Step 1.2: Remove Root-Level Duplicates

```bash
# Remove duplicate TypeScript files
git rm index.ts
git rm clip-renderer.ts
git rm decision-engine.ts
git rm emphasis-engine.ts
git rm face-tracker.ts
git rm memory-profiler.ts
git rm participant-registry.ts
git rm subtitle-renderer.ts
git rm subtitle-templates.ts
git rm tracker.ts
git rm speaker-detector.ts
git rm features.ts

# Remove duplicate Python files
git rm tracker.py
git rm diarize.py
git rm run.py
git rm debug_asd.py
git rm face-detect.py
git rm face-detect-v2.py
git rm reaction-detector.py
git rm transcribe.py
git rm visual-reaction-detector.py

# Remove duplicate speaker-hybrid folder
git rm -r speaker-hybrid/

# Remove worker setup files from root
git rm setup.sh setup.ps1 monit.ps1
git rm requirements.txt
git rm env-template.txt
```

**Verification:**
```bash
git status
# Should show: deleted: [all files above]

# Verify worker/ folder still intact
ls worker/
# Should show: index.ts, clip-renderer.ts, tracker.py, etc.
```

**Rollback:**
```bash
git reset --hard HEAD
# Restores all deleted files
```

#### Step 1.3: Commit Cleanup

```bash
git commit -m "chore: consolidate worker — remove root-level duplicates

All worker source code now lives exclusively in worker/ folder.

Removed from root:
- TypeScript worker files (index.ts, clip-renderer.ts, etc.)
- Python worker files (tracker.py, diarize.py, etc.)
- speaker-hybrid/ folder (now only in worker/speaker-hybrid/)
- Worker setup scripts (setup.sh, setup.ps1, monit.ps1)

This consolidation enables:
- Single source of truth for worker code
- Git sparse checkout on Windows (worker/ only)
- Cleaner repository structure"
```

**Verification:**
```bash
git log --oneline -1
# Should show: "chore: consolidate worker..."

git diff HEAD~1 --stat
# Should show deleted files, no additions
```

**Risk:** LOW — commit belum di-push, rollback via `git reset HEAD~1`

---

### PHASE 2: UPDATE PM2 CONFIG

**Tujuan:** Fix PM2 worker config untuk point ke `/root/GANYIQ/worker`

**Risk:** VERY LOW — config file change, easily reversible

#### Step 2.1: Update pm2.config.cjs

```bash
cd /root/GANYIQ

# Backup original
cp pm2.config.cjs pm2.config.cjs.backup

# Update cwd path
cat > pm2.config.cjs << 'PMEOF'
module.exports = {
  apps: [{
    name: 'ganyiq-worker',
    script: 'npx',
    args: 'tsx index.ts',
    cwd: '/root/GANYIQ/worker',
    env: {
      NODE_ENV: 'production',
    },
    error_file: '/root/.pm2/logs/ganyiq-worker-error.log',
    out_file: '/root/.pm2/logs/ganyiq-worker-out.log',
    max_restarts: 10,
    restart_delay: 5000,
    watch: false,
    exp_backoff_restart_delay: 10000,
  }]
};
PMEOF
```

**Verification:**
```bash
cat pm2.config.cjs | grep cwd
# Expected: cwd: '/root/GANYIQ/worker',

# Test PM2 config syntax
pm2 start pm2.config.cjs --dry-run
```

**Rollback:**
```bash
cp pm2.config.cjs.backup pm2.config.cjs
```

#### Step 2.2: Commit PM2 Config Update

```bash
git add pm2.config.cjs
git commit -m "fix: update PM2 worker config to point to /root/GANYIQ/worker

Changed cwd from stale /root/GANYIQ-worker to canonical /root/GANYIQ/worker.

This aligns with repository consolidation where worker/ is now
the single source of truth inside the main monorepo."
```

**Verification:**
```bash
git show --stat
# Should show: pm2.config.cjs | 2 +-
```

---

### PHASE 3: PUSH CLEANUP BRANCH

**Tujuan:** Push cleanup changes ke GitHub untuk review

**Risk:** VERY LOW — new branch, tidak affect main/worker-v2

#### Step 3.1: Push to GitHub

```bash
git push origin cleanup/consolidate-worker
```

**Verification:**
```bash
git branch -vv | grep cleanup
# Should show: cleanup/consolidate-worker -> origin/cleanup/consolidate-worker
```

**Rollback:**
```bash
# Delete remote branch
git push origin --delete cleanup/consolidate-worker

# Delete local branch
git checkout worker-v2
git branch -D cleanup/consolidate-worker
```

---

### PHASE 4: MERGE TO WORKER-V2

**Tujuan:** Merge cleanup branch ke worker-v2 (Worker Source of Truth)

**Risk:** LOW — merge dilakukan setelah review, reversible

#### Step 4.1: Review Changes

```bash
# Review diff
git diff worker-v2..cleanup/consolidate-worker --stat

# Verify only deletions + PM2 config change
git log worker-v2..cleanup/consolidate-worker --oneline
```

**Expected Output:**
```
chore: consolidate worker — remove root-level duplicates
fix: update PM2 worker config to point to /root/GANYIQ/worker
```

#### Step 4.2: Merge to worker-v2

```bash
git checkout worker-v2
git pull origin worker-v2
git merge cleanup/consolidate-worker --no-ff -m "Merge cleanup/consolidate-worker into worker-v2

Consolidates worker source code exclusively into worker/ folder.
Removes root-level duplicates and updates PM2 config."
```

**Verification:**
```bash
git log --oneline -3
# Should show merge commit + 2 cleanup commits

ls worker/
# Verify worker files intact

ls index.ts 2>/dev/null || echo "REMOVED (correct)"
# Should output: REMOVED (correct)
```

**Rollback:**
```bash
git reset --hard HEAD~1
# Undoes merge commit
```

---

### PHASE 5: PUSH WORKER-V2

**Tujuan:** Push consolidated worker-v2 branch ke GitHub

**Risk:** MEDIUM — affects remote branch, but safe (worker-v2 is isolated)

#### Step 5.1: Push to Remote

```bash
git push origin worker-v2
```

**Verification:**
```bash
# Check GitHub via gh CLI (if available)
gh browse --branch worker-v2

# Or verify via git log
git log origin/worker-v2 --oneline -3
```

**Rollback:**
```bash
# Force push previous state (use safety branch)
git reset --hard origin/worker-v2~3
git push origin worker-v2 --force-with-lease
```

---

### PHASE 6: WINDOWS SPARSE CHECKOUT SETUP

**Tujuan:** Setup Git Sparse Checkout di Windows PC

**Risk:** ZERO — Windows-only setup, tidak affect VPS

#### Step 6.1: Windows Initial Clone

**Run di Windows PowerShell:**

```powershell
# Remove old directory if exists
Remove-Item -Recurse -Force C:\ganyiq-worker -ErrorAction SilentlyContinue

# Clone with no-checkout (metadata only)
git clone --no-checkout https://github.com/ghaniyys-dotcom/ganyiq.git C:\ganyiq-worker

# Navigate to repo
cd C:\ganyiq-worker

# Checkout worker-v2 branch
git checkout worker-v2
```

**Verification:**
```powershell
git branch --show-current
# Expected: worker-v2

ls
# Expected: (empty or minimal files)
```

#### Step 6.2: Enable Sparse Checkout

```powershell
# Enable sparse-checkout (cone mode)
git sparse-checkout init --cone

# Set pattern: ONLY worker/ folder
git sparse-checkout set worker

# Verify
git sparse-checkout list
# Expected: worker
```

**Verification:**
```powershell
ls
# Expected: worker\

ls worker\
# Expected: index.ts, clip-renderer.ts, tracker.py, etc.

# Verify other folders NOT present
ls app\ 2>&1
# Expected: error (directory not found)

ls lib\ 2>&1
# Expected: error (directory not found)
```

#### Step 6.3: Install Dependencies

```powershell
cd worker

# Install Node dependencies
npm install

# Install Python dependencies
pip install -r requirements.txt

# Verify
npx tsx --version
python --version
```

**Verification:**
```powershell
# Test worker can run
npx tsx index.ts --version
# Should not error (even if exits immediately)
```

---

### PHASE 7: END-TO-END WORKFLOW TEST

**Tujuan:** Verify full development workflow (VPS → GitHub → Windows)

**Risk:** ZERO — testing only, no destructive changes

#### Step 7.1: VPS — Edit Worker File

**Run di VPS:**

```bash
cd /root/GANYIQ
git checkout worker-v2

# Make test change
echo "// Test change $(date)" >> worker/index.ts

# Commit & push
git add worker/index.ts
git commit -m "test: verify VPS→GitHub→Windows workflow"
git push origin worker-v2
```

**Verification:**
```bash
git log --oneline -1
# Should show: "test: verify VPS→GitHub→Windows workflow"
```

#### Step 7.2: Windows — Pull Changes

**Run di Windows:**

```powershell
cd C:\ganyiq-worker

# Pull changes
git pull

# Verify change propagated
Get-Content worker\index.ts | Select-Object -Last 1
# Should show: // Test change [timestamp]
```

**Verification:**
```powershell
git log --oneline -1
# Should match VPS commit
```

#### Step 7.3: VPS — Revert Test Change

**Run di VPS:**

```bash
cd /root/GANYIQ
git revert HEAD --no-edit
git push origin worker-v2
```

**Verification:**
```bash
git log --oneline -2
# Should show: Revert + original test commit
```

#### Step 7.4: Windows — Pull Revert

```powershell
cd C:\ganyiq-worker
git pull

# Verify test line removed
Get-Content worker\index.ts | Select-Object -Last 1
# Should NOT show test comment
```

**Success Criteria:**
- ✅ VPS edits propagate ke GitHub
- ✅ Windows `git pull` updates ONLY worker/ folder
- ✅ No other folders appear di Windows
- ✅ Round-trip workflow verified

---


## 11. RISK ASSESSMENT & MITIGATION

### 11.1 Risk Matrix

| Phase | Operation | Risk Level | Impact if Failed | Mitigation | Rollback Time |
|-------|-----------|------------|------------------|------------|---------------|
| 0 | Backup | ZERO | None | N/A | N/A |
| 1 | Remove duplicates | LOW | Files deleted | Git reset | <1 min |
| 2 | Update PM2 config | VERY LOW | Worker won't start | Restore backup | <30 sec |
| 3 | Push cleanup branch | VERY LOW | Branch pollution | Delete branch | <30 sec |
| 4 | Merge to worker-v2 | LOW | Branch divergence | Git reset | <1 min |
| 5 | Push worker-v2 | MEDIUM | Remote branch affected | Force push | 2-3 min |
| 6 | Windows setup | ZERO | Windows-only | Delete dir | <1 min |
| 7 | E2E test | ZERO | Testing only | N/A | N/A |

### 11.2 Critical Safeguards

**Pre-Execution Checklist:**
- [ ] Full backup created and verified
- [ ] Safety branch pushed to GitHub
- [ ] No uncommitted changes in /root/GANYIQ
- [ ] PM2 processes documented (pm2 list)
- [ ] Disk space checked (df -h)

**During Execution:**
- [ ] Verify each step before proceeding
- [ ] Read git status after every operation
- [ ] Test PM2 config with --dry-run before applying
- [ ] Keep backup terminal open with `cd /root/GANYIQ`

**Post-Execution:**
- [ ] Verify worker/ folder intact
- [ ] Test PM2 worker can start
- [ ] Confirm Windows sparse checkout works
- [ ] Run end-to-end workflow test

### 11.3 Rollback Procedures

#### Rollback Scenario 1: Phase 1-3 Failed (Before Push)

```bash
cd /root/GANYIQ
git checkout worker-v2
git branch -D cleanup/consolidate-worker
# All local changes discarded, repository unchanged
```

**Recovery Time:** <1 minute  
**Data Loss:** ZERO (changes not pushed)

#### Rollback Scenario 2: Phase 4 Failed (After Merge)

```bash
cd /root/GANYIQ
git checkout worker-v2
git reset --hard HEAD~1
# Undo merge commit
```

**Recovery Time:** <1 minute  
**Data Loss:** ZERO (changes not pushed to remote)

#### Rollback Scenario 3: Phase 5 Failed (After Push)

```bash
cd /root/GANYIQ
git checkout worker-v2

# Option A: Reset to safety branch
git reset --hard safety-backup-YYYYMMDD-HHMMSS
git push origin worker-v2 --force-with-lease

# Option B: Restore from backup tarball
cd /root
tar -xzf GANYIQ-pre-consolidation-backup-*.tar.gz
cd GANYIQ
git push origin worker-v2 --force-with-lease
```

**Recovery Time:** 2-5 minutes  
**Data Loss:** ZERO (safety branch + backup exist)

#### Rollback Scenario 4: Windows Sparse Checkout Issues

```powershell
# Windows: Delete and re-clone
Remove-Item -Recurse -Force C:\ganyiq-worker
git clone https://github.com/ghaniyys-dotcom/ganyiq.git C:\ganyiq-worker
cd C:\ganyiq-worker
git checkout worker-v2
# Continue with normal workflow (no sparse checkout)
```

**Recovery Time:** 5-10 minutes (depends on network)  
**Data Loss:** ZERO (Windows-only issue)

### 11.4 Emergency Contacts & Resources

**If Execution Fails:**
1. STOP immediately — do not continue
2. Run `git status` and document output
3. Check current branch: `git branch --show-current`
4. Review last 5 commits: `git log --oneline -5`
5. Consult rollback procedures above

**Key Commands:**
```bash
# Safety check
git status
git log --oneline -5
git branch -vv

# Emergency undo (if not pushed)
git reset --hard HEAD

# Emergency undo (if pushed)
git reset --hard safety-backup-YYYYMMDD-HHMMSS
git push origin worker-v2 --force-with-lease
```

---

## 12. POST-IMPLEMENTATION VERIFICATION

### 12.1 VPS Verification Checklist

**Repository Structure:**
```bash
cd /root/GANYIQ
git checkout worker-v2

# ✅ worker/ folder exists and has content
ls worker/ | wc -l
# Expected: >20 files

# ✅ Root-level duplicates removed
ls index.ts 2>/dev/null || echo "PASS"
ls tracker.py 2>/dev/null || echo "PASS"
ls speaker-hybrid/ 2>/dev/null || echo "PASS"
# All should output: PASS

# ✅ Worker files intact
ls worker/index.ts worker/tracker.py worker/speaker-hybrid/
# All should exist

# ✅ PM2 config points to worker/ folder
grep "cwd:" pm2.config.cjs
# Expected: cwd: '/root/GANYIQ/worker',
```

**Git Status:**
```bash
# ✅ worker-v2 is current branch
git branch --show-current
# Expected: worker-v2

# ✅ No uncommitted changes
git status
# Expected: nothing to commit, working tree clean

# ✅ worker-v2 pushed to remote
git log origin/worker-v2 --oneline -3
# Should show merge + cleanup commits
```

**PM2 Test:**
```bash
# ✅ PM2 config is valid
pm2 start pm2.config.cjs --dry-run
# Should not error

# ✅ Worker can start (optional — may need .env.local)
cd worker
npx tsx index.ts --help 2>&1 | head -5
# Should not show fatal errors
```

### 12.2 Windows Verification Checklist

**Sparse Checkout Setup:**
```powershell
cd C:\ganyiq-worker

# ✅ worker-v2 branch active
git branch --show-current
# Expected: worker-v2

# ✅ Sparse checkout enabled
git sparse-checkout list
# Expected: worker

# ✅ ONLY worker/ folder present
ls
# Expected: worker\

# ✅ Other folders NOT present
ls app\ 2>&1 | Select-String "cannot find"
ls lib\ 2>&1 | Select-String "cannot find"
# Both should error (correct behavior)

# ✅ Worker files exist
ls worker\
# Should show: index.ts, clip-renderer.ts, tracker.py, etc.
```

**Dependencies:**
```powershell
cd worker

# ✅ Node modules installed
ls node_modules\ | Measure-Object | Select-Object Count
# Expected: >10

# ✅ Python packages installed
pip list | Select-String "numpy\|opencv\|torch"
# Should show installed packages
```

**Functionality:**
```powershell
# ✅ TypeScript can compile
npx tsc --noEmit
# Should complete without fatal errors

# ✅ Worker entry point exists
npx tsx index.ts --version
# Should not crash immediately
```

### 12.3 GitHub Verification Checklist

**Via GitHub Web UI or gh CLI:**

```bash
# ✅ worker-v2 branch exists
gh browse --branch worker-v2

# ✅ Recent commits visible
gh repo view --branch worker-v2

# ✅ worker/ folder structure correct
gh browse --branch worker-v2 -- worker/
```

**Expected Structure on GitHub:**
```
worker-v2 branch:
├── app/
├── lib/
├── worker/          ← Focus here
│   ├── index.ts
│   ├── tracker.py
│   └── speaker-hybrid/
├── package.json
└── (no root-level worker duplicates)
```

---

## 13. MAINTENANCE & FUTURE WORKFLOW

### 13.1 Daily Development Workflow

**Hermes (VPS) Workflow:**

```bash
# Morning: Start work
cd /root/GANYIQ
git checkout worker-v2
git pull origin worker-v2

# Development
# ... edit worker/ files ...

# Commit
git add worker/
git commit -m "feat: implement feature X"

# Push (Windows akan pull ini)
git push origin worker-v2

# Repeat throughout day
```

**Gany (Windows) Workflow:**

```powershell
# Morning: Sync
cd C:\ganyiq-worker
git pull

# Testing
cd worker
npm start
# ... test locally ...

# Sync lagi saat Hermes push
git pull

# Repeat
```

### 13.2 Periodic Maintenance

**Weekly:**
- [ ] Review git log untuk ensure commits clean
- [ ] Check disk space di VPS (`df -h`)
- [ ] Verify Windows sparse checkout masih aktif (`git sparse-checkout list`)

**Monthly:**
- [ ] Full backup repository (`tar -czf`)
- [ ] Review branch strategy (apakah perlu merge ke main?)
- [ ] Clean up stale branches (`git branch -vv | grep gone`)

**Quarterly:**
- [ ] Archive old backups
- [ ] Review PM2 logs (`pm2 logs --lines 100`)
- [ ] Update documentation jika workflow berubah

### 13.3 Handling Merge Conflicts

**If Windows `git pull` Shows Conflicts:**

```powershell
# Check status
git status

# See conflicted files
git diff

# Option A: Stash local changes (if any)
git stash
git pull
git stash pop

# Option B: Reset to remote (discard local)
git fetch origin
git reset --hard origin/worker-v2
```

**Prevention:**
- Windows seharusnya **READ-ONLY** (hanya pull, tidak commit)
- Jika perlu edit di Windows, coordinate dengan Hermes dulu

### 13.4 When to Sync worker-v2 → main

**Scenario:** Setelah beberapa minggu development, perlu sync worker changes ke main branch.

```bash
cd /root/GANYIQ
git checkout main
git pull origin main

# Merge worker-v2 into main
git merge worker-v2 --no-ff -m "Merge worker-v2: [describe changes]"

# Resolve conflicts if any (likely in package.json, etc.)
git mergetool

# Push to main
git push origin main

# Update worker-v2 to match main
git checkout worker-v2
git merge main --ff-only
git push origin worker-v2
```

**When to Do This:**
- Major worker milestone selesai
- Need to deploy full stack (web + worker)
- Before major refactoring

**Frequency:** Monthly or as needed (not every commit)

---

