'use client';

import { useState, FormEvent, useRef, useEffect, Fragment } from 'react';

type Moment = {
  startTime: number;
  endTime: number;
  worthClippingScore: number;
  confidence: string;
  dnaTags: string[];
  reasoning: string;
  rank: number;
  tier: string;
  startTimestamp: string;
  endTimestamp: string;
  transcriptExcerpt: string;
};

type AnalysisResult = {
  analysisId: string;
  videoId: string;
  moments: Moment[];
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

type Stage = 'idle' | 'fetching' | 'extracting' | 'analyzing' | 'ranking' | 'done' | 'error';

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

function abbreviateTag(tag: string, maxChars: number): string {
  if (tag.length <= maxChars) return tag;
  return tag.slice(0, maxChars);
}

function renderDnaTag(tag: string, maxChars: number): string {
  const symbol = DNA_SYMBOLS[tag];
  const name = abbreviateTag(tag, maxChars);
  return symbol ? `${symbol} ${name}` : name;
}

function formatTimestamp(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
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

function formatDuration(start: number, end: number): string {
  const d = end - start;
  if (d < 60) return `${Math.round(d)}s`;
  return `${Math.floor(d / 60)}m ${Math.round(d % 60)}s`;
}

export default function Home() {
  const [url, setUrl] = useState('');
  const [stage, setStage] = useState<Stage>('idle');
  const [stageStart, setStageStart] = useState(0);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [error, setError] = useState('');
  const [history, setHistory] = useState<HistoryItem[] | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(false);

  // Clip generation state
  const [clipStates, setClipStates] = useState<Record<number, ClipStatus>>({});
  const [clipUrls, setClipUrls] = useState<Record<number, string>>({});
  const [clipErrors, setClipErrors] = useState<Record<number, string>>({});
  const [renderMode, setRenderMode] = useState<'landscape' | 'vertical'>('vertical');
  const [urlError, setUrlError] = useState(false);
  const [elapsed, setElapsed] = useState(0);

  // Detail modal state
  const [selectedMoment, setSelectedMoment] = useState<Moment | null>(null);
  const [transcriptExpanded, setTranscriptExpanded] = useState(false);

  const TIMELINE_STAGES = ['Fetching', 'Extracting', 'Analyzing', 'Ranking'];
  const FRONTEND_STAGE_ORDER: Stage[] = ['fetching', 'extracting', 'analyzing', 'ranking'];
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
    if (prevStageRef.current === 'analyzing' && stage === 'done') {
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
    const isAnalyzing = stage === 'fetching' || stage === 'extracting' || stage === 'analyzing' || stage === 'ranking';
    if (isAnalyzing) {
      const timer = setInterval(() => {
        setElapsed(Math.floor((Date.now() - stageStart) / 1000));
      }, 1000);
      return () => clearInterval(timer);
    } else {
      setElapsed(0);
    }
  }, [stage, stageStart]);

  // Reset transcript state when switching selected moment
  useEffect(() => {
    setTranscriptExpanded(false);
  }, [selectedMoment]);

  async function openAnalysis(analysisId: string) {
    setStage('fetching');
    setError('');
    try {
      const res = await fetch(`/api/history/${analysisId}`);
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message || 'Failed to load analysis.');
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
        body: JSON.stringify({ analysisId: result.analysisId, momentIndex, renderMode }),
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
    setSelectedMoment(null);
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

      const pollInterval = setInterval(async () => {
        try {
          const statusRes = await fetch(`/api/analyze/${analysisId}/status`);
          const statusData = await statusRes.json();

          if (!statusRes.ok) {
            clearInterval(pollInterval);
            const detailRes = await fetch(`/api/history/${analysisId}`);
            const detailData = await detailRes.json();
            if (detailRes.ok) {
              setResult(detailData);
              setStage('done');
            } else {
              throw new Error(detailData.message || 'Failed to load analysis.');
            }
            return;
          }

          const stageMap: Record<string, Stage> = {
            queued: 'fetching',
            fetching_transcript: 'fetching',
            extracting_candidates: 'extracting',
            batch_analysis: 'analyzing',
            multi_pass: 'analyzing',
            ranking: 'ranking',
            storing_results: 'ranking',
          };

          if (statusData.status === 'processing' || statusData.status === 'pending') {
            const frontendStage = stageMap[statusData.stage] || 'fetching';
            setStage(frontendStage);
            setStageStart(Date.now());
          } else if (statusData.status === 'completed') {
            clearInterval(pollInterval);
            if (statusData.moments && statusData.moments.length > 0) {
              setResult({ analysisId: statusData.analysisId, videoId: statusData.videoId, moments: statusData.moments });
              setStage('done');
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
          <button className="clip-action-btn" onClick={(e) => { e.stopPropagation(); generateClip(moment.rank); }}>
            Generate
          </button>
        );
      case 'generating':
        return (
          <button className="clip-action-btn generating" disabled>
            Generating...
          </button>
        );
      case 'ready':
        return (
          <a className="clip-action-btn ready" href={clipUrls[moment.rank] || '#'} download onClick={(e) => e.stopPropagation()}>
            Download MP4
          </a>
        );
      case 'failed':
        return (
          <div className="clip-action-group" onClick={(e) => e.stopPropagation()}>
            <button className="clip-action-btn failed" onClick={() => generateClip(moment.rank)}>
              Retry
            </button>
            {clipErrors[moment.rank] && (
              <span className="clip-error-text">{clipErrors[moment.rank]}</span>
            )}
          </div>
        );
    }
  }

  // ── Detail Modal ──
  function renderDetailModal() {
    if (!selectedMoment) return null;
    const m = selectedMoment;
    const state = clipStates[m.rank] || 'idle';
    const duration = formatDuration(m.startTime, m.endTime);
    const embedUrl = result?.videoId
      ? `https://www.youtube.com/embed/${result.videoId}?start=${Math.floor(m.startTime)}&autoplay=1`
      : null;

    return (
      <div className="modal-overlay" onClick={() => setSelectedMoment(null)}>
        <div className="modal-content" onClick={(e) => e.stopPropagation()}>
          <button className="modal-close" onClick={() => setSelectedMoment(null)}>✕</button>

          {/* YouTube embed preview */}
          {embedUrl && (
            <div className="modal-embed">
              <iframe
                src={embedUrl}
                title="YouTube video preview"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                allowFullScreen
                loading="lazy"
              />
            </div>
          )}

          {/* Header */}
          <div className="modal-header">
            <span className="modal-rank">#{m.rank}</span>
            <span className="modal-tier-dot" data-tier={m.tier} />
            <span className="modal-tier-label">{m.tier === 'elite' ? 'Elite' : 'Notable'}</span>
            <div className="modal-score-track">
              <div className="modal-score-fill" style={{ '--score-pct': `${m.worthClippingScore}%` } as React.CSSProperties} />
            </div>
            <span className="modal-score-number">{Math.round(m.worthClippingScore)}</span>
          </div>

          {/* Metadata row */}
          <div className="modal-meta">
            <span>⏱ {m.startTimestamp} &mdash; {m.endTimestamp}</span>
            <span>📐 {duration}</span>
            <span>📊 {(m.confidence || 'N/A').toUpperCase()}</span>
          </div>

          {/* Why this clip? */}
          <div className="modal-section">
            <h3 className="modal-section-title">Why this clip?</h3>
            <p className="modal-reasoning">{m.reasoning || 'No reasoning available for this clip.'}</p>
          </div>

          {/* DNA Tags */}
          {m.dnaTags.length > 0 && (
            <div className="modal-section">
              <h3 className="modal-section-title">Tags</h3>
              <div className="modal-tags">
                {m.dnaTags.map((tag) => (
                  <span key={tag} className="modal-tag">{renderDnaTag(tag, 20)}</span>
                ))}
              </div>
            </div>
          )}

          {/* Transcript — always visible toggle, expandable content */}
          <div className="modal-section">
            <h3 className="modal-section-title">
              Transcript
              {m.transcriptExcerpt && (
                <button
                  className="modal-transcript-toggle"
                  onClick={() => setTranscriptExpanded(!transcriptExpanded)}
                  aria-expanded={transcriptExpanded}
                >
                  {transcriptExpanded ? 'Hide' : 'Show'}
                </button>
              )}
            </h3>
            {transcriptExpanded && m.transcriptExcerpt && (
              <p className="modal-transcript">&ldquo;{m.transcriptExcerpt}&rdquo;</p>
            )}
            {transcriptExpanded && !m.transcriptExcerpt && (
              <p className="modal-transcript-empty">No transcript excerpt available for this clip.</p>
            )}
          </div>

          {/* Generate action */}
          <div className="modal-action">
            {renderClipAction(m)}
          </div>
        </div>
      </div>
    );
  }

  const heroMoment = result?.moments?.[0] || null;
  const eliteCompactMoments = result?.moments?.filter(m => m.tier === 'elite').slice(1, 6) || [];
  const secondaryMoments = result?.moments?.filter(m => m.tier === 'secondary').slice(0, 7) || [];

  return (
    <div className="container">
      <header className="header">
        <div className="header-row">
          <h1 className="logo">GANYIQ</h1>
          <span className="version-tag">v1.0</span>
        </div>
      </header>
      {stage === 'idle' && (
        <p className="subheadline">Surface the moments people actually remember.</p>
      )}

      <main className="main">
        {/* Input Section */}
        <section className="input-section">
          <form onSubmit={handleSubmit} className="form">
            <div className="input-wrapper">
              <input
                type="url"
                className={`url-input${urlError ? ' error' : ''}`}
                placeholder="Paste a YouTube link"
                value={url}
                onChange={(e) => { setUrl(e.target.value); setUrlError(false); }}
                disabled={stage === 'fetching' || stage === 'extracting' || stage === 'analyzing' || stage === 'ranking'}
                autoFocus
              />
              <button
                type="submit"
                className="submit-btn"
                disabled={!url.trim() || stage === 'fetching' || stage === 'extracting' || stage === 'analyzing' || stage === 'ranking'}
                aria-label="Analyze"
              >
                ▶
              </button>
            </div>
          </form>
        </section>

        {/* History Section */}
        {history && history.length > 0 && stage !== 'fetching' && stage !== 'extracting' && stage !== 'analyzing' && stage !== 'ranking' && (
          <section className="history-section">
            <p className="section-label">Recent Analyses</p>
            <div className="history-list">
              {history.map((item, idx) => (
                <div key={item.analysisId} className="history-card" style={{ animationDelay: `${idx * 40}ms` }}>
                  <img
                    className="history-thumbnail"
                    src={item.thumbnailUrl}
                    alt={item.title}
                    loading="lazy"
                    onError={(e) => {
                      (e.target as HTMLImageElement).style.display = 'none';
                    }}
                  />
                  <div className="history-info">
                    <div className="history-title-row">
                      <div className="history-title">{item.title}</div>
                      <button
                        className="history-open-btn"
                        onClick={() => openAnalysis(item.analysisId)}
                      >
                        Open
                      </button>
                    </div>
                    <div className="history-meta-row">
                      <span className="history-meta">
                        {item.channelName} · {item.totalMoments} clips
                        {item.avgScore !== null && (
                          <> · Avg <span className="history-score">{item.avgScore}</span></>
                        )}
                      </span>
                      <span className="history-date">
                        {new Date(item.createdAt).toLocaleDateString('en-US', {
                          month: 'short',
                          day: 'numeric',
                          year: 'numeric',
                        })}
                      </span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Analysis Section */}
        {(stage === 'fetching' || stage === 'extracting' || stage === 'analyzing' || stage === 'ranking') && (() => {
          const stageIdx = FRONTEND_STAGE_ORDER.indexOf(stage);
          return (
            <section className="analysis-section">
              <p className="analyzing-label">Analyzing your video</p>

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

              <p className="elapsed-timer">Elapsed: {formatElapsed(elapsed)}</p>

              <div className="skeleton-row">
                {[1, 2, 3, 4].map((i) => (
                  <div key={i} className="skeleton-card" />
                ))}
              </div>

              <p className="discovery-counter">0 moments discovered</p>
            </section>
          );
        })()}

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

        {/* Results Section */}
        {stage === 'done' && result && result.moments.length > 0 && (
          <section className="results-section">
            <span className="section-title">Picks of the Analysis</span>

            {/* Hero Card */}
            {heroMoment && (
              <div className="hero-card clickable" onClick={() => setSelectedMoment(heroMoment)}>
                <div className="hero-top-row">
                  <span className="hero-rank">#{heroMoment.rank}</span>
                  <span className="hero-timestamp">{heroMoment.startTimestamp} &mdash; {heroMoment.endTimestamp}</span>
                  <span className="hero-duration">{formatDuration(heroMoment.startTime, heroMoment.endTime)}</span>
                  <div className="hero-tier-section">
                    <div className="hero-tier-dot" />
                    <span className="hero-tier-label">Elite</span>
                  </div>
                  <div className="hero-score-track">
                    <div className="hero-score-fill" style={{ '--score-pct': `${heroMoment.worthClippingScore}%` } as React.CSSProperties} />
                  </div>
                  <span className="hero-score-number">{Math.round(heroMoment.worthClippingScore)}</span>
                </div>

                <p className="hero-reasoning">{heroMoment.reasoning}</p>

                {heroMoment.dnaTags.length > 0 && (
                  <div className="hero-tags">
                    {heroMoment.dnaTags.slice(0, 6).map((tag, i) => (
                      <span key={tag} className="hero-tag" style={{ animationDelay: `${i * 20}ms` }}>
                        {renderDnaTag(tag, 10)}
                      </span>
                    ))}
                    {heroMoment.dnaTags.length > 6 && (
                      <span className="hero-tag-more">+{heroMoment.dnaTags.length - 6}</span>
                    )}
                  </div>
                )}

                <div className="hero-bottom-row">
                  {renderClipAction(heroMoment)}
                </div>
              </div>
            )}

            {/* More Picks — Elite Compact Row */}
            {eliteCompactMoments.length > 0 && (
              <>
                <span className="section-title">More Picks</span>
                <div className="compact-row">
                  {eliteCompactMoments.map((m, i) => (
                    <div
                      key={m.rank}
                      className="compact-card clickable"
                      style={{ animationDelay: `${i * 60}ms` }}
                      onClick={() => setSelectedMoment(m)}
                    >
                      <div className="compact-header">
                        <span className="compact-rank">#{m.rank}</span>
                        <span className="compact-score">{Math.round(m.worthClippingScore)}</span>
                      </div>
                      <span className="compact-timestamp">{m.startTimestamp} &mdash; {m.endTimestamp}</span>
                      <span className="compact-duration">{formatDuration(m.startTime, m.endTime)}</span>
                      <span className="compact-reasoning">{m.reasoning ? m.reasoning.slice(0, 60) + (m.reasoning.length > 60 ? '...' : '') : ''}</span>
                      {m.dnaTags.length > 0 && (
                        <div className="compact-tags">
                          {m.dnaTags.slice(0, 3).map((tag) => (
                            <span key={tag} className="compact-tag-item">{renderDnaTag(tag, 8)}</span>
                          ))}
                        </div>
                      )}
                      {renderClipAction(m)}
                    </div>
                  ))}
                </div>
              </>
            )}

            {/* Also Notable — Secondary Compact Row */}
            {secondaryMoments.length > 0 && (
              <>
                <span className="section-title">Also Notable</span>
                <div className="compact-row">
                  {secondaryMoments.map((m, i) => (
                    <div
                      key={m.rank}
                      className="compact-card secondary clickable"
                      style={{ animationDelay: `${i * 60}ms` }}
                      onClick={() => setSelectedMoment(m)}
                    >
                      <div className="compact-header">
                        <span className="compact-rank">#{m.rank}</span>
                        <span className="compact-score">{Math.round(m.worthClippingScore)}</span>
                      </div>
                      <span className="compact-timestamp">{m.startTimestamp} &mdash; {m.endTimestamp}</span>
                      <span className="compact-duration">{formatDuration(m.startTime, m.endTime)}</span>
                      <span className="compact-reasoning">{m.reasoning ? m.reasoning.slice(0, 50) + (m.reasoning.length > 50 ? '...' : '') : ''}</span>
                      {m.dnaTags.length > 0 && (
                        <div className="compact-tags">
                          {m.dnaTags.slice(0, 2).map((tag) => (
                            <span key={tag} className="compact-tag-item">{renderDnaTag(tag, 7)}</span>
                          ))}
                        </div>
                      )}
                      {renderClipAction(m)}
                    </div>
                  ))}
                </div>
              </>
            )}

            {/* Render Mode Toggle */}
            <div className="render-mode-toggle" style={{ marginTop: 0 }}>
              <span className="toggle-label">Output Format:</span>
              <button
                className={`toggle-btn ${renderMode === 'landscape' ? 'toggle-active' : ''}`}
                onClick={() => setRenderMode('landscape')}
              >
                Landscape 16:9
              </button>
              <button
                className={`toggle-btn ${renderMode === 'vertical' ? 'toggle-active' : ''}`}
                onClick={() => setRenderMode('vertical')}
              >
                Shorts 9:16
              </button>
            </div>

            <div className="new-analysis">
              <button className="new-btn" onClick={() => { setStage('idle'); setResult(null); setUrl(''); setSelectedMoment(null); }}>
                Analyze Another Video
              </button>
            </div>
          </section>
        )}

        {/* Empty state */}
        {stage === 'idle' && !result && (!history || history.length === 0) && (
          <section className="empty-section">
            <p className="empty-text">No analyses yet. Paste a link above to begin.</p>
          </section>
        )}
      </main>

      {/* Detail Modal */}
      {renderDetailModal()}

      <footer className="footer">
        <p>GANYIQ &mdash; AI-powered clip discovery</p>
      </footer>
    </div>
  );
}
