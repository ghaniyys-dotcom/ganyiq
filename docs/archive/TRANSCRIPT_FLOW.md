# Transcript Flow — Actual Runtime Architecture

**Date:** 2026-06-20
**Last verified analysis:** 2026-06-18

---

## 1. Entry Point

```
POST /api/analyze
→ app/api/analyze/route.ts
  → runAnalysisPipeline() in lib/analyze-pipeline.ts
    → fetchVideoDataWithFallback() in lib/transcript-service.ts
```

---

## 2. Acquisition Paths (tried in order)

### Path A: YouTube InnerTube API
```
fetchVideoDataWithFallback()
  └─ fetchVideoData() in lib/youtube.ts
       ├─ Input: youtubeId
       ├─ Method: InnerTube API with SAPISIDHASH auth
       ├─ Output: TranscriptSegment[] { start, duration, text }
       ├─ Source: 'youtube'
       └─ Failures: LOGIN_REQUIRED (broken since June 13)
```

### Path B: Residential Worker Queue
```
fetchVideoDataWithFallback()
  └─ tryWorkerQueue() in lib/transcript-service.ts
       ├─ Input: youtubeId, youtubeUrl
       ├─ Method: INSERT job → worker polls → worker returns result
       ├─ Worker runs yt-dlp + Deepgram on PC-GANY
       ├─ Output: TranscriptSegment[] { start, duration, text }
       ├─ Source: 'deepgram' (from worker)
       └─ Timeout: 120s polling (3s intervals)
```

### Path C: Direct Deepgram (VPS)
```
fetchVideoDataWithFallback()
  └─ fallbackToDeepgram() in lib/transcript-service.ts
       └─ fetchDeepgramTranscript() in lib/deepgram.ts
            ├─ Input: youtubeUrl
            ├─ Step 1: yt-dlp download audio to /tmp/
            ├─ Step 2: POST to https://api.deepgram.com/v1/listen
            │     model: 'nova-2'
            │     language: 'id'
            │     smart_format: true
            │     utterances: true
            ├─ Step 3: wordsToSegments() → TranscriptSegment[]
            ├─ Output: { segments, confidence, fullTranscript }
            └─ Source: 'deepgram'
```

---

## 3. Data Flow

### Output Schema (from lib/types.ts)
```typescript
interface TranscriptSegment {
  start: number;      // seconds
  duration: number;    // seconds
  text: string;
  speaker?: string;    // optional — from Deepgram diarization
}
```

### DB Persistence
```
transcript-service.ts
  → cacheVideo() in lib/youtube.ts
    → INSERT INTO videos (youtube_id, title, channel_name, duration_seconds, ...)
    → INSERT INTO analyses (video_id, ...) ← transcript stored as related data
```

### Speaker Flow
```
TranscriptSegment[]
  → lib/speaker-enrich.ts
    → detectSpeakerChanges()
    → measureExchangeRate()
    → detectDebateSegments()
    → detectReactionMoments()
    → enrichTranscript() ← main export
```

### Downstream Pipeline
```
TranscriptSegment[]
  → lib/candidate-extraction.ts (moment candidate generation)
  → lib/analyzer.ts (evaluator scoring — frozen)
  → lib/ranking.ts (deterministic sorting)
  → app/api/ranking/route.ts (API output)
  → app/api/clips/route.ts (render job dispatch)
```

---

## 4. Missing Providers

| Provider | Status |
|----------|--------|
| **Deepgram** | ✅ PRODUCTION (nova-2, language: id) |
| **FasterWhisper** | ❌ NOT IMPLEMENTED (no code anywhere) |
| **VibeVoice** | ❌ NOT IMPLEMENTED (to be built) |

---

## 5. Current Gaps

1. **No fallback if Deepgram + YouTube both fail** — pipeline throws TRANSCRIPT_UNAVAILABLE
2. **No VibeVoice speaker intelligence** — Deepgram diarization is unreliable for Bahasa Indonesia
3. **No FasterWhisper offline** — no local fallback exists
4. **No transcript_provider tracking** — no DB column for which provider served
5. **No provider_latency_ms tracking**
6. **No deterministic routing** — tries YouTube first, then worker, then Deepgram (hardcoded)
7. **Speaker → Face mapping** — no foundation layer exists

---

## 6. Files in the Transcript Path

| File | Role |
|------|------|
| `lib/transcript-service.ts` | Orchestration + fallback (288 lines) |
| `lib/deepgram.ts` | Deepgram STT provider (338 lines) |
| `lib/youtube.ts` | YouTube InnerTube transcript |
| `lib/speaker-enrich.ts` | Speaker change analysis (377 lines) |
| `lib/types.ts` | TranscriptSegment type |
| `lib/candidate-extraction.ts` | Moment candidates from transcript |
| `lib/analyze-pipeline.ts` | Pipeline orchestrator |
