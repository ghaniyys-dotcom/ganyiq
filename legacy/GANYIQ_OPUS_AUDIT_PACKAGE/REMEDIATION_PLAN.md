# GANYIQ — Remediation Plan

## Prioritasi Berdasarkan Verified Issues — 2026-06-07

---

## Prioritas: P0 = Fix Hari Ini

| ID | Issue | Severity | Effort | Risk | Fix | Rollback Plan |
|---|---|---|---|---|---|---|
| **P0-1** | **F-05: Deploy 20 commits tertinggal** | 🔴 KRITIKAL | 1 jam | Rendah | `cd /root/GANYIQ && bash deploy.sh` | `bash deploy.sh --rollback HEAD~1` |
| **P0-2** | **F-03: Dead Zone mencegah update `lastKnownCx`** | 🔴 KRITIKAL | 30 menit | Rendah | Pindah update `lastKnownCx` ke SEBELUM dead zone check. `state.lastKnownCx = target.cx; state.lastKnownCy = target.cy;` di luar `if (Math.abs(dx) < DEAD_ZONE_PX)` block. Output push tetap pake `state.lastKnownCx` yang lama jika dalam dead zone. | `git stash` atau revert file |
| **P0-3** | **F-01: `lastGoodCx` simpan face center, dipakai crop X** | 🔴 KRITIKAL | 30 menit | Rendah | Simpan crop position (bukan face center) di `lastGoodCx`/`lastGoodCy`. `lastGoodCx = Math.max(0, Math.min(srcW - cropW, sample.cx - cropW / 2));` | `git stash` atau revert file |
| **P0-4** | **F-04: Job completion non-idempotent** | 🔴 KRITIKAL | 1 jam | Rendah | Ganti `UPDATE ... WHERE id = $1` → `UPDATE ... WHERE id = $1 AND status = 'claimed' RETURNING id`. Jika tidak ada row returned, return 409. | Revert SQL perubahan |
| **P0-5** | **F-14: tsserver cleanup** | 🟡 TINGGI | 15 menit | Rendah | `pkill -f tsserver` atau cron: `0 */6 * * * pkill -f tsserver` | Hapus dari crontab |

**Total P0 effort:** ~3 jam. **Risk:** Rendah (semua fix memiliki rollback jelas).

---

## Prioritas: P1 = Minggu Ini

| ID | Issue | Severity | Effort | Risk | Fix | Rollback Plan |
|---|---|---|---|---|---|---|
| **P1-1** | **F-07: PM2 migrasi ke non-root** | 🔴 KRITIKAL | 2 jam | Sedang | Buat user `nodeapp`. `chown -R nodeapp: /var/www/ganyiq`. `pm2 delete ganyiq`. `sudo -u nodeapp pm2 start npm --name ganyiq -- start -- -p 3003`. `pm2 save`. `pm2 startup -u nodeapp`. | `pm2 delete ganyiq` → ulang sebagai root |
| **P1-2** | **F-09: Stale job recovery 15 menit terlalu pendek** | 🟡 TINGGI | 30 menit | Rendah | Naikkan poll route stale timeout ke 30 menit. Ubah `INTERVAL '15 minutes'` → `INTERVAL '30 minutes'`. Atau lebih baik: join dengan workers table (seperti cron) — cek worker heartbeat. | Revert perubahan interval |
| **P1-3** | **F-16/F-24: `max_tokens` naik** | 🟡 TINGGI | 15 menit | Rendah | Ubah `max_tokens: 8192` → `max_tokens: 16384` di `lib/analyzer.ts:303`. Juga log warning jika `finish_reason === 'length'`. | Revert max_tokens |
| **P1-4** | **F-12: Video duration=0 edge case** | 🟡 TINGGI | 30 menit | Rendah | Tambah minimum floor 600s di `analyzer.ts` jika effectiveDuration = 0. Atau return error `VIDEO_DURATION_UNKNOWN`. | Revert guard |
| **P1-5** | **F-11: Worker endpoints rate limit** | 🟡 TINGGI | 2 jam | Sedang | Implement simple in-memory rate limiter per worker per endpoint. Atau extend `lib/rate-limit.ts` untuk worker. | Non-aktifkan rate limit |
| **P1-6** | **F-15: Identity timeout naik** | 🟡 TINGGI | 15 menit | Rendah | Ubah `IDENTITY_TIMEOUT_FRAMES = 3` → `= 10` di `face-tracker.ts:103`. | Revert ke 3 |
| **P1-7** | **F-06 / F-08: Deploy V2.4A-opt** | 🟡 TINGGI | 0 menit | — | Selesai jika P0-1 dijalankan (deploy 20 commits). | — |

**Total P1 effort:** ~6 jam. **Risk:** Sedang (PM2 migration perlu test).

---

## Prioritas: P2 = Bulan Ini

| ID | Issue | Severity | Effort | Risk | Fix |
|---|---|---|---|---|---|
| **P2-1** | **F-10: Eliminasi worker-package duplikasi** | 🟡 TINGGI | 2 jam | Rendah | Build worker-package.zip dari `worker/` saat deploy. Hapus `worker-package/` source directory. |
| **P2-2** | **F-13: Ganti `execSync` → `exec` dengan handler** | 🟡 TINGGI | 4 jam | Sedang | Refactor semua `execSync` di worker ke `exec` dengan Promise wrapper + timeout + proper cleanup. |
| **P2-3** | **F-17: Tambah index rate limit** | 🟢 SEDANG | 15 menit | Sangat Rendah | Migration: `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_analyses_ip_date ON analyses (ip_address, created_at DESC);` |
| **P2-4** | **F-18: Tambah `isLocked` field** | 🟢 SEDANG | 1 jam | Rendah | Tambah `isLocked: boolean` di SegmentAccum. Set `true` untuk no-face frames. |
| **P2-5** | **F-20: Button debounce** | 🟢 SEDANG | 30 menit | Rendah | Disabled button saat `stage !== 'idle'`. |
| **P2-6** | **F-21: Exponential backoff untuk upload** | 🟢 SEDANG | 1 jam | Rendah | Delay: attempt 1 = 5s, attempt 2 = 30s. Tambah jitter ±20%. |
| **P2-7** | **Sentri error tracking** | 🟢 SEDANG | 2 jam | Rendah | setup `npm install @sentry/nextjs`. Cat error di handler. |
| **P2-8** | **GitHub Actions CI** | 🟡 TINGGI | 4 jam | Sedang | Setup lint + type-check + build. Optional: auto-deploy on main. |

**Total P2 effort:** ~15 jam. **Risk:** Rendah-Sedang.

---

## Prioritas: P3 = Nice to Have

| ID | Issue | Severity | Effort | Risk | Fix |
|---|---|---|---|---|---|
| **P3-1** | **F-02: Rename `totalCx` → `runningAvgCx` untuk clarity** | 🔵 RENDAH | 30 menit | Sangat Rendah | Rename variable biar jelas perbedaan antara cumulative sum (face) vs running average (no-face). |
| **P3-2** | **F-19: Hapus `CONFIDENCE_LOCK_THRESHOLD`** | 🟢 SEDANG | 15 menit | Tidak Ada | Hapus line 104. |
| **P3-3** | **F-22: Keyframe alignment** | 🟢 SEDANG | 1 jam | Rendah | Ganti `-ss` ke output position, atau tambah `-noaccurate_seek`. |
| **P3-4** | **F-23: Persist metrics ke DB** | 🟢 SEDANG | 2 jam | Rendah | Simpan fallback metrics ke tabel `metrics`. |
| **P3-5** | **F-25: `execSync` → `spawn`** | 🔵 RENDAH | 4 jam | Sedang | Refactor ke `spawn` dengan array args. |
| **P3-6** | **F-26: `execSync` mkdir → `mkdirSync`** | 🔵 RENDAH | 30 menit | Sangat Rendah | Ganti semua `execSync(`mkdir`...)` → `mkdirSync(dir, { recursive: true })` |
| **P3-7** | **F-27: Hapus redundant sort** | 🔵 RENDAH | 15 menit | Sangat Rendah | Hapus sort di interpolatePerFace() jika tidak ada consumer. |
| **P3-8** | **F-28: Perbaiki logging face count** | 🔵 RENDAH | 30 menit | Rendah | Tambah NMS atau ubah log message. |
| **P3-9** | **Structured logging (pino)** | 🟢 SEDANG | 4 jam | Rendah | Ganti `console.log` → pino JSON logger. |

**Total P3 effort:** ~13 jam. **Risk:** Rendah.

---

## Timeline

```
Hari 1 (P0)          Minggu 1 (P0-P1)       Bulan 1 (P1-P2)      Bulan 2+ (P2-P3)
┌─────────────────┐  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
│ P0-1: deploy     │  │ P1-1: PM2 non-root│  │ P2-1: worker-pkg  │  │ P3 items          │
│ P0-2: dead zone  │  │ P1-2: stale 30min │  │ P2-2: exec→exec   │  │ Face tracking     │
│ P0-3: lastGoodCx  │  │ P1-3: max_tokens  │  │ P2-3: index rate   │  │ (MediaPipe, etc)  │
│ P0-4: idempotent  │  │ P1-4: duration=0  │  │ P2-4: isLocked     │  │                   │
│ P0-5: tsserver    │  │ P1-5: rate limit  │  │ P2-5: debounce     │  │                   │
│                    │  │ P1-6: identity 10 │  │ P2-6: backoff      │  │                   │
│ Effort: 3 jam     │  │ P1-7: (covered)   │  │ P2-7: Sentry       │  │                   │
│                    │  │ Effort: ~6 jam    │  │ P2-8: CI           │  │                   │
│                    │  │                   │  │ Effort: ~15 jam    │  │                   │
└─────────────────┘  └──────────────────┘  └──────────────────┘  └──────────────────┘
```

---

## Order of Execution yang Direkomendasikan

### Langsung Eksekusi (P0) — 3 jam

```
Step 1: bash deploy.sh                           [1 jam]  → Fix F-05, F-06, F-08
Step 2: Fix dead zone + lastGoodCx + identity     [1 jam]  → Fix F-01, F-03, F-15
Step 3: Fix idempotent completion                 [1 jam]  → Fix F-04
Step 4: pkill -f tsserver                         [5 min]  → Fix F-14
Step 5: Deploy lagi (bash deploy.sh --quick)      [10 min] → Deploy step 2-4
```

### Minggu Ini (P1) — ~6 jam

```
Step 6: PM2 non-root migration                   [2 jam]   → Fix F-07
Step 7: max_tokens 8192→16384                    [15 min]  → Fix F-16
Step 8: Stale timeout 15→30 min                  [30 min]  → Fix F-09
Step 9: Duration=0 guard                         [30 min]  → Fix F-12
Step 10: Worker rate limit                       [2 jam]   → Fix F-11
Step 11: Deploy lagi (--quick)                    [10 min]
```

### Bulan Ini (P2) — ~15 jam

```
Step 12: Worker-package elimination              [2 jam]
Step 13: execSync → exec refactor                [4 jam]
Step 14: Database index migration                [15 min]
Step 15: Sentry + GitHub Actions CI              [6 jam]
Step 16: Various minor fixes                     [3 jam]
```

---

## Risk Analysis per Fix

| Fix | Risk | Mitigation |
|---|---|---|
| **P0-1: deploy 20 commits** | Rendah — perubahan sudah di-source | `--rollback HEAD~1` tersedia |
| **P0-2: dead zone fix** | Rendah — hanya ubah posisi line | `git stash` |
| **P0-3: lastGoodCx fix** | Rendah — hanya ganti value yang di-simpan | `git stash` |
| **P0-4: idempotent completion** | Rendah — SQL atomic operation | Revert SQL |
| **P1-1: PM2 non-root** | **SEDANG** — app bisa down jika permission salah | Test di non-production hours. Backup .env. Pastikan public/clips/ writeable. |
| **P1-5: worker rate limit** | Rendah — additive, tidak merusak | Non-aktifkan via env var |
| **P2-2: exec→exec refactor** | **SEDANG** — bisa ubah behavior async | Extensive testing di worker |

---

## Rollback Plan Umum

```bash
# Rollback deploy
cd /root/GANYIQ && bash deploy.sh --rollback HEAD~1

# Rollback code changes
cd /root/GANYIQ && git checkout -- worker/face-tracker.ts
cd /root/GANYIQ && git checkout -- app/api/workers/jobs/[id]/complete/route.ts
cd /root/GANYIQ && git checkout -- lib/analyzer.ts
```
