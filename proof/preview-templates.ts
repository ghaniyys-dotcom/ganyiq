/**
 * proof/preview-templates.ts
 *
 * Generates visual screenshots of ALL 7 subtitle templates rendered with ffmpeg.
 *
 * For each template:
 *   1. Generate the .ass file using renderSubtitles()
 *   2. Render the .ass on a test background image using ffmpeg
 *   3. Capture a screenshot at a key moment
 *   4. Assemble a composite preview grid
 *
 * Run: npx tsx proof/preview-templates.ts
 *
 * Output: proof/previews/*.png
 */

import { existsSync, readFileSync, mkdirSync, writeFileSync, unlinkSync } from 'fs';
import { resolve, join, basename } from 'path';
import { execSync } from 'child_process';
import { renderSubtitles, type SubtitleRenderResult } from '../worker/subtitle-renderer';
import type { WordTimestamp, SpeakerLabel } from '../worker/speaker-detector';
import type { SubtitleTemplateId } from '../worker/subtitle-templates';
import { getTemplate, TEMPLATE_NAMES } from '../worker/subtitle-templates';

// ═══════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════

const ALL_TEMPLATES: SubtitleTemplateId[] = [
  'opus', 'hormozi', 'gadzhi', 'mrbeast',
  'podcast_minimal', 'documentary', 'clean_corporate',
];

const __filename = new URL(import.meta.url).pathname;
const _dirname = __filename.substring(0, __filename.lastIndexOf('/'));
const PREVIEW_DIR = resolve(_dirname || '.', 'previews');
const TEST_BG = '/tmp/ganyiq_test_bg.mp4';
const FONTCONFIG_FILE = '/tmp/ganyiq-fonts.conf';

// Available fonts on this system (substitutions for missing ones)
const FONT_MAP: Record<string, string> = {
  'Geist Sans': 'DejaVu Sans',
  'Impact': 'DejaVu Sans',
  'EB Garamond': 'EB Garamond',
};

// Mock data matching test-all-templates.ts
const mockWords: WordTimestamp[] = [
  { word: 'This', start: 0.0, end: 0.3, confidence: 0.99 },
  { word: 'is', start: 0.3, end: 0.5, confidence: 0.98 },
  { word: 'absolutely', start: 0.5, end: 0.9, confidence: 0.97 },
  { word: 'incredible', start: 0.9, end: 1.3, confidence: 0.96 },
  { word: 'We', start: 1.5, end: 1.7, confidence: 0.95 },
  { word: 'just', start: 1.7, end: 1.9, confidence: 0.94 },
  { word: 'hit', start: 1.9, end: 2.1, confidence: 0.93 },
  { word: '10', start: 2.1, end: 2.3, confidence: 0.92 },
  { word: 'million', start: 2.3, end: 2.6, confidence: 0.91 },
  { word: 'subscribers', start: 2.6, end: 3.0, confidence: 0.90 },
  { word: 'Can', start: 3.3, end: 3.5, confidence: 0.89 },
  { word: 'you', start: 3.5, end: 3.6, confidence: 0.88 },
  { word: 'believe', start: 3.6, end: 3.9, confidence: 0.87 },
  { word: 'it', start: 3.9, end: 4.0, confidence: 0.86 },
  { word: 'This', start: 4.2, end: 4.4, confidence: 0.85 },
  { word: 'is', start: 4.4, end: 4.5, confidence: 0.84 },
  { word: 'insane', start: 4.5, end: 4.9, confidence: 0.83 },
  { word: 'Seriously', start: 5.1, end: 5.5, confidence: 0.82 },
];

const mockSpeakerSegments: SpeakerLabel[] = [
  { speaker: 'SPEAKER_00', start: 0.0, end: 4.0 },
  { speaker: 'SPEAKER_01', start: 4.0, end: 6.0 },
];

const clipStart = 0.0;
const clipEnd = 6.0;

// ═══════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════

function log(message: string): void {
  console.log(`[PREVIEW] ${message}`);
}

/** Run a command and return stdout. */
function run(cmd: string): string {
  try {
    return execSync(cmd, { timeout: 30000, maxBuffer: 10 * 1024 * 1024 }).toString();
  } catch (e: any) {
    return `ERROR: ${e.message?.slice(0, 200) || e}`;
  }
}

/** Substitute font names in ASS content with available alternatives. */
function substituteFonts(assContent: string, templateId: SubtitleTemplateId): string {
  const template = getTemplate(templateId);
  const originalFont = template.config.fontName;
  const substitute = FONT_MAP[originalFont] || originalFont;
  if (substitute !== originalFont) {
    log(`  Font sub: "${originalFont}" → "${substitute}" for ${templateId}`);
    return assContent.replace(
      new RegExp(originalFont.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'),
      substitute
    );
  }
  return assContent;
}

// ═══════════════════════════════════════════════
// Setup
// ═══════════════════════════════════════════════

function checkLibass(): boolean {
  const out = run('ffmpeg -filters 2>&1 | grep ass');
  return out.includes('ass');
}

function setup(): boolean {
  // Create preview directory
  if (!existsSync(PREVIEW_DIR)) {
    mkdirSync(PREVIEW_DIR, { recursive: true });
  }

  // Verify libass support
  if (!checkLibass()) {
    log('ERROR: ffmpeg built without libass (ass filter not available)');
    return false;
  }
  log('libass support verified ✅');

  // Create fontconfig alias file
  const fontconfigContent = `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <!-- Geist Sans → DejaVu Sans -->
  <alias>
    <family>Geist Sans</family>
    <prefer><family>DejaVu Sans</family></prefer>
  </alias>
  <!-- Impact → DejaVu Sans Bold -->
  <alias>
    <family>Impact</family>
    <prefer><family>DejaVu Sans</family></prefer>
  </alias>
  <!-- EB Garamond is already installed -->
</fontconfig>`;
  writeFileSync(FONTCONFIG_FILE, fontconfigContent, 'utf-8');

  // Create test background as a 6-second video (not a single frame)
  // Using -t 6 ensures the video has proper duration for -ss seeking
  const bgCmd = `ffmpeg -y -f lavfi -i "color=c=#1a1a2e:s=1920x1080:d=6" \
    -vf "drawtext=text='SUBITTLE PREVIEW':fontcolor=#e2c266:fontsize=42:x=(w-text_w)/2:y=80:fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf, \
          drawtext=text='Testing all 7 subtitle templates':fontcolor=#888888:fontsize=24:x=(w-text_w)/2:y=135:fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf, \
          drawtext=text='This is absolutely incredible... We just hit 10 million!':fontcolor=#666677:fontsize=18:x=(w-text_w)/2:y=180:fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf" \
    -c:v libx264 -preset ultrafast -crf 28 ${TEST_BG} 2>&1 | tail -3`;

  const result = run(bgCmd);
  if (!existsSync(TEST_BG)) {
    log(`ERROR: Failed to create test background: ${result.slice(0, 100)}`);
    return false;
  }
  log('Test background video created: 6s 1920x1080 dark gradient');
  return true;
}

// ═══════════════════════════════════════════════
// Render ASS + Screenshot
// ═══════════════════════════════════════════════

interface TemplatePreview {
  templateId: SubtitleTemplateId;
  name: string;
  assFilePath: string;
  screenshotPath: string;
  success: boolean;
  error?: string;
}

function renderPreview(templateId: SubtitleTemplateId): TemplatePreview {
  const name = TEMPLATE_NAMES[templateId] || templateId;
  const assFile = join(PREVIEW_DIR, `test_${templateId}.ass`);
  const screenshotFile = join(PREVIEW_DIR, `${templateId}.png`);
  const result: TemplatePreview = {
    templateId, name,
    assFilePath: assFile,
    screenshotPath: screenshotFile,
    success: false,
  };

  try {
    // ── Step 1: Generate ASS using the subtitle renderer ──
    log(`\n  Rendering "${name}"...`);
    const subtitleResult: SubtitleRenderResult = renderSubtitles(
      mockWords, mockSpeakerSegments, clipStart, clipEnd,
      PREVIEW_DIR, `test_${templateId}`, templateId,
    );

    result.assFilePath = subtitleResult.assFilePath;
    log(`  ASS generated: ${subtitleResult.lineCount} lines, ${subtitleResult.wordCount} words`);

    // ── Step 2: Read and substitute fonts ──
    let assContent = readFileSync(subtitleResult.assFilePath, 'utf-8');
    assContent = substituteFonts(assContent, templateId);

    // Write modified ASS with substituted fonts
    writeFileSync(assFile, assContent, 'utf-8');
    log(`  Fonts substituted in ASS file`);

    // ── Step 3: Render the ASS on the test background video using ffmpeg ──
    // Capture at 2.1s: shows "10" (number highlight, gold emphasis color)
    // The emphasis engine highlights '10' (number), 'insane', 'Seriously' (emotional)
    const captureTimes = [
      { time: '00:00:02.100', label: 'number_emphasis' },  // "10" highlighted
      { time: '00:00:04.700', label: 'emotion_emphasis' }, // "insane" highlighted
    ];

    let screenshotCount = 0;
    for (const cap of captureTimes) {
      const timeLabel = cap.label;
      const capScreenshot = screenshotFile.replace('.png', `_${timeLabel}.png`);

      // Use the ass filter to overlay subtitles
      const ffmpegCmd = `FONTCONFIG_FILE="${FONTCONFIG_FILE}" \
        ffmpeg -y -ss ${cap.time} -i ${TEST_BG} \
        -vf "ass='${assFile}'" \
        -vframes 1 -q:v 3 ${capScreenshot} 2>&1 | tail -5`;

      const ffmpegResult = run(ffmpegCmd);

      if (existsSync(capScreenshot)) {
        const stats = readFileSync(capScreenshot).length;
        screenshotCount++;
        log(`  Screenshot (${timeLabel}): ${capScreenshot} (${(stats / 1024).toFixed(0)} KB)`);
      } else {
        log(`  ERROR (${timeLabel}): ${ffmpegResult.slice(0, 200)}`);
      }
    }

    // Use the first successful capture as the primary screenshot path
    if (screenshotCount > 0) {
      result.success = true;
      result.screenshotPath = screenshotFile.replace('.png', `_${captureTimes[0].label}.png`);
    } else {
      result.error = 'ffmpeg failed to create any screenshots';
      log(`  ERROR: ${result.error}`);
    }
  } catch (e: any) {
    result.error = e.message?.slice(0, 200) || String(e);
    log(`  ERROR: ${result.error}`);
  }

  return result;
}

// ═══════════════════════════════════════════════
// Composite Grid
// ═══════════════════════════════════════════════

function createComposite(previews: TemplatePreview[]): string {
  const compositePath = join(PREVIEW_DIR, 'all_templates_composite.png');
  const successfulPreviews = previews.filter(p => p.success);

  if (successfulPreviews.length === 0) {
    log('No successful previews to compose');
    return '';
  }

  // Use a simpler approach: hstack + vstack
  // Layout: 4 columns x 2 rows (7 templates in a 4+3 grid)
  const firstRow = successfulPreviews.slice(0, 4);
  const secondRow = successfulPreviews.slice(4, 7);

  const fontBold = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
  const fontRegular = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';

  // Build inputs and filter complex
  const inputs: string[] = [];
  const scales: string[] = [];
  const labels: string[] = [];

  for (let i = 0; i < successfulPreviews.length; i++) {
    const preview = successfulPreviews[i];
    const label = preview.name.length > 16
      ? preview.name.slice(0, 14) + '..'
      : preview.name;

    inputs.push(`-i ${preview.screenshotPath}`);
    scales.push(`[${i}:v]scale=480:270:force_original_aspect_ratio=decrease,pad=480:270:(ow-iw)/2:(oh-ih)/2:color=#1a1a2e,drawtext=text='${label}':fontcolor=#e2c266:fontsize=13:x=8:y=8:fontfile=${fontBold},drawtext=text='✓ ${preview.templateId}':fontcolor=#44aa44:fontsize=11:x=8:y=252:fontfile=${fontRegular}[v${i}]`);
  }

  // Build hstack for first row (4 inputs)
  const row0Inputs = firstRow.map((_, i) => `[v${i}]`).join('');
  const row0Filter = `${row0Inputs}hstack=inputs=${firstRow.length},pad=1920:270:0:0:color=#0d0d1a[row0]`;

  // Build hstack for second row (3 inputs)
  const row1Inputs = secondRow.map((_, i) => `[v${firstRow.length + i}]`).join('');
  const row1Filter = `${row1Inputs}hstack=inputs=${secondRow.length},pad=1920:270:0:0:color=#0d0d1a[row1]`;

  // Add title bar (60px tall)
  const titleFilter = `color=c=#0d0d1a:s=1920x60,drawtext=text='GANYIQ Subtitle Template Preview':fontcolor=#e2c266:fontsize=22:x=(w-text_w)/2:y=(h-text_h)/2:fontfile=${fontBold}[title]`;

  // Stack everything: title + row0 + row1
  const filterStr = `${scales.join('; ')}; ${row0Filter}; ${row1Filter}; ${titleFilter}; [title][row0][row1]vstack=inputs=3[v]`;

  const ffmpegCmd = `ffmpeg -y ${inputs.join(' ')} \
    -filter_complex "${filterStr}" \
    -map "[v]" -frames:v 1 ${compositePath} \
    2>&1 | tail -5`;

  const result = run(ffmpegCmd);

  if (existsSync(compositePath)) {
    const stats = readFileSync(compositePath).length;
    log(`Composite grid: ${compositePath} (${(stats / 1024).toFixed(0)} KB)`);
    return compositePath;
  } else {
    log(`ERROR creating composite: ${result.slice(0, 200)}`);
    return '';
  }
}

// ═══════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════

async function main(): Promise<void> {
  console.log('');
  console.log('═'.repeat(60));
  console.log('  GANYIQ Subtitle Template Visual Preview');
  console.log('  Generates ffmpeg-rendered screenshots of all 7 templates');
  console.log('═'.repeat(60));

  // Setup
  if (!setup()) {
    console.error('Setup failed. Aborting.');
    process.exit(1);
  }

  // Render each template
  const previews: TemplatePreview[] = [];
  for (const templateId of ALL_TEMPLATES) {
    const preview = renderPreview(templateId);
    previews.push(preview);
  }

  // Print summary
  console.log('\n' + '─'.repeat(60));
  console.log('  RESULTS');
  console.log('─'.repeat(60));

  let passed = 0;
  let failed = 0;
  for (const p of previews) {
    const icon = p.success ? '✅' : '❌';
    console.log(`  ${icon} ${p.name.padEnd(22)} ${p.success ? p.screenshotPath : p.error?.slice(0, 60)}`);
    if (p.success) passed++;
    else failed++;
  }

  console.log('\n' + '─'.repeat(60));
  console.log(`  ${passed} screenshots generated, ${failed} failed`);
  console.log(`  Output: ${PREVIEW_DIR}/`);

  // Create composite grid
  if (passed > 0) {
    console.log('\n  Creating composite grid...');
    const compositePath = createComposite(previews);
    if (compositePath) {
      console.log(`  ✅ Composite: ${compositePath}`);
    }
  }

  console.log('\n' + '═'.repeat(60));
  process.exit(failed > 0 ? 1 : 0);
}

main();
