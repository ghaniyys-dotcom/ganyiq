/**
 * GANYIQ V2 — End-to-End Worker Pipeline Validation
 * Tests 3 fresh YouTube videos through the full worker pipeline.
 */

import dotenv from 'dotenv';
dotenv.config({ path: '/root/GANYIQ/.env.local' });

const API_URL = 'http://localhost:3003/api/analyze';

// 3 fresh videos NOT previously cached
const TEST_VIDEOS = [
  {
    url: 'https://www.youtube.com/watch?v=MhQKe-aERsU',
    category: 'Indonesian Entertainment',
    note: 'Indonesian comedy/entertainment',
  },
  {
    url: 'https://www.youtube.com/watch?v=J---aiyznGQ',
    category: 'Entertainment',
    note: 'Keyboard Cat (short, classic)',
  },
  {
    url: 'https://www.youtube.com/watch?v=9bZkp7q19f0',
    category: 'Entertainment',
    note: 'PSY Gangnam Style (music video)',
  },
];

interface TestResult {
  category: string;
  note: string;
  youtubeId: string;
  title: string;
  duration: number;
  moments: number;
  processingTimeMs: number;
  top3: Array<{
    rank: number;
    timestamp: string;
    score: number;
    confidence: string;
    tags: string[];
    reasoning: string;
  }>;
  error?: string;
}

async function testVideo(url: string, category: string, note: string): Promise<TestResult> {
  const startTime = Date.now();
  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
      signal: AbortSignal.timeout(180_000),
    });

    const data = await response.json();
    const elapsed = Date.now() - startTime;

    if (data.error) {
      return {
        category, note,
        youtubeId: data.videoId || 'unknown',
        title: 'ERROR',
        duration: 0, moments: 0,
        processingTimeMs: elapsed, top3: [],
        error: data.error + ': ' + (data.message || '').slice(0, 300),
      };
    }

    const moments = data.moments || [];
    return {
      category, note,
      youtubeId: data.videoId,
      title: data.video?.title || data.videoId,
      duration: data.video?.durationSeconds || 0,
      moments: moments.length,
      processingTimeMs: elapsed,
      top3: moments.slice(0, 3).map((m: any) => ({
        rank: m.rank,
        timestamp: m.startTimestamp + ' - ' + m.endTimestamp,
        score: m.worthClippingScore,
        confidence: m.confidence,
        tags: m.dnaTags,
        reasoning: (m.reasoning || '').slice(0, 150),
      })),
    };
  } catch (err) {
    return {
      category, note,
      youtubeId: 'error', title: 'ERROR',
      duration: 0, moments: 0,
      processingTimeMs: Date.now() - startTime, top3: [],
      error: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}

function printResult(r: TestResult, idx: number) {
  console.log('');
  console.log('='.repeat(80));
  console.log('TEST ' + (idx + 1) + ': ' + r.category + ' — ' + r.note);
  console.log('='.repeat(80));

  if (r.error) {
    console.log('  RESULT: ' + r.error);
    return;
  }

  console.log('  Title:    ' + r.title);
  console.log('  ID:       ' + r.youtubeId);
  console.log('  Duration: ' + r.duration + 's (' + Math.round(r.duration / 60) + 'min)');
  console.log('  Moments:  ' + r.moments);
  console.log('  Time:     ' + (r.processingTimeMs / 1000).toFixed(1) + 's');

  if (r.top3.length > 0) {
    console.log('');
    console.log('  TOP 3 CLIPS:');
    for (const m of r.top3) {
      console.log('  ' + '-'.repeat(60));
      console.log('  #' + m.rank + ' | ' + m.timestamp + ' | Score: ' + m.score + ' | ' + m.confidence);
      console.log('  Tags: [' + m.tags.join(', ') + ']');
      console.log('  ' + m.reasoning);
    }
  } else {
    console.log('');
    console.log('  No moments found (all scores below threshold)');
  }
}

async function main() {
  console.log('#'.repeat(80));
  console.log('GANYIQ V2 — END-TO-END WORKER PIPELINE VALIDATION');
  console.log('Testing 3 fresh videos through: VPS API -> Queue -> PC Worker -> Deepgram -> VPS');
  console.log('#'.repeat(80));

  const results: TestResult[] = [];

  for (let i = 0; i < TEST_VIDEOS.length; i++) {
    const v = TEST_VIDEOS[i];
    console.log('');
    console.log('[' + (i + 1) + '/' + TEST_VIDEOS.length + '] ' + v.category + ' — ' + v.note);
    console.log('  URL: ' + v.url);

    const result = await testVideo(v.url, v.category, v.note);
    results.push(result);
    printResult(result, i);

    if (i < TEST_VIDEOS.length - 1) {
      console.log('\n  Waiting 5s before next test...');
      await new Promise(r => setTimeout(r, 5000));
    }
  }

  // Summary
  console.log('');
  console.log('');
  console.log('#'.repeat(80));
  console.log('VALIDATION SUMMARY');
  console.log('#'.repeat(80));

  let success = 0, fail = 0, totalMoments = 0, totalTime = 0;
  for (const r of results) {
    if (r.error) { fail++; continue; }
    success++;
    totalMoments += r.moments;
    totalTime += r.processingTimeMs;
  }

  console.log('');
  console.log('  Tests:     ' + results.length);
  console.log('  Success:   ' + success);
  console.log('  Failed:    ' + fail);
  console.log('  Moments:   ' + totalMoments + ' (avg ' + (totalMoments / (success || 1)).toFixed(1) + '/video)');
  console.log('  Avg time:  ' + (totalTime / (success || 1) / 1000).toFixed(1) + 's');

  // Pipeline trace
  console.log('');
  console.log('  PIPELINE TRACE:');
  for (const r of results) {
    const status = r.error ? 'FAIL' : r.moments > 0 ? 'OK' : 'EMPTY';
    console.log('    ' + r.youtubeId.slice(0, 15) + '... ' + r.category.slice(0, 20) + ' -> ' + status);
  }

  console.log('');
  console.log('#'.repeat(80));
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
