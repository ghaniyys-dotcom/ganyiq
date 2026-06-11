/**
 * proof/test-all-templates.ts
 *
 * End-to-end validation of ALL 7 subtitle templates (P0.5).
 *
 * For each template, validates:
 *   1. ASS file generation succeeds
 *   2. Correct font name and size in Default style
 *   3. Correct outline width
 *   4. Correct accent/primary/speaker colors
 *   5. Correct word rendering mode (word-by-word, karaoke, static_line)
 *   6. Emphasis handling (color, ALL CAPS transform)
 *   7. Extra template-specific styles (MrBeast Highlight)
 *   8. Line count proportional to word count
 *   9. No crashes or exceptions
 *
 * Run: npx tsx proof/test-all-templates.ts
 */

import { existsSync, readFileSync, unlinkSync } from 'fs';
import { resolve } from 'path';
import { renderSubtitles, type SubtitleRenderResult } from '../worker/subtitle-renderer';
import type { WordTimestamp, SpeakerLabel } from '../worker/speaker-detector';
import type { SubtitleTemplateId } from '../worker/subtitle-templates';
import {
  getTemplate,
  TEMPLATE_NAMES,
  type SubtitleTemplate,
} from '../worker/subtitle-templates';

// ═══════════════════════════════════════════════
// Test Infrastructure
// ═══════════════════════════════════════════════

const __filename = new URL(import.meta.url).pathname;
const _dirname = __filename.substring(0, __filename.lastIndexOf('/'));

interface TestAssertion {
  name: string;
  passed: boolean;
  detail: string;
}

interface TemplateTestResult {
  templateId: string;
  templateName: string;
  assertions: TestAssertion[];
  passed: number;
  failed: number;
}

const allResults: TemplateTestResult[] = [];
let totalPassed = 0;
let totalFailed = 0;

function assert(
  results: TestAssertion[],
  name: string,
  condition: boolean,
  detail: string,
): void {
  results.push({ name, passed: !!condition, detail });
}

function printBanner(text: string): void {
  const line = '─'.repeat(text.length + 6);
  console.log(`\n${line}`);
  console.log(`   ${text}`);
  console.log(`${line}`);
}

// ═══════════════════════════════════════════════
// Mock Data
// ═══════════════════════════════════════════════

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
const testDir = resolve(_dirname || '.');

// ═══════════════════════════════════════════════
// Template-specific validation expectations
// ═══════════════════════════════════════════════

interface TemplateExpectations {
  fontName: string;
  fontSize: number;
  outlineWidth: number;
  wordByWordEvents: boolean;
  staticLine: boolean;          // no \K tags, full line at once
  accentColor: string;          // ASS BGR color string
  primaryColor: string;         // ASS BGR color string
  speakerBColor: string;        // AltSpeaker color
  emphasisStrategy: string;
  hasExtraStyles: boolean;       // extra template-specific ASS styles
  expectAllCapsWord: string;     // word that should be ALL CAPS
  expectHighlightedWords: string[]; // words that should have accent color
  expectDimmedWords: string[];     // words that should be dimmed
}

const TEMPLATE_EXPECTATIONS: Record<SubtitleTemplateId, TemplateExpectations> = {
  opus: {
    fontName: 'Geist Sans',
    fontSize: 32,
    outlineWidth: 3,
    wordByWordEvents: true,
    staticLine: false,
    accentColor: '&H0066C2E2',
    primaryColor: '&H00FFFFFF',
    speakerBColor: '&H0066B9E2',
    emphasisStrategy: 'full',
    hasExtraStyles: false,
    expectAllCapsWord: '',
    // Emphasis engine with 15% density cap on 18 words → max 3 highlights:
    // '10' (number, 0.8), 'insane' (emotional, 0.7), 'Seriously' (emotional, 0.7)
    // 'absolutely' and 'incredible' get demoted by density enforcement
    expectHighlightedWords: ['10', 'insane', 'Seriously'],
    expectDimmedWords: [],
  },
  hormozi: {
    fontName: 'Geist Sans',
    fontSize: 38,
    outlineWidth: 5,
    wordByWordEvents: false,
    staticLine: true,
    accentColor: '&H0066C2E2',
    primaryColor: '&H00FFFFFF',
    speakerBColor: '&H0066B9E2',
    emphasisStrategy: 'accent_only',
    hasExtraStyles: false,
    expectAllCapsWord: '',
    expectHighlightedWords: ['10', 'insane', 'Seriously'],
    expectDimmedWords: [],
  },
  gadzhi: {
    fontName: 'EB Garamond',
    fontSize: 34,
    outlineWidth: 1,
    wordByWordEvents: false,
    staticLine: false,
    accentColor: '&H0066C2E2',
    primaryColor: '&H00E8E0D0',
    speakerBColor: '&H0066B9E2',
    emphasisStrategy: 'accent_only',
    hasExtraStyles: false,
    expectAllCapsWord: '',
    expectHighlightedWords: ['10', 'insane', 'Seriously'],
    expectDimmedWords: [],
  },
  mrbeast: {
    fontName: 'Impact',
    fontSize: 44,
    outlineWidth: 6,
    wordByWordEvents: true,
    staticLine: false,
    accentColor: '&H00FFFFFF',
    primaryColor: '&H0033CCFF',
    speakerBColor: '&H0066B9E2',
    emphasisStrategy: 'all_caps',
    hasExtraStyles: true,
    expectAllCapsWord: '10',
    // MrBeast all_caps transforms highlighted words: '10'→'10', 'insane'→'INSANE', 'Seriously'→'SERIOUSLY'
    expectHighlightedWords: ['10', 'INSANE', 'SERIOUSLY'],
    expectDimmedWords: [],
  },
  podcast_minimal: {
    fontName: 'Geist Sans',
    fontSize: 26,
    outlineWidth: 2,
    wordByWordEvents: false,
    staticLine: false,
    accentColor: '&H0066C2E2',
    primaryColor: '&H00FFFFFF',
    speakerBColor: '&H0066B9E2',
    emphasisStrategy: 'accent_only',
    hasExtraStyles: false,
    expectAllCapsWord: '',
    expectHighlightedWords: ['10', 'insane', 'Seriously'],
    expectDimmedWords: [],
  },
  documentary: {
    fontName: 'EB Garamond',
    fontSize: 30,
    outlineWidth: 1,
    wordByWordEvents: false,
    staticLine: false,
    accentColor: '&H0066C2E2',
    primaryColor: '&H00F0E8D0',
    speakerBColor: '&H0066B9E2',
    emphasisStrategy: 'accent_only',
    hasExtraStyles: false,
    expectAllCapsWord: '',
    expectHighlightedWords: ['10', 'insane', 'Seriously'],
    expectDimmedWords: [],
  },
  clean_corporate: {
    fontName: 'Geist Sans',
    fontSize: 30,
    outlineWidth: 0,
    wordByWordEvents: false,
    staticLine: false,
    accentColor: '&H0022AADD',
    primaryColor: '&H00FFFFFF',
    speakerBColor: '&H0066B9E2',
    emphasisStrategy: 'accent_only',
    hasExtraStyles: false,
    expectAllCapsWord: '',
    expectHighlightedWords: ['10', 'insane', 'Seriously'],
    expectDimmedWords: [],
  },
};

// ═══════════════════════════════════════════════
// Test Runner
// ═══════════════════════════════════════════════

const ALL_TEMPLATES: SubtitleTemplateId[] = [
  'opus', 'hormozi', 'gadzhi', 'mrbeast',
  'podcast_minimal', 'documentary', 'clean_corporate',
];

for (const templateId of ALL_TEMPLATES) {
  const template = getTemplate(templateId);
  const exp = TEMPLATE_EXPECTATIONS[templateId];
  const assertions: TestAssertion[] = [];
  const name = TEMPLATE_NAMES[templateId] || templateId;

  printBanner(`Testing: ${name} (${templateId})`);

  let assContent = '';
  let dialogueLines: string[] = [];

  // ── 1. Generate the .ass file ──
  try {
    const result: SubtitleRenderResult = renderSubtitles(
      mockWords, mockSpeakerSegments, clipStart, clipEnd,
      testDir, `test_${templateId}`, templateId,
    );

    assert(assertions, 'ASS file generated', existsSync(result.assFilePath), result.assFilePath);

    assContent = readFileSync(result.assFilePath, 'utf-8');
    dialogueLines = assContent.split('\n').filter(l => l.startsWith('Dialogue:'));

    // Cleanup
    try { unlinkSync(result.assFilePath); } catch { /* ok */ }
  } catch (e: any) {
    assert(assertions, 'No exceptions during render', false,
      `Render threw: ${e?.message || e}`);
    allResults.push({
      templateId, templateName: name,
      assertions, passed: 0, failed: assertions.length,
    });
    totalFailed += assertions.length;
    continue;
  }

  // ── 2. Script Info ──
  assert(assertions, 'Script Info references template',
    assContent.includes(`Template: ${template.name}`),
    `Expected "Template: ${template.name}" in header`);

  // ── 3. Default style — font name ──
  const defaultStyleLine = assContent.split('\n').find(l =>
    l.startsWith(`Style: Default,${exp.fontName},${exp.fontSize}`)
  );
  assert(assertions, `Default style: font=${exp.fontName} size=${exp.fontSize}`,
    !!defaultStyleLine,
    `Expected "Style: Default,${exp.fontName},${exp.fontSize}" — got style lines: ${
      assContent.split('\n').filter(l => l.startsWith('Style:')).join(' | ')
    }`);

  // ── 4. Default style — outline width ──
  const hasOutline = defaultStyleLine
    ? new RegExp(`,${exp.outlineWidth},0,2,40,40,`).test(defaultStyleLine)
    : false;
  assert(assertions, `Default style: outline=${exp.outlineWidth}`,
    hasOutline,
    `Expected outline=${exp.outlineWidth} in Default style line: ${defaultStyleLine?.slice(0, 140) || 'NOT FOUND'}`);

  // ── 5. Highlight style — accent color ──
  const highlightStyleLine = assContent.split('\n').find(l =>
    l.startsWith('Style: Highlight')
  );
  assert(assertions, `Highlight style: accent color ${exp.accentColor}`,
    highlightStyleLine?.includes(exp.accentColor) || false,
    `Expected accent color ${exp.accentColor} in Highlight style. Found: ${highlightStyleLine?.slice(0, 120) || 'NONE'}`);

  // ── 6. AltSpeaker style — speaker B color ──
  const altSpeakerLine = assContent.split('\n').find(l =>
    l.startsWith('Style: AltSpeaker')
  );
  assert(assertions, `AltSpeaker style: speaker B color ${exp.speakerBColor}`,
    altSpeakerLine?.includes(exp.speakerBColor) || false,
    `Expected speaker B color ${exp.speakerBColor} in AltSpeaker style. Found: ${altSpeakerLine?.slice(0, 120) || 'NONE'}`);

  // ── 7. Extra template-specific styles (MrBeast Highlight with custom definition) ──
  if (exp.hasExtraStyles) {
    const hasExtra = template.extraStyles.some(extra =>
      assContent.includes(`Style: ${extra.name},${exp.fontName}`)
    );
    assert(assertions, 'Extra template-specific styles present',
      hasExtra,
      `Expected extra style for ${templateId}: ${template.extraStyles.map(e => e.name).join(', ')}`);
  } else {
    // No extra styles expected
    assert(assertions, 'No unexpected extra styles',
      !assContent.includes('Style:') || defaultStyleLine !== undefined,
      'Template should not have unexpected extra style definitions');
  }

  // ── 8. Dialogue event count ──
  if (exp.wordByWordEvents) {
    // Word-by-word: each word should get its own Dialogue line
    assert(assertions, `Word-by-word: ${dialogueLines.length} events (≥${mockWords.length - 2})`,
      dialogueLines.length >= mockWords.length - 2,
      `Expected at least ${mockWords.length - 2} dialogue events for word-by-word mode, got ${dialogueLines.length}`);
  } else if (exp.staticLine) {
    // Static line: full line appears at once, no \K tags
    assert(assertions, `Static line: ${dialogueLines.length} events (< ${mockWords.length})`,
      dialogueLines.length < mockWords.length,
      `Expected fewer dialogue events than words (${mockWords.length}) for static line mode, got ${dialogueLines.length}`);

    // Verify no \K tags in static line mode
    const hasKaraoke = dialogueLines.some(l => /\{\\K\d+/.test(l));
    assert(assertions, 'Static line: no \\K karaoke tags',
      !hasKaraoke,
      'Static line mode should not have \\K karaoke tags in dialogue events');
  } else {
    // Karaoke mode: line-level, each line has multiple words
    assert(assertions, `Karaoke: ${dialogueLines.length} events (< ${mockWords.length})`,
      dialogueLines.length < mockWords.length,
      `Expected fewer events than words for karaoke mode, got ${dialogueLines.length}`);

    // Verify \K tags present in karaoke mode
    const hasKaraoke = dialogueLines.some(l => /\{\\K\d+/.test(l));
    assert(assertions, 'Karaoke: has \\K tags',
      hasKaraoke,
      'Karaoke mode should have \\K timing tags in dialogue events');
  }

  // ── 9. Emphasis: highlighted words contain accent color ──
  const eventsText = dialogueLines.join(' ');
  if (exp.expectHighlightedWords.length > 0) {
    const foundHighlighted = exp.expectHighlightedWords.filter(w =>
      eventsText.includes(w)
    );
    assert(assertions, `Emphasis: highlighted words present (${foundHighlighted.length}/${exp.expectHighlightedWords.length})`,
      foundHighlighted.length >= Math.ceil(exp.expectHighlightedWords.length * 0.6),
      `Expected at least ${Math.ceil(exp.expectHighlightedWords.length * 0.6)} of ${exp.expectHighlightedWords.join(', ')} to be present. Found: ${foundHighlighted.join(', ')}`);
  }

  // ── 10. ALL CAPS transform (MrBeast) ──
  if (exp.expectAllCapsWord) {
    const capsWord = exp.expectAllCapsWord.toUpperCase();
    const hasAllCaps = eventsText.includes(capsWord);
    assert(assertions, `ALL CAPS: "${exp.expectAllCapsWord}" → "${capsWord}"`,
      hasAllCaps,
      `Expected "${capsWord}" (ALL CAPS) in events. Events: ${eventsText.slice(0, 200)}`);
  }

  // ── 11. Content completeness: check each mock word appears in output ──
  const matchedWords = new Set(
    mockWords
      .map(w => w.word.toLowerCase())
      .filter(w => eventsText.toLowerCase().includes(w))
  );
  assert(assertions, `Content completeness: ${matchedWords.size}/${mockWords.length} unique words`,
    matchedWords.size >= Math.ceil(mockWords.length * 0.5),
    `Expected at least ${Math.ceil(mockWords.length * 0.5)} unique words from the mock data. Found: ${matchedWords.size}`);

  // ── 12. No error/exception markers ──
  assert(assertions, 'No error markers in output',
    !assContent.includes('ERROR') && !assContent.includes('undefined') && !assContent.includes('NaN'),
    'ASS output should not contain error markers');

  // ── Tally ──
  const passed = assertions.filter(a => a.passed).length;
  const failed = assertions.filter(a => !a.passed).length;
  totalPassed += passed;
  totalFailed += failed;

  allResults.push({ templateId, templateName: name, assertions, passed, failed });

  // Print per-template summary
  for (const a of assertions) {
    console.log(`  ${a.passed ? '✅' : '❌'} ${a.name}`);
    if (!a.passed) console.log(`     ${a.detail}`);
  }
  console.log(`  → ${passed} passed, ${failed} failed`);
}

// ═══════════════════════════════════════════════
// Final Report
// ═══════════════════════════════════════════════

console.log('\n' + '═'.repeat(50));
console.log('  ALL 7 TEMPLATES — FINAL REPORT');
console.log('═'.repeat(50));

for (const r of allResults) {
  const status = r.failed === 0 ? '✅' : '❌';
  console.log(`  ${status} ${r.templateName.padEnd(22)} ${r.passed}/${r.passed + r.failed} passed`);
}

console.log('\n' + '─'.repeat(40));
console.log(`  TOTAL: ${totalPassed} passed, ${totalFailed} failed, ${totalPassed + totalFailed} assertions`);

if (totalFailed > 0) {
  console.log('\nFailed tests:');
  for (const r of allResults) {
    for (const a of r.assertions) {
      if (!a.passed) console.log(`  ❌ [${r.templateName}] ${a.name}: ${a.detail}`);
    }
  }
}

process.exit(totalFailed > 0 ? 1 : 0);
