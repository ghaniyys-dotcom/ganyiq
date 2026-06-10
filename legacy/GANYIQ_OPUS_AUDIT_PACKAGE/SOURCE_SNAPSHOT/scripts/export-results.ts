#!/usr/bin/env npx tsx
/**
 * export-results.ts — Export analysis results as a reviewer-friendly CSV.
 *
 * Reads completed analysis IDs from the URL tracker, fetches their data
 * from the database, and exports each moment as a row in a CSV file.
 *
 * Usage:
 *   npx tsx scripts/export-results.ts                          # all submitted/reviewed
 *   npx tsx scripts/export-results.ts --id=BUS-01              # single analysis
 *   npx tsx scripts/export-results.ts --status=reviewed        # only reviewed
 *   npx tsx scripts/export-results.ts --output=results.csv     # custom output path
 *   npx tsx scripts/export-results.ts --flat                   # flat format (1 row/moment)
 *
 * Output formats:
 *   --flat     (default)  One row per moment. Best for spreadsheets.
 *   --grouped             One row per analysis with JSON moments. Best for compact review.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { query } from '../db/client';

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

const CSV_PATH = resolve(PROJECT_ROOT, getArg('csv', 'eval/url-tracker.csv'));
const OUTPUT_PATH = resolve(PROJECT_ROOT, getArg('output', 'eval/exported-results.csv'));
const FILTER_ID = getArg('id', '');
const FILTER_STATUS = getArg('status', 'submitted');
const FLAT_FORMAT = !hasFlag('grouped');

// ---------------------------------------------------------------------------
// CSV Parser (shared with batch-analyze.ts)
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

// ---------------------------------------------------------------------------
// Database Queries
// ---------------------------------------------------------------------------

interface DbAnalysis {
  id: string;
  video_id: string;
  total_moments_found: number;
  processing_time_ms: number;
  llm_model: string;
  prompt_version: string;
  status: string;
  created_at: string;
}

interface DbMoment {
  rank_position: number;
  tier: string;
  worth_clipping_score: number;
  start_time: number;
  end_time: number;
  confidence: string;
  dna_tags: string;
  reasoning: string;
  transcript_excerpt: string;
}

async function fetchAnalysis(analysisId: string): Promise<DbAnalysis | null> {
  const result = await query<DbAnalysis>(
    `SELECT id, video_id, total_moments_found, processing_time_ms,
            llm_model, prompt_version, status, created_at
     FROM analyses WHERE id = $1`,
    [analysisId],
  );
  return result.rows[0] ?? null;
}

async function fetchMoments(analysisId: string): Promise<DbMoment[]> {
  const result = await query<DbMoment>(
    `SELECT rank_position, tier, worth_clipping_score,
            start_time, end_time, confidence,
            dna_tags, reasoning, transcript_excerpt
     FROM moments
     WHERE analysis_id = $1
     ORDER BY rank_position`,
    [analysisId],
  );
  return result.rows;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatTimestamp(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function escapeCsv(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('='.repeat(60));
  console.log('GANYIQ RESULTS EXPORTER');
  console.log('='.repeat(60));
  console.log('');
  console.log(`  CSV source : ${CSV_PATH}`);
  console.log(`  Output     : ${OUTPUT_PATH}`);
  console.log(`  Format     : ${FLAT_FORMAT ? 'flat (1 row/moment)' : 'grouped (JSON moments)'}`);
  if (FILTER_ID) console.log(`  Filter ID  : ${FILTER_ID}`);
  console.log('');

  // Read CSV
  const { rows } = parseCsv(CSV_PATH);

  // Filter to relevant rows
  let targetRows = rows;

  if (FILTER_ID) {
    targetRows = targetRows.filter((r) => r.id === FILTER_ID);
    if (targetRows.length === 0) {
      console.log(`  ❌ No row found with id "${FILTER_ID}"`);
      console.log('');
      return;
    }
  } else {
    targetRows = targetRows.filter(
      (r) => r.review_status === 'submitted' || r.review_status === 'reviewed',
    );
  }

  if (targetRows.length === 0) {
    console.log('  ✅ No submitted analyses to export.');
    console.log('');
    return;
  }

  console.log(`  Exporting ${targetRows.length} analyses...`);
  console.log('');

  // Build output lines
  const outputLines: string[] = [];

  if (FLAT_FORMAT) {
    // Flat format: one row per moment
    outputLines.push([
      'tracker_id',
      'category',
      'channel',
      'video_title',
      'analysis_id',
      'rank',
      'tier',
      'score',
      'timestamp',
      'duration_seconds',
      'confidence',
      'dna_tags',
      'reasoning',
      'transcript_excerpt',
    ].join(','));
  } else {
    // Grouped format: one row per analysis
    outputLines.push([
      'tracker_id',
      'category',
      'channel',
      'video_title',
      'analysis_id',
      'submitted_at',
      'total_moments',
      'elite_count',
      'secondary_count',
      'processing_time_ms',
      'model',
      'prompt_version',
      'moments_json',
    ].join(','));
  }

  let totalMoments = 0;
  let successCount = 0;
  let failCount = 0;

  for (const row of targetRows) {
    if (!row.analysis_id) {
      console.log(`  ⏭  ${row.id}: no analysis_id`);
      continue;
    }

    const analysis = await fetchAnalysis(row.analysis_id);
    if (!analysis) {
      console.log(`  ❌ ${row.id}: analysis ${row.analysis_id.slice(0, 8)} not found in DB`);
      failCount++;
      continue;
    }

    const moments = await fetchMoments(row.analysis_id);
    totalMoments += moments.length;
    successCount++;

    if (FLAT_FORMAT) {
      for (const m of moments) {
        outputLines.push([
          row.id,
          row.category,
          row.channel_name,
          escapeCsv(row.video_title),
          row.analysis_id,
          m.rank_position,
          m.tier,
          m.worth_clipping_score,
          `${formatTimestamp(m.start_time)} → ${formatTimestamp(m.end_time)}`,
          (m.end_time - m.start_time).toFixed(0),
          m.confidence,
          escapeCsv(m.dna_tags),
          escapeCsv(m.reasoning),
          escapeCsv(m.transcript_excerpt),
        ].join(','));
      }
      const elite = moments.filter((m) => m.tier === 'elite').length;
      const secondary = moments.filter((m) => m.tier === 'secondary').length;
      console.log(`  ✅ ${row.id}: ${moments.length} moments (${elite} elite, ${secondary} secondary)`);
    } else {
      const elite = moments.filter((m) => m.tier === 'elite').length;
      const secondary = moments.filter((m) => m.tier === 'secondary').length;
      outputLines.push([
        row.id,
        row.category,
        escapeCsv(row.channel_name),
        escapeCsv(row.video_title),
        row.analysis_id,
        row.submitted_at,
        moments.length,
        elite,
        secondary,
        analysis.processing_time_ms,
        analysis.llm_model,
        analysis.prompt_version,
        escapeCsv(JSON.stringify(moments)),
      ].join(','));
      console.log(`  ✅ ${row.id}: ${moments.length} moments (${elite} elite, ${secondary} secondary)`);
    }
  }

  // Write output
  writeFileSync(OUTPUT_PATH, outputLines.join('\n') + '\n');
  console.log('');
  console.log('-'.repeat(60));
  console.log('EXPORT SUMMARY');
  console.log('-'.repeat(60));
  console.log(`  Analyses exported : ${successCount}`);
  console.log(`  Failed to fetch   : ${failCount}`);
  console.log(`  Total moments     : ${totalMoments}`);
  console.log(`  Output file       : ${OUTPUT_PATH}`);
  console.log('');
  console.log('='.repeat(60));
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
