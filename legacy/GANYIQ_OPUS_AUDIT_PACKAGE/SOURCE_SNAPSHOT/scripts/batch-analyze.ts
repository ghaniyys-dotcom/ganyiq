#!/usr/bin/env npx tsx
/**
 * batch-analyze.ts — Submit pending URLs to the ganyIQ analysis API.
 *
 * Reads rows from eval/url-tracker.csv where review_status = "pending",
 * submits each to POST /api/analyze, records the analysisId, and updates
 * the CSV status.
 *
 * Usage:
 *   npx tsx scripts/batch-analyze.ts                       # default: 5 analyses
 *   npx tsx scripts/batch-analyze.ts --max=10              # submit 10 analyses
 *   npx tsx scripts/batch-analyze.ts --api=http://...:3000  # custom API URL
 *   npx tsx scripts/batch-analyze.ts --csv=eval/url-tracker.csv
 *
 * Flags:
 *   --max=<N>    Maximum analyses to submit this run (default: 5)
 *   --api=<url>  API base URL (default: http://localhost:3000)
 *   --csv=<path> Path to tracker CSV (default: eval/url-tracker.csv)
 *   --dry-run    Print what would be done without submitting
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PROJECT_ROOT = resolve(process.cwd());

function getArg(name: string, fallback: string): string {
  const flag = process.argv.find((a) => a.startsWith(`--${name}=`));
  return flag ? flag.split('=', 2)[1] : fallback;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

const MAX_ANALYSES = parseInt(getArg('max', '5'), 10);
const API_BASE = getArg('api', 'http://localhost:3000');
const CSV_PATH = resolve(PROJECT_ROOT, getArg('csv', 'eval/url-tracker.csv'));
const DRY_RUN = hasFlag('dry-run');

// ---------------------------------------------------------------------------
// CSV Helpers (lightweight — assumes well-formed CSV with no escaped commas)
// ---------------------------------------------------------------------------

interface CsvRow {
  id: string;
  category: string;
  channel_name: string;
  video_title: string;
  youtube_url: string;
  duration_minutes: string;
  submitted_at: string;
  analysis_id: string;
  review_status: string;
  reviewer: string;
  overall_score: string;
  notes: string;
}

function parseCsv(path: string): { header: string; rows: CsvRow[] } {
  const text = readFileSync(path, 'utf-8').trim();
  const lines = text.split('\n');
  const header = lines[0];
  const rows: CsvRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    rows.push({
      id: cols[0] ?? '',
      category: cols[1] ?? '',
      channel_name: cols[2] ?? '',
      video_title: cols[3] ?? '',
      youtube_url: cols[4] ?? '',
      duration_minutes: cols[5] ?? '',
      submitted_at: cols[6] ?? '',
      analysis_id: cols[7] ?? '',
      review_status: cols[8] ?? '',
      reviewer: cols[9] ?? '',
      overall_score: cols[10] ?? '',
      notes: cols[11] ?? '',
    });
  }

  return { header, rows };
}

function writeCsv(path: string, header: string, rows: CsvRow[]): void {
  const lines = rows.map((r) =>
    [
      r.id,
      r.category,
      r.channel_name,
      r.video_title,
      r.youtube_url,
      r.duration_minutes,
      r.submitted_at,
      r.analysis_id,
      r.review_status,
      r.reviewer,
      r.overall_score,
      r.notes,
    ].join(','),
  );
  writeFileSync(path, [header, ...lines, ''].join('\n'));
}

// ---------------------------------------------------------------------------
// API Call
// ---------------------------------------------------------------------------

interface AnalyzeResult {
  success: boolean;
  analysisId?: string;
  momentsCount?: number;
  error?: string;
  elapsedMs: number;
}

async function submitAnalysis(url: string): Promise<AnalyzeResult> {
  const start = Date.now();

  try {
    const response = await fetch(`${API_BASE}/api/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      return {
        success: false,
        error: `HTTP ${response.status}: ${(body as any).message ?? response.statusText}`,
        elapsedMs: Date.now() - start,
      };
    }

    const data = (await response.json()) as {
      analysisId: string;
      moments: unknown[];
    };
    return {
      success: true,
      analysisId: data.analysisId,
      momentsCount: data.moments?.length ?? 0,
      elapsedMs: Date.now() - start,
    };
  } catch (err: unknown) {
    return {
      success: false,
      error: `Network error: ${err instanceof Error ? err.message : String(err)}`,
      elapsedMs: Date.now() - start,
    };
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('='.repeat(60));
  console.log('GANYIQ BATCH ANALYZER');
  console.log('='.repeat(60));
  console.log('');
  console.log(`  CSV file  : ${CSV_PATH}`);
  console.log(`  API URL   : ${API_BASE}/api/analyze`);
  console.log(`  Max batch : ${MAX_ANALYSES} analyses`);
  console.log(`  Dry run   : ${DRY_RUN ? 'YES (no changes)' : 'NO'}`);
  console.log('');

  // Read CSV
  const { header, rows } = parseCsv(CSV_PATH);
  const pending = rows.filter((r) => r.review_status === 'pending');

  if (pending.length === 0) {
    console.log('  ✅ No pending analyses found. CSV is up to date.');
    console.log('');
    return;
  }

  console.log(`  Found ${pending.length} pending analyses.`);
  console.log(`  Submitting ${Math.min(MAX_ANALYSES, pending.length)} this batch.`);
  console.log('');

  const toSubmit = pending.slice(0, MAX_ANALYSES);
  const results: { row: CsvRow; result: AnalyzeResult }[] = [];
  const batchStart = Date.now();

  for (const row of toSubmit) {
    const label = `${row.id} (${row.channel_name} — ${(row.video_title || '').slice(0, 40)})`;

    if (DRY_RUN) {
      console.log(`  ⏭  [DRY RUN] Would submit ${label}`);
      continue;
    }

    process.stdout.write(`  ▶  ${label} ... `);

    const result = await submitAnalysis(row.youtube_url);

    if (result.success) {
      row.analysis_id = result.analysisId ?? '';
      row.submitted_at = new Date().toISOString().slice(0, 19).replace('T', ' ');
      row.review_status = 'submitted';
      console.log(`✅ ${result.analysisId?.slice(0, 8)} (${result.momentsCount} moments, ${(result.elapsedMs / 1000).toFixed(1)}s)`);
    } else {
      // Retry once
      process.stdout.write(`❌ ${result.error?.slice(0, 60)} — retrying... `);
      const retry = await submitAnalysis(row.youtube_url);

      if (retry.success) {
        row.analysis_id = retry.analysisId ?? '';
        row.submitted_at = new Date().toISOString().slice(0, 19).replace('T', ' ');
        row.review_status = 'submitted';
        console.log(`✅ on retry — ${retry.analysisId?.slice(0, 8)} (${retry.momentsCount} moments, ${(retry.elapsedMs / 1000).toFixed(1)}s)`);
      } else {
        row.review_status = 'failed';
        row.notes = `${result.error} | Retry: ${retry.error}`;
        console.log(`❌ failed after retry`);
      }
    }

    results.push({ row, result });

    // Small delay between submissions to avoid overwhelming the API
    await new Promise((r) => setTimeout(r, 1000));
  }

  // Write updated CSV
  if (!DRY_RUN) {
    writeCsv(CSV_PATH, header, rows);
  }

  const totalElapsed = ((Date.now() - batchStart) / 1000).toFixed(1);

  // Summary
  console.log('');
  console.log('-'.repeat(60));
  console.log('BATCH SUMMARY');
  console.log('-'.repeat(60));
  console.log(`  Submitted  : ${results.filter((r) => r.result.success).length}`);
  console.log(`  Failed     : ${results.filter((r) => !r.result.success).length}`);
  console.log(`  Total time : ${totalElapsed}s`);
  console.log(`  Avg time   : ${results.length > 0 ? (parseFloat(totalElapsed) / results.length).toFixed(1) : '-'}s per analysis`);
  console.log(`  CSV saved  : ${CSV_PATH}`);
  console.log('');

  // Show remaining
  const remainingPending = rows.filter((r) => r.review_status === 'pending').length;
  if (remainingPending > 0) {
    console.log(`  📋 ${remainingPending} analyses remaining.`);
  } else {
    console.log('  🎉 All analyses submitted!');
  }

  console.log('');
  console.log('='.repeat(60));
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
