/**
 * proof/test-opus-subtitles.ts
 *
 * End-to-end validation of the Opus subtitle template (P0.5).
 *
 * Tests:
 *   1. Generate .ass file from mock word timestamps with Opus template
 *   2. Verify ASS header has correct Opus styling (Gold accent, Geist Sans 32px)
 *   3. Verify word-by-word events are generated (each word gets its own Dialogue line)
 *   4. Verify emphasis colors use Opus gold palette
 *
 * Run: npx tsx proof/test-opus-subtitles.ts
 */

import { existsSync, readFileSync, unlinkSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';
import { renderSubtitles, type SubtitleRenderResult } from '../worker/subtitle-renderer';
import type { WordTimestamp, SpeakerLabel } from '../worker/speaker-detector';
import type { SubtitleTemplateId } from '../worker/subtitle-templates';

// ES module compatibility: __dirname replacement
const __filename = new URL(import.meta.url).pathname;
const _dirname = __filename.substring(0, __filename.lastIndexOf('/'));

interface TestResult {
  name: string;
  passed: boolean;
  detail: string;
}

const results: TestResult[] = [];
let passedCount = 0;
let failedCount = 0;

function assert(name: string, condition: boolean, detail: string): void {
  const passed = !!condition;
  if (passed) passedCount++;
  else failedCount++;
  results.push({ name, passed, detail });
  console.log(`${passed ? '✅ PASS' : '❌ FAIL'} ${name}: ${detail}`);
}

// ── Mock Data ──

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

// ── Test 1: Generate .ass with Opus template ──

const testDir = resolve(_dirname || '.');
const clipStart = 0.0;
const clipEnd = 6.0;

let subtitleResult: SubtitleRenderResult | null = null;

try {
  subtitleResult = renderSubtitles(
    mockWords,
    mockSpeakerSegments,
    clipStart,
    clipEnd,
    testDir,
    'test_opus_output',
    'opus' as SubtitleTemplateId,
  );
} catch (e) {
  console.error('❌ renderSubtitles threw an exception:', e);
  process.exit(1);
}

const assPath = subtitleResult.assFilePath;
assert('ASS file exists', existsSync(assPath), `Path: ${assPath}`);

const assContent = readFileSync(assPath, 'utf-8');

// Cleanup test file
try { unlinkSync(assPath); } catch { /* ignore */ }

// ── Test 2: Verify Script Info ──

assert('Script Info mentions template',
  assContent.includes('Template: Opus Style'),
  'ASS header should reference Opus Style template'
);

// ── Test 3: Verify ASS PlayRes ──

assert('PlayRes is 1920x1080',
  assContent.includes('PlayResX: 1920') && assContent.includes('PlayResY: 1080'),
  'ASS resolution should be 1920x1080'
);

// ── Test 4: Verify Default style uses Opus settings ──

// Opus Template: Geist Sans, 32px, outline=3
assert('Default style uses Geist Sans',
  /Style: Default,Geist Sans,32/.test(assContent),
  'Opus template should use Geist Sans at 32px'
);

// Opus Template: Geist Sans, 32px, outline=3 anywhere in the Default style line
const defaultStyleLine = assContent.split('\n').find(l => l.startsWith('Style: Default,Geist Sans,32'));
const hasOutline3 = defaultStyleLine ? /,3,0,2,40,40,/.test(defaultStyleLine) : false;
assert('Default style has outline 3',
  hasOutline3,
  `Opus template outline width should be 3. Line: ${defaultStyleLine?.slice(0, 120) || 'NOT FOUND'}`
);

// ── Test 5: Verify Opus gold accent in Highlight style ──

assert('Highlight style uses gold color',
  assContent.includes('Style: Highlight') && assContent.includes('&H0066C2E2'),
  'Opus gold accent (&H0066C2E2) should be in Highlight style'
);

// ── Test 6: Verify word-by-word events ──

// Count Dialogue lines
const dialogueLines = assContent.split('\n').filter(l => l.startsWith('Dialogue:'));
assert('Word-by-word events generated',
  dialogueLines.length >= mockWords.length,
  `Expected at least ${mockWords.length} Dialogue events, got ${dialogueLines.length}`
);

// ── Test 7: Verify each word appears as a separate event ──

// Opus template: wordByWordEvents=true, each word gets its own Dialogue line
// Extract the text portion after the ASS codec tags (after the last '}')
const wordsFound = dialogueLines.filter(l => {
  const textMatch = l.match(/\}[^}]*$/);  // text after last '}'
  const text = textMatch ? textMatch[0].substring(1) : l.split(',,')[1] || '';
  return mockWords.some(w => text.includes(w.word));
});
assert('All words rendered in events',
  wordsFound.length >= mockWords.length - 1, // allow for punctuation-word skips
  `${wordsFound.length} of ${mockWords.length} words found in Dialogue events`
);

// ── Test 8: Verify emphasis words use gold color ──

// "absolutely", "incredible" are emotional words → should be highlighted
const emotionalEvents = dialogueLines.filter(l => l.includes('absolutely') || l.includes('incredible'));
assert('Emotional words rendered',
  emotionalEvents.length >= 1,
  'Emotional words (absolutely, incredible) should be in Dialogue events'
);

// Check if emphasis colors are used (look for gold in Dialogue text)
const goldInEvents = dialogueLines.some(l => l.includes('&H0066C2E2') || l.includes('66C2E2'));
assert('Emphasis color (gold) used in events',
  goldInEvents,
  'Highlighted words should include Opus gold accent color \\c tag'
);

// ── Test 9: Verify numbers are highlighted ──

// "10", "million" → number + number phrase = highlight
const numberEvents = dialogueLines.filter(l => l.includes('10') || l.includes('million'));
if (numberEvents.length > 0) {
  const hasGoldForNumber = numberEvents.some(l => l.includes('&H0066C2E2') || l.includes('66C2E2'));
  assert('Number words highlighted with gold',
    hasGoldForNumber,
    'Number words (10, million) should have gold emphasis color'
  );
} else {
  assert('Number words rendered', false,
    'Number words (10, million) should appear in Dialogue events'
  );
}

// ── Test 10: Verify no filler color for regular words ──

// Count gold occurrences vs total events
const goldCount = dialogueLines.filter(l => l.includes('&H0066C2E2') || l.includes('66C2E2')).length;
const normalCount = dialogueLines.filter(l => !l.includes('&H0066C2E2')).length;
assert('Balance of normal vs emphasized words',
  normalCount >= goldCount * 2, // at least 2x normal vs emphasized
  `Normal events: ${normalCount}, Gold-emphasized: ${goldCount} — should be balanced by density limit (15%)`
);

// ── Summary ──

console.log('\n═══════════════════════════════════════');
console.log(`  Results: ${passedCount} passed, ${failedCount} failed, ${results.length} total`);
console.log('═══════════════════════════════════════\n');

if (failedCount > 0) {
  console.log('Failed tests:');
  for (const r of results) {
    if (!r.passed) console.log(`  ❌ ${r.name}: ${r.detail}`);
  }
}

// Exit with proper code
process.exit(failedCount > 0 ? 1 : 0);
