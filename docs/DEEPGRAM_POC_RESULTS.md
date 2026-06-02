# Deepgram Proof of Concept Results

> **Date:** 2026-06-02 19:05:19
> **Purpose:** Validate Deepgram URL transcription for Indonesian YouTube content that fails with LOGIN_REQUIRED
> **Model:** nova-2 (language: id)
> **Total time:** 5m 53s
> **Success rate:** 1/1 (100%)

---

## Custom video (FIXQQ7X7tZE)

| Metric | Value |
|---|---|
| **YouTube URL** | https://www.youtube.com/watch?v=FIXQQ7X7tZE |
| **Success** | ✅ YES |
| **Method** | file-upload |
| **Processing time** | 5m 53s |
| **Audio duration** | 4749s (79.2 min) |
| **Transcript length** | 59482 characters |
| **Confidence** | 96.6% |
| **Detected language** | N/A |

### Transcript Preview

```
Semakin banyak yang kita tahu semakin kita merasa kita tidak tahu apaapa. You should mencoba untuk put diri sendiri in a room, where you are the paling smart or the paling capable kita lagi effort dengan sesuatu kalau hasilnya optimal ya itu wajar, tapi kalau hasilnya luar biasa, effort kita rendah aku malah gak happy gitu. Karena rasanya jadi kayak we don't earn it. Ya. Maksudnya ya, maksud ya? Karena Maksud ya, maksud ya. Karena bentuk lukaku nih kan, dapet lukaku. Bener tadi tuh, aku kayak lo
```

---

## Summary

| # | Video | Status | Method | Time | Transcript |
|---|---|---|---|---|---|
| 1 | Custom video (FIXQQ7X7tZE) | ✅ | file-upload | 5m 53s | 59482 chars |

## Verdict

**Deepgram URL transcription is CONFIRMED working for Indonesian YouTube content.**

All 1 test videos were successfully transcribed. This proves Deepgram can bypass the LOGIN_REQUIRED/IP-block issue that affects InnerTube API and yt-dlp on the VPS.

### Next Steps

1. Integrate Deepgram as fallback in `lib/youtube.ts` when InnerTube returns LOGIN_REQUIRED
2. Add `DEEPGRAM_API_KEY` to Vercel environment variables
3. Deploy and monitor transcript coverage improvement
