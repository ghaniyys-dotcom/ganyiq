'use client';

import { useState, FormEvent, useRef, useEffect } from 'react';

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

const STAGE_LABELS: Record<Stage, string> = {
  idle: '',
  fetching: 'Fetching transcript',
  extracting: 'Extracting candidates',
  analyzing: 'AI analysis',
  ranking: 'Ranking moments',
  done: 'Complete!',
  error: 'Error',
};

const TIER_COLORS: Record<string, string> = {
  elite: '#fbbf24',
  secondary: '#60a5fa',
};

const TIER_LABELS: Record<string, string> = {
  elite: ' Elite',
  secondary: ' Secondary',
};

function formatTimestamp(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
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
  const [renderMode, setRenderMode] = useState<'landscape' | 'vertical'>('landscape');
  const pollTimers = useRef<Record<number, ReturnType<typeof setInterval>>>({});
  const pollStartTimes = useRef<Record<number, number>>({});

  const MAX_POLL_DURATION = 12 * 60 * 1000; // 12 minutes (face tracking + download + render)

  useEffect(() => {
    return () => {
      Object.values(pollTimers.current).forEach(clearInterval);
    };
  }, []);

  // Fetch recent analyses on mount
  useEffect(() => {
    setLoadingHistory(true);
    fetch('/api/history')
      .then((r) => r.json())
      .then((data) => {
        if (data?.analyses) setHistory(data.analyses);
      })
      .catch(() => {
        /* silent — history is non-critical */
      })
      .finally(() => setLoadingHistory(false));
  }, []);

  // Refresh history after a new analysis completes
  const prevStageRef = useRef(stage);
  useEffect(() => {
    if (prevStageRef.current === 'analyzing' && stage === 'done') {
      // A fresh analysis just completed — refresh history
      fetch('/api/history')
        .then((r) => r.json())
        .then((data) => {
          if (data?.analyses) setHistory(data.analyses);
        })
        .catch(() => {});
    }
    prevStageRef.current = stage;
  }, [stage]);

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

      // Poll
      const clipId = data.clipId;
      pollStartTimes.current[momentIndex] = Date.now();
      const timer = setInterval(async () => {
        try {
          // Stop if exceeded max poll duration
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

  const stageDurations: Record<Stage, number> = {
    fetching: 3000,
    extracting: 2000,
    analyzing: 35000,
    ranking: 1500,
    idle: 0,
    done: 0,
    error: 0,
  };

  function simulateProgress(currentStage: Stage): number {
    if (currentStage === 'idle' || currentStage === 'done' || currentStage === 'error') return 100;
    const elapsed = Date.now() - stageStart;
    const total = stageDurations[currentStage] || 5000;
    return Math.min(95, Math.round((elapsed / total) * 100));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = url.trim();
    if (!trimmed) return;

    if (!validateYouTubeUrl(trimmed)) {
      setError('Invalid YouTube URL. Please check and try again.');
      setStage('error');
      return;
    }

    setResult(null);
    setError('');
    setClipStates({});
    setClipUrls({});
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

      if (data.moments && data.moments.length > 0) {
        setResult(data);
        setStage('done');
      } else {
        setError('No clip-worthy moments found in this video. Try a different video.');
        setStage('error');
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Network error. Please try again.';
      setError(message);
      setStage('error');
    }
  }

  function formatScore(score: number): string {
    if (score >= 85) return score.toString();
    if (score >= 70) return score.toString();
    return score.toString();
  }

  function renderClipButton(moment: Moment) {
    const state = clipStates[moment.rank] || 'idle';

    switch (state) {
      case 'idle':
        return (
          <button
            className="clip-btn"
            onClick={() => generateClip(moment.rank)}
          >
            Generate Clip
          </button>
        );
      case 'generating':
        return (
          <button className="clip-btn clip-btn-generating" disabled>
            Generating...
          </button>
        );
      case 'ready':
        return (
          <a
            className="clip-btn clip-btn-ready"
            href={clipUrls[moment.rank] || '#'}
            download
          >
            Download MP4
          </a>
        );
      case 'failed':
        return (
          <div className="clip-error-group">
            <button
              className="clip-btn clip-btn-failed"
              onClick={() => generateClip(moment.rank)}
            >
              Retry
            </button>
            {clipErrors[moment.rank] && (
              <span className="clip-error-text">{clipErrors[moment.rank]}</span>
            )}
          </div>
        );
    }
  }

  const progress = simulateProgress(stage);

  return (
    <div className="container">
      <header className="header">
        <h1 className="logo">
          <span className="logo-accent">GANY</span>IQ
        </h1>
        <p className="tagline">
          Find clip-worthy moments in any YouTube video
        </p>
      </header>

      <main className="main">
        {/* Input Section */}
        <section className="input-section">
          <form onSubmit={handleSubmit} className="form">
            <div className="input-group">
              <input
                type="url"
                className="url-input"
                placeholder="Paste YouTube URL here..."
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                disabled={stage === 'fetching' || stage === 'extracting' || stage === 'analyzing' || stage === 'ranking'}
                autoFocus
              />
              <button
                type="submit"
                className="analyze-btn"
                disabled={!url.trim() || stage === 'fetching' || stage === 'extracting' || stage === 'analyzing' || stage === 'ranking'}
              >
                {stage === 'fetching' || stage === 'extracting' || stage === 'analyzing' || stage === 'ranking' ? (
                  <span className="btn-loading">Analyzing...</span>
                ) : (
                  'Analyze'
                )}
              </button>
            </div>
          </form>
        </section>

        {/* History Section — show when idle or after results */}
        {history && history.length > 0 && stage !== 'fetching' && stage !== 'extracting' && stage !== 'analyzing' && stage !== 'ranking' && (
          <section className="history-section">
            <div className="history-header">
              <h2>Recent Analyses</h2>
            </div>
            <div className="history-list">
              {history.map((item) => (
                <div key={item.analysisId} className="history-card">
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
                    <div className="history-title">{item.title}</div>
                    <div className="history-channel">{item.channelName}</div>
                    <div className="history-meta">
                      <span>{item.totalMoments} moments</span>
                      {item.avgScore !== null && (
                        <span className="history-score">Avg {item.avgScore}</span>
                      )}
                      <span className="history-date">
                        {new Date(item.createdAt).toLocaleDateString('en-US', {
                          month: 'short',
                          day: 'numeric',
                        })}
                      </span>
                    </div>
                  </div>
                  <button
                    className="history-open-btn"
                    onClick={() => openAnalysis(item.analysisId)}
                  >
                    Open Analysis
                  </button>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Loading Section */}
        {(stage === 'fetching' || stage === 'extracting' || stage === 'analyzing' || stage === 'ranking') && (
          <section className="loading-section">
            <div className="progress-bar-container">
              <div className="progress-bar" style={{ width: `${progress}%` }} />
            </div>
            <div className="stage-indicator">
              <div className="stage-dot active" />
              <span className="stage-label">{STAGE_LABELS[stage]}</span>
            </div>
            <div className="stage-hint">
              {stage === 'fetching' && 'Downloading and processing video transcript...'}
              {stage === 'extracting' && 'Finding potential clip-worthy segments...'}
              {stage === 'analyzing' && 'Scoring moments with AI analysis...'}
              {stage === 'ranking' && 'Ranking and filtering best moments...'}
            </div>
          </section>
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

        {/* Results Section */}
        {stage === 'done' && result && (
          <section className="results-section">
            <div className="results-header">
              <h2>Clip Recommendations</h2>
              <span className="moment-count">{result.moments.length} moments</span>
            </div>

            {/* Render Mode Toggle */}
            <div className="render-mode-toggle">
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
                Vertical Shorts 9:16
              </button>
            </div>

            <div className="moments-list">
              {result.moments.map((moment) => (
                <div key={moment.rank} className={`moment-card ${moment.tier}`}>
                  <div className="moment-rank">
                    <span className="rank-number">#{moment.rank}</span>
                    <span className="tier-badge" style={{ background: TIER_COLORS[moment.tier] || '#888' }}>
                      {TIER_LABELS[moment.tier] || moment.tier}
                    </span>
                  </div>

                  <div className="moment-meta">
                    <div className="meta-item">
                      <span className="meta-label">Score</span>
                      <span className="meta-value score">{formatScore(moment.worthClippingScore)}</span>
                    </div>
                    <div className="meta-item">
                      <span className="meta-label">Timestamp</span>
                      <span className="meta-value">{moment.startTimestamp} &mdash; {moment.endTimestamp}</span>
                    </div>
                  </div>

                  <div className="moment-dna">
                    {moment.dnaTags.map((tag) => (
                      <span key={tag} className="dna-tag">{tag}</span>
                    ))}
                  </div>

                  <p className="moment-reasoning">{moment.reasoning}</p>

                  {moment.transcriptExcerpt && (
                    <div className="moment-excerpt">
                      <span className="excerpt-label">Transcript</span>
                      <p className="excerpt-text">&ldquo;{moment.transcriptExcerpt.slice(0, 200)}{moment.transcriptExcerpt.length > 200 ? '...' : ''}&rdquo;</p>
                    </div>
                  )}

                  {/* Clip Generation Button */}
                  <div className="clip-action">
                    {renderClipButton(moment)}
                  </div>
                </div>
              ))}
            </div>

            <div className="new-analysis">
              <button className="new-btn" onClick={() => { setStage('idle'); setResult(null); setUrl(''); }}>
                Analyze Another Video
              </button>
            </div>
          </section>
        )}

        {/* Empty state */}
        {stage === 'idle' && !result && (
          <section className="empty-section">
            <div className="empty-illustration">
              <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="23 7 16 12 23 17 23 7" />
                <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
              </svg>
            </div>
            <p className="empty-text">
              Paste a YouTube URL above to discover the best moments worth clipping
            </p>
          </section>
        )}
      </main>

      <footer className="footer">
        <p>GANYIQ &mdash; AI-powered clip discovery</p>
      </footer>
    </div>
  );
}
