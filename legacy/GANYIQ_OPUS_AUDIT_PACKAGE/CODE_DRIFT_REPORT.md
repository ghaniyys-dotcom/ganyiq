# CODE DRIFT REPORT
## /root/GANYIQ (source) vs /var/www/ganyiq (deployed)

Generated: 2026-06-07

---

## 1. GIT COMMIT DIVERGENCE

| Property       | Source (/root/GANYIQ)                         | Deployed (/var/www/ganyiq)                    |
|----------------|------------------------------------------------|-----------------------------------------------|
| HEAD commit    | `fcebf14`                                      | `3bbf1f3`                                     |
| Branch         | main                                           | main                                          |
| Behind/ahead   | Deployed is **6 commits ahead** of source?     | Source has V2.4A changes not in deploy        |

Deployed was deployed from an older state. Source has V2.4A multi-face tracking series that were never synced to production.

### Source commits (not in deploy):
```
fcebf14 — fix: confidence threshold too high causing empty segments + perf
8a455e1 — V2.4A-opt: clip-range-only face detection + cleanup debug
446c9a6 — debug: add segment value logging for renderVerticalTracked
2021353 — V2.4A: multi-face tracking — fix camera stuck in empty space
742cfae — fix: include renderMode in clip filename to prevent overwrite
```

### Deploy commits (not in source):
```
3bbf1f3 — fix: upgrade yt-dlp format selector to 720p DASH streams
258587f — chore: full system hardening
ebde68f — fix: clips status endpoint returns failed instead of processing when filename empty
e16a61e — fix: increase LLM AbortSignal.timeout 300s→500s to prevent race with Nginx
a382901 — fix: remove DeepSeek retry attempt — 1 attempt then immediate fallback to Mimo
```

---

## 2. FILE BY FILE HASH COMPARISON

Only **1 file** has different content between source and deploy:

### cookies.txt
- Source: `0c57e95c` (7620 bytes)
- Deploy: `fe6af766` (7617 bytes)
- Difference: 3 bytes — likely trailing newline or cookie expiry timestamp

---

## 3. UNCOMMITTED / DIRTY FILES

### Source dirty files (not committed to git):
```
M app/api/workers/jobs/[id]/complete/route.ts
M app/api/workers/jobs/[id]/upload/route.ts
M app/api/workers/jobs/poll/route.ts
M lib/analyzer.ts
M worker/face-tracker.ts
```

### Deploy dirty files (not committed to git):
```
M app/api/clips/route.ts
M app/api/workers/jobs/[id]/complete/route.ts
M app/api/workers/jobs/[id]/upload/route.ts
M app/api/workers/jobs/poll/route.ts
M app/globals.css
M app/page.tsx
M lib/analyzer.ts
M worker-package/clip-renderer.ts
M worker/clip-renderer.ts
M worker/index.ts
```

### Overlapping dirty files (both source and deploy have uncommitted changes to):
- `app/api/workers/jobs/[id]/complete/route.ts`
- `app/api/workers/jobs/[id]/upload/route.ts`
- `app/api/workers/jobs/poll/route.ts`
- `lib/analyzer.ts`

### Deploy-only dirty files:
- `app/api/clips/route.ts` — clip API changes deployed but not in source
- `app/globals.css` — CSS changes
- `app/page.tsx` — UI changes
- `worker-package/clip-renderer.ts` — renderer changes on deploy only
- `worker/clip-renderer.ts` — renderer changes on deploy only
- `worker/index.ts` — worker changes on deploy only

### Source-only dirty files:
- `worker/face-tracker.ts` — V2.4A face tracking (not in deploy!)

### Deploy untracked files:
- `db/migrations/008_add_render_mode.sql` — render_mode migration, not committed!
- `public/clips/*.mp4` — 8 rendered clip files
- `public/worker-package.zip` — worker distribution zip
- `worker-package.zip` — worker distribution zip
- `worker-package/face-detect.py` — face tracking script, not committed!
- `worker-package/face-tracker.ts` — face tracking module, not committed!
- `worker/face-detect.py` — face tracking script, not committed!
- `worker/face-tracker.ts` — face tracking module, not committed!

---

## 4. ENVIRONMENT CONFIGURATION

- `.env.local`: **IDENTICAL** between source and deploy
- `.env.example`: **IDENTICAL** between source and deploy

---

## 5. DEPLOYMENT SCRIPT ANALYSIS

```bash
# deploy.sh syncs via rsync with these excludes:
--exclude=.git
--exclude=node_modules
--exclude=.next
--exclude=.env*
--exclude=*tsbuildinfo
--exclude=cookies.txt
--exclude=public/clips
```

Critical observation: deploy.sh excludes `.env*` files, meaning `.env.local` changes require manual copying. The script also excludes `cookies.txt` (YouTube cookie auth).

---

## 6. FILES IN DEPLOY NOT IN SOURCE

All files are rendered clip MP4s under `public/clips/` — these are output artifacts, not drift:

```
public/clips/44522c10-ecaf-4aab-bcbc-dee7c5c43c7c_522s_597s.mp4
public/clips/674cd0de-6fb0-473c-b4c4-63513a1a2864_1790s_1868s_landscape.mp4
public/clips/674cd0de-6fb0-473c-b4c4-63513a1a2864_1790s_1868s_vertical.mp4
public/clips/674cd0de-6fb0-473c-b4c4-63513a1a2864_1953s_2031s_vertical.mp4
public/clips/c3a6d4a2-0299-4e86-a7b5-02eafca22683_2921s_2995s_vertical.mp4
public/clips/d602eb94-31f8-47fa-9047-c31807035738_102s_187s_vertical.mp4
public/clips/d602eb94-31f8-47fa-9047-c31807035738_2615s_2683s.mp4
public/clips/dd764739-47d3-488b-b048-b414bbedff4c_1477s_1533s_landscape.mp4
```

---

## 7. RISK ASSESSMENT

| Risk | Severity | Details |
|------|----------|---------|
| Git divergence | HIGH | 6-commit gap. Source has V2.4A face-tracking, deploy has yt-dlp fix + hardening. |
| Untracked face-tracking files | HIGH | `worker/face-tracker.ts` and `face-detect.py` exist on deploy filesystem but are NOT in git. A fresh clone or deploy will lose them. |
| Migration not committed | HIGH | `008_add_render_mode.sql` is applied to DB but NOT in git — will be lost on re-deploy. |
| Worker index.ts changes | MEDIUM | Deploy has uncommitted changes to `worker/index.ts` that are NOT in source of truth. |
| Renderer changes drift | MEDIUM | Both `worker/clip-renderer.ts` and `worker-package/clip-renderer.ts` have uncommitted changes on deploy. |
| cookies.txt drift | LOW | 3-byte difference, likely timestamp. |
| Deploy script excludes | LOW | `.env*` excluded — manual step needed after deploy. |

---

## 8. VERIFICATION COMMANDS

```bash
# Verify git divergence
cd /root/GANYIQ && git log --oneline -3
cd /var/www/ganyiq && git log --oneline -3

# Check uncommitted changes
cd /root/GANYIQ && git diff --name-only
cd /var/www/ganyiq && git diff --name-only

# Verify untracked files
cd /var/www/ganyiq && git ls-files --others --exclude-standard

# Verify migration in DB
psql -U ganyiq -h localhost -d ganyiq -c "SELECT * FROM _migrations ORDER BY id;"
```
