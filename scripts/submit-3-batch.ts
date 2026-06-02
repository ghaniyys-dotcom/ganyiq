/**
 * Submit the 3 working videos for analysis via the local API.
 */
const API = 'http://localhost:3002/api/analyze';

const VIDEOS = [
  { url: 'https://youtu.be/9vJRopau0g0', label: 'Think Fast Talk Smart (Stanford Business)', cat: 'business' },
  { url: 'https://youtu.be/D1R-jKKp3NA', label: 'Why the secret to success is failure (TED)', cat: 'motivation' },
  { url: 'https://youtu.be/dQw4w9WgXcQ', label: 'Rick Astley (control)', cat: 'entertainment' },
];

interface Result {
  label: string;
  cat: string;
  success: boolean;
  analysisId?: string;
  momentsCount?: number;
  elapsedMs?: number;
  error?: string;
}

async function submit(url: string, label: string, cat: string): Promise<Result> {
  const start = Date.now();
  process.stdout.write(`  ▶ ${label} ... `);

  try {
    const resp = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });

    const elapsedMs = Date.now() - start;
    const data = await resp.json();

    if (resp.ok && data.analysisId) {
      const count = data.moments?.length ?? 0;
      const elite = data.moments?.filter((m: any) => m.tier === 'elite').length ?? 0;
      const sec = data.moments?.filter((m: any) => m.tier === 'secondary').length ?? 0;
      console.log(`✅ ${count} moments (${elite} elite, ${sec} sec) - ${(elapsedMs / 1000).toFixed(1)}s`);
      return { label, cat, success: true, analysisId: data.analysisId, momentsCount: count, elapsedMs };
    } else {
      console.log(`❌ ${data.error}: ${(data.message || '').slice(0, 80)}`);
      return { label, cat, success: false, error: `${data.error}: ${data.message}`, elapsedMs };
    }
  } catch (e: any) {
    console.log(`❌ Network: ${e.message}`);
    return { label, cat, success: false, error: `Network: ${e.message}` };
  }
}

async function main() {
  console.log('GANYIQ VALIDATION BATCH — 3 Videos\n');
  const results: Result[] = [];

  for (const v of VIDEOS) {
    const r = await submit(v.url, v.label, v.cat);
    results.push(r);
    await new Promise(r => setTimeout(r, 2000)); // 2s between submissions
  }

  console.log('\n--- SUMMARY ---');
  const success = results.filter(r => r.success);
  const failed = results.filter(r => !r.success);
  const avgTime = success.reduce((s, r) => s + (r.elapsedMs || 0), 0) / (success.length || 1);

  console.log(`Success: ${success.length}/${results.length}`);
  console.log(`Failed: ${failed.length}/${results.length}`);
  console.log(`Avg processing time: ${(avgTime / 1000).toFixed(1)}s`);
  console.log('\nAnalysis IDs:');
  success.forEach(r => console.log(`  ${r.analysisId} — ${r.label} (${r.momentsCount} moments)`));
  
  // Output as JSON for the report
  console.log('\n--- JSON ---');
  console.log(JSON.stringify(results, null, 2));
}

main().catch(console.error);
