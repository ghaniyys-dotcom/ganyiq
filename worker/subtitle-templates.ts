/**
 * worker/subtitle-templates.ts — Word-by-word subtitle template system for GANYIQ V3 (P0.5).
 *
 * Defines 7 professional subtitle templates inspired by top creators and platforms:
 *
 *   1. Opus Style      — Viral gold accent, curved bg, word-by-word pop
 *   2. Hormozi Style   — Bold white, thick outline, 1-line max, high contrast
 *   3. Gadzhi Style    — Minimal, serif, center, warm off-white
 *   4. MrBeast Style   — Big yellow bold, thick black outline, full width
 *   5. Podcast Minimal — Small clean sans, no background, bottom-only
 *   6. Documentary     — Thin serif, lower-third, elegant
 *   7. Clean Corporate — Medium sans, rounded bg pill, professional blue
 *
 * Each template controls:
 *   - Font family, size, weight
 *   - Outline width, background opacity/style
 *   - Color palette (primary, accent, outline, background)
 *   - Per-word rendering behavior (static vs animated, word-by-word pop)
 *   - Emphasis highlighting strategy
 *   - Positioning (vertical offset, max lines, char limit)
 *
 * The template system integrates with the existing ASS karaoke (\K) pipeline.
 * Word-by-word pop effect is achieved by giving each word its own Dialogue line
 * with a brief duration, creating the appearance of sequential word reveal.
 */

import type { SubtitleConfig, SubtitleWord } from './subtitle-renderer';

// ---------------------------------------------------------------------------
// Template ID and Names
// ---------------------------------------------------------------------------

export type SubtitleTemplateId =
  | 'opus'
  | 'hormozi'
  | 'gadzhi'
  | 'mrbeast'
  | 'podcast_minimal'
  | 'documentary'
  | 'clean_corporate';

export const TEMPLATE_NAMES: Record<SubtitleTemplateId, string> = {
  opus: 'Opus Style',
  hormozi: 'Alex Hormozi Style',
  gadzhi: 'Iman Gadzhi Style',
  mrbeast: 'MrBeast Style',
  podcast_minimal: 'Podcast Minimal',
  documentary: 'Documentary',
  clean_corporate: 'Clean Corporate',
};

// ---------------------------------------------------------------------------
// Template Interface
// ---------------------------------------------------------------------------

/**
 * Per-word rendering behavior.
 *   - 'karaoke'    : Standard \K timed reveal (existing behavior)
 *   - 'word_pop'   : Each word appears with a pop-in animation (short \K, position offset)
 *   - 'word_by_word': Each word gets its own Dialogue line with brief \K timing
 *   - 'static_line': Full line appears at once (no karaoke)
 */
export type WordRenderMode = 'karaoke' | 'word_pop' | 'word_by_word' | 'static_line';

export interface SubtitleTemplate {
  /** Unique identifier. */
  id: SubtitleTemplateId;
  /** Display name. */
  name: string;
  /** Base SubtitleConfig overrides. */
  config: Partial<SubtitleConfig> & {
    fontName: string;
    fontSize: number;
    outlineWidth: number;
    backgroundOpacity: number;
    verticalPosition: number;
    maxLines: number;
    maxCharsPerLine: number;
  };
  /** Per-word rendering mode. */
  wordRenderMode: WordRenderMode;
  /** Color palette in ASS format (&H00BBGGRR). */
  colors: {
    primary: string;       // Main text color (white usually)
    accent: string;        // Emphasis/highlight color
    dim: string;           // Filler/dimmed text
    outline: string;       // Outline color
    background: string;    // Background box fill
    speakerA: string;      // Speaker A color
    speakerB: string;      // Speaker B color
    speakerC: string;      // Speaker C color
  };
  /**
   * Emphasis strategy:
   *   - 'full'         : Use P0.4 emphasis engine highlights (gold for numbers/money/names)
   *   - 'accent_only'  : Only use emphasis for strong hooks/numbers; dim fillers
   *   - 'off'          : No emphasis highlighting
   *   - 'all_caps'     : Show emphasized words in ALL CAPS
   */
  emphasisStrategy: 'full' | 'accent_only' | 'off' | 'all_caps';
  /**
   * Style-specific ASS style definitions to add to the file header.
   * Each entry is { name, definition } where definition is the full style line values.
   */
  extraStyles: Array<{ name: string; definition: string }>;
  /**
   * Optional per-word transform before rendering.
   * Allows All-caps, capitalization, or other text transforms.
   */
  transformWord?: (text: string, isEmphasis: boolean) => string;
  /**
   * If true, renders each word as its own Dialogue event for pop-in effect.
   * When false (default), uses standard line-level karaoke.
   */
  wordByWordEvents: boolean;
  /**
   * Word pop animation duration in centiseconds (for word_by_word mode).
   * Each word gets this duration before the next word appears.
   */
  wordPopDurationCs: number;
  /**
   * Vertical offset per word for word_by_word mode.
   * Words can stack vertically (0 means same line, positive means upward).
   */
  wordStackGap: number;
}

// ---------------------------------------------------------------------------
// Template Presets
// ---------------------------------------------------------------------------

/**
 * 1. Opus Style
 * Viral gold accent, rounded dark background, word-by-word pop.
 * Mimics the popular OpusClip subtitle look.
 */
const OPUS_TEMPLATE: SubtitleTemplate = {
  id: 'opus',
  name: 'Opus Style',
  config: {
    fontName: 'Geist Sans',
    fontSize: 32,
    outlineWidth: 3,
    backgroundOpacity: 0.12,
    verticalPosition: 10,
    maxLines: 1,
    maxCharsPerLine: 36,
  },
  wordRenderMode: 'word_by_word',
  colors: {
    primary: '&H00FFFFFF',
    accent: '&H0066C2E2',     // gold (#E2C266 → BGR: 66C2E2)
    dim: '&H00888888',
    outline: '&H00000000',
    background: '&H22000000',  // semi-transparent black
    speakerA: '&H0066C2E2',   // gold
    speakerB: '&H0066B9E2',   // blue
    speakerC: '&H00E266B9',   // pink
  },
  emphasisStrategy: 'full',
  extraStyles: [],
  wordByWordEvents: true,
  wordPopDurationCs: 8,   // 80ms per word reveal
  wordStackGap: 0,
};

/**
 * 2. Hormozi Style
 * Bold white + thick black outline, single line, high contrast.
 * Maximizes readability on fast-scrolling feeds.
 */
const HORMOZI_TEMPLATE: SubtitleTemplate = {
  id: 'hormozi',
  name: 'Alex Hormozi Style',
  config: {
    fontName: 'Geist Sans',
    fontSize: 38,
    outlineWidth: 5,
    backgroundOpacity: 0,
    verticalPosition: 8,
    maxLines: 1,
    maxCharsPerLine: 30,
  },
  wordRenderMode: 'static_line',
  colors: {
    primary: '&H00FFFFFF',
    accent: '&H0066C2E2',     // gold
    dim: '&H00666666',
    outline: '&H00000000',
    background: '&H00000000',  // transparent
    speakerA: '&H0066C2E2',
    speakerB: '&H0066B9E2',
    speakerC: '&H00E266B9',
  },
  emphasisStrategy: 'accent_only',
  extraStyles: [],
  wordByWordEvents: false,
  wordPopDurationCs: 0,
  wordStackGap: 0,
};

/**
 * 3. Gadzhi Style
 * Minimal serif, center-aligned, warm off-white, elegant.
 * Used by Iman Gadzhi — clean, premium feel.
 */
const GADZHI_TEMPLATE: SubtitleTemplate = {
  id: 'gadzhi',
  name: 'Iman Gadzhi Style',
  config: {
    fontName: 'EB Garamond',
    fontSize: 34,
    outlineWidth: 1,
    backgroundOpacity: 0.06,
    verticalPosition: 12,
    maxLines: 2,
    maxCharsPerLine: 38,
  },
  wordRenderMode: 'karaoke',
  colors: {
    primary: '&H00E8E0D0',     // warm off-white
    accent: '&H0066C2E2',     // gold
    dim: '&H00808080',
    outline: '&H00000000',
    background: '&H18000000',  // very subtle bg
    speakerA: '&H0066C2E2',
    speakerB: '&H0066B9E2',
    speakerC: '&H00E266B9',
  },
  emphasisStrategy: 'accent_only',
  extraStyles: [],
  wordByWordEvents: false,
  wordPopDurationCs: 0,
  wordStackGap: 0,
};

/**
 * 4. MrBeast Style
 * Big yellow bold, thick black outline, full width.
 * Max impact, minimal subtlety.
 */
const MRBEAST_TEMPLATE: SubtitleTemplate = {
  id: 'mrbeast',
  name: 'MrBeast Style',
  config: {
    fontName: 'Impact',
    fontSize: 44,
    outlineWidth: 6,
    backgroundOpacity: 0,
    verticalPosition: 14,
    maxLines: 1,
    maxCharsPerLine: 28,
  },
  wordRenderMode: 'word_pop',
  colors: {
    primary: '&H0033CCFF',     // bright yellow (#FFCC33 → BGR: 33CCFF)
    accent: '&H00FFFFFF',      // white for emphasis
    dim: '&H00888888',
    outline: '&H00000000',
    background: '&H00000000',   // no bg
    speakerA: '&H0033CCFF',    // yellow
    speakerB: '&H0066B9E2',   // blue
    speakerC: '&H00E266B9',   // pink
  },
  emphasisStrategy: 'all_caps',
  extraStyles: [
    {
      name: 'Highlight',
      definition: '&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,6,0,2,40,40,0,1',
    },
  ],
  wordByWordEvents: true,
  wordPopDurationCs: 6,   // 60ms — faster pop
  wordStackGap: 0,
  transformWord: (text: string, isEmphasis: boolean) => {
    return isEmphasis ? text.toUpperCase() : text;
  },
};

/**
 * 5. Podcast Minimal
 * Small clean sans, no background, bottom-only, unobtrusive.
 * Good for professional podcasts where audio is primary.
 */
const PODCAST_MINIMAL_TEMPLATE: SubtitleTemplate = {
  id: 'podcast_minimal',
  name: 'Podcast Minimal',
  config: {
    fontName: 'Geist Sans',
    fontSize: 26,
    outlineWidth: 2,
    backgroundOpacity: 0,
    verticalPosition: 8,
    maxLines: 2,
    maxCharsPerLine: 42,
  },
  wordRenderMode: 'karaoke',
  colors: {
    primary: '&H00FFFFFF',
    accent: '&H0066C2E2',     // gold
    dim: '&H00999999',
    outline: '&H00000000',
    background: '&H00000000',  // no bg
    speakerA: '&H0066C2E2',
    speakerB: '&H0066B9E2',
    speakerC: '&H00E266B9',
  },
  emphasisStrategy: 'accent_only',
  extraStyles: [],
  wordByWordEvents: false,
  wordPopDurationCs: 0,
  wordStackGap: 0,
};

/**
 * 6. Documentary
 * Thin serif, lower-third positioning, elegant uppercase labels.
 * Good for talking-head commentary and documentary content.
 */
const DOCUMENTARY_TEMPLATE: SubtitleTemplate = {
  id: 'documentary',
  name: 'Documentary',
  config: {
    fontName: 'EB Garamond',
    fontSize: 30,
    outlineWidth: 1,
    backgroundOpacity: 0.04,
    verticalPosition: 15,
    maxLines: 2,
    maxCharsPerLine: 40,
  },
  wordRenderMode: 'karaoke',
  colors: {
    primary: '&H00F0E8D0',     // warm off-white
    accent: '&H0066C2E2',     // gold emphasis
    dim: '&H00777777',
    outline: '&H00000000',
    background: '&H10000000',
    speakerA: '&H0066C2E2',
    speakerB: '&H0066B9E2',
    speakerC: '&H00E266B9',
  },
  emphasisStrategy: 'accent_only',
  extraStyles: [],
  wordByWordEvents: false,
  wordPopDurationCs: 0,
  wordStackGap: 0,
};

/**
 * 7. Clean Corporate
 * Medium sans with rounded background pill, professional blue accent.
 * Good for business content, interview clips, and educational.
 */
const CLEAN_CORPORATE_TEMPLATE: SubtitleTemplate = {
  id: 'clean_corporate',
  name: 'Clean Corporate',
  config: {
    fontName: 'Geist Sans',
    fontSize: 30,
    outlineWidth: 0,
    backgroundOpacity: 0.15,
    verticalPosition: 10,
    maxLines: 2,
    maxCharsPerLine: 40,
  },
  wordRenderMode: 'karaoke',
  colors: {
    primary: '&H00FFFFFF',
    accent: '&H0022AADD',     // professional blue
    dim: '&H00888888',
    outline: '&H00000000',
    background: '&H26000000',  // dark pill background
    speakerA: '&H0022AADD',   // blue
    speakerB: '&H0066B9E2',   // lighter blue
    speakerC: '&H00E266B9',   // pink
  },
  emphasisStrategy: 'accent_only',
  extraStyles: [],
  wordByWordEvents: false,
  wordPopDurationCs: 0,
  wordStackGap: 0,
};

// ---------------------------------------------------------------------------
// Template Registry
// ---------------------------------------------------------------------------

const TEMPLATE_REGISTRY: Record<SubtitleTemplateId, SubtitleTemplate> = {
  opus: OPUS_TEMPLATE,
  hormozi: HORMOZI_TEMPLATE,
  gadzhi: GADZHI_TEMPLATE,
  mrbeast: MRBEAST_TEMPLATE,
  podcast_minimal: PODCAST_MINIMAL_TEMPLATE,
  documentary: DOCUMENTARY_TEMPLATE,
  clean_corporate: CLEAN_CORPORATE_TEMPLATE,
};

/**
 * Get a template by ID. Falls back to Opus style if not found.
 */
export function getTemplate(id: string): SubtitleTemplate {
  return TEMPLATE_REGISTRY[id as SubtitleTemplateId] || OPUS_TEMPLATE;
}

/**
 * Get all available templates for frontend selection.
 */
export function getAllTemplates(): Array<{ id: string; name: string }> {
  return Object.entries(TEMPLATE_NAMES).map(([id, name]) => ({ id, name }));
}

// ---------------------------------------------------------------------------
// Template → SubtitleConfig Converter
// ---------------------------------------------------------------------------

/**
 * Build a full SubtitleConfig from a template, with optional overrides.
 */
export function templateToConfig(template: SubtitleTemplate): SubtitleConfig {
  return {
    fontName: template.config.fontName,
    fontSize: template.config.fontSize,
    outlineWidth: template.config.outlineWidth,
    backgroundOpacity: template.config.backgroundOpacity,
    verticalPosition: template.config.verticalPosition,
    maxLines: template.config.maxLines,
    maxCharsPerLine: template.config.maxCharsPerLine,
    speakerColors: new Map([
      ['SPEAKER_00', template.colors.speakerA],
      ['SPEAKER_01', template.colors.speakerB],
      ['SPEAKER_02', template.colors.speakerC],
      ['SPEAKER_03', template.colors.speakerB],
      ['SPEAKER_04', template.colors.speakerC],
      ['default', template.colors.speakerA],
    ]),
  };
}

/**
 * Get the ASS BGR-format color for emphasis based on the template's palette.
 */
export function getTemplateEmphasisColor(
  template: SubtitleTemplate,
  isHighlight: boolean,
  isDim: boolean,
): string {
  if (isHighlight) return template.colors.accent;
  if (isDim) return template.colors.dim;
  return template.colors.primary;
}

/**
 * Apply template-specific word transformation.
 */
export function transformWordForTemplate(
  text: string,
  isEmphasis: boolean,
  template: SubtitleTemplate,
): string {
  if (template.transformWord) {
    return template.transformWord(text, isEmphasis);
  }
  return text;
}

// ---------------------------------------------------------------------------
// ASS Style Header Builder
// ---------------------------------------------------------------------------

/**
 * Build the [V4+ Styles] section for a given template.
 * Returns complete style lines (without Format header).
 */
export function buildTemplateStyles(
  template: SubtitleTemplate,
  marginVertical: number,
): string {
  const { fontName, fontSize, outlineWidth } = template.config;
  const { primary, accent, outline, background } = template.colors;

  // Primary style
  const primaryStyle = `Style: Default,${fontName},${fontSize},${primary},${primary},${outline},${background},1,0,0,0,100,100,0,0,1,${outlineWidth},0,2,40,40,${marginVertical},1`;

  // Highlight style (for emphasis words)
  const highlightStyle = `Style: Highlight,${fontName},${fontSize},${accent},${primary},${outline},${background},1,0,0,0,100,100,0,0,1,${outlineWidth},0,2,40,40,${marginVertical},1`;

  // Speaker alt colors
  const altSpeakerStyle = `Style: AltSpeaker,${fontName},${fontSize},${template.colors.speakerB},${primary},${outline},${background},1,0,0,0,100,100,0,0,1,${outlineWidth},0,2,40,40,${marginVertical},1`;

  let styles = `${primaryStyle}\n${highlightStyle}\n${altSpeakerStyle}`;

  // Add extra template-specific styles
  for (const extra of template.extraStyles) {
    styles += `\nStyle: ${extra.name},${fontName},${fontSize},${extra.definition}`;
  }

  return styles;
}
