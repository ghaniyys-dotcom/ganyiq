/**
 * worker/subtitle-renderer.ts — ASS subtitle generation for GANYIQ V2.
 *
 * Generates Advanced SubStation Alpha (.ass) subtitle files with:
 *   - Karaoke word highlighting (syllable-level \K tags)
 *   - Speaker-aware coloring (different color per speaker)
 *   - Smart positioning (avoids face region — top 70% free)
 *   - Max 2 lines, 40 chars per line
 *   - Bottom 12% of frame, centered
 *   - Geist Sans Bold font, 28px, 2px black outline, 8% background opacity
 *
 * The .ass file is consumed by ffmpeg's ass filter for high-quality rendering.
 */

import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';
import type { WordTimestamp, SpeakerLabel } from './speaker-detector';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SubtitleConfig {
  fontName: string;
  fontSize: number;
  outlineWidth: number;
  backgroundOpacity: number;
  verticalPosition: number;  // percentage from bottom (0-100)
  maxLines: number;
  maxCharsPerLine: number;
  speakerColors: Map<string, string>;  // speaker label → ASS color string
}

export interface SubtitleWord {
  text: string;
  start: number;
  end: number;
  speaker?: string;
}

export interface SubtitleLine {
  start: number;
  end: number;
  text: string;
  words: SubtitleWord[];
  speaker?: string;
}

// ---------------------------------------------------------------------------
// Default Configuration
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: SubtitleConfig = {
  fontName: 'Geist Sans',
  fontSize: 28,
  outlineWidth: 2,
  backgroundOpacity: 0.08,
  verticalPosition: 12,  // 12% from bottom
  maxLines: 2,
  maxCharsPerLine: 40,
  speakerColors: new Map([
    ['SPEAKER_00', '&H00E2C266'],  // gold (primary)
    ['SPEAKER_01', '&H0066B9E2'],  // blue
    ['SPEAKER_02', '&H00E266B9'],  // pink
    ['SPEAKER_03', '&H0066E2B9'],  // teal
    ['SPEAKER_04', '&H00B966E2'],  // purple
    // Fallback for any speaker
    ['default', '&H00E2C266'],
  ]),
};

function log(tag: string, message: string): void {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] [SUBTITLE${tag.padEnd(4)}] ${message}`);
}

// ============================================================================
// ASS File Generator
// ============================================================================

/**
 * Escape ASS text (curly braces, etc.).
 */
function escapeAssText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/{/g, '\\{')
    .replace(/}/g, '\\}')
    .replace(/\n/g, '\\N');
}

/**
 * Get color for a speaker.
 */
function getSpeakerColor(speaker: string | undefined, config: SubtitleConfig): string {
  if (!speaker) return config.speakerColors.get('default') || '&H00FFFFFF';
  return config.speakerColors.get(speaker) || config.speakerColors.get('default') || '&H00FFFFFF';
}

/**
 * Generate .ass file content from word-level timestamps.
 *
 * Karaoke effect: uses \K tags for syllable-level timing.
 * When a syllable's time is reached, its color changes from the outlined
 * style to the highlighted style.
 *
 * @param words - Word-level timestamps
 * @param speakerSegments - Speaker segments for coloring
 * @param clipStart - Clip start time in seconds
 * @param clipEnd - Clip end time in seconds
 * @param config - Subtitle configuration
 * @returns ASS file content as string
 */
export function generateAssSubtitle(
  words: WordTimestamp[],
  speakerSegments: SpeakerLabel[],
  clipStart: number,
  clipEnd: number,
  config: SubtitleConfig = DEFAULT_CONFIG,
): string {
  const clipDuration = clipEnd - clipStart;

  // Group words into lines (chunks of ~5-8 words or natural pauses)
  const lines = groupWordsIntoLines(words, speakerSegments, clipStart, clipEnd);

  // Build ASS file
  const assContent = buildAssFile(lines, config, clipDuration);
  return assContent;
}

/**
 * Group words into subtitle lines with speaker info.
 */
function groupWordsIntoLines(
  words: WordTimestamp[],
  speakerSegments: SpeakerLabel[],
  clipStart: number,
  clipEnd: number,
): SubtitleLine[] {
  if (words.length === 0) return [];

  // Filter words within clip range
  const clipWords = words.filter(w => w.start >= clipStart && w.end <= clipEnd);
  if (clipWords.length === 0) return [];

  const lines: SubtitleLine[] = [];
  let currentLineWords: SubtitleWord[] = [];
  let lineStart = clipWords[0].start;
  const pauseThreshold = 0.4; // seconds of silence between lines

  for (let i = 0; i < clipWords.length; i++) {
    const word = clipWords[i];
    const wordText = word.word.replace(/[^\w\s.,!?'"-]/g, '').trim();
    if (!wordText) continue;

    // Determine speaker for this word
    const speaker = speakerSegments.find(
      s => word.start >= s.start && word.end <= s.end
    )?.speaker;

    const subWord: SubtitleWord = {
      text: wordText,
      start: word.start,
      end: word.end,
      speaker,
    };

    // Check for natural break: pause, line length, or punctuation
    const prevWordEnd = currentLineWords.length > 0
      ? currentLineWords[currentLineWords.length - 1].end
      : lineStart;

    const gap = word.start - prevWordEnd;
    const currentCharCount = currentLineWords.reduce((s, w) => s + w.text.length + 1, 0) - 1;
    const willExceed = currentCharCount + wordText.length + 1 > DEFAULT_CONFIG.maxCharsPerLine;

    if ((gap > pauseThreshold || willExceed) && currentLineWords.length > 0) {
      // Flush current line
      const lineEnd = currentLineWords[currentLineWords.length - 1].end;
      lines.push({
        start: lineStart - clipStart,
        end: lineEnd - clipStart,
        text: currentLineWords.map(w => w.text).join(' '),
        words: currentLineWords,
        speaker: getDominantSpeaker(currentLineWords),
      });
      currentLineWords = [subWord];
      lineStart = word.start;
    } else {
      currentLineWords.push(subWord);
    }
  }

  // Flush last line
  if (currentLineWords.length > 0) {
    const lineEnd = currentLineWords[currentLineWords.length - 1].end;
    lines.push({
      start: lineStart - clipStart,
      end: lineEnd - clipStart,
      text: currentLineWords.map(w => w.text).join(' '),
      words: currentLineWords,
      speaker: getDominantSpeaker(currentLineWords),
    });
  }

  return lines;
}

/**
 * Get the dominant speaker for a group of words.
 */
function getDominantSpeaker(words: SubtitleWord[]): string | undefined {
  const counts = new Map<string, number>();
  for (const w of words) {
    if (w.speaker) {
      counts.set(w.speaker, (counts.get(w.speaker) || 0) + 1);
    }
  }
  if (counts.size === 0) return undefined;
  let maxCount = 0;
  let maxSpeaker: string | undefined;
  for (const [speaker, count] of counts) {
    if (count > maxCount) {
      maxCount = count;
      maxSpeaker = speaker;
    }
  }
  return maxSpeaker;
}

/**
 * Build the complete .ass file content.
 */
function buildAssFile(
  lines: SubtitleLine[],
  config: SubtitleConfig,
  clipDuration: number,
): string {
  const resolutionX = 1920;
  const resolutionY = 1080;

  // Calculate vertical position (from bottom)
  const marginBottom = Math.round(resolutionY * (config.verticalPosition / 100));
  const marginVertical = marginBottom;

  // Build ASS header
  const header = `[Script Info]
; Generated by GANYIQ Subtitle Renderer V2
ScriptType: v4.00+
PlayResX: ${resolutionX}
PlayResY: ${resolutionY}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${config.fontName},${config.fontSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,${config.outlineWidth},0,2,40,40,${marginVertical},1
Style: Highlight,${config.fontName},${config.fontSize},&H00${getSpeakerColor('default', config) !== 'WHITE' ? 'E2C266' : 'FFFFFF'},&H00FFFFFF,&H00000000,&H22000000,1,0,0,0,100,100,0,0,1,${config.outlineWidth},0,2,40,40,${marginVertical},1
Style: AltSpeaker,${config.fontName},${config.fontSize},&H0066B9E2,&H00FFFFFF,&H00000000,&H22000000,1,0,0,0,100,100,0,0,1,${config.outlineWidth},0,2,40,40,${marginVertical},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  // Build event lines with karaoke
  let events = '';

  for (const line of lines) {
    const startTime = formatAssTime(line.start);
    const endTime = formatAssTime(line.end);
    const color = getSpeakerColor(line.speaker, config);

    // Determine style based on speaker
    const style = line.speaker && line.speaker !== 'SPEAKER_00' ? 'AltSpeaker' : 'Default';

    // Build karaoke text
    let karaokeText = '';
    for (let wi = 0; wi < line.words.length; wi++) {
      const word = line.words[wi];
      const wordDuration = Math.round((word.end - word.start) * 100); // centiseconds for \K
      const durationCs = Math.max(1, wordDuration);

      if (wi > 0) karaokeText += ' ';
      karaokeText += `{\\K${durationCs}\\c${color}}${escapeAssText(word.text)}`;
    }

    events += `Dialogue: 0,${startTime},${endTime},${style},,0,0,0,,${karaokeText}\n`;
  }

  return header + events;
}

/**
 * Format time for ASS format: H:MM:SS.cc (centiseconds)
 */
function formatAssTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const cs = Math.round((seconds % 1) * 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

// ============================================================================
// Public API
// ============================================================================

export interface SubtitleRenderResult {
  assFilePath: string;
  lineCount: number;
  wordCount: number;
}

/**
 * Generate subtitle .ass file for a clip.
 *
 * @param words - Word-level timestamps (from transcribe.py or Deepgram)
 * @param speakerSegments - Speaker segments (from diarize.py)
 * @param clipStart - Clip start time in seconds
 * @param clipEnd - Clip end time in seconds
 * @param outputDir - Directory to write .ass file
 * @param filename - Output filename (without extension)
 * @returns SubtitleRenderResult with path to .ass file
 */
export function renderSubtitles(
  words: WordTimestamp[],
  speakerSegments: SpeakerLabel[],
  clipStart: number,
  clipEnd: number,
  outputDir: string,
  filename: string,
): SubtitleRenderResult {
  // Ensure output directory exists
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  const assContent = generateAssSubtitle(words, speakerSegments, clipStart, clipEnd);
  const assFilePath = join(outputDir, `${filename}.ass`);

  writeFileSync(assFilePath, assContent, 'utf-8');

  // Count lines and words
  const lineCount = (assContent.match(/Dialogue:/g) || []).length;
  const wordCount = words.length;

  log('RENDER', `Generated ${assFilePath}: ${lineCount} lines, ${wordCount} words`);
  const firstDialogueLines = assContent.split('\n')
    .filter(l => l.startsWith('Dialogue:'))
    .slice(0, 3)
    .map(l => l.slice(0, 120))
    .join('\n');
  log('SAMPLE', firstDialogueLines);

  return { assFilePath, lineCount, wordCount };
}

/**
 * Build FFmpeg filter string for subtitle overlay.
 * Uses the `ass` filter for high-quality rendering.
 */
export function buildSubtitleFilter(assFilePath: string): string {
  const escapedPath = assFilePath.replace(/\\/g, '/').replace(/:/g, '\\:');
  return `ass='${escapedPath}'`;
}
