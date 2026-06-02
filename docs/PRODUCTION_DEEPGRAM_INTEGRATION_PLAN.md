# Production Deepgram Fallback Integration Plan

> **Date:** 2026-06-02
> **Status:** REVISED per Gany's architectural correction
> **Prerequisite:** Deepgram Pipeline Validation: 3/3 passed

---

## 1. Overview

Add automatic Deepgram fallback when YouTube transcript acquisition fails. Zero changes to ranking, prompt, or DeepSeek integration.

### Architecture (Separation of Concerns)

```
lib/youtube.ts           lib/deepgram.ts
  YouTube transcript       Audio transcription
  acquisition              (yt-dlp + Deepgram API)
  │                        │
  └────────┬───────────────┘
           │
           ▼
    lib/transcript-service.ts       ← ORCHESTRATOR
      fetchVideoDataWithFallback()
      │
      ├─ try:    fetchVideoData()             → source: youtube
      ├─ catch:  TRANSCRIPT_UNAVAILABLE       → source: deepgram
      └─ return: VideoData + transcriptSource
                │
                ▼
         app/api/analyze/route.ts
```

### Flow

```
YouTube URL
  │
  ├─ Step 1: fetchVideoData() ← existing, unchanged
  │   └─ SUCCESS → transcript_source: 'youtube' → continue
  │
  └─ Step 2: if TRANSCRIPT_UNAVAILABLE (LOGIN_REQUIRED / NO_CAPTIONS)
      │
      ├─ Check: VERCEL=1? → throw original error (no yt-dlp)
      ├─ Check: DEEPGRAM_API_KEY missing? → throw original error
      │
      ├─ yt-dlp --cookies → audio download
      ├─ Deepgram binary upload → raw words
      ├─ wordsToSegments() → TranscriptSegment[]
      ├─ fetchMetadata() → VideoMetadata (lightweight, no captions)
      ├─ cacheVideo() → DB cache for future requests
      │
      └─ SUCCESS → transcript_source: 'deepgram' → continue
```

### What stays identical for either source:

1. `analyzeTranscript()` — DeepSeek V4 Flash via OpenCode Go
2. `rankMoments()` — deterministic scoring + tier assignment
3. DB storage (analyses → moments)
4. API response format
5. Rate limiting
6. URL validation

---

## 2. Modules

### 2.1 `lib/youtube.ts` — MINIMAL CHANGE (export 3 functions)

**Current state:** 589 lines, functions `fetchMetadata`, `getCachedVideo`, `cacheVideo` are internal.

**Change:** Add `export` keyword to 3 existing functions — no logic changes.

```typescript
export async function fetchMetadata(videoId: string): Promise<VideoMetadata>
export async function getCachedVideo(youtubeId: string): Promise<VideoData | null>
export async function cacheVideo(data: VideoData): Promise<string>
```

**Why export:** The transcript-service orchestrator needs these:
- `fetchMetadata` → get title/channel/duration for Deepgram transcripts
- `getCachedVideo` → check if a previous run cached a transcript
- `cacheVideo` → persist Deepgram transcripts so future requests are instant

**No Deepgram import here** — youtube.ts stays pure YouTube.

### 2.2 `lib/deepgram.ts` — NEW (~180 lines)

**Purpose:** Standalone Deepgram transcription module. No knowledge of YouTube transcripts or the analysis pipeline.

**Exports:**

```typescript
export interface DeepgramResult {
  segments: TranscriptSegment[];
  confidence: number;
  fullTranscript: string;
}

export async function fetchDeepgramTranscript(
  youtubeUrl: string,
): Promise<DeepgramResult>;
```

**Internal functions:**

```
getApiKey()
  → process.env.DEEPGRAM_API_KEY
  → Fallback: .env.local parse

downloadAudio(youtubeUrl)
  → yt-dlp -f bestaudio -o /tmp/*.webm
  → Returns { filePath, fileSize, durationMs }

transcribeAudio(audioBuffer)
  → POST api.deepgram.com/v1/listen
  → model: nova-2, language: id, smart_format
  → Parse alternatives[0].words[]

wordsToSegments(words)
  → SEGMENT_TARGET=5s, MAX_WORD_GAP=1.0s
  → Returns TranscriptSegment[] (same format as youtube.ts)
```

**Vercel guard:** Not needed here — deepgram.ts is only ever called by transcript-service.ts, which checks `process.env.VERCEL` first.

**Error handling:**

| Scenario | Behavior |
|---|---|
| No Deepgram API key | Throws `AppError('ANALYSIS_FAILED', 'Deepgram API key not configured')` |
| yt-dlp not found | Throws `AppError('TRANSCRIPT_UNAVAILABLE', 'yt-dlp not available')` |
| Audio download fails | Throws `AppError('ANALYSIS_FAILED', 'Audio download failed: ...')` |
| Deepgram HTTP error | Throws `AppError('ANALYSIS_FAILED', 'Deepgram HTTP {status}: {message}')` |
| Deepgram timeout (600s) | Throws `AppError('ANALYSIS_FAILED', 'Deepgram request timed out')` |

### 2.3 `lib/transcript-service.ts` — NEW (~60 lines)

**Purpose:** Orchestration only. Composes youtube.ts + deepgram.ts with fallback logic.

```typescript
import { fetchVideoData, fetchMetadata, getCachedVideo, cacheVideo } from '@/lib/youtube';
import { fetchDeepgramTranscript } from '@/lib/deepgram';
import { AppError } from '@/lib/errors';
import type { VideoData, TranscriptSegment } from '@/lib/types';

export interface VideoDataWithSource extends VideoData {
  videoDbId: string;
  transcriptSource: 'youtube' | 'deepgram';
}

export async function fetchVideoDataWithFallback(
  youtubeId: string,
  youtubeUrl: string,
): Promise<VideoDataWithSource> {
  // Step 1: Try existing YouTube flow (with DB cache)
  try {
    const data = await fetchVideoData(youtubeId);
    return { ...data, transcriptSource: 'youtube' };
  } catch (err) {
    // Step 2: Only fallback for TRANSCRIPT_UNAVAILABLE
    if (!(err instanceof AppError) || err.code !== 'TRANSCRIPT_UNAVAILABLE') {
      throw err;
    }

    // Step 3: Vercel has no yt-dlp — skip fallback
    if (process.env.VERCEL === '1') throw err;

    // Step 4: Try Deepgram
    const dgResult = await fetchDeepgramTranscript(youtubeUrl);

    // Step 5: Get metadata (lightweight — no captions)
    const metadata = await fetchMetadata(youtubeId);

    // Step 6: Cache in DB for future requests
    const videoDbId = await cacheVideo({ metadata, transcript: dgResult.segments });

    return {
      metadata,
      transcript: dgResult.segments,
      videoDbId,
      transcriptSource: 'deepgram',
    };
  }
}
```

**Why this works on Vercel:** `lib/deepgram.ts` is statically imported at the top of transcript-service.ts. On Vercel, this import happens at module load time (cold start). If deepgram.ts imports `child_process`, **this could fail on Vercel**. 

**Mitigation for Vercel:** Wrap the deepgram import in the catch block:
```typescript
async function fallbackToDeepgram(youtubeUrl: string): Promise<DeepgramResult> {
  // Lazy import — only evaluated when fallback path actually executes
  const { fetchDeepgramTranscript } = await import('@/lib/deepgram');
  return fetchDeepgramTranscript(youtubeUrl);
}
```

This way, on Vercel:
- If YouTube works → deepgram.ts never loads → no `child_process` error
- If YouTube fails → VERCEL guard fires BEFORE the dynamic import → throws original error → deepgram.ts never loads
- The dynamic import only runs on VPS where `child_process` is available

### 2.4 `db/migrations/005_add_transcript_source.sql` — NEW (~15 lines)

```sql
-- Track transcript source for monitoring and cost analysis.
ALTER TABLE analyses
ADD COLUMN IF NOT EXISTS transcript_source VARCHAR(20) DEFAULT 'youtube'
CHECK (transcript_source IN ('youtube', 'deepgram'));

COMMENT ON COLUMN analyses.transcript_source IS
  'Source of transcript: ''youtube'' (InnerTube API) or ''deepgram'' (fallback via yt-dlp + Deepgram STT)';
```

### 2.5 `app/api/analyze/route.ts` — MINIMAL CHANGE (~+10 lines)

**Changes:**

1. **Import line:** Replace `fetchVideoData` with `fetchVideoDataWithFallback`
2. **Call line:** Replace `fetchVideoData(youtubeId)` with `fetchVideoDataWithFallback(youtubeId, trimmedUrl)`
3. **INSERT:** Add `transcript_source` column + value

---

## 3. Summary of Changes

| File | Action | Est. LOC | Coupling |
|---|---|---|---|
| `lib/deepgram.ts` | CREATE | ~180 | Standalone |
| `lib/transcript-service.ts` | CREATE | ~60 | Orchestrator |
| `db/migrations/005_add_transcript_source.sql` | CREATE | ~15 | Schema |
| `lib/youtube.ts` | MODIFY (add `export`) | +3 words | Youtube only |
| `app/api/analyze/route.ts` | MODIFY | +10 lines | Route |
| **Total** | | **~265** | |

**Files with ZERO changes:**

| File | Reason |
|---|---|
| `lib/analyzer.ts` | Unchanged — receives TranscriptSegment[] regardless of source |
| `lib/ranking.ts` | Unchanged — scoring is source-agnostic |
| `lib/prompt.ts` | Unchanged — prompt template doesn't reference source |
| `lib/types.ts` | Unchanged — TranscriptSegment already defined |
| `lib/validators.ts` | Unchanged — URL validation not affected |
| `lib/errors.ts` | Unchanged — reuses existing AppError codes |
| `lib/rate-limit.ts` | Unchanged — rate limit is source-agnostic |
| `db/migrations/001-004` | Unchanged — additive migration only |
| `next.config.ts` | Unchanged |
| `tsconfig.json` | Unchanged |
| `package.json` | Unchanged (raw fetch, no SDK dependency) |
| `scripts/*` | Unchanged — testing scripts remain as-is |

---

## 4. Risks & Mitigations

| # | Risk | Impact | Likelihood | Mitigation |
|---|---|---|---|---|
| R1 | **Vercel cold start bundles deepgram.ts** | Build fails if `child_process` traced | MEDIUM | Lazy dynamic `import()` inside catch block. VERCEL guard fires BEFORE import. Next.js 14+ handles dynamic imports without static analysis tracing. |
| R2 | **Deepgram API key missing** | Fallback silently skipped | LOW | Check `process.env.DEEPGRAM_API_KEY` before calling. Log warning. |
| R3 | **yt-dlp missing on VPS** | Fallback fails | LOW | Document in setup. If missing, error is caught and original TRANSCRIPT_UNAVAILABLE is re-thrown. |
| R4 | **Deepgram latency on long videos** | Slow response | MEDIUM | yt-dlp downloads audio progressively. For 60-90min podcasts at ~150kbps: ~60-80MB upload. Upload time ~30-60s. Acceptable for MVP. |
| R5 | **Deepgram cost spike** | Billing | LOW | $0.0043/min. At 10/day avg 70min: ~$9/mo. `transcript_source` column enables monitoring. |

---

## 5. Rollout & Rollback

### Implementation order:

```
1. db/migrations/005_add_transcript_source.sql   ← schema first
2. lib/deepgram.ts                                 ← dependency
3. lib/youtube.ts   (export 3 functions)           ← dependency  
4. lib/transcript-service.ts                        ← orchestrator
5. app/api/analyze/route.ts                         ← wire it up
6. Run migration
7. Test all 3 videos
8. tsc --noEmit + npm run build
```

### Rollback plan:

| Scenario | Action |
|---|---|
| Deepgram fails | Remove `DEEPGRAM_API_KEY` from env → fallback never triggers |
| Vercel build broken | `VERCEL=1` guard already blocks fallback import; YouTube flow works as before |
| Cost too high | Remove API key, re-deploy |
| Migration issue | `ALTER TABLE analyses DROP COLUMN transcript_source;` |
| Anything else | Revert import in route.ts to `fetchVideoData` → restores original flow |

---

## 6. Verification (after implementation)

```bash
# 1. TypeScript
npx tsc --noEmit    # Expect: exit 0

# 2. Build
npm run build        # Expect: PASS

# 3. Migration
npx tsx db/migrate.ts

# 4. Test normal video (YouTube transcript)
curl -s -X POST https://ganyiq.vercel.app/api/analyze \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://youtu.be/dQw4w9WgXcQ"}'
# → transcript_source: 'youtube'

# 5. Test blocked video (Deepgram fallback) on VPS
curl -s -X POST http://localhost:3000/api/analyze \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://youtu.be/ROCM31HEB6M"}'
# → transcript_source: 'deepgram'
```
