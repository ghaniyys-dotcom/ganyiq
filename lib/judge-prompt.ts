/**
 * lib/judge-prompt.ts — Dimension-Specific Judge Prompts
 *
 * Each prompt evaluates ONE dimension of clip quality.
 * Designed for LLM structured output (JSON with score + reasoning).
 *
 * Scoring range: 0-10 (float, for internal precision)
 *
 * Based on OpusClip judgeResult reverse engineering:
 *   hookScore: 6-9 observed range
 *   coherenceScore: 6-10
 *   connectionScore: 5-10
 *   trendScore: 5-8
 */

// ---------------------------------------------------------------------------
// Judge Context (inline type to avoid circular dependency)
// ---------------------------------------------------------------------------

export interface JudgeContext {
  /** Full transcript text of the clip. */
  transcriptText: string;
  /** Clip duration in seconds. */
  durationSeconds: number;
  /** Number of speakers in this clip segment. */
  speakerCount: number;
  /** Number of source segments stitched to make this clip. */
  segmentCount: number;
  /** Detected topic or genre. */
  topic: string;
}

// ---------------------------------------------------------------------------
// Prompt Templates
// ---------------------------------------------------------------------------

/**
 * HOOK prompt: Evaluates whether the opening grabs attention.
 *
 * Opus rubric (inferred from comments):
 *   9-10: Strong question/controversial statement, immediately engaging
 *   7-8:  Relatable but needs setup, "consider making more direct"
 *   5-6:  Factual opening, no hook framing, "could be stronger"
 */
export function buildHookPrompt(candidate: JudgeContext): string {
  return `You are evaluating the HOOK STRENGTH of a video clip.
Rate how well the opening grabs attention and relates to the video's main topic.

CLIP TRANSCRIPT:
${candidate.transcriptText}

CLIP DURATION: ${candidate.durationSeconds}s
TOPIC: ${candidate.topic}

EVALUATION RUBRIC:
10 — Opening is a compelling question or controversial statement that immediately grabs attention and directly relates to the main topic
8-9 — Opening is engaging and relatable; captures attention effectively
6-7 — Opening is functional but could be more direct or attention-grabbing
4-5 — Opening is factual; no hook framing present
0-3 — No clear opening hook

Respond with JSON:
{
  "score": <number 0-10>,
  "reasoning": "<1-2 sentence explanation>"
}`;
}

/**
 * COHERENCE prompt: Evaluates logical flow and narrative progression.
 *
 * Opus rubric (inferred from comments):
 *   9-10: Single clear topic, smooth logical flow, "flows logically"
 *   7-8:  Multiple related points, some transitions, "clear progression"
 *   5-6:  Topic shifts, multiple speakers, stitched segments
 */
export function buildCoherencePrompt(candidate: JudgeContext): string {
  return `You are evaluating the COHERENCE of a video clip.
Rate how well the clip flows as a self-contained narrative.

CLIP TRANSCRIPT:
${candidate.transcriptText}

CLIP DURATION: ${candidate.durationSeconds}s
SPEAKER COUNT: ${candidate.speakerCount}
SEGMENT COUNT: ${candidate.segmentCount}

EVALUATION RUBRIC:
10 — Single clear topic with smooth logical progression; one unified narrative
8-9 — Multiple related points that flow naturally; transitions are clear
6-7 — Some topic shifts but generally coherent; may have minor jumps
4-5 — Stitched from different segments; noticeable topic shifts
0-3 — Disjointed; multiple unrelated topics; hard to follow

Respond with JSON:
{
  "score": <number 0-10>,
  "reasoning": "<1-2 sentence explanation>"
}`;
}

/**
 * CONNECTION prompt: Evaluates emotional resonance and relatability.
 *
 * Opus rubric (inferred from comments):
 *   9-10: Highly relatable, universal experience, emotional resonance
 *   7-8:  Relatable observations, "relatable and humorous"
 *   5-6:  Informational/topic-driven, less emotional appeal
 */
export function buildConnectionPrompt(candidate: JudgeContext): string {
  return `You are evaluating the CONNECTION quality of a video clip.
Rate how well the content emotionally resonates with viewers and feels relatable.

CLIP TRANSCRIPT:
${candidate.transcriptText}

CLIP DURATION: ${candidate.durationSeconds}s

EVALUATION RUBRIC:
10 — Universally relatable content that creates strong emotional resonance; viewers will feel personally connected
8-9 — Relatable observations that feel personal and genuine; good emotional appeal
6-7 — Generally interesting but not particularly emotional or relatable
4-5 — Informational or topic-driven; low emotional engagement
0-3 — Abstract or impersonal content; hard to connect with

Respond with JSON:
{
  "score": <number 0-10>,
  "reasoning": "<1-2 sentence explanation>"
}`;
}

/**
 * TREND prompt: Evaluates topical relevance and viral potential.
 *
 * Opus rubric (inferred from comments):
 *   8:   Currently trending topic, named entities, current events
 *   7:   Generally interesting, evergreen content
 *   5-6: Generic topic, no timeliness
 */
export function buildTrendPrompt(candidate: JudgeContext): string {
  return `You are evaluating the TREND ALIGNMENT of a video clip.
Rate how timely, viral, or culturally relevant this content is.

CLIP TRANSCRIPT:
${candidate.transcriptText}

CLIP DURATION: ${candidate.durationSeconds}s

EVALUATION RUBRIC:
10 — Highly timely/trending topic; mentions current events or viral moments
8-9 — Topical and shareable; relevant to ongoing conversations
6-7 — Generally interesting but evergreen; not time-sensitive
4-5 — Generic content; low shareability
0-3 — Dated or irrelevant content

Respond with JSON:
{
  "score": <number 0-10>,
  "reasoning": "<1-2 sentence explanation>"
}`;
}

/**
 * Build the combined judge prompt (all 4 dimensions in one LLM call).
 * More efficient than 4 separate calls.
 * 
 * Uses human-evaluation-derived weights:
 *   Connection: 1.5x (strongest predictor)
 *   Hook: 1.25x
 *   Trend: 0.75x
 *   Coherence: 0.5x (weakest predictor)
 */
export function buildCombinedJudgePrompt(candidate: JudgeContext): string {
  return `You are evaluating a video clip for short-form content (TikTok/Reels/Shorts).

CRITICAL: Use the FULL 0-10 scale. An average clip gets 5. Only exceptional clips get 8+. Only truly terrible clips get 1-2.

CLIP TRANSCRIPT:
${candidate.transcriptText}

CLIP DURATION: ${candidate.durationSeconds}s
SPEAKER COUNT: ${candidate.speakerCount}
SEGMENT COUNT: ${candidate.segmentCount}
TOPIC: ${candidate.topic}

SCORE ANCHORS:
Score 1 — Pure filler: outro ("jangan lupa subscribe"), guest intro ("hari ini bersama..."), generic greeting. Zero value.
Score 3 — Weak: Generic statement, no hook, no emotion, no data. Blah content that adds nothing.
Score 5 — Average: Has some value but no strong hook. A factual statement or mild opinion. Nothing memorable.
Score 7 — Good: Strong hook, clear insight, emotional or educational value. Would work as a standalone clip.
Score 9 — Excellent: Immediate hook in first 3s. High emotional density. Universal relatability. Memorable takeaway.

PENALIZE (score 1-3):
- Filler acknowledgements ("iya", "betul", "okelah", "heeh")
- Confirmations ("iya dong", "betul sekali")
- Housekeeping ("kita mulai ya", "lanjut")
- Pure transitions ("berikutnya", "next", "terus")
- Low-information dialogue that adds nothing to the topic

REWARD (score 7-9):
- Strong opening hook (question, controversial statement, emotional reveal)
- Actionable insight or data-driven analysis
- Emotional vulnerability or authenticity
- Strong opinion or controversial take
- Memorable quote or closing punch
- Self-contained narrative even if short
- **Inspirational statement or life lesson**
- **Motivational insight that reframes perspective**
- **Personal transformation story or vulnerability**
- **Emotional resonance that feels universal**

Respond with JSON:
{
  "hook": { "score": <number 0-10>, "reasoning": "<why>" },
  "coherence": { "score": <number 0-10>, "reasoning": "<why>" },
  "connection": { "score": <number 0-10>, "reasoning": "<why>" },
  "trend": { "score": <number 0-10>, "reasoning": "<why>" }
}`;
}

/**
 * Build batch prompt for evaluating multiple candidates in one call.
 * Includes full rubric with anchors.
 */
export function buildBatchJudgePrompt(candidates: JudgeContext[]): string {
  const clipsText = candidates.map((c, i) => {
    return `--- CLIP ${i + 1} ---
Transcript: ${c.transcriptText}
Duration: ${c.durationSeconds}s
Speakers: ${c.speakerCount}
Segments: ${c.segmentCount}`;
  }).join('\n\n');

  return `You are evaluating ${candidates.length} video clips for short-form content.

CRITICAL: Use the FULL 0-10 scale. An average clip gets 5. Only exceptional clips get 8+.

SCORE ANCHORS:
Score 1 — Pure filler (outro, intro, greeting). Zero value.
Score 3 — Weak statement, no hook, no emotion.
Score 5 — Average content, some value but unremarkable.
Score 7 — Good hook, clear value, emotional/educational.
Score 9 — Excellent: immediate hook, universal appeal, memorable.

PENALIZE (score 1-3): Filler confirmations, housekeeping, pure transitions, low-info dialogue. NOT penalizing introductions any more.
REWARD (score 7-9): Strong hook, actionable insight, emotional authenticity, strong opinion, memorable takeaway, **inspirational statement, life lesson, personal transformation, vulnerability**.

${clipsText}

For EACH clip, evaluate across 4 dimensions (score 0-10 each). Use the FULL scale.

Respond with JSON array:
[
  {
    "clipIndex": 0,
    "hook": { "score": <0-10>, "reasoning": "<why>" },
    "coherence": { "score": <0-10>, "reasoning": "<why>" },
    "connection": { "score": <0-10>, "reasoning": "<why>" },
    "trend": { "score": <0-10>, "reasoning": "<why>" }
  },
  ...
]`;
}
