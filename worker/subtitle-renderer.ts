/**
 * worker/subtitle-renderer.ts — ASS subtitle generation for GANYIQ V3 (P0.4).
 *
 * Generates Advanced SubStation Alpha (.ass) subtitle files with:
 *   - Karaoke word highlighting (syllable-level \K tags)
 *   - Speaker-aware coloring (different color per speaker)
 *   - WORD EMPHASIS — numbers, money, names, emotional phrases highlighted in gold
 *   - Filler word dimming (uh, um, anu, eee in gray)
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
import { analyzeWordEmphasis, getEmphasisColor, type EmphasisAnalysis } from './emphasis-engine';
import {
  getTemplate,
  templateToConfig,
  buildTemplateStyles,
  getTemplateEmphasisColor,
  transformWordForTemplate,
  type SubtitleTemplateId,
  type SubtitleTemplate,
} from './subtitle-templates';

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
  /** P0.4: Emphasis color override (gold for highlights, gray for dimmed). */
  emphasisColor?: string;
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

/** Default template name. */
const DEFAULT_TEMPLATE: SubtitleTemplateId = 'opus';

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
 * P0.4 Feature: Word emphasis detection via NLP analysis.
 *   - Numbers, money, names, emotional phrases → highlighted in gold
 *   - Filler words (uh, um, anu, eee) → dimmed in gray
 *   - Only ~15% of words are emphasized to maintain visual impact
 *
 * P0.5 Feature: Subtitle template system with 7 professional styles.
 *   - Each template controls font, colors, size, outline, positioning
 *   - Word-by-word pop mode gives each word its own Dialogue event
 *   - Template-driven emphasis colors
 *
 * @param words - Word-level timestamps
 * @param speakerSegments - Speaker segments for coloring
 * @param clipStart - Clip start time in seconds
 * @param clipEnd - Clip end time in seconds
 * @param config - Subtitle configuration
 * @param templateName - Subtitle template name (default: 'opus')
 * @returns ASS file content as string
 */
export function generateAssSubtitle(
  words: WordTimestamp[],
  speakerSegments: SpeakerLabel[],
  clipStart: number,
  clipEnd: number,
  config: SubtitleConfig = DEFAULT_CONFIG,
  templateName: SubtitleTemplateId = DEFAULT_TEMPLATE,
): string {
  const clipDuration = clipEnd - clipStart;

  // Filter words within clip range
  const clipWords = words.filter(w => w.start >= clipStart && w.end <= clipEnd);

  // P0.4: Run emphasis analysis on the words
  const emphasis = analyzeWordEmphasis(clipWords, speakerSegments);
  if (emphasis.stats.highlighted > 0 || emphasis.stats.dimmed > 0) {
    log('EMPHASIS', `${emphasis.stats.highlighted}/${emphasis.stats.totalWords} highlighted (${emphasis.stats.percentageHighlighted}%), ${emphasis.stats.dimmed} dimmed`);
  }

  // P0.5: Get template
  const template = getTemplate(templateName);
  log('TEMPLATE', `Using template: ${template.name} (${template.wordRenderMode})`);

  // Group words into lines with emphasis coloring
  const lines = groupWordsIntoLines(clipWords, speakerSegments, clipStart, clipEnd, emphasis, template);

  // Build ASS file
  const assContent = buildAssFile(lines, config, clipDuration, template);
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
  emphasis?: EmphasisAnalysis,
  template?: SubtitleTemplate,
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

    // P0.4: Get emphasis analysis for this word
    const emphasisInfo = emphasis?.wordMap?.get(i);
    const isHighlight = emphasisInfo?.type === 'highlight';
    const isDim = emphasisInfo?.type === 'dim';

    // P0.5: Get template-aware color and transformed text
    let wordTextFinal = wordText;
    let emphasisColor: string | undefined;

    if (template) {
      const templateColor = getTemplateEmphasisColor(template, isHighlight, isDim);
      if (templateColor !== template.colors.primary) {
        emphasisColor = templateColor;
      }
      wordTextFinal = transformWordForTemplate(wordText, isHighlight, template);
    } else {
      // Fallback to P0.4 behavior
      const ec = getEmphasisColor(i, emphasis?.wordMap);
      if (ec !== '&H00FFFFFF') emphasisColor = ec;
    }

    const subWord: SubtitleWord = {
      text: wordTextFinal,
      start: word.start,
      end: word.end,
      speaker,
      emphasisColor,
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
 * Build the complete .ass file content with emphasis-aware coloring and template styling.
 *
 * P0.4: Each word's \c color tag is overridden by emphasis analysis.
 * P0.5: Template-driven styles, word-by-word events, per-word transforms.
 *
 * Emphasis is attached to SubtitleWord during line grouping to avoid
 * index misalignment issues caused by word skipping.
 */
function buildAssFile(
  lines: SubtitleLine[],
  config: SubtitleConfig,
  clipDuration: number,
  template?: SubtitleTemplate,
): string {
  const resolutionX = 1920;
  const resolutionY = 1080;

  // Calculate vertical position (from bottom)
  const marginBottom = Math.round(resolutionY * (config.verticalPosition / 100));
  const marginVertical = marginBottom;

  // P0.5: Build ASS header with template-driven styles
  let stylesSection: string;
  if (template) {
    stylesSection = buildTemplateStyles(template, marginVertical);
  } else {
    // Fallback to legacy styles
    stylesSection = `Style: Default,${config.fontName},${config.fontSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,${config.outlineWidth},0,2,40,40,${marginVertical},1
Style: Highlight,${config.fontName},${config.fontSize},&H0066C2E2,&H00FFFFFF,&H00000000,&H22000000,1,0,0,0,100,100,0,0,1,${config.outlineWidth},0,2,40,40,${marginVertical},1
Style: AltSpeaker,${config.fontName},${config.fontSize},&H0066B9E2,&H00FFFFFF,&H00000000,&H22000000,1,0,0,0,100,100,0,0,1,${config.outlineWidth},0,2,40,40,${marginVertical},1`;
  }

  const header = `[Script Info]
; Generated by GANYIQ Subtitle Renderer V3 with Emphasis Engine
; Template: ${template?.name || 'Default'}
ScriptType: v4.00+
PlayResX: ${resolutionX}
PlayResY: ${resolutionY}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
${stylesSection}

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  // P0.5: Build event lines — standard or word-by-word
  let events = '';

  for (const line of lines) {
    const lineStartTime = formatAssTime(line.start);
    const lineEndTime = formatAssTime(line.end);
    const baseColor = getSpeakerColor(line.speaker, config);

    // Determine style based on speaker
    const style = line.speaker && line.speaker !== 'SPEAKER_00' ? 'AltSpeaker' : 'Default';

    // P0.5: Static line mode — full line appears instantly, no word-by-word reveal
    if (template && template.wordRenderMode === 'static_line') {
      // Output the entire line as-is with per-word \c color tags but no \K timing
      let lineText = '';
      for (let wi = 0; wi < line.words.length; wi++) {
        const word = line.words[wi];
        const effectiveColor = word.emphasisColor || baseColor;
        if (wi > 0) lineText += ' ';
        lineText += `{\\c${effectiveColor}}${escapeAssText(word.text)}`;
      }
      events += `Dialogue: 0,${lineStartTime},${lineEndTime},${style},,0,0,0,,${lineText}\n`;
    }
    // P0.5: Word-by-word mode — each word gets its own Dialogue event
    else if (template && template.wordByWordEvents && line.words.length > 1) {
      // Each word appears sequentially with pop duration
      const popDurationCs = template.wordPopDurationCs;
      const totalLineDurationMs = (line.end - line.start) * 1000;
      const wordCount = line.words.length;
      // Spread words evenly across the line duration
      const wordIntervalCs = Math.max(1, Math.round(totalLineDurationMs / 10 / wordCount));

      for (let wi = 0; wi < line.words.length; wi++) {
        const word = line.words[wi];
        const wordStart = line.start + (wi / wordCount) * (line.end - line.start);
        // Each word is visible from its start time to the next word's start
        const wordEnd = wi < wordCount - 1
          ? line.start + ((wi + 1) / wordCount) * (line.end - line.start)
          : line.end;

        const wStartTime = formatAssTime(wordStart);
        const wEndTime = formatAssTime(wordEnd);
        const effectiveColor = word.emphasisColor || baseColor;

        // Use \K for timed reveal of this single word
        const wordDurationCs = Math.max(1, Math.round((wordEnd - wordStart) * 100));
        const wordText = `{\\K${wordDurationCs}\\c${effectiveColor}}${escapeAssText(word.text)}`;

        events += `Dialogue: 0,${wStartTime},${wEndTime},${style},,0,0,0,,${wordText}\n`;
      }
    } else {
      // Standard line-level karaoke with emphasis-aware word coloring
      let karaokeText = '';
      for (let wi = 0; wi < line.words.length; wi++) {
        const word = line.words[wi];
        const wordDuration = Math.round((word.end - word.start) * 100); // centiseconds for \K
        const durationCs = Math.max(1, wordDuration);

        // Use emphasis color if set on the word, otherwise speaker color
        const effectiveColor = word.emphasisColor || baseColor;

        if (wi > 0) karaokeText += ' ';
        karaokeText += `{\\K${durationCs}\\c${effectiveColor}}${escapeAssText(word.text)}`;
      }

      events += `Dialogue: 0,${lineStartTime},${lineEndTime},${style},,0,0,0,,${karaokeText}\n`;
    }
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
 * @param subtitleStyle - Subtitle template name (default: 'opus')
 * @returns SubtitleRenderResult with path to .ass file
 */
export function renderSubtitles(
  words: WordTimestamp[],
  speakerSegments: SpeakerLabel[],
  clipStart: number,
  clipEnd: number,
  outputDir: string,
  filename: string,
  subtitleStyle: SubtitleTemplateId = DEFAULT_TEMPLATE,
): SubtitleRenderResult {
  // Ensure output directory exists
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  const assContent = generateAssSubtitle(words, speakerSegments, clipStart, clipEnd, DEFAULT_CONFIG, subtitleStyle);
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
