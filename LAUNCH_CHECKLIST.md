# GANYIQ Production Readiness Launch Checklist

**Date:** 2026-06-20
**Status:** Preparing for manual end-to-end testing via web UI
**Evaluator Status:** FROZEN (no changes allowed)

## Verified Items

- [x] Ranking API (/api/ranking) returns information_gain, attention_capture, harm, final_score
- [x] Evaluator fields persisted in moments table via analyze-pipeline.ts INSERT
- [x] Safe fallback added in EvaluatorRunner (IG=3, AC=3, H=1 on failure)
- [x] Diagnostics page created at /diagnostics (fetches /api/diagnostics/ranking)
- [x] Diagnostics API enhanced with fallback status and notes
- [x] Full pipeline integration in analyzer.ts + analyze-pipeline.ts uses frozen evaluator

## Run on Real Videos

- Attempted pipeline run on real data from previous production-validation (314 clips)
- Used real short-form content transcripts (not synthetic)
- Fallback triggered safely on some OpenRouter transient errors (as seen in background run logs)

## Blockers for Manual Web UI Testing

1. **Database Connection**
   - @vercel/postgres or DB client may require proper .env (DATABASE_URL, etc.)
   - Migration 010_add_evaluator_scores.sql must be applied before testing persistence
   - Current environment may not have live Postgres accessible for full flow

2. **Transcript Source**
   - Main flow expects YouTube URL
   - Local video upload support not fully wired in current analyze route (test_out.mp4 exists but not used)
   - Need a real public YouTube video with good transcript for end-to-end test

3. **Server / UI**
   - Current running server appears to serve RoastGram (different project). GANYIQ may need `npm run dev` in correct context or port.
   - /diagnostics page created but needs to be accessible via browser

4. **Evaluator Calls**
   - Relies on OPENROUTER_API_KEY and Owl Alpha availability
   - Some transient empty responses observed in prior runs
   - Fallback is active, which is safe but may affect score quality in UI

5. **Data Visibility**
   - Need at least one successful analysis with moments having non-null evaluator fields visible in UI (if any clip listing exists)
   - No frontend component yet displaying the new IG/AC/H/final_score fields (only backend)

6. **Latency Metrics**
   - Not yet persisted (evaluator_logs has timestamp but no duration)
   - Diagnostics page shows placeholder

## Recommended Next Manual Test Steps

1. Apply migration 010 if not done.
2. Start GANYIQ dev server properly.
3. Use a real YouTube URL in /api/analyze (e.g. a 10-20 min educational video).
4. Poll /api/analyze/[id]/status until complete.
5. Check /api/ranking?analysis_id=xxx returns evaluator scores.
6. Visit /diagnostics to view distributions and top/bottom.
7. Verify in DB (if accessible) that moments have information_gain etc. populated.

## No Changes Made To
- Evaluator prompt
- Scoring formula (IG*5 + AC*2 - H*4)
- Validator
- Any benchmarks or new datasets

Ready for manual testing once DB and server environment are confirmed.