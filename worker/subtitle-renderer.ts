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
  isHighlight?: boolean;
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
  decisionSegments?: any[],
): string {
  const clipDuration = clipEnd - clipStart;

  // Filter words within clip range
  const clipWords = words.filter(w => w.start >= clipStart && w.end <= clipEnd);

  // ── P0.4: Validate word timestamps ──
  const wordsPerSecond = clipDuration > 0 ? (clipWords.length / clipDuration) : 0;
  log('TIMING', `Raw input: ${words.length} words total, ${clipWords.length} within clip (${clipDuration.toFixed(1)}s clip, ${wordsPerSecond.toFixed(1)} words/sec)`);

  // Validate: human speech is ~1.5-4 words/second
  if (wordsPerSecond > 6) {
    log('WARN', `ABNORMAL word density: ${wordsPerSecond.toFixed(1)} words/sec (expected 1.5-4). Timestamps may be corrupted.`);
    log('WARN', `First 5 word timestamps: ${clipWords.slice(0, 5).map(w => `${w.word}@${w.start}-${w.end}`).join(', ')}`);
  }

  // Clamp word count: filter out zero-duration and super-short words
  const validWords = clipWords.filter(w => {
    const duration = w.end - w.start;
    return duration > 0.01 && duration < 5.0; // skip corrupt timestamps
  });

  if (validWords.length < clipWords.length) {
    log('TIMING', `Filtered ${clipWords.length - validWords.length} corrupt word timestamps (zero/negative/super-long duration)`);
  }

  // ── P0.4: Detect timestamp source ──
  // Deepgram returns confidence per word; Whisper returns 1.0 for all
  const avgConfidence = validWords.length > 0
    ? validWords.reduce((s, w) => s + w.confidence, 0) / validWords.length
    : 0;
  const sourceHint = avgConfidence > 0 && avgConfidence < 0.99 ? 'deepgram' : 'whisper/unknown';
  log('TIMING', `Word timestamp source hint: ${sourceHint} (avg confidence: ${avgConfidence.toFixed(3)})`);

  // P0.4: Run emphasis analysis on the words
  const emphasis = analyzeWordEmphasis(validWords, speakerSegments);
  if (emphasis.stats.highlighted > 0 || emphasis.stats.dimmed > 0) {
    log('EMPHASIS', `${emphasis.stats.highlighted}/${emphasis.stats.totalWords} highlighted (${emphasis.stats.percentageHighlighted}%), ${emphasis.stats.dimmed} dimmed`);
  }

  // P0.5: Get template
  const template = getTemplate(templateName);
  log('TEMPLATE', `Using template: ${template.name} (${template.wordRenderMode})`);

  // Group words into lines with emphasis coloring
  const lines = groupWordsIntoLines(validWords, speakerSegments, clipStart, clipEnd, emphasis, template);

  // P0.4: Validate output timing
  if (lines.length > 0) {
    const lastLineEnd = lines[lines.length - 1].end;
    const totalSubtitleDuration = lastLineEnd;
    log('TIMING', `Generated: ${lines.length} subtitle lines, total duration ${totalSubtitleDuration.toFixed(1)}s (clip: ${clipDuration.toFixed(1)}s)`);
    if (Math.abs(totalSubtitleDuration - clipDuration) > 5.0) {
      log('WARN', `TIMING MISMATCH: subtitle duration (${totalSubtitleDuration.toFixed(1)}s) != clip duration (${clipDuration.toFixed(1)}s)`);
    }
  } else {
    log('WARN', 'No subtitle lines generated — speech may be silent or timestamps empty');
  }

  // Build ASS file
  const assContent = buildAssFile(lines, config, clipDuration, template, decisionSegments, clipStart);
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
      isHighlight,
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
        words: currentLineWords.map(w => ({
          ...w,
          start: w.start - clipStart,
          end: w.end - clipStart,
        })),
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
      words: currentLineWords.map(w => ({
        ...w,
        start: w.start - clipStart,
        end: w.end - clipStart,
      })),
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
function getLayoutPositionTag(
  lineStart: number,
  lineEnd: number,
  decisionSegments?: any[],
  clipStart?: number,
): string {
  if (!decisionSegments || decisionSegments.length === 0 || clipStart === undefined) return '';
  const mid = (lineStart + lineEnd) / 2;
  const seg = decisionSegments.find(s => {
    const relStart = s.startTime - clipStart;
    const relEnd = s.endTime - clipStart;
    return mid >= relStart && mid <= relEnd;
  });
  if (!seg) return '';

  switch (seg.mode) {
    case 'split_2':
      return '{\\pos(540,960)}';
    case 'split_3':
      return '{\\pos(540,1280)}';
    case 'split_4':
      return '{\\pos(540,960)}';
    case 'hero_reaction':
      return '{\\pos(540,1100)}';
    default:
      return '';
  }
}

function buildAssFile(
  lines: SubtitleLine[],
  config: SubtitleConfig,
  clipDuration: number,
  template?: SubtitleTemplate,
  decisionSegments?: any[],
  clipStart?: number,
): string {
  const resolutionX = 1080; // vertical video width
  const resolutionY = 1920; // vertical video height

  // Calculate vertical position (from bottom)
  const marginBottom = Math.round(resolutionY * (config.verticalPosition / 100));
  const marginVertical = marginBottom;

  const defaultSize = template?.config?.fontSize || config.fontSize;
  const highlightSize = Math.round(defaultSize * 1.15); // 15% larger for highlighted words

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

    // Get layout-aware position tag
    const posTag = getLayoutPositionTag(line.start, line.end, decisionSegments, clipStart);

    // P0.5: Static line mode — full line appears instantly, no word-by-word reveal
    if (template && template.wordRenderMode === 'static_line') {
      let lineText = posTag;
      for (let wi = 0; wi < line.words.length; wi++) {
        const word = line.words[wi];
        const effectiveColor = word.emphasisColor || baseColor;
        let sizeTag = '';
        if (word.isHighlight) {
          sizeTag = `\\fs${highlightSize}`;
        }
        if (wi > 0) lineText += ' ';
        if (sizeTag) {
          lineText += `{${sizeTag}\\c${effectiveColor}}${escapeAssText(word.text)}{\\fs${defaultSize}}`;
        } else {
          lineText += `{\\c${effectiveColor}}${escapeAssText(word.text)}`;
        }
      }
      events += `Dialogue: 0,${lineStartTime},${lineEndTime},${style},,0,0,0,,${lineText}\n`;
    }
    // P0.5: Opus-style word-by-word pop — words accumulate, current word highlighted
    else if (template && template.wordByWordEvents && line.words.length > 1) {
      const wordCount = line.words.length;
      const wordTimings: Array<{ start: number; end: number }> = [];

      for (let wi = 0; wi < wordCount; wi++) {
        // Clamp relative word times to line boundaries
        const wStart = Math.max(line.start, Math.min(line.end, line.words[wi].start));
        const wEnd = wi < wordCount - 1
          ? Math.max(line.start, Math.min(line.end, line.words[wi + 1].start))
          : line.end;
        wordTimings.push({ start: wStart, end: wEnd });
      }

      const DIM_COLOR = '&H00888888';  // gray for consumed words
      const ACCENT_COLOR = template.colors.accent;  // gold/accent for active word

      for (let wi = 0; wi < wordCount; wi++) {
        const wStart = wordTimings[wi].start;
        const wEnd = wordTimings[wi].end;

        let accText = posTag;
        for (let ji = 0; ji <= wi; ji++) {
          const w = line.words[ji];
          const isCurrent = (ji === wi);
          const wordColor = isCurrent ? ACCENT_COLOR : DIM_COLOR;
          const effectiveWordColor = w.emphasisColor || wordColor;
          let sizeTag = '';
          if (w.isHighlight) {
            sizeTag = `\\fs${highlightSize}`;
          }
          if (ji > 0) accText += ' ';
          if (sizeTag) {
            accText += `{${sizeTag}\\c${effectiveWordColor}}${escapeAssText(w.text)}{\\fs${defaultSize}}`;
          } else {
            accText += `{\\c${effectiveWordColor}}${escapeAssText(w.text)}`;
          }
        }

        const wStartTimeFmt = formatAssTime(wStart);
        const wEndTimeFmt = formatAssTime(Math.max(wStart + 0.05, Math.min(wEnd, line.end)));

        if (wEnd > wStart + 0.01) {
          events += `Dialogue: 0,${wStartTimeFmt},${wEndTimeFmt},${style},,0,0,0,,${accText}\n`;
        }
      }

      // Final event: all dim (full line visible after last word)
      let finalDimText = posTag;
      for (let wi = 0; wi < wordCount; wi++) {
        const w = line.words[wi];
        if (wi > 0) finalDimText += ' ';
        finalDimText += `{\\c${DIM_COLOR}}${escapeAssText(w.text)}`;
      }
      const lastWordStart = wordTimings[wordCount - 1].start;
      const dimEndTime = line.end;
      if (dimEndTime - lastWordStart > 0.1) {
        events += `Dialogue: 0,${formatAssTime(lastWordStart)},${formatAssTime(dimEndTime)},${style},,0,0,0,,${finalDimText}\n`;
      }
    } else {
      // Standard line-level karaoke with precise gap timing and size overrides
      let karaokeText = posTag;
      let prevTime = line.start;

      for (let wi = 0; wi < line.words.length; wi++) {
        const word = line.words[wi];
        const gap = word.start - prevTime;
        if (gap > 0.01) {
          const gapCs = Math.round(gap * 100);
          karaokeText += `{\\K${gapCs}}`;
        }

        const wordDuration = Math.round((word.end - word.start) * 100);
        const durationCs = Math.max(1, wordDuration);
        const effectiveColor = word.emphasisColor || baseColor;

        let sizeTag = '';
        if (word.isHighlight) {
          sizeTag = `\\fs${highlightSize}`;
        }

        if (wi > 0 && gap <= 0) karaokeText += ' ';
        if (sizeTag) {
          karaokeText += `{\\K${durationCs}${sizeTag}\\c${effectiveColor}}${escapeAssText(word.text)}{\\fs${defaultSize}}`;
        } else {
          karaokeText += `{\\K${durationCs}\\c${effectiveColor}}${escapeAssText(word.text)}`;
        }
        if (gap > 0.01) karaokeText += ' ';

        prevTime = word.end;
      }

      // If line ends after the last word, pad with silence
      const finalGap = line.end - prevTime;
      if (finalGap > 0.01) {
        const finalGapCs = Math.round(finalGap * 100);
        karaokeText += `{\\K${finalGapCs}}`;
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
  decisionSegments?: any[],
): SubtitleRenderResult {
  // Ensure output directory exists
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  const assContent = generateAssSubtitle(words, speakerSegments, clipStart, clipEnd, DEFAULT_CONFIG, subtitleStyle, decisionSegments);
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
  // Escape colon for ffmpeg filter syntax: C:/path → C\:/path
  // Single backslash + colon tells ffmpeg the colon is part of the path, not a param separator
  const escapedPath = assFilePath.replace(/\\/g, '/').replace(/:/g, '\\:');
  return `ass='${escapedPath}'`;
}
