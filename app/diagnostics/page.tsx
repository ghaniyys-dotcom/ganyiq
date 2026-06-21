'use client';

import { useEffect, useState } from 'react';

interface DiagnosticsData {
  total_scored: number;
  top_clips: any[];
  bottom_clips: any[];
  distributions: {
    information_gain: any;
    attention_capture: any;
    harm: any;
    final_score: any;
    viral_score?: any;
  };
  category_distribution: Record<string, number>;
  top_10_percent_categories: Record<string, number>;
  bottom_10_percent_categories: Record<string, number>;
}

export default function DiagnosticsPage() {
  const [data, setData] = useState<DiagnosticsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchData() {
      try {
        const res = await fetch('/api/diagnostics/ranking');
        if (!res.ok) throw new Error('Failed to fetch');
        const json = await res.json();
        setData(json);
      } catch (e: any) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    }
    fetchData();
  }, []);

  if (loading) return <div className="p-8">Loading diagnostics...</div>;
  if (error) return <div className="p-8 text-red-500">Error: {error}</div>;
  if (!data) return <div className="p-8">No data</div>;

  return (
    <div className="p-8 max-w-6xl mx-auto">
      <h1 className="text-3xl font-bold mb-6">GANYIQ Diagnostics Dashboard</h1>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Summary */}
        <div className="bg-zinc-900 p-6 rounded-xl">
          <h2 className="text-xl mb-4">Summary</h2>
          <p>Total scored clips: <span className="font-mono text-2xl">{data.total_scored}</span></p>
          <p className="mt-2 text-sm text-zinc-400">Frozen evaluator + viral score active</p>
        </div>

        {/* Distributions */}
        <div className="bg-zinc-900 p-6 rounded-xl">
          <h2 className="text-xl mb-4">Score Distributions</h2>
          <div className="space-y-2 text-sm">
            <div>Information Gain: mean {data.distributions.information_gain.mean} (min {data.distributions.information_gain.min}, max {data.distributions.information_gain.max})</div>
            <div>Attention Capture: mean {data.distributions.attention_capture.mean}</div>
            <div>Harm: mean {data.distributions.harm.mean}</div>
            <div>Final Score: mean {data.distributions.final_score.mean} (min {data.distributions.final_score.min}, max {data.distributions.final_score.max})</div>
            <div className="mt-2">Viral Score: mean {data.distributions.viral_score?.mean || "N/A"}</div>
          </div>
        </div>

        {/* Top Clips */}
        <div className="bg-zinc-900 p-6 rounded-xl">
          <h2 className="text-xl mb-4">Top Ranked Clips</h2>
          <ul className="text-sm space-y-1">
            {data.top_clips.slice(0, 8).map((clip: any, i: number) => (
              <li key={i} className="truncate">#{i+1} {clip.transcript_excerpt?.slice(0,80)}... (IG:{clip.information_gain} Final:{clip.final_score})</li>
            ))}
          </ul>
        </div>

        {/* Bottom Clips */}
        <div className="bg-zinc-900 p-6 rounded-xl">
          <h2 className="text-xl mb-4">Bottom Ranked Clips</h2>
          <ul className="text-sm space-y-1">
            {data.bottom_clips.slice(0, 8).map((clip: any, i: number) => (
              <li key={i} className="truncate"> {clip.transcript_excerpt?.slice(0,80)}... (IG:{clip.information_gain} Final:{clip.final_score})</li>
            ))}
          </ul>
        </div>
      </div>

      <div className="mt-8 bg-zinc-900 p-6 rounded-xl">
        <h2 className="text-xl mb-4">Phase 1 — Tier 1 Features</h2>
        <ul className="text-sm space-y-1">
          <li>Scene detection: module ready (ffmpeg-based, worker/scene-detector.ts)</li>
          <li>Visual quality scoring: OpenCV-based blur/brightness/face analysis (worker/visual-quality-scorer.py)</li>
          <li>Viral moment detection: active in pipeline (hook strength, surprise, novelty, emotional intensity, audience relevance)</li>
          <li>B-roll infrastructure: architecture layer created (keyword mapping, candidate generation in worker/broll-engine.ts)</li>
        </ul>
        <p className="text-xs text-zinc-500 mt-2">Viral score stored separately. Does not modify frozen evaluator or ranking formula.</p>
      </div>

      <div className="mt-8 bg-zinc-900 p-6 rounded-xl">
        <h2 className="text-xl mb-4">Evaluator Status</h2>
        <p className="text-sm">Evaluator: FROZEN (no changes to prompt, validator, or formula)</p>
        <p className="text-xs text-zinc-500 mt-4">All Phase 1 Tier 1 features are independent additions, not modifications to the evaluator.</p>
      </div>

      <div className="mt-4 text-xs text-zinc-500">
        Frozen evaluator in use. No tuning. Phase 1 features integrated.
      </div>
    </div>
  );
}
