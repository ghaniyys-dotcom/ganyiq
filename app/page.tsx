'use client';

import React, { useState, FormEvent, useRef, useEffect, Fragment, Component, ReactNode, ErrorInfo } from 'react';

type Moment = {
  startTime: number;
  endTime: number;
  worthClippingScore: number;
  displayScore?: number;       // spread-adjusted score for UI (fixes compression)
  confidence: string;
  dnaTags: string[];
  reasoning: string;
  rank: number;
  tier: string;
  startTimestamp: string;
  endTimestamp: string;
  transcriptExcerpt: string;
  suggestedTitles?: Array<{ style: string; title: string }> | null;
  exportStrategy?: {
    currentDuration: number;
    conservative: { start: number; end: number; duration: number };
    balanced: { start: number; end: number; duration: number };
    aggressive: { start: number; end: number; duration: number };
    recommended: 'conservative' | 'balanced' | 'aggressive';
    reasons: string[];
    retentionImpact: { label: string; pct: number; confidence: string } | null;
  } | null;
};

type AnalysisResult = {
  analysisId: string;
  videoId: string;
  moments: Moment[];
  video?: {
    title: string;
    channelName: string;
    durationSeconds: number;
  };
  totalMomentsFound?: number;
  transcriptWords?: number;
};

type HistoryItem = {
  analysisId: string;
  videoId: string;
  title: string;
  channelName: string;
  thumbnailUrl: string;
  createdAt: string;
  totalMoments: number;
  avgScore: number | null;
};

type ClipStatus = 'idle' | 'generating' | 'ready' | 'failed';
type Stage = 'idle' | 'fetching' | 'extracting' | 'batched' | 'multipass' | 'ranking' | 'storing' | 'done' | 'error';

// Status response shape from polling
type StatusData = {
  analysisId: string;
  videoId?: string;
  status: string;
  stage?: string;
  moments?: Moment[];
  totalMomentsFound?: number;
  videoDuration?: number;
  transcriptWords?: number;
  error?: string;
  funnel?: {
    transcriptWords: number;
    transcriptSegments: number;
    candidateMoments: number;
    highSignalMoments: number;
    eliteMoments: number;
    finalRecommendations: number;
  } | null;
};

const DNA_SYMBOLS: Record<string, string> = {
  hookPower: '◇',
  curiosity: '▼',
  controversy: '▲',
  emotion: '♥',
  humor: '◆',
  storytelling: '✦',
  educational: '■',
  authority: '◈',
  money: '¤',
  shock: '⚡',
  motivation: '↑',
  relatability: '○',
  vulnerability: '♥',
  inspiration: '✦',
};

const DNA_DISPLAY_NAMES: Record<string, string> = {
  hookPower: 'Hook Power',
  curiosity: 'Curiosity',
  controversy: 'Controversy',
  emotion: 'Emotion',
  humor: 'Humor',
  storytelling: 'Storytelling',
  educational: 'Educational',
  authority: 'Authority',
  money: 'Money',
  shock: 'Shock Value',
  motivation: 'Motivation',
  relatability: 'Relatability',
  vulnerability: 'Vulnerability',
  inspiration: 'Inspiration',
};

// Title suggestion style labels
const STYLE_LABELS: Record<string, string> = {
  curiosity: 'Curiosity',
  emotional: 'Emotional',
  viral: 'Viral',
  story: 'Story',
  professional: 'Professional',
};

// Helper: get the best score to display (spread-adjusted if available)
function displayScore(m: Moment): number {
  return m.displayScore ?? m.worthClippingScore;
}

// Scored labels (Feature 2)
function getScoreLabel(score: number): string {
  if (score >= 95) return 'Exceptional';
  if (score >= 90) return 'Very Strong';
  if (score >= 80) return 'Strong';
  if (score >= 70) return 'Good';
  return 'Moderate';
}

// ── CLIP DNA PROFILE (deterministic, no fake precision) ──

type DnaLevel = 'strong' | 'high' | 'medium' | 'low';

interface DnaProfileItem {
  label: string;
  key: string;
  level: DnaLevel | null;
}

const DNA_PROFILE_COMPONENTS = [
  { label: 'Hook Strength',  key: 'hook',      primaryTag: 'hookPower',      relatedTags: ['curiosity'] },
  { label: 'Storytelling',   key: 'story',     primaryTag: 'storytelling',   relatedTags: ['humor'] },
  { label: 'Emotion',        key: 'emotion',   primaryTag: 'emotion',        relatedTags: ['vulnerability', 'motivation', 'inspiration'] },
  { label: 'Authority',      key: 'authority', primaryTag: 'authority',      relatedTags: ['educational'] },
  { label: 'Retention',      key: 'retention', primaryTag: null,             relatedTags: ['hookPower', 'curiosity', 'humor', 'shock'] },
  { label: 'Relatability',   key: 'relate',    primaryTag: 'relatability',   relatedTags: ['humor', 'vulnerability'] },
];

const LEVEL_LABELS: Record<string, string> = {
  strong: 'Strong',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

const LEVEL_BAR_SEGMENTS: Record<string, number> = {
  strong: 10,
  high: 7,
  medium: 5,
  low: 3,
};

function deriveDnaLevel(
  label: string, primaryTag: string | null, relatedTags: string[],
  dnaTags: string[], confidence: string, score: number,
): DnaLevel | null {
  // Retention (composite)
  if (primaryTag === null) {
    const tagSet = new Set(dnaTags);
    const diversity = tagSet.size;
    const hasHookSignal = dnaTags.some(t => ['hookPower', 'curiosity', 'humor', 'shock'].includes(t));
    if (hasHookSignal && diversity >= 2 && confidence === 'high' && score >= 85) return 'strong';
    if (hasHookSignal && diversity >= 1) return 'high';
    if (diversity >= 2 || confidence === 'low') return 'medium';
    return 'low';
  }

  // Standard component
  const primaryFound = dnaTags.includes(primaryTag);
  const relatedFound = relatedTags.some(t => dnaTags.includes(t));

  if (primaryFound) {
    if (confidence === 'high' && score >= 85) return 'strong';
    if (confidence === 'high' || confidence === 'medium') return 'high';
    return 'medium';
  }
  if (relatedFound) return 'medium';
  return 'low';
}

function renderDnaProfile(
  score: number, confidence: string, dnaTags: string[],
) {
  const items = DNA_PROFILE_COMPONENTS.map(c => ({
    ...c,
    level: deriveDnaLevel(c.label, c.primaryTag, c.relatedTags, dnaTags, confidence, score),
  }));

  return (
    <div className="dna-profile">
      <div className="dna-profile-title">CLIP DNA PROFILE</div>
      <div className="dna-profile-grid">
        {items.map(item => {
          const segs = item.level ? LEVEL_BAR_SEGMENTS[item.level] : 0;
          const label = item.level ? LEVEL_LABELS[item.level] : '—';
          return (
            <div key={item.key} className="dna-row">
              <span className="dna-row-label">{item.label}</span>
              <div className="dna-row-bar">
                {Array.from({ length: 10 }).map((_, i) => (
                  <div
                    key={i}
                    className={`dna-bar-seg${i < segs ? ` ${item.level}` : ''}`}
                  />
                ))}
              </div>
              <span className={`dna-row-level ${item.level || ''}`}>{label}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── WHY RANKED #X (deterministic ranking signals) ──

interface RankingSignal {
  label: string;
  active: boolean;
}

function deriveRankingSignals(
  rank: number,
  score: number,
  confidence: string,
  dnaTags: string[],
  duration: number,
  totalMoments: number,
): RankingSignal[] {
  const signals: RankingSignal[] = [];

  // Always show rank context
  if (totalMoments > 0) {
    const pct = Math.round(((totalMoments - rank) / totalMoments) * 100);
    signals.push({
      label: `Outscored ${pct}% of candidates (ranked #${rank} of ${totalMoments})`,
      active: true,
    });
  }

  // DNA-based signals — only show if active
  if (dnaTags.includes('hookPower') && confidence === 'high' && score >= 80) {
    signals.push({ label: 'Strong hook that grabs attention immediately', active: true });
  }

  if (dnaTags.includes('storytelling')) {
    signals.push({ label: 'Clear narrative structure with setup → payoff', active: true });
  }

  if (dnaTags.some(t => ['emotion', 'motivation', 'inspiration', 'vulnerability'].includes(t))) {
    signals.push({ label: 'Emotional resonance that drives engagement', active: true });
  }

  if (dnaTags.some(t => ['curiosity', 'shock', 'humor'].includes(t)) && score >= 80) {
    signals.push({ label: 'High replay and share potential', active: true });
  }

  if (dnaTags.some(t => ['relatability', 'humor', 'vulnerability'].includes(t))) {
    signals.push({ label: 'Strong audience relatability', active: true });
  }

  if (dnaTags.includes('storytelling') && duration < 90) {
    signals.push({ label: 'Compact story arc within a short window', active: true });
  }

  if (dnaTags.some(t => ['authority', 'educational'].includes(t)) && confidence === 'high') {
    signals.push({ label: 'Authority-driven insight with credible delivery', active: true });
  }

  if (dnaTags.some(t => ['controversy', 'shock'].includes(t))) {
    signals.push({ label: 'Bold or surprising take that sparks discussion', active: true });
  }

  if (dnaTags.length >= 3) {
    signals.push({ label: 'Rich content density across multiple DNA signals', active: true });
  }

  return signals;
}

function renderRankingSignals(
  rank: number,
  score: number,
  confidence: string,
  dnaTags: string[],
  duration: number,
  totalMoments: number,
) {
  const total = totalMoments > 0 ? totalMoments : 0;
  const signals = deriveRankingSignals(rank, score, confidence, dnaTags, duration, total);
  if (signals.length === 0) return null;

  return (
    <div className="ws-section">
      <h3 className="ws-section-title">Why Ranked #{rank}</h3>
      <div className="rank-signals">
        {signals.map((s, i) => (
          <div key={i} className={`rank-signal${s.active ? '' : ' inactive'}`}>
            <span className="rank-signal-check">{s.active ? '✓' : '—'}</span>
            <span className="rank-signal-text">{s.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Best Hook — extract strongest opening sentence from transcript ──

function extractHookSentence(text: string): string {
  // Natural pause markers for Indonesian conversational text (escaped for RegExp)
  const pauseMarkers = ['\\. ', '! ', '\\? ', ',\\s*', ' tapi ', ' karena ', ' kalau ', ' jadi ', ' cuman ', ' makanya ', ' terus ', ' nah ', ' iya ', ' ya ', ' gitu ', ' pas ', ' waktu ', ' ketika ', ' tiba-tiba '];
  
  // Try to find first natural pause within first 15 words
  const words = text.trim().split(/\s+/);
  const first15 = words.slice(0, 15).join(' ');
  
  for (const marker of pauseMarkers) {
    const idx = first15.search(new RegExp(marker, 'i'));
    if (idx > 5 && idx < first15.length - 3) {
      return first15.slice(0, idx).trim();
    }
  }
  
  // No natural pause found → cut at ~12 words
  const cutoff = Math.min(12, words.length);
  let hook = words.slice(0, cutoff).join(' ');
  if (!hook.endsWith('.') && !hook.endsWith('!') && !hook.endsWith('?')) {
    hook += '...';
  }
  return hook;
}

function getHookWhy(dnaTags: string[], confidence: string, score: number, reasoning: string): string {
  const parts: string[] = [];
  
  // Use the strongest signal from DNA tags
  const tagMap: Record<string, string> = {
    hookPower: 'Starts with an instant attention grab',
    curiosity: 'Opens with a question or mystery that demands an answer',
    controversy: 'First words challenge expectations',
    shock: 'Opens with a statement that stops scroll',
    humor: 'Opens with unexpected humor or irony',
    storytelling: 'Opens mid-narrative, dropping you into the action',
    emotion: 'Starts with raw emotional charge',
    vulnerability: 'Opens with personal honesty that builds instant trust',
    authority: 'Opens with a strong opinion or factual claim',
    motivation: 'First words carry inspirational weight',
  };
  
  // Find the most relevant tag description
  for (const tag of dnaTags) {
    if (tagMap[tag]) {
      parts.push(tagMap[tag]);
      break;
    }
  }
  
  // Score context
  if (score >= 90) {
    parts.push('Top-tier engagement potential');
  } else if (score >= 80) {
    parts.push('Strong engagement potential');
  }
  
  // Reasoning snippet (short)
  if (reasoning) {
    const short = reasoning.length > 80 ? reasoning.slice(0, 77) + '...' : reasoning;
    parts.push(short);
  }
  
  return parts.join(' · ');
}

function renderBestHook(
  transcriptExcerpt: string,
  dnaTags: string[],
  confidence: string,
  score: number,
  reasoning: string,
) {
  if (!transcriptExcerpt || transcriptExcerpt.trim().length < 10) return null;
  
  const hook = extractHookSentence(transcriptExcerpt);
  const why = getHookWhy(dnaTags, confidence, score, reasoning);
  
  return (
    <div className="best-hook">
      <p className="best-hook-text">&ldquo;{hook}&rdquo;</p>
      <p className="best-hook-why">{why}</p>
    </div>
  );
}

// ── Export Strategy ──
const EXPORT_LABELS: Record<string, string> = {
  conservative: 'Conservative',
  balanced: 'Balanced',
  aggressive: 'Aggressive',
};

function renderExportStrategy(moment: Moment) {
  const es = moment.exportStrategy;
  if (!es) return null;

  const fmt = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  };

  const recLabel = EXPORT_LABELS[es.recommended] || 'Balanced';
  const recDur = es[es.recommended].duration;
  const recStart = es[es.recommended].start;
  const recEnd = es[es.recommended].end;

  return (
    <div className="export-strategy">
      <h3 className="ws-section-title">EXPORT STRATEGY</h3>
      <div className="es-current">
        <span className="es-current-label">Current Clip</span>
        <span className="es-current-dur">{Math.round(es.currentDuration)}s</span>
      </div>
      <div className="es-options">
        {(['conservative', 'balanced', 'aggressive'] as const).map(level => (
          <div
            key={level}
            className={`es-option${level === es.recommended ? ' recommended' : ''}`}
          >
            <span className="es-opt-label">{EXPORT_LABELS[level]}</span>
            <span className="es-opt-dur">{Math.round(es[level].duration)}s</span>
            {level === es.recommended && (
              <span className="es-opt-badge">Best</span>
            )}
          </div>
        ))}
      </div>
      <div className="es-detail">
        <div className="es-detail-row">
          <span className="es-detail-label">Start</span>
          <span className="es-detail-val">{fmt(Math.floor(recStart))}</span>
        </div>
        <div className="es-detail-row">
          <span className="es-detail-label">End</span>
          <span className="es-detail-val">{fmt(Math.floor(recEnd))}</span>
        </div>
      </div>
      {es.reasons.length > 0 && (
        <div className="es-reasons">
          {es.reasons.map((r, i) => (
            <div key={i} className="es-reason">
              <span className="es-reason-check">✓</span>
              <span className="es-reason-text">{r}</span>
            </div>
          ))}
        </div>
      )}
      {es.retentionImpact && (
        <div className="es-retention">
          <span className="es-retention-pct">+{es.retentionImpact.pct}%</span>
          <span className="es-retention-label">
            {es.retentionImpact.confidence === 'high' ? 'Estimated retention improvement' : 'Potential retention improvement'}
          </span>
        </div>
      )}
    </div>
  );
}

function getThemeSummary(dnaTags: string[]): { primaryTheme: string; emotionLevel: string; authority: string; storyDensity: string; curiosity: string } {
  const emotional = ['emotion', 'vulnerability', 'motivation', 'inspiration'];
  const authoritative = ['authority', 'educational'];
  const storyLike = ['storytelling', 'hookPower', 'humor'];
  const curious = ['curiosity', 'controversy', 'shock'];

  const scoreCat = (tags: string[], category: string[]): number =>
    tags.filter(t => category.includes(t)).length;

  const e = scoreCat(dnaTags, emotional);
  const a = scoreCat(dnaTags, authoritative);
  const s = scoreCat(dnaTags, storyLike);
  const c = scoreCat(dnaTags, curious);

  // Find primary theme
  const themeTags = dnaTags.filter(t => !emotional.includes(t) && !['relatability', 'money'].includes(t));
  const primaryTheme = themeTags.length > 0 ? DNA_DISPLAY_NAMES[themeTags[0]] || themeTags[0] : 'General Discussion';

  return {
    primaryTheme,
    emotionLevel: e >= 3 ? 'High' : e >= 1 ? 'Medium' : 'Low',
    authority: a >= 2 ? 'High' : a >= 1 ? 'Medium' : 'Low',
    storyDensity: s >= 3 ? 'High' : s >= 1 ? 'Medium' : 'Low',
    curiosity: c >= 3 ? 'High' : c >= 1 ? 'Medium' : 'Low',
  };
}

function abbreviateTag(tag: string, maxChars: number): string {
  if (tag.length <= maxChars) return tag;
  return tag.slice(0, maxChars);
}

function renderDnaTag(tag: string, maxChars: number): string {
  const symbol = DNA_SYMBOLS[tag];
  const name = abbreviateTag(tag, maxChars);
  return symbol ? `${symbol} ${name}` : name;
}

function formatDuration(start: number, end: number): string {
  const d = end - start;
  if (d < 60) return `${Math.round(d)}s`;
  return `${Math.floor(d / 60)}m ${Math.round(d % 60)}s`;
}

function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

// ── Error Boundary (prevents one crash from collapsing the whole page) ──
class ErrorBoundary extends Component<
  { children: ReactNode; fallback?: ReactNode },
  { hasError: boolean; error: Error | null }
> {
  constructor(props: { children: ReactNode; fallback?: ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }
  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('[ErrorBoundary] Caught:', error, errorInfo);
  }
  render() {
    if (this.state.hasError) {
      return this.props.fallback || (
        <section className="error-section">
          <div className="error-icon">⚠️</div>
          <p className="error-text">Something went wrong rendering this section.</p>
          <button className="retry-btn" onClick={() => this.setState({ hasError: false, error: null })}>
            Try Again
          </button>
        </section>
      );
    }
    return this.props.children;
  }
}

function formatMinutes(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  return `${Math.round(seconds / 60)} min`;
}

function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}

function validateYouTubeUrl(url: string): boolean {
  const patterns = [
    /(?:youtube\.com\/watch\?v=)([^"&?/\s]{11})/i,
    /(?:youtu\.be\/)([^"&?/\s]{11})/i,
    /(?:youtube\.com\/embed\/)([^"&?/\s]{11})/i,
  ];
  const trimmed = url.trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(trimmed)) return true;
  return patterns.some((p) => p.test(trimmed));
}

function getThumbnail(videoId: string, quality: 'mqdefault' | 'hqdefault' | 'default' = 'mqdefault'): string {
  return `https://img.youtube.com/vi/${videoId}/${quality}.jpg`;
}

// Example videos for Feature 7
const EXAMPLE_VIDEOS = [
  { label: 'Podkesmas — Gofar Hilman', videoId: '3mLbMqNlIgM' },
  { label: 'VINDES — Andre Taulany', videoId: 'fZGZ42IpURA' },
  { label: 'CEO Podcast — Onadio', videoId: 'BlPQ97-RRJ8' },
];

// Subtitle style options (mirrors worker/subtitle-templates.ts TEMPLATE_NAMES)
const SUBTITLE_STYLE_OPTIONS: Array<{ id: string; label: string }> = [
  { id: 'opus', label: 'Opus Style' },
  { id: 'hormozi', label: 'Alex Hormozi' },
  { id: 'gadzhi', label: 'Iman Gadzhi' },
  { id: 'mrbeast', label: 'MrBeast' },
  { id: 'podcast_minimal', label: 'Podcast Minimal' },
  { id: 'documentary', label: 'Documentary' },
  { id: 'clean_corporate', label: 'Clean Corporate' },
];

export default function Home() {
  const [url, setUrl] = useState('');
  const [stage, setStage] = useState<Stage>('idle');
  const [stageStart, setStageStart] = useState(0);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [error, setError] = useState('');
  const [history, setHistory] = useState<HistoryItem[] | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(false);

  // Analysis intelligence data from status polling
  const [liveCandidates, setLiveCandidates] = useState(0);
  const [liveDuration, setLiveDuration] = useState(0);
  const [liveTranscriptWords, setLiveTranscriptWords] = useState(0);
  const [liveTotalMomentsFound, setLiveTotalMomentsFound] = useState(0);
  const [liveStage, setLiveStage] = useState('queued');

  // Scoring progress — count-up simulation
  const [scoredCount, setScoredCount] = useState(0);

  // Clip generation state
  const [clipStates, setClipStates] = useState<Record<number, ClipStatus>>({});
  const [clipUrls, setClipUrls] = useState<Record<number, string>>({});
  const [clipErrors, setClipErrors] = useState<Record<number, string>>({});
  const [renderMode, setRenderMode] = useState<'landscape' | 'vertical'>('vertical');
  const [subtitleStyle, setSubtitleStyle] = useState('opus');
  const [urlError, setUrlError] = useState(false);
  const [elapsed, setElapsed] = useState(0);

  // Active clip — defaults to #1 when results load
  const [activeMoment, setActiveMoment] = useState<Moment | null>(null);
  const [transcriptExpanded, setTranscriptExpanded] = useState(false);
  const [secondaryExpanded, setSecondaryExpanded] = useState(false);
  const [analyticsExpanded, setAnalyticsExpanded] = useState(false);
  const [activeTab, setActiveTab] = useState<'analysis' | 'titles' | 'export'>('analysis');
  const [isPlayingVideo, setIsPlayingVideo] = useState(false);
  const [copiedTimestamp, setCopiedTimestamp] = useState(false);

  // Title suggestions copy state
  const [copiedTitleIndex, setCopiedTitleIndex] = useState<number | null>(null);

  // Analysis funnel data
  const [funnel, setFunnel] = useState<StatusData['funnel']>(null);

  const TIMELINE_STAGES = ['Transcript', 'Extraction', 'AI Scoring', 'Multi-Pass', 'Ranking', 'Storing'];
  const FRONTEND_STAGE_ORDER: Stage[] = ['fetching', 'extracting', 'batched', 'multipass', 'ranking', 'storing'];
  const pollTimers = useRef<Record<number, ReturnType<typeof setInterval>>>({});
  const pollStartTimes = useRef<Record<number, number>>({});

  const MAX_POLL_DURATION = 12 * 60 * 1000;

  useEffect(() => {
    return () => {
      Object.values(pollTimers.current).forEach(clearInterval);
      const pollInt = (window as unknown as Record<string, unknown>).__pollInterval;
      if (pollInt) clearInterval(pollInt as ReturnType<typeof setInterval>);
    };
  }, []);

  useEffect(() => {
    setLoadingHistory(true);
    fetch('/api/history')
      .then((r) => r.json())
      .then((data) => {
        if (data?.analyses) setHistory(data.analyses);
      })
      .catch(() => {})
      .finally(() => setLoadingHistory(false));
  }, []);

  const prevStageRef = useRef(stage);
  useEffect(() => {
    if (prevStageRef.current === 'batched' && stage === 'done') {
      fetch('/api/history')
        .then((r) => r.json())
        .then((data) => {
          if (data?.analyses) setHistory(data.analyses);
        })
        .catch(() => {});
    }
    prevStageRef.current = stage;
  }, [stage]);

  useEffect(() => {
    const isAnalyzing = stage === 'fetching' || stage === 'extracting' || stage === 'batched' || stage === 'multipass' || stage === 'ranking' || stage === 'storing';
    if (isAnalyzing) {
      const timer = setInterval(() => {
        setElapsed(Math.floor((Date.now() - stageStart) / 1000));
      }, 1000);
      return () => clearInterval(timer);
    } else {
      setElapsed(0);
    }
  }, [stage, stageStart]);

  // Auto-select #1 when results load; reset transcript on active change
  useEffect(() => {
    if (stage === 'done' && result && result.moments.length > 0) {
      setActiveMoment(result.moments[0]);
    }
  }, [stage, result]);

  useEffect(() => {
    setTranscriptExpanded(false);
    setActiveTab('analysis');
    setIsPlayingVideo(false);
    setCopiedTimestamp(false);
  }, [activeMoment]);

  // Scoring progress counter: increments during AI scoring stage
  useEffect(() => {
    if (stage !== 'batched' && stage !== 'multipass') {
      setScoredCount(0);
      return;
    }
    const total = liveTotalMomentsFound || Math.max(liveCandidates, 10);
    if (total <= 0) return;
    const step = Math.max(1, Math.floor(total / 12)); // ~12 ticks over 36s
    const timer = setInterval(() => {
      setScoredCount(prev => {
        const next = prev + step;
        return next >= total ? total : next;
      });
    }, 3000);
    return () => clearInterval(timer);
  }, [stage, liveTotalMomentsFound, liveCandidates]);

  async function openAnalysis(analysisId: string) {
    setStage('fetching');
    setError('');
    try {
      const res = await fetch(`/api/history/${analysisId}`);
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message || 'Failed to load analysis.');
      }
      // Capture video metadata from history detail
      if (data.video?.durationSeconds) {
        setLiveDuration(data.video.durationSeconds);
      }
      if (data.totalMomentsFound) {
        setLiveTotalMomentsFound(data.totalMomentsFound);
      }
      if (data.transcriptWords) {
        setLiveTranscriptWords(data.transcriptWords);
      }
      setResult(data);
      setStage('done');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to load analysis.';
      setError(message);
      setStage('error');
    }
  }

  async function generateClip(momentIndex: number) {
    if (!result?.analysisId) return;

    setClipStates((prev) => ({ ...prev, [momentIndex]: 'generating' }));

    try {
      const res = await fetch('/api/clips', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ analysisId: result.analysisId, momentIndex, renderMode, subtitleStyle }),
      });
      const data = await res.json();

      if (!res.ok) {
        setClipStates((prev) => ({ ...prev, [momentIndex]: 'failed' }));
        return;
      }

      if (data.status === 'ready') {
        setClipStates((prev) => ({ ...prev, [momentIndex]: 'ready' }));
        setClipUrls((prev) => ({ ...prev, [momentIndex]: data.clipUrl }));
        return;
      }

      const clipId = data.clipId;
      pollStartTimes.current[momentIndex] = Date.now();
      const timer = setInterval(async () => {
        try {
          const elapsed = Date.now() - (pollStartTimes.current[momentIndex] || 0);
          if (elapsed > MAX_POLL_DURATION) {
            clearInterval(timer);
            delete pollTimers.current[momentIndex];
            delete pollStartTimes.current[momentIndex];
            setClipStates((prev) => ({ ...prev, [momentIndex]: 'failed' }));
            setClipErrors((prev) => ({ ...prev, [momentIndex]: 'Processing is taking longer than expected. Please refresh or try again.' }));
            return;
          }

          const statusRes = await fetch(`/api/clips/${clipId}/status`);
          const statusData = await statusRes.json();

          if (statusData.status === 'ready') {
            setClipStates((prev) => ({ ...prev, [momentIndex]: 'ready' }));
            setClipUrls((prev) => ({ ...prev, [momentIndex]: statusData.clipUrl }));
            clearInterval(timer);
            delete pollTimers.current[momentIndex];
            delete pollStartTimes.current[momentIndex];
          } else if (statusData.status === 'failed') {
            setClipStates((prev) => ({ ...prev, [momentIndex]: 'failed' }));
            setClipErrors((prev) => ({ ...prev, [momentIndex]: statusData.error || 'Clip generation failed.' }));
            clearInterval(timer);
            delete pollTimers.current[momentIndex];
            delete pollStartTimes.current[momentIndex];
          }
        } catch { /* keep polling */ }
      }, 5000);

      pollTimers.current[momentIndex] = timer;
    } catch {
      setClipStates((prev) => ({ ...prev, [momentIndex]: 'failed' }));
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = url.trim();
    if (!trimmed) return;

    if (!validateYouTubeUrl(trimmed)) {
      setError('Invalid YouTube URL. Please check and try again.');
      setUrlError(true);
      return;
    }

    setResult(null);
    setError('');
    setUrlError(false);
    setClipStates({});
    setClipUrls({});
    setActiveMoment(null);
    setLiveCandidates(0);
    setLiveDuration(0);
    setLiveTranscriptWords(0);
    setLiveTotalMomentsFound(0);
    setLiveStage('queued');
    setScoredCount(0);
    setFunnel(null);
    setStage('fetching');
    setStageStart(Date.now());

    try {
      const res = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: trimmed }),
      });

      const data = await res.json();

      if (!res.ok) {
        const messages: Record<string, string> = {
          INVALID_URL: 'Invalid YouTube URL format.',
          TRANSCRIPT_UNAVAILABLE: 'No transcript available for this video.',
          RATE_LIMITED: 'Rate limit exceeded. Try again later.',
          ANALYSIS_FAILED: 'Analysis failed. Please try again.',
        };
        throw new Error(messages[data.error] || data.message || 'Something went wrong.');
      }

      const analysisId = data.analysisId;

      // Analysis cache hit — load immediately without polling
      if (data.cached === true) {
        const detailRes = await fetch(`/api/analyze/${analysisId}/status`);
        const detailData = await detailRes.json();
        if (detailRes.ok && detailData.moments && detailData.moments.length > 0) {
          if (detailData.videoDuration) setLiveDuration(detailData.videoDuration);
          if (detailData.totalMomentsFound) setLiveTotalMomentsFound(detailData.totalMomentsFound);
          if (detailData.transcriptWords) setLiveTranscriptWords(detailData.transcriptWords);
          setResult({
            analysisId: detailData.analysisId,
            videoId: detailData.videoId || '',
            moments: detailData.moments,
            totalMomentsFound: detailData.totalMomentsFound,
          });
          setStage('done');
          if (detailData.funnel) setFunnel(detailData.funnel);
          return;
        }
        // Fallback: if cached response is incomplete, fall through to polling
      }

      const pollInterval = setInterval(async () => {
        try {
          const statusRes = await fetch(`/api/analyze/${analysisId}/status`);
          const statusData: StatusData = await statusRes.json();

          if (!statusRes.ok) {
            clearInterval(pollInterval);
            const detailRes = await fetch(`/api/history/${analysisId}`);
            const detailData = await detailRes.json();
            if (detailRes.ok) {
              if (detailData.video?.durationSeconds) {
                setLiveDuration(detailData.video.durationSeconds);
              }
              if (detailData.totalMomentsFound) {
                setLiveTotalMomentsFound(detailData.totalMomentsFound);
              }
              if (detailData.transcriptWords) {
                setLiveTranscriptWords(detailData.transcriptWords);
              }
              setResult(detailData);
              setStage('done');
              if ((detailData as any).funnel) setFunnel((detailData as any).funnel);
            } else {
              throw new Error(detailData.message || 'Failed to load analysis.');
            }
            return;
          }

          // Capture live intelligence data
          if (statusData.stage) {
            setLiveStage(statusData.stage);
          }
          if (statusData.totalMomentsFound !== undefined) {
            setLiveCandidates(statusData.totalMomentsFound);
          }
          if (statusData.videoDuration !== undefined) {
            setLiveDuration(statusData.videoDuration);
          }
          if (statusData.transcriptWords !== undefined) {
            setLiveTranscriptWords(statusData.transcriptWords);
          }
          if (statusData.totalMomentsFound !== undefined) {
            setLiveTotalMomentsFound(statusData.totalMomentsFound);
          }

          const stageMap: Record<string, Stage> = {
            queued: 'fetching',
            fetching_transcript: 'fetching',
            extracting_candidates: 'extracting',
            batch_analysis: 'batched',
            multi_pass: 'multipass',
            ranking: 'ranking',
            storing_results: 'storing',
          };

          if (statusData.status === 'processing' || statusData.status === 'pending') {
            const frontendStage = stageMap[statusData.stage || ''] || 'fetching';
            setStage(frontendStage);
            setStageStart(Date.now());
          } else if (statusData.status === 'completed') {
            clearInterval(pollInterval);
            if (statusData.moments && statusData.moments.length > 0) {
              if (statusData.transcriptWords !== undefined) {
                setLiveTranscriptWords(statusData.transcriptWords);
              }
              setResult({
                analysisId: statusData.analysisId,
                videoId: statusData.videoId || '',
                moments: statusData.moments,
                totalMomentsFound: statusData.totalMomentsFound,
              });
              setStage('done');
              if (statusData.funnel) setFunnel(statusData.funnel);
            } else {
              setError('No clip-worthy moments found in this video. Try a different video.');
              setStage('error');
            }
          } else if (statusData.status === 'failed') {
            clearInterval(pollInterval);
            throw new Error(statusData.error || 'Analysis failed.');
          }
        } catch {
          /* keep polling */
        }
      }, 3000);

      (window as unknown as Record<string, unknown>).__pollInterval = pollInterval;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Network error. Please try again.';
      setError(message);
      setStage('error');
    }
  }

  function renderClipAction(moment: Moment) {
    const state = clipStates[moment.rank] || 'idle';
    switch (state) {
      case 'idle':
        return (
          <button className="ws-generate-btn" onClick={(e) => { e.stopPropagation(); generateClip(moment.rank); }}>
            Generate Clip
          </button>
        );
      case 'generating':
        return (
          <button className="ws-generate-btn generating" disabled>
            Generating...
          </button>
        );
      case 'ready':
        return (
          <a className="ws-generate-btn ready" href={clipUrls[moment.rank] || '#'} download onClick={(e) => e.stopPropagation()}>
            Download MP4
          </a>
        );
      case 'failed':
        return (
          <div className="ws-generate-group" onClick={(e) => e.stopPropagation()}>
            <button className="ws-generate-btn failed" onClick={() => generateClip(moment.rank)}>
              Retry
            </button>
            {clipErrors[moment.rank] && (
              <span className="clip-error-text">{clipErrors[moment.rank]}</span>
            )}
          </div>
        );
    }
  }

  function renderCardAction(moment: Moment) {
    const state = clipStates[moment.rank] || 'idle';
    switch (state) {
      case 'idle':
        return (
          <button className="card-clip-btn" onClick={(e) => { e.stopPropagation(); generateClip(moment.rank); }}>
            Generate
          </button>
        );
      case 'generating':
        return (
          <button className="card-clip-btn generating" disabled>
            ...
          </button>
        );
      case 'ready':
        return (
          <a className="card-clip-btn ready" href={clipUrls[moment.rank] || '#'} download onClick={(e) => e.stopPropagation()}>
            MP4
          </a>
        );
      case 'failed':
        return (
          <button className="card-clip-btn failed" onClick={(e) => { e.stopPropagation(); generateClip(moment.rank); }}>
            Retry
          </button>
        );
    }
  }

  // ── Score label helper ──
  function scoreWithLabel(score: number) {
    return (
      <span className="ws-score-wrap">
        <span className="ws-score-number">{Math.round(score)}</span>
        <span className="ws-score-label">{getScoreLabel(score)}</span>
      </span>
    );
  }

  // ── Live analysis card (Priority 1) ──
  function renderLiveCard(
    title: string,
    kind: 'transcript' | 'moments' | 'scoring' | 'multipass' | 'ranking' | 'storing',
    value: number | string,
    suffix: string,
    placeholder: string,
    currentStage: Stage,
    backendStage: string,
    cardIndex: number,
  ) {
    const FRONTEND_ORDER: Stage[] = ['fetching', 'extracting', 'batched', 'multipass', 'ranking', 'storing'];
    const cardStage = FRONTEND_ORDER[cardIndex];
    const stageIdx = FRONTEND_ORDER.indexOf(currentStage);
    const isActive = cardIndex === stageIdx;
    const isCompleted = cardIndex < stageIdx;
    const isUpcoming = cardIndex > stageIdx;

    // No special override needed — batched/multipass/storing map directly to real cards
    const scoringActive = kind === 'scoring' && currentStage === 'batched';

    // Transcript is "complete" when we have word count
    const transcriptDone = kind === 'transcript' && typeof value === 'number' && value > 0;
    // Moments is "complete" when we have count > 0
    const momentsDone = kind === 'moments' && typeof value === 'number' && value > 0;
    // Scoring is "complete" when all candidates scored
    const scoringDone = kind === 'scoring' && typeof value === 'number' && value > 0 &&
      liveTotalMomentsFound > 0 && value >= liveTotalMomentsFound;
    // Multipass is "complete" when stage moved past to ranking
    const multipassDone = kind === 'multipass' && currentStage !== 'batched' && currentStage !== 'multipass' && currentStage !== 'fetching' && currentStage !== 'extracting';
    // Ranking is "complete" when stage is 'done' or 'storing'
    const rankingDone = kind === 'ranking' && (currentStage === 'done' || currentStage === 'storing');
    // Storing is "complete" when stage is 'done'
    const storingDone = kind === 'storing' && currentStage === 'done';

    const isCardDone = transcriptDone || momentsDone || scoringDone || multipassDone || rankingDone || storingDone || isCompleted;
    const isCardActive = isActive || scoringActive;

    let statusLabel = '';
    if (isCardDone) statusLabel = 'Complete';
    else if (isCardActive) statusLabel = 'In Progress';
    else if (isUpcoming) statusLabel = 'Pending';

    let displayContent: React.ReactNode;
    const hasValue = kind !== 'ranking' && kind !== 'multipass' && kind !== 'storing' && typeof value === 'number' && value > 0;
    if (hasValue) {
      if (kind === 'scoring') {
        const total = liveTotalMomentsFound || liveCandidates || '?';
        displayContent = (
          <span className="live-card-count">
            <span className="live-card-num">{formatNumber(value as number)}</span>
            <span className="live-card-suffix"> / {total} processed</span>
          </span>
        );
      } else {
        displayContent = (
          <span className="live-card-count">
            <span className="live-card-num">{typeof value === 'number' ? formatNumber(value) : value}</span>
            {suffix && <span className="live-card-suffix"> {suffix}</span>}
          </span>
        );
      }
    } else if (isCardDone && kind === 'ranking') {
      displayContent = <span className="live-card-placeholder">Ranking complete</span>;
    } else if (isCardDone && kind === 'multipass') {
      displayContent = <span className="live-card-placeholder">Verification done</span>;
    } else if (isCardDone && kind === 'storing') {
      displayContent = <span className="live-card-placeholder">Saved to database</span>;
    } else if (isCardActive || isUpcoming) {
      if (kind === 'ranking' && currentStage === 'ranking') {
        displayContent = <span className="live-card-placeholder live-pulse">Ranking moments...</span>;
      } else if (kind === 'multipass' && currentStage === 'multipass') {
        displayContent = <span className="live-card-placeholder live-pulse">Cross-checking picks...</span>;
      } else if (kind === 'storing' && currentStage === 'storing') {
        displayContent = <span className="live-card-placeholder live-pulse">Writing to database...</span>;
      } else {
        displayContent = <span className="live-card-placeholder live-pulse">{placeholder}</span>;
      }
    } else {
      displayContent = <span className="live-card-placeholder">{placeholder}</span>;
    }

    return (
      <div
        className={`live-card${isCardDone ? ' done' : ''}${isCardActive ? ' active' : ''}${isUpcoming ? ' upcoming' : ''}`}
        style={{ animationDelay: `${cardIndex * 60}ms` }}
      >
        <div className="live-card-header">
          <span className="live-card-title">{title}</span>
          <span className={`live-card-status${isCardDone ? ' done' : ''}${isCardActive ? ' active' : ''}`}>
            {statusLabel}
          </span>
        </div>
        <div className="live-card-body">
          {displayContent}
        </div>
      </div>
    );
  }

  // ── Analysis Overview (Feature 1) ──
  function renderAnalysisOverview() {
    if (!result) return null;
    const duration = liveDuration || result?.video?.durationSeconds || 0;
    const words = liveTranscriptWords;
    const candidates = liveTotalMomentsFound || result?.totalMomentsFound || 0;
    const picks = result.moments.length;
    const hasData = duration > 0 || words > 0 || candidates > 0;

    return (
      <section className="overview-section">
        <h2 className="section-label" style={{ marginBottom: 16 }}>Analysis Overview</h2>
        <div className="overview-grid">
          {duration > 0 && (
            <div className="overview-card">
              <span className="overview-value">{formatMinutes(duration)}</span>
              <span className="overview-label">Duration</span>
            </div>
          )}
          {words > 0 && (
            <div className="overview-card">
              <span className="overview-value">{formatNumber(words)}</span>
              <span className="overview-label">Transcript Words</span>
            </div>
          )}
          {candidates > 0 && (
            <div className="overview-card">
              <span className="overview-value">{candidates}</span>
              <span className="overview-label">Candidates Found</span>
            </div>
          )}
          <div className="overview-card">
            <span className="overview-value">{picks}</span>
            <span className="overview-label">Final Recommendations</span>
          </div>
        </div>
        {/* Trust Signal (Feature 10) */}
        <p className="trust-line">
          Generated from transcript analysis, multi-pass scoring, and ranking verification.
        </p>
      </section>
    );
  }

  // ── Analysis Funnel ──
  function renderAnalysisFunnel() {
    if (!funnel) return null;
    const { transcriptWords, transcriptSegments, candidateMoments, highSignalMoments, eliteMoments, finalRecommendations } = funnel;
    const hasData = transcriptWords > 0 || transcriptSegments > 0 || candidateMoments > 0;

    if (!hasData) return null;

    const steps = [
      { count: transcriptWords, label: 'Transcript Words', desc: 'Raw speech captured from audio' },
      { count: transcriptSegments, label: 'Transcript Segments', desc: 'Broken down by sentence boundary' },
      { count: candidateMoments, label: 'Candidate Moments', desc: 'Potential clip opportunities' },
      { count: highSignalMoments, label: 'High Signal Moments', desc: 'Scored above quality threshold (≥70)' },
      { count: eliteMoments, label: 'Elite Candidates', desc: 'Top-tier clips (score ≥85)' },
      { count: finalRecommendations, label: 'Final Recommendations', desc: 'Highest confidence picks' },
    ].filter(s => s.count > 0);

    if (steps.length === 0) return null;

    return (
      <section className="funnel-section">
        <h2 className="section-label" style={{ marginBottom: 16 }}>Analysis Funnel</h2>
        <div className="funnel-flow">
          {steps.map((step, i) => (
            <div key={step.label} className="funnel-step" style={{ animationDelay: `${i * 60}ms` }}>
              <div className="funnel-card">
                <span className="funnel-count">{formatNumber(step.count)}</span>
                <span className="funnel-label">{step.label}</span>
                <span className="funnel-desc">{step.desc}</span>
              </div>
              {i < steps.length - 1 && (
                <div className="funnel-arrow">
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                    <path d="M8 3L8 13M8 13L4 9M8 13L12 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                </div>
              )}
            </div>
          ))}
        </div>
      </section>
    );
  }

  // ── Executive Summary (Priority 2) ──
  function getContentType(tagFreq: Record<string, number>, topTags: string[]): string {
    const has = (tag: string) => topTags.includes(tag);
    if (has('educational') && has('authority')) return 'Educational Discussion';
    if (has('humor') && has('storytelling')) return 'Entertainment Story';
    if (has('controversy') && has('shock')) return 'Hot Topic Debate';
    if (has('motivation') && has('inspiration')) return 'Motivational Content';
    if (has('emotion') && has('vulnerability')) return 'Emotional Narrative';
    if (has('money') && has('authority')) return 'Business / Finance';
    if (has('hookPower') && has('curiosity')) return 'Engaging Commentary';
    if (has('educational')) return 'Educational Content';
    if (has('storytelling')) return 'Narrative Storytelling';
    if (has('humor')) return 'Humorous Discussion';
    if (has('controversy')) return 'Controversial Topic';
    if (has('motivation')) return 'Motivational Talk';
    return 'Podcast Discussion';
  }

  function getConvStyle(topTags: string[]): string {
    const has = (tag: string) => topTags.includes(tag);
    if (has('storytelling') && has('humor')) return 'Conversational';
    if (has('educational') && has('authority')) return 'Instructional';
    if (has('controversy') && has('shock')) return 'Provocative';
    if (has('emotion') && has('vulnerability')) return 'Confessional';
    if (has('hookPower') && has('curiosity')) return 'Engaging';
    if (has('authority')) return 'Authoritative';
    if (has('storytelling')) return 'Narrative';
    if (has('humor')) return 'Lighthearted';
    if (has('controversy')) return 'Debate';
    return 'Casual';
  }

  function renderAnalysisSummary() {
    if (!result || result.moments.length === 0) return null;

    // Aggregate DNA tags across all moments
    const tagCounts: Record<string, number> = {};
    const allScores: number[] = [];
    result.moments.forEach(m => {
      m.dnaTags.forEach(t => { tagCounts[t] = (tagCounts[t] || 0) + 1; });
      allScores.push(m.worthClippingScore);
    });
    const sortedTags = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]);
    const topTags = sortedTags.slice(0, 3).map(([t]) => t);
    const dominantTag = sortedTags.length > 0 ? sortedTags[0][0] : null;

    // Averages
    const avgScore = allScores.reduce((s, v) => s + v, 0) / allScores.length;
    const top3Avg = allScores.slice(0, 3).reduce((s, v) => s + v, 0) / Math.min(3, allScores.length);
    const totalMoments = liveTotalMomentsFound || result.totalMomentsFound || result.moments.length;

    // Derived values
    const contentType = getContentType(tagCounts, topTags);
    const dominantDna = sortedTags.length >= 2
      ? `${DNA_DISPLAY_NAMES[sortedTags[0][0]] || sortedTags[0][0]} + ${DNA_DISPLAY_NAMES[sortedTags[1][0]] || sortedTags[1][0]}`
      : dominantTag ? DNA_DISPLAY_NAMES[dominantTag] || dominantTag : '—';
    const clipPotential: string = avgScore >= 80 ? 'High' : avgScore >= 65 ? 'Good' : 'Moderate';
    const conversationStyle = getConvStyle(topTags);
    const hookStrength: string = top3Avg >= 85 ? 'Very Strong' : top3Avg >= 75 ? 'Strong' : top3Avg >= 65 ? 'Good' : 'Moderate';
    const candidateDensity = `${totalMoments} Moments`;

    const insights = [
      { label: 'Content Type', value: contentType },
      { label: 'Dominant DNA', value: dominantDna },
      { label: 'Clip Potential', value: clipPotential },
      { label: 'Candidate Density', value: candidateDensity },
      { label: 'Conversation Style', value: conversationStyle },
      { label: 'Hook Strength', value: hookStrength },
    ];

    return (
      <section className="summary-section">
        <h2 className="section-label" style={{ marginBottom: 16 }}>Analysis Summary</h2>
        <div className="summary-grid">
          {insights.map((insight) => (
            <div key={insight.label} className="summary-card">
              <span className="summary-label">{insight.label}</span>
              <span className="summary-value">{insight.value}</span>
            </div>
          ))}
        </div>
      </section>
    );
  }

  // ── Content Profile (Feature 4) ──
  function renderContentProfile() {
    if (!result || result.moments.length === 0) return null;
    const allTags = result.moments.flatMap(m => m.dnaTags);
    if (allTags.length === 0) return null;
    const profile = getThemeSummary(allTags);

    return (
      <div className="profile-block">
        <h3 className="ws-section-title">Content Profile</h3>
        <div className="profile-grid">
          <div className="profile-item">
            <span className="profile-key">Primary Theme</span>
            <span className="profile-val">{profile.primaryTheme}</span>
          </div>
          <div className="profile-item">
            <span className="profile-key">Emotion Level</span>
            <span className="profile-val">{profile.emotionLevel}</span>
          </div>
          <div className="profile-item">
            <span className="profile-key">Authority</span>
            <span className="profile-val">{profile.authority}</span>
          </div>
          <div className="profile-item">
            <span className="profile-key">Story Density</span>
            <span className="profile-val">{profile.storyDensity}</span>
          </div>
          <div className="profile-item">
            <span className="profile-key">Curiosity</span>
            <span className="profile-val">{profile.curiosity}</span>
          </div>
        </div>
      </div>
    );
  }

  // ── DNA Distribution (Feature 5) ──
  function renderDnaDistribution() {
    if (!result || result.moments.length === 0) return null;
    const tagCounts: Record<string, number> = {};
    result.moments.forEach(m => {
      m.dnaTags.forEach(tag => {
        tagCounts[tag] = (tagCounts[tag] || 0) + 1;
      });
    });
    const entries = Object.entries(tagCounts)
      .sort((a, b) => b[1] - a[1]);
    if (entries.length === 0) return null;
    const maxCount = entries[0][1];

    const dnaSymbols: Record<string, string> = {
      hookPower: '◇', curiosity: '▼', controversy: '▲', emotion: '♥',
      humor: '◆', storytelling: '✦', educational: '■', authority: '◈',
      money: '¤', shock: '⚡', motivation: '↑', relatability: '○',
      vulnerability: '♥', inspiration: '✦',
    };

    return (
      <div className="dna-dist-section">
        <div className="dna-dist-header">
          <h3 className="ws-section-title">DNA Distribution</h3>
          <span className="dna-dist-total">{result.moments.length} moments</span>
        </div>
        <div className="dna-dist-grid">
          {entries.map(([tag, count], idx) => {
            const pct = Math.round((count / maxCount) * 100);
            const symbol = dnaSymbols[tag] || '○';
            return (
              <div key={tag} className="dna-dist-chip" style={{ animationDelay: `${idx * 40}ms` }}>
                <div className="dna-dist-chip-top">
                  <span className="dna-dist-symbol">{symbol}</span>
                  <span className="dna-dist-name">{DNA_DISPLAY_NAMES[tag] || tag}</span>
                  <span className="dna-dist-chip-count">{count}</span>
                </div>
                <div className="dna-dist-chip-track">
                  <div className="dna-dist-chip-fill" style={{ width: `${pct}%` }} />
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  // ── Analysis Journey (Feature 6) ──
  function renderAnalysisJourney() {
    if (!result) return null;
    const duration = liveDuration || result?.video?.durationSeconds || 0;
    const words = liveTranscriptWords;
    const candidates = liveTotalMomentsFound || result?.totalMomentsFound || 0;
    const picks = result.moments.length;
    if (!duration && !words && !candidates) return null;

    const items: string[] = [];
    if (duration > 0) items.push(`${formatMinutes(duration)} podcast`);
    if (words > 0) items.push(`${formatNumber(words)} transcript words`);
    if (candidates > 0) items.push(`${candidates} candidate moments`);
    if (picks > 0) items.push(`${picks * 3} scored moments`);
    items.push(`${picks} final recommendations`);

    return (
      <div className="journey-block">
        <p className="journey-line">
          GANYIQ analyzed:<br />
          {items.join(' → ')}
        </p>
      </div>
    );
  }

  // ── Featured Workspace ──
  function renderFeaturedWorkspace() {
    if (!activeMoment || !result) return null;
    const m = activeMoment;
    const duration = formatDuration(m.startTime, m.endTime);
    const totalDuration = result.video?.durationSeconds || 
      (result.moments && result.moments.length > 0 
        ? Math.max(...result.moments.map((x: Moment) => x.endTime)) 
        : 1);

    return (
      <section className="workspace">
        <div className="workspace-grid">
          
          {/* LEFT COLUMN: Player, Timeline, Waveform, Metadata, Actions */}
          <div className="workspace-left">
            {/* Editorial banner (Priority 4) */}
            <div className="ws-banner">
              <span className="ws-banner-tag">TOP RANKED MOMENT</span>
              <span className="ws-banner-sep">·</span>
              <span className="ws-banner-sub">
                Selected from {liveTotalMomentsFound || result?.totalMomentsFound || result.moments.length} candidate moments
              </span>
            </div>
            <div className="workspace-section-label">Featured Pick</div>

            {/* YouTube thumbnail/embed inline player with Format Frame Preview */}
            {result.videoId ? (
              renderMode === 'vertical' ? (
                <div className="phone-mockup-frame">
                  <div className="phone-notch">
                    <div className="phone-speaker" />
                    <div className="phone-camera" />
                  </div>
                  {isPlayingVideo ? (
                    <div className="ws-iframe-container">
                      <iframe
                        src={`https://www.youtube.com/embed/${result.videoId}?start=${Math.floor(m.startTime)}&autoplay=1&rel=0`}
                        title="YouTube video player"
                        frameBorder="0"
                        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                        allowFullScreen
                        className="ws-iframe"
                      />
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="ws-video-link-btn"
                      onClick={() => setIsPlayingVideo(true)}
                    >
                      <img
                        src={`https://img.youtube.com/vi/${result.videoId}/hqdefault.jpg`}
                        alt="Video thumbnail"
                        className="ws-video-thumb"
                        loading="lazy"
                      />
                      <div className="ws-video-play">
                        <svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor">
                          <path d="M8 5v14l11-7z" />
                        </svg>
                      </div>
                      <div className="ws-video-timestamp">{m.startTimestamp}</div>
                    </button>
                  )}
                </div>
              ) : (
                <div className="ws-video">
                  {isPlayingVideo ? (
                    <div className="ws-iframe-container">
                      <iframe
                        src={`https://www.youtube.com/embed/${result.videoId}?start=${Math.floor(m.startTime)}&autoplay=1&rel=0`}
                        title="YouTube video player"
                        frameBorder="0"
                        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                        allowFullScreen
                        className="ws-iframe"
                      />
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="ws-video-link-btn"
                      onClick={() => setIsPlayingVideo(true)}
                    >
                      <img
                        src={`https://img.youtube.com/vi/${result.videoId}/hqdefault.jpg`}
                        alt="Video thumbnail"
                        className="ws-video-thumb"
                        loading="lazy"
                      />
                      <div className="ws-video-play">
                        <svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor">
                          <path d="M8 5v14l11-7z" />
                        </svg>
                      </div>
                      <div className="ws-video-timestamp">{m.startTimestamp}</div>
                    </button>
                  )}
                </div>
              )
            ) : (
              <div className="ws-video-placeholder">Video preview unavailable</div>
            )}

            {/* Waveform Studio visualizer (CSS-only skeleton) */}
            <div className={`ws-waveform ${isPlayingVideo ? 'playing' : ''}`}>
              {[...Array(24)].map((_, i) => {
                const heights = [15, 25, 40, 18, 30, 48, 22, 10, 35, 42, 28, 50, 38, 20, 45, 30, 15, 25, 40, 18, 30, 48, 22, 10];
                return (
                  <div
                    key={i}
                    className="waveform-bar"
                    style={{
                      height: `${heights[i % heights.length]}%`,
                      animationDelay: `${i * 35}ms`
                    }}
                  />
                );
              })}
            </div>

            {/* Moment Distribution Heatmap/Timeline */}
            <div className="timeline-heatmap-container">
              <div className="timeline-heatmap-label">
                <span>Timeline Moment Terbaik</span>
                <span>{formatDuration(0, totalDuration)}</span>
              </div>
              <div className="timeline-heatmap-track">
                {result.moments.map((moment: Moment, idx: number) => {
                  const leftPercent = (moment.startTime / totalDuration) * 100;
                  const widthPercent = ((moment.endTime - moment.startTime) / totalDuration) * 100;
                  const isActive = moment.rank === m.rank;
                  return (
                    <button
                      key={idx}
                      type="button"
                      className={`timeline-pin ${isActive ? 'active' : ''} ${moment.tier}`}
                      style={{
                        left: `${leftPercent}%`,
                        width: `${Math.max(widthPercent, 1.8)}%`
                      }}
                      onClick={() => {
                        setActiveMoment(moment);
                        setIsPlayingVideo(true);
                      }}
                    >
                      <span className="timeline-tooltip">
                        #{moment.rank} ({moment.startTimestamp}) - Skor: {Math.round(displayScore(moment))}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Format Ratio Selector */}
            <div className="ws-ratio-selector">
              <span className="ratio-label">Format:</span>
              <div className="ratio-toggle-group">
                <button
                  type="button"
                  className={`ratio-btn ${renderMode === 'landscape' ? 'active' : ''}`}
                  onClick={() => setRenderMode('landscape')}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <rect x="2" y="5" width="20" height="14" rx="2" />
                  </svg>
                  16:9
                </button>
                <button
                  type="button"
                  className={`ratio-btn ${renderMode === 'vertical' ? 'active' : ''}`}
                  onClick={() => setRenderMode('vertical')}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <rect x="6" y="2" width="12" height="20" rx="3" />
                  </svg>
                  9:16
                </button>
              </div>
            </div>

            {/* P0.5: Subtitle Style Dropdown */}
            <div className="ws-subtitle-selector">
              <span className="ratio-label">Subtitles:</span>
              <div className="style-dropdown-group">
                <select
                  className="style-dropdown"
                  value={subtitleStyle}
                  onChange={(e) => setSubtitleStyle(e.target.value)}
                >
                  {SUBTITLE_STYLE_OPTIONS.map(opt => (
                    <option key={opt.id} value={opt.id}>{opt.label}</option>
                  ))}
                </select>
              </div>
            </div>

            {/* Clip metadata bar */}
            <div className="ws-meta">
              <span className="ws-rank">#{m.rank}</span>
              <span className="ws-tier-dot" data-tier={m.tier} />
              <span className="ws-tier-label">{m.tier === 'elite' ? 'Elite' : 'Notable'}</span>
              <div className="ws-score-track">
                <div className="ws-score-fill" style={{ '--score-pct': `${displayScore(m)}%` } as React.CSSProperties} />
              </div>
              {scoreWithLabel(displayScore(m))}
              <span className="ws-meta-sep">·</span>
              <span className="ws-timestamp">{m.startTimestamp} — {m.endTimestamp}</span>
              <span className="ws-meta-sep">·</span>
              <span className="ws-duration">{duration}</span>

              {/* Quick Copy Timestamp (Ide 3) */}
              <span className="ws-meta-sep">·</span>
              <button
                type="button"
                className="ws-copy-time-btn"
                onClick={() => {
                  navigator.clipboard.writeText(`${m.startTimestamp} - ${m.endTimestamp}`);
                  setCopiedTimestamp(true);
                  setTimeout(() => setCopiedTimestamp(false), 2000);
                }}
              >
                {copiedTimestamp ? '✓ Copied' : 'Copy Time'}
              </button>
            </div>

            {/* Generate Button */}
            <div className="ws-action">
              {renderClipAction(m)}
            </div>
          </div>

          {/* RIGHT COLUMN: Tabs and active tab detailed content */}
          <div className="workspace-right">
            {/* ── Tabs Navigation ── */}
            <div className="ws-tabs-nav">
              <button
                type="button"
                className={`ws-tab-btn${activeTab === 'analysis' ? ' active' : ''}`}
                onClick={() => setActiveTab('analysis')}
              >
                AI Analysis
              </button>
              <button
                type="button"
                className={`ws-tab-btn${activeTab === 'titles' ? ' active' : ''}`}
                onClick={() => setActiveTab('titles')}
              >
                Suggested Titles
              </button>
              <button
                type="button"
                className={`ws-tab-btn${activeTab === 'export' ? ' active' : ''}`}
                onClick={() => setActiveTab('export')}
              >
                Trim & Transcript
              </button>
            </div>

            {/* ── Tab Content Areas ── */}
            <div className="ws-tab-content">
              {activeTab === 'analysis' && (
                <div className="tab-pane fade-in">
                  {/* WHY GANYIQ PICKED THIS (Feature 4 inside workspace) */}
                  <div className="ws-section">
                    <h3 className="ws-section-title">WHY GANYIQ PICKED THIS</h3>
                    <p className="ws-reasoning">{m.reasoning || 'No reasoning available for this clip.'}</p>
                  </div>

                  {/* Why Ranked #X — deterministic ranking signals */}
                  {renderRankingSignals(m.rank, displayScore(m), m.confidence, m.dnaTags, m.endTime - m.startTime, liveTotalMomentsFound)}

                  {/* CLIP DNA PROFILE */}
                  {renderDnaProfile(displayScore(m), m.confidence, m.dnaTags)}

                  {/* DNA Tags */}
                  {m.dnaTags.length > 0 && (
                    <div className="ws-tags">
                      {m.dnaTags.map((tag: string, i: number) => (
                        <span key={tag} className="ws-tag" style={{ animationDelay: `${i * 20}ms` }}>
                          {renderDnaTag(tag, 20)}
                        </span>
                      ))}
                    </div>
                  )}

                  {/* Content Profile (Feature 4) */}
                  {m.rank === 1 && renderContentProfile()}

                  {/* DNA Distribution (Feature 5) */}
                  {m.rank === 1 && renderDnaDistribution()}
                </div>
              )}

              {activeTab === 'titles' && (
                <div className="tab-pane fade-in">
                  {/* Suggested Titles (AI Title Suggestions) ── */}
                  {m.suggestedTitles && m.suggestedTitles.length > 0 && (
                    <div className="ws-section">
                      <h3 className="ws-section-title">5 Publish-Ready Titles</h3>
                      <div className="title-suggestions">
                        {m.suggestedTitles.map((st: any, i: number) => (
                          <div key={i} className="title-suggestion-row">
                            <span className="title-suggestion-style">{STYLE_LABELS[st.style] || st.style}</span>
                            <span className="title-suggestion-text">{st.title}</span>
                            <button
                              className="title-copy-btn"
                              onClick={() => {
                                navigator.clipboard.writeText(st.title);
                                setCopiedTitleIndex(i);
                                setTimeout(() => setCopiedTitleIndex(null), 2000);
                              }}
                              title="Copy title"
                            >
                              {copiedTitleIndex === i ? '✓' : 'Copy'}
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Best Hook ── */}
                  {m.transcriptExcerpt && (
                    <div className="ws-section">
                      <h3 className="ws-section-title">Best Hook</h3>
                      {renderBestHook(m.transcriptExcerpt, m.dnaTags, m.confidence, displayScore(m), m.reasoning)}
                    </div>
                  )}
                </div>
              )}

              {activeTab === 'export' && (
                <div className="tab-pane fade-in">
                  {/* Export Strategy — above Generate */}
                  {renderExportStrategy(m)}

                  {/* Transcript toggle (Ide 1: Click-to-Seek click listener) */}
                  {m.transcriptExcerpt && (
                    <div className="ws-section">
                      <button
                        className="ws-transcript-toggle"
                        onClick={() => setTranscriptExpanded(!transcriptExpanded)}
                        aria-expanded={transcriptExpanded}
                      >
                        {transcriptExpanded ? 'Hide transcript' : 'Show transcript'}
                      </button>
                      {transcriptExpanded && (
                        <p 
                          className="ws-transcript interactive-transcript"
                          onClick={() => setIsPlayingVideo(true)}
                          title="Klik untuk putar video dari awal klip"
                        >
                          &ldquo;{m.transcriptExcerpt}&rdquo;
                        </p>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

        </div>
      </section>
    );
  }

  const heroMoment = result?.moments?.[0] || null;
  const eliteCompactMoments = result?.moments?.filter((m: Moment) => m.tier === 'elite').slice(1, 6) || [];
  const secondaryMoments = result?.moments?.filter((m: Moment) => m.tier === 'secondary').slice(0, 7) || [];

  return (
    <div className="container">
      <header className="header">
        <div className="header-inner">
          <div className="header-left">
            <h1 className="logo">GANYIQ</h1>
            <span className="header-badge">BETA</span>
          </div>
          <div className="header-right">
            <span className="stats-mini">{history?.length || 0} analyses</span>
          </div>
        </div>
      </header>

      <main className="main">

        {/* ── HERO SECTION ── */}
        {stage === 'idle' && !result && (
          <section className="hero-section">
            <div className="hero-content">
              <div className="hero-badge">
                <span className="hero-badge-dot" />
                AI-Powered Clip Discovery
              </div>

              <h2 className="hero-title">
                Surface the moments<br />
                <span className="hero-title-accent">people actually remember.</span>
              </h2>

              <p className="hero-desc">
                Paste a YouTube link. Get the 15 most clip-worthy moments — ranked, scored, and ready to export.
              </p>

              <form onSubmit={handleSubmit} className="hero-form">
                <div className="hero-input-wrap">
                  <svg className="hero-input-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                  </svg>
                  <input
                    type="url"
                    className={`hero-input${urlError ? ' error' : ''}`}
                    placeholder="Paste a YouTube link"
                    value={url}
                    onChange={(e) => { setUrl(e.target.value); setUrlError(false); }}
                    autoFocus
                  />
                  <button
                    type="submit"
                    className="hero-btn"
                    disabled={!url.trim()}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M8 5v14l11-7z" />
                    </svg>
                    Analyze
                  </button>
                </div>
              </form>

              <div className="hero-trust">
                <div className="trust-item">
                  <span className="trust-num">103</span>
                  <span className="trust-label">conversations</span>
                </div>
                <div className="trust-dot" />
                <div className="trust-item">
                  <span className="trust-num">749</span>
                  <span className="trust-label">clip candidates</span>
                </div>
                <div className="trust-dot" />
                <div className="trust-item">
                  <span className="trust-num">79</span>
                  <span className="trust-label">avg score</span>
                </div>
              </div>
            </div>

            {/* Decorative elements */}
            <div className="hero-glow-1" />
            <div className="hero-glow-2" />
          </section>
        )}

        {/* ── HOW IT WORKS ── */}
        {stage === 'idle' && !result && (
          <section className="how-section">
            <h3 className="section-label" style={{ marginBottom: 16 }}>How It Works</h3>
            <div className="how-grid">
              <div className="how-card">
                <span className="how-step">01</span>
                <span className="how-icon">📋</span>
                <h4 className="how-title">Paste YouTube Link</h4>
                <p className="how-desc">Drop any podcast, interview, or talk URL. We fetch the transcript automatically.</p>
              </div>
              <div className="how-card">
                <span className="how-step">02</span>
                <span className="how-icon">🧠</span>
                <h4 className="how-title">AI Analyzes & Scores</h4>
                <p className="how-desc">Our engine extracts 15+ candidate moments, scores them across 5 dimensions, and ranks by clip-worthiness.</p>
              </div>
              <div className="how-card">
                <span className="how-step">03</span>
                <span className="how-icon">✂️</span>
                <h4 className="how-title">Get Ready-to-Post Clips</h4>
                <p className="how-desc">Top 15 moments with AI titles, trim suggestions, and one-click MP4 export for Shorts/Reels.</p>
              </div>
            </div>
          </section>
        )}

        {/* ── TRY AN EXAMPLE — Visual Card Style ── */}
        {stage === 'idle' && !result && (
          <section className="examples-section">
            <div className="examples-header">
              <h3 className="section-label">Try an Example</h3>
              <span className="examples-arrow">→</span>
            </div>
            <div className="examples-grid">
              {EXAMPLE_VIDEOS.map((ex) => {
                const thumb = getThumbnail(ex.videoId);
                return (
                  <button
                    key={ex.videoId}
                    className="example-card"
                    onClick={() => {
                      setUrl(`https://www.youtube.com/watch?v=${ex.videoId}`);
                      setUrlError(false);
                    }}
                  >
                    <div className="example-thumb-wrap">
                      <img
                        className="example-thumb"
                        src={thumb}
                        alt={ex.label}
                        loading="lazy"
                      />
                      <div className="example-play">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                          <path d="M8 5v14l11-7z" />
                        </svg>
                      </div>
                    </div>
                    <div className="example-info">
                      <span className="example-name">{ex.label}</span>
                      <span className="example-action">Try this video →</span>
                    </div>
                  </button>
                );
              })}
            </div>
          </section>
        )}

        {/* ── RECENT ANALYSES — Visual Gallery ── */}
        {history && history.length > 0 && stage !== 'fetching' && stage !== 'extracting' && stage !== 'batched' && stage !== 'multipass' && stage !== 'ranking' && stage !== 'storing' && (
          <section className="history-modern">
            <div className="history-modern-header">
              <h3 className="section-label">Recently analyzed</h3>
              <span className="history-count">{history.length} videos</span>
            </div>
            <div className="history-modern-grid">
              {history.map((item: HistoryItem, idx: number) => (
                <button
                  key={item.analysisId}
                  className="history-modern-card"
                  style={{ animationDelay: `${idx * 50}ms` }}
                  onClick={() => openAnalysis(item.analysisId)}
                >
                  <div className="hmc-thumb-wrap">
                    <img
                      className="hmc-thumb"
                      src={item.thumbnailUrl}
                      alt={item.title}
                      loading="lazy"
                    />
                    <div className="hmc-overlay">
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M8 5v14l11-7z" />
                      </svg>
                    </div>
                  </div>
                  <div className="hmc-body">
                    <span className="hmc-title">{item.title}</span>
                    <span className="hmc-meta">
                      {item.totalMoments} clips{item.avgScore !== null ? ` · Avg ${item.avgScore}` : ''}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          </section>
        )}

        {/* ── EMPTY STATE ── */}
        {stage === 'idle' && !result && (!history || history.length === 0) && (
          <section className="empty-modern">
            <div className="empty-icon-wrap">
              <svg className="empty-icon" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <rect x="2" y="2" width="20" height="20" rx="4" />
                <path d="M8 12h8" />
                <path d="M12 8v8" />
              </svg>
            </div>
            <p className="empty-modern-text">No analyses yet</p>
            <p className="empty-modern-sub">Paste a YouTube link above to discover clip-worthy moments.</p>
          </section>
        )}

        {/* Analysis Section (Feature 8: Live Intelligence) */}
        {(stage === 'fetching' || stage === 'extracting' || stage === 'batched' || stage === 'multipass' || stage === 'ranking' || stage === 'storing') && (
          <ErrorBoundary>{(() => {
          const stageIdx = FRONTEND_STAGE_ORDER.indexOf(stage);
          return (
            <section className="analysis-section">
              <p className="analyzing-label">Analysis in Progress</p>
              <div className="stage-timeline">
                <div className="timeline-items">
                  {TIMELINE_STAGES.map((label, i) => (
                    <Fragment key={label}>
                      {i > 0 && (
                        <div className={`timeline-connector${i <= stageIdx ? ' completed' : ''}`} />
                      )}
                      <div className="timeline-item">
                        <div className={`timeline-dot${i < stageIdx ? ' completed' : i === stageIdx ? ' active' : ' upcoming'}`} />
                        <span className={`timeline-label${i < stageIdx ? ' completed' : i === stageIdx ? ' active' : ' upcoming'}`}>
                          {label}
                        </span>
                      </div>
                    </Fragment>
                  ))}
                </div>
              </div>

              {/* Live intelligence data */}
              <div className="live-intel">
                {liveCandidates > 0 && (
                  <span className="live-intel-item">
                    <span className="live-intel-label">Candidates Found</span>
                    <span className="live-intel-value">{liveCandidates}</span>
                  </span>
                )}
                <span className="live-intel-item">
                  <span className="live-intel-label">Current Stage</span>
                  <span className="live-intel-value">{TIMELINE_STAGES[stageIdx]}</span>
                </span>
                <span className="live-intel-item">
                  <span className="live-intel-label">Elapsed</span>
                  <span className="live-intel-value">{formatElapsed(elapsed)}</span>
                </span>
              </div>

              {/* Live analysis cards — replace skeleton */}
              <div className="live-cards">
                {renderLiveCard('Transcript', 'transcript', liveTranscriptWords, 'words detected', 'Scanning content...', stage, liveStage, 0)}
                {renderLiveCard('Candidate Extraction', 'moments', liveTotalMomentsFound || liveCandidates, 'moments found', 'Discovering opportunities...', stage, liveStage, 1)}
                {renderLiveCard('AI Scoring', 'scoring', scoredCount, ` / ${liveTotalMomentsFound || liveCandidates || '?'} processed`, 'Evaluating quality...', stage, liveStage, 2)}
                {renderLiveCard('Multi-Pass Verification', 'multipass', 0, '', 'Validating picks...', stage, liveStage, 3)}
                {renderLiveCard('Ranking', 'ranking', 0, '', 'Ranking moments...', stage, liveStage, 4)}
                {renderLiveCard('Storing Results', 'storing', 0, '', 'Saving results...', stage, liveStage, 5)}
              </div>
              <p className="discovery-counter">{liveCandidates > 0 ? `${liveTotalMomentsFound || liveCandidates} moments identified across ${liveTranscriptWords > 0 ? formatNumber(liveTranscriptWords) : ''} transcript words` : 'Analyzing content...'}</p>
            </section>
          );
          })()}</ErrorBoundary>
        )}
        {/* Error Section */}
        {stage === 'error' && error && (
          <section className="error-section">
            <div className="error-icon">⚠️</div>
            <p className="error-text">{error}</p>
            <button className="retry-btn" onClick={() => { setStage('idle'); setError(''); }}>
              Try Again
            </button>
          </section>
        )}

        {/* ── RESULTS EXPERIENCE V4 — Premium Dashboard Layout ── */}
        {stage === 'done' && result && result.moments.length > 0 && (
          <ErrorBoundary>
            <div className="results-dashboard">
              {/* Left Pane: Sidebar navigation list */}
              <aside className="dashboard-sidebar">
                <div className="sidebar-header">
                  <h2 className="section-label">
                    All Picks
                    <span className="section-label-count">{result.moments.length} moments</span>
                  </h2>
                </div>

                <div className="sidebar-list">
                  {result.moments.map((m: Moment, i: number) => {
                    const isActive = activeMoment?.rank === m.rank;
                    const isHero = m.rank === 1;
                    const isSecondary = m.tier === 'secondary';
                    // Only show secondary if expanded, hide beyond rank 6 initial
                    if (isSecondary && !secondaryExpanded && m.rank > 6) return null;

                    // Use suggested title or reasoning
                    const cardTitle = m.suggestedTitles?.[0]?.title || m.reasoning || '';
                    const displayTitle = cardTitle.length > 55 ? cardTitle.slice(0, 52) + '...' : cardTitle;

                    return (
                      <div
                        key={m.rank}
                        className={`sidebar-card${isActive ? ' active' : ''}${isHero ? ' hero' : ''}${isSecondary ? ' secondary' : ''}`}
                        onClick={() => {
                          setActiveMoment(m);
                          if (window.innerWidth <= 1024) {
                            const wsEl = document.getElementById('active-workspace');
                            if (wsEl) {
                              wsEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
                            }
                          }
                        }}
                      >
                        <div className="card-top">
                          <div className="card-rank-wrap">
                            <span className="card-rank">
                              {isHero ? '★ ' : m.tier === 'elite' ? '◇ ' : ''}
                              #{String(m.rank).padStart(2, '0')}
                            </span>
                            {isHero && <span className="card-hero-dot" title="Top Rated Moment" />}
                          </div>
                          <span className="card-score">{Math.round(displayScore(m))}</span>
                        </div>
                        <div className="card-body">
                          <p className="card-title">{displayTitle}</p>
                        </div>
                        <div className="card-bottom">
                          {m.dnaTags.length > 0 && (
                            <span className="card-tag">{renderDnaTag(m.dnaTags[0], 12)}</span>
                          )}
                          <span className="card-time">{m.startTimestamp}</span>
                          <span className="card-dur">
                            {formatDuration(m.startTime, m.endTime)}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* Secondary toggle */}
                {secondaryMoments.length > 0 && (
                  <button
                    className="secondary-toggle"
                    onClick={() => setSecondaryExpanded(!secondaryExpanded)}
                  >
                    {secondaryExpanded
                      ? `Hide ${secondaryMoments.length} Secondary Picks`
                      : `Show ${secondaryMoments.length} More Moments`
                    }
                    <span className={`secondary-arrow${secondaryExpanded ? ' expanded' : ''}`}>▸</span>
                  </button>
                )}
              </aside>

              {/* Right Pane: Sticky Active Workspace */}
              <div id="active-workspace" className="dashboard-workspace">
                {renderFeaturedWorkspace()}
              </div>
            </div>

            {/* Analytics & Technical Details — Collapsible */}
            <section className="analytics-section">
              <button
                className="analytics-toggle"
                onClick={() => setAnalyticsExpanded(!analyticsExpanded)}
              >
                <span className="analytics-toggle-label">Technical Analysis Details</span>
                <span className={`analytics-arrow${analyticsExpanded ? ' expanded' : ''}`}>▸</span>
              </button>
              {analyticsExpanded && (
                <div className="analytics-body">
                  {renderAnalysisOverview()}
                  {renderAnalysisFunnel()}
                  {renderAnalysisSummary()}
                </div>
              )}
            </section>

            <div className="new-analysis">
              <button className="new-btn" onClick={() => { setStage('idle'); setResult(null); setUrl(''); setActiveMoment(null); }}>
                Analyze Another Video
              </button>
            </div>
          </ErrorBoundary>
        )}
      </main>

      {/* Footer Stats & Branding */}
      <footer className="site-footer">
        {result && result.moments.length > 0 && (
          <div className="footer-stats">
            <div className="footer-stat">
              <span className="footer-stat-value">{result.moments.length}</span>
              <span className="footer-stat-label">recommendations</span>
            </div>
            <span className="footer-stat-sep">·</span>
            <div className="footer-stat">
              <span className="footer-stat-value">{result.moments.filter((m: Moment) => m.tier === 'elite').length}</span>
              <span className="footer-stat-label">elite</span>
            </div>
            <span className="footer-stat-sep">·</span>
            <div className="footer-stat">
              <span className="footer-stat-value">{result.moments.filter((m: Moment) => m.tier === 'secondary').length}</span>
              <span className="footer-stat-label">secondary</span>
            </div>
          </div>
        )}
        <p className="footer-branding">Powered by GANYIQ Ranking Engine</p>
      </footer>
    </div>
  );
}
