# GANYIQ V3 Rendering Quality Audit — OpusClip-Level Upgrade Blueprint

**Date:** June 11, 2026
**Scope:** Full pipeline audit + gap analysis + execution roadmap
**Target:** Bring MP4 export quality from ~6/10 → 9-10/10

---

## TABLE OF CONTENTS

1. Current Architecture Diagram
2. Part 1 — Pipeline Trace (Active/Dead/Ineffective)
3. Part 2 — Face Tracking Deep Audit
4. Part 3 — Reaction Shot Engine Design
5. Part 4 — Split Screen Intelligence
6. Part 5 — Speaker Transitions
7. Part 6 — Subtitle System Audit
8. Part 7 — Visual Composition Audit
9. Part 8 — HD Quality / Export Audit
10. Part 9 — OpusClip Gap Analysis
11. Part A — Editorial vs Speaker Intelligence
12. Part B — Multi-Person Podcast Layouts
13. Part C — Peak Moment Detection
14. Part D — Subtitle Quality Root Causes
15. Part E — Word-by-Word Captions
16. Part F — Subtitle Template System
17. Part G — Emphasis Engine
18. Part H — Visual Rhythm Engine
19. Part I — Updated Gap Analysis
20. P0/P1/P2 Execution Roadmap

---

# 1. Current Architecture Diagram

```
Input Video (YouTube)
    │
    ▼
┌─────────────────────────────┐
│  yt-dlp download            │  ← Format: bestvideo[height<=1080][vcodec^=avc1]+bestaudio[ext=m4a]
│  Cache: 7-day TTL, 50GB cap │
└─────────────────────────────┘
    │
    ▼
┌─────────────────────────────┐
│  ffprobe source analysis    │  ← Logs resolution/codec/bitrate only
└─────────────────────────────┘
    │
    ▼
┌──────────────────────────────────────────────────────┐
│  analyzeFaces()  (face-tracker.ts)                   │
│                                                      │
│  ┌─ V2 Pipeline (tried first) ──────────────────┐   │
│  │  1. face-detect-v2.py (YOLOv8-face ONNX)      │   │
│  │  2. tracker.py (ByteTrack + Kalman)           │   │
│  │  3. speaker-detector.ts (AV-ASD)              │   │
│  │     ├─ diarize.py (PyAnnote→energy fallback)  │   │
│  │     ├─ transcribe.py (Whisper→Deepgram)       │   │
│  │     └─ lip motion energy from landmarks       │   │
│  │  4. decision-engine.ts (P1.1)                 │   │
│  └───────────────────────────────────────────────┘   │
│                                                      │
│  ┌─ V1 Fallback ─────────────────────────────┐      │
│  │  face-detect.py (Haar Cascade)            │      │
│  │  → greedy identity tracking               │      │
│  │  → dominant face selection                 │      │
│  └───────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────┐
│  subtitle-renderer.ts       │  ← ASS with karaoke \\K tags
│  groupWordsIntoLines()      │    28px Geist, bottom 12%
│  buildAssFile()             │
└─────────────────────────────┘
    │
    ▼
┌──────────────────────────────────────────────────────────┐
│  renderVerticalSplit()  (clip-renderer.ts)               │
│                                                          │
│  For each MultiCropSegment:                              │
│    crops=1 → trim→crop→scale=1080:1920→unsharp→subtitle │
│    crops=2 → split→crop each→scale 1080:960→vstack      │
│    PiP → main full + inset (270x480, gold border)        │
│                                                          │
│  xfade chain for transitions                             │
│  Concat all segments → single-pass ffmpeg               │
│                                                          │
│  Encoder: h264_nvenc (preset p7, cq 22) or libx264      │
│           (preset fast, crf 20) + aac 128k              │
└──────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────┐
│  Upload to VPS              │
└─────────────────────────────┘
```

---

# PART 1 — PIPELINE TRACE: ACTIVE / DEAD / INEFFECTIVE

## Module Status Summary

| Module | File | Status | Evidence |
|--------|------|--------|----------|
| V2 Face Detector | `face-detect-v2.py` | **PARTIALLY ACTIVE** | Works only if ONNX model downloaded, Python + opencv + onnxruntime present. Falls back to V1 silently otherwise. |
| V1 Face Detector | `face-detect.py` | **ACTIVE** (fallback) | Haar Cascade, always works but poor quality — no confidence scores, no landmarks, no profile faces. |
| ByteTrack Tracker | `tracker.py` | **PARTIALLY ACTIVE** | Python ByteTrack; falls back to JS fallback (IoU matching + EMA) which is a poor substitute. |
| JS Fallback Tracker | `tracker.ts:JsFallbackTracker` | **ACTIVE** (common) | IoU threshold 0.2 + distance 150px. No Kalman filter in JS — only simple velocity/dampening. |
| Speaker Detector | `speaker-detector.ts` | **ACTIVE** | Works but lip motion energy is crude — uses nose-to-mouth distance delta only. No real AV fusion. |
| Diarization | `diarize.py` | **ACTIVE** | PyAnnote 3.1 → energy-based VAD fallback → single speaker fallback. Quality depends on HF token. |
| Transcription | `transcribe.py` | **ACTIVE** | Whisper small → Deepgram fallback. Word-level timestamps exist. |
| Decision Engine | `decision-engine.ts` | **ACTIVE** | EMA smoothing, Reaction scheduler, Layout switching all implemented. |
| Subtitle Renderer | `subtitle-renderer.ts` | **ACTIVE** | ASS karaoke, speaker colors, 28px, bottom 12%. |
| Clip Renderer | `clip-renderer.ts` | **ACTIVE** | Single-pass complex filter, xfade chain, NVENC detection. |
| Export Strategy | `lib/export-strategy.ts` | **EFFECTIVE** but NOT CONSUMED by rendering | Deterministic trim suggestions — but renderer doesn't use them. |

## Critical Ineffectiveness Findings

### Finding 1: `export-strategy.ts` output is discarded
The entire `ExportStrategy` (conservative/balanced/aggressive trims, retention estimates) is computed in `lib/export-strategy.ts` but is **never consumed by the rendering pipeline**. Clip start/end are dictated solely by the candidate window's `startSeconds`/`endSeconds` from `candidate-extraction.ts`. The export strategy module might be called from the analysis pipeline but its output is not fed into the renderer to trim dead air from clip boundaries. This means every rendered clip includes:
- Leading silence before first word
- Trailing silence after last word
- Mid-clip dead air gaps

### Finding 2: V2 pipeline fallback is silent
When V2 face detection or ByteTrack fails, the system silently falls back to V1 (Haar Cascade). Haar Cascade:
- Has no confidence scores (fixed 0.5)
- Has no landmarks (synthetic estimates)
- Cannot detect profile faces
- Returns no face for tilted/occluded faces
This means many renders get the V1 fallback WITHOUT the user knowing.

### Finding 3: Reaction cut detection is text-only
The "audio event detection" in `speaker-detector.ts` uses regex keyword matching on transcript words (e.g., `/haha/i`, `/lol/i`). This:
- Never detects silent laughter
- Never detects emotional responses without words
- Has zero actual audio signal processing
- Confidence is hardcoded (0.7 for laughter, 0.6 for gasp)
- No detection of applause, audience reactions, overlapping speech

### Finding 4: Active speaker detection is rudimentary
The "AV-ASD fusion" in `speaker-detector.ts`:
1. Computes lip motion energy (nose-to-mouth distance delta)
2. Threshold at 0.02 for "speaking"
3. Falls back to "face closest to center" or "first face"
This means:
- False positives when head moves but lips don't speak
- False negatives when speaker's face is occluded/side-profile
- No actual audio-visual synchronization
- Cuts to wrong speaker during rapid conversation

### Finding 5: Decision Engine reaction cuts are text-only triggered
The `ReactionScheduler` in `decision-engine.ts` offers events based on `frame.audioEvent`, which comes from text keyword matching. This means:
- No detection of silent/non-verbal reactions
- No detection of audience laughter (requires actual audio energy detection)
- Reaction cuts only fire when spoken words indicate a reaction (paradoxical — the person reacting is usually NOT speaking)

---

# PART 2 — FACE TRACKING DEEP AUDIT

## Current State: ~7/10

### What Works
- YOLOv8-face ONNX detection with 5 landmarks (eyes, nose, mouth corners)
- ByteTrack identity assignment (Python tracker)
- Per-face smoothing (identity-aware window averaging)
- Per-face interpolation (fills gaps of up to IDENTITY_TIMEOUT_FRAMES=3)
- Dead zone (30px) prevents jitter
- EMA smoothing in decision engine (alpha 0.15)

### What Doesn't Work

#### 1. Eye-line composition is absent
The crop coordinate calculation (`targetCropY = sample.cy - cropH * 0.35`) is a fixed percentage — it doesn't consider:
- Where the subject's eyes are in the frame
- Looking-room direction
- Whether the subject is looking left/right/up

**OpusClip likely does:** Eye-level positioning — the eyes are always at approximately 1/3 from top of frame (rule of thirds). If the subject looks left, the crop shifts right to create looking room.

#### 2. Rule of thirds is not applied
Crop positioning centers the face with `cropX = faceCx - cropW/2, clamped to [0, sourceWidth - cropW]`. There's no compositional awareness:
- No face grid positioning (left third, center third, right third)
- No dynamic offset for looking room
- No headroom calculation
- For landscape→vertical crops, the face is always dead center

**OpusClip likely does:** Positions the face on power points (intersections of thirds grid). For horizontal video → vertical, the subject is placed on the left or right third line, not center.

#### 3. Predictive tracking is absent
The camera position is purely reactive:
- Follower mode with dead zone
- No velocity prediction
- No acceleration/deceleration curves
- When a face moves, the crop follows at EMA rate
- When a speaker switches, the camera snaps (even with sprint EMA)

**OpusClip likely does:** Predictive tracking with velocity vectors. When a person starts turning their head, the crop anticipates where they'll be looking. When a new speaker starts talking, the system has already started moving toward them (using VAD pre-roll).

#### 4. No temporal smoothing of crop dimensions
The crop width/height are fixed: `cropH = sourceHeight; cropW = sourceHeight * (1080/1920)`. This means:
- In a group shot, all faces are cropped to the same width
- No dynamic zoom during emotional moments
- No push-in effect during punchlines

**OpusClip likely does:** Dynamic zoom — slowly zoom in during emotional moments (1-3% over 2-5 seconds), zoom out slightly when both people are in frame to give breathing room.

#### 5. No multi-person framing awareness
When 2 people are side by side in a 16:9 frame and the crop is vertical 9:16, the system:
- Picks one dominant face
- Crops to that face only
- Loses all context of the other person

This is acceptable for solo speakers but poor for podcasts where both people need to be visible.

#### 6. Face detection sample rate is too low
`SAMPLE_RATE = 1.0` means 1 detection per second. For 30fps video, this is 1/30 frames analyzed. This causes:
- Missed expressions (a 0.5s smile can be completely missed)
- Choppy crop transitions even with interpolation
- Poor timing for reaction cuts

---

# PART 3 — REACTION SHOT ENGINE DESIGN

## Problem

Current system: `Speaker talks → Camera stays on speaker.`  
Desired: `Conversation-aware editing — show Person B laughing at Person A's joke.`

## Root Cause

The `ReactionScheduler` in `decision-engine.ts` depends on `frame.audioEvent` which comes from text keyword matching. This cannot detect:
- Silent reactions (laughing without words)
- Visual-only reactions (shocked facial expression)
- Audience reactions
- Overlapping reactions

## Design: Reaction Detection Engine

### 3.1 Audio-Based Detection (REQUIRED)

Add a Python script `reaction-detector.py` that:
1. Extracts audio from the clip window
2. Computes spectrogram features using librosa
3. Trains/runs a binary classifier for:
   - Laughter (high-frequency energy bursts, rhythmic 3-8Hz)
   - Applause (broadband noise burst with decay)
   - Gasp (sudden broadband spike)
   - Silence/breath holds (energy drop preceding emotional moment)
4. Outputs: `[{ time, eventType, confidence, duration }]`

**Model:** A simple CNN on mel-spectrogram patches or use an existing model like `SpeechBrain emotion-recognition` or a fine-tuned `YAMNet`.

### 3.2 Visual-Based Detection (REQUIRED)

Add facial expression analysis using the existing YOLOv8-face landmarks:
1. Compute mouth aspect ratio (MAR) over time:
   - MAR = |lm - rm| / |le - re|
   - Peak MAR > threshold = smile/laughter candidate
2. Compute eye aspect ratio (EAR) from eye landmarks:
   - EAR drop > threshold = surprise/shock candidate
3. Compute head pose from landmark asymmetry:
   - Sudden head tilt = reaction to something

### 3.3 Fusion Engine

Merge audio + visual detection into a single `ReactionFrame`:

```typescript
interface ReactionFrame {
  time: number;
  faceId: number;
  score: number;          // 0-100 reaction importance
  type: 'laughter' | 'gasp' | 'smile' | 'shock' | 'applause' | 'none';
  audioConfidence: number;
  visualConfidence: number;
  duration: number;       // expected hold time
}
```

### 3.4 Scoring Logic

```
ReactionScore = audioScore * 0.5 + visualScore * 0.3 + contextScore * 0.2

contextScore factors:
- Face is NOT the current speaker (+20)
- Face WAS the speaker recently (+10, avoids cutting away from storyteller)
- Multiple faces reacting simultaneously (+30, peak moment!)
- Face is listener, not primary (+25)
```

### 3.5 Trigger Thresholds

| Event | Min Audio Conf | Min Visual Conf | Min Score | Hold Duration |
|-------|---------------|-----------------|-----------|---------------|
| Laughter | 0.35 | 0.3 | 40 | 0.8-1.5s |
| Gasp | 0.4 | 0.25 | 35 | 0.6-1.2s |
| Smile | 0 | 0.5 | 30 | 0.5-1.0s |
| Shock | 0.1 | 0.5 | 35 | 0.8-1.5s |
| Applause | 0.5 | 0 | 30 | 1.0-2.5s |

### 3.6 Decision Rules

```
IF reactionScore > threshold AND faceId != currentSpeaker:
  IF scheduler.cooldown_remaining == 0:
    SCHEDULE reaction cut to faceId
    SET cooldown = 2.5s
    SET holdDuration = based on event type

IF multiple faces have simultaneous reactions (within 0.3s):
  SPLIT SCREEN showing all reacting faces (even if 3+)
  ESCALATE to quad layout
```

---

# PART 4 — SPLIT SCREEN INTELLIGENCE

## Current State: Poor

### Problems

1. **Split decision is face-count-based, not conversation-based**
   - Split activates when 2+ faces detected (with hold timer)
   - No awareness of whether those faces are actually participating
   - Shows static listener in split even when they're not reacting

2. **Only 2-way split implemented**
   - SPLIT_2 = 50/50 vertical stack
   - No 3-way, 4-way, hero+reaction, or wide context layouts
   - No dynamic layout transitions

3. **Duplicate crops happen**
   - When face tracking swaps IDs mid-segment, the segment builder can produce crops for the same physical person at different positions
   - Caused by IDENTITY_MATCH_DIST being too permissive (100px)

4. **PiP implementation is crude**
   - Fixed 270x480 inset (25% of frame)
   - Always bottom-right with gold border
   - No intelligence about WHERE to place PiP (should be based on:
     - Empty space in frame
     - Where the main subject is looking
     - Speaker's gaze direction)

## Design: Opus-Style Layout Engine

### 4.1 Layout Options

```
SINGLE          — 1 face, full 1080x1920
  Usage: Solo speaker, monologue, single talking head

SPEAKER_WIDE    — 1 face, slightly zoomed out (10% wider crop)
  Usage: Speaker using hand gestures, showing something

SPLIT_2         — 50/50 vertical stack
  Usage: Two active speakers, dialogue, debate

SPLIT_3         — 33/33/33 or Hero + 2 small
  Usage: 3-person podcast, panel discussion

SPLIT_4         — 2x2 grid
  Usage: 4-person show, family reaction video

LISTENER_PIP    — Full speaker + PiP listener
  Usage: Speaker talking, listener reacting silently
  PiP position: determined by empty space in speaker's frame

HERO_REACTION   — 60/40 top/bottom split
  Usage: Primary speaker large + 1-2 reaction panels below
  Ideal for interview reactions

REACTION_CUT    — Full-frame listener (brief, 0.8-1.5s)
  Usage: Rapid reaction to punchline/joke

WIDE_CONTEXT    — Full 16:9 source with letterboxing
  Usage: Establishing shot, visual demonstration
```

### 4.2 Decision Rules

```
IF 1 face visible:
  IF face is gesturing or hands visible → SPEAKER_WIDE
  ELSE → SINGLE

IF 2 faces visible:
  IF both have spoken in last 5s → SPLIT_2
  IF only 1 speaking AND listener is reacting:
    IF reaction is strong (score>50) → REACTION_CUT
    IF reaction is mild (score 20-50) → LISTENER_PIP
  IF 1 speaking AND listener is NOT reacting → SINGLE (speaker only)
  IF rapid back-and-forth (<2s between turns) → SPLIT_2

IF 3-4 faces visible:
  IF 2+ active speakers → SPLIT_3 or SPLIT_4
  IF 1 speaker + 2+ reactors → HERO_REACTION
  IF 1 speaker + listeners NOT reacting → SINGLE (hero shot)

PEAK MOMENT OVERRIDE:
  IF laughter/applause detected from 2+ faces simultaneously:
    → ESCALATE to HERO_REACTION or SPLIT_4
    → Hold for duration of peak
    → Return to previous layout after peak
```

### 4.3 Why Current Split Feels Arbitrary

The current `buildSplitSegments` logic in `clip-renderer.ts` uses:
- Face count as the only input
- `SPLIT_CONFIDENCE_FLOOR = 0.01` (far too low — accepts noise as "active face")
- No speaker activity awareness
- No reaction awareness

The fix requires feeding speaker activity data into the split decision, which the `DecisionEngine` already computes but the legacy `buildSplitSegments` doesn't use.

---

# PART 5 — SPEAKER TRANSITIONS

## Current State: Reactive

### Current Logic
In `speaker-detector.ts`, active speaker is determined by:
1. Highest lip motion energy > 0.02 threshold
2. If no clear lip motion → face closest to center
3. If nothing → first face

### Problems

1. **No anticipation** — system waits for lip movement before cutting
2. **Hard cuts on turn detection** — `turnDetected` flag causes immediate segment boundary
3. **No minimum hold** — `MIN_HOLD_FRAMES = 1` in face-tracker, `1.5s` in decision-engine — too short
4. **No transition confidence** — each turn detection is treated equally
5. **Audio diarization not fused with visual** — they run independently, then speaker-detector.ts tries to merge with ad-hoc logic

### Design: Predictive Transition System

#### 5.1 Transition Confidence Score

```typescript
interface TurnPrediction {
  fromFaceId: number;
  toFaceId: number;
  confidence: number;         // 0-100
  predictedTime: number;      // when the turn will happen
  audioCue: boolean;          // did audio indicate the turn?
  visualCue: boolean;         // did visual indicate the turn?
}
```

Factors:
- Audio diarization: detected speaker label change (+30)
- Lip motion: current speaker lip motion decreasing, target increasing (+25)
- Head turn: current speaker turning toward target (+20)
- Silence: brief pause after current speaker's last word (+15)
- Visual attention: target looking at current speaker (+10)

#### 5.2 Minimum Hold Duration

| Context | Min Hold |
|---------|----------|
| Monologue | 3.0s |
| Active dialogue | 2.0s |
| Heated debate | 1.5s |
| Rapid Q&A | 1.0s |

#### 5.3 Cut Suppression Rules

```
IF transitionConfidence < 50:
  DO NOT cut — hold current speaker
IF transitionConfidence 50-70 AND timeSinceLastCut < minHold:
  DO NOT cut — extend hold
IF transitionConfidence > 70 AND timeSinceLastCut >= minHold:
  SCHEDULE cut at predictedTime
IF durationSinceLastCut > maxHold (8s):
  FORCE cut to most likely speaker (even with low confidence)
```

#### 5.4 Audio Pre-roll

When a new speaker starts talking, their first word is often cut off because the system is still showing the previous speaker. The fix:
- Use VAD (voice activity detection) to detect the NEW speaker starting 100-200ms before their first audible word
- Pre-roll: start the transition 150ms before the turn boundary
- Use crossfade (0.15s) to mask the transition

---

# PART 6 — SUBTITLE SYSTEM AUDIT

## Current State: ~5/10

### What Works
- ASS format with karaoke (\\K tags)
- Speaker-aware coloring (gold primary, blue/teal/pink/purple for alternates)
- 28px Geist Sans Bold font
- 2px black outline
- Bottom 12% positioning
- Max 2 lines, 40 chars per line

### What's Missing

#### 6.1 Segmentation Quality

Current `groupWordsIntoLines` uses:
- 0.4s pause threshold for line breaks
- 40 char max per line
- Natural breaks at punctuation

**Problems:**
- Lines often split mid-phrase
- Word groupings feel robotic because they're timing-only (no NLP)
- No awareness of grammatical units (noun phrases, verb phrases)
- No max duration per line (a line could be visible for 0.1s or 4s)

**Fix:** Add NLP-aware chunking:
```
1. Parse transcript into clauses using dependency parsing (or simple punctuation heuristics)
2. Group words into lines by clause boundaries
3. Max 2 lines, max 3.5s per line
4. Minimum 0.5s per line (flicker prevention)
5. Penalty for breaking multi-word expressions ("terima kasih", "ada apa")
```

#### 6.2 Emphasis is Missing

The current subtitle system has NO emphasis at all:
- All words are the same color (karaoke only highlights timing)
- No bold/italic for emphasis
- No size variation for important words
- No animated emphasis

**Fix:** Add an emphasis system (see Part G below).

#### 6.3 Font Size is Too Small for Mobile

28px in a 1080p frame at standard viewing distance is approximately:
- 28/1080 = 2.6% of frame height
- On a phone (6.1" screen, viewed at 30cm): approximately 1.2mm tall
- Minimum recommended: 4-5% of frame height (43-54px)

**OpusClip uses ~36-48px** depending on content.

#### 6.4 No Background Opacity Control

Current `backgroundOpacity: 0.08` means 8% black background. This is very subtle. OpusClip uses a gradient background:
- Full-width background bar
- Gradient from 30% opacity at bottom to 0% at top
- Ensures readability over changing video backgrounds

#### 6.5 No Word Highlight Animation

The karaoke \\K tag only changes the word color at the exact moment it's spoken. More advanced systems use:
- Scale animation: word grows 1.1x when spoken
- Color transition: gradient from gray to white/gold
- Glow effect: subtle drop shadow on current word

---

# PART 7 — VISUAL COMPOSITION AUDIT

## Current Problems

### 7.1 Crop Margins Are Nonexistent

The crop `cropW = sourceHeight * (1080/1920)` uses the FULL source height with no padding. This means:
- At the edges of the source frame, the face can be cut off with zero margin
- No breathing room around the subject
- Headroom is variable — sometimes eyes are at 10%, sometimes at 40%

**Fix:** Add intelligent crop margins:
```
TOP_MARGIN = 0.05 * cropH     // 5% above head
SIDE_MARGIN = 0.05 * cropW     // 5% on each side
BOTTOM_MARGIN = 0.08 * cropH   // 8% below chin
```

### 7.2 No Safe Area Awareness

Modern phones have:
- Notch at top
- Dynamic Island
- Rounded corners
- Status bar

Current crops don't account for this. Subtitles are at 12% from bottom, which may overlap with system home indicator on iPhone.

**Fix:** Define safe areas:
```
TOP_SAFE = 0.08       // 8% top safe zone (notch)
BOTTOM_SAFE = 0.05    // 5% bottom safe zone (home indicator)
EXPORT_RESOLUTION: 1080x1920
ACTIVE_VIDEO_AREA: 1080x1776 (top 88px + bottom 56px clipped)
SUBTITLE_POSITION: 50px from bottom of ACTIVE_VIDEO_AREA
```

### 7.3 Eye-Line Positioning

The crop Y position formula `targetCropY = sample.cy - cropH * 0.35` is a rough heuristic. Better:

```
1. Detect eye positions from landmarks
2. Position eyes at Y = cropHeight * 0.33 (rule of thirds: eyes at upper third line)
3. Clamp so head doesn't exceed top margin or fall below center
4. If speaker is looking up/down, adjust accordingly
```

### 7.4 Looking Room

When a person is looking to the side (profile/semi-profile), the crop should:
- Shift to put more space in front of their face than behind
- `offset = faceWidth * 0.1` in the direction of their gaze
- Gaze direction: from eye landmarks, determine left/right/center

### 7.5 Multi-Person Balance

When two people are in split-screen:
- Each panel should have balanced headroom
- Both subjects should appear to be at the same height
- If one person is much taller, the crop center adjusts per-person

---

# PART 8 — HD QUALITY / EXPORT AUDIT

## Current Settings

| Setting | Current Value | OpusClip Estimated |
|---------|--------------|-------------------|
| Resolution | 1080x1920 | 1080x1920 |
| Encoder (GPU) | h264_nvenc presets p7 cq 22 | h264_nvenc presets p7 cq 18 |
| Encoder (CPU) | libx264 preset fast crf 20 | libx264 preset medium crf 18 |
| Audio | aac 128k | aac 192k |
| Scaling | lanczos | lanczos |
| Sharpening | unsharp 5:5:0.8:3:3:0.4 | unsharp + adaptive |
| Source download | bestvideo[height<=1080] | bestvideo[height<=1080] |

## Recommendations

### 8.1 CRF/CQ Values

| Encoder | Current | Recommended | Why |
|---------|---------|-------------|-----|
| NVENC | cq 22 | cq 18-19 | NVENC cq 22 is visibly blocky in high-motion. cq 18 matches libx264 crf 18. |
| libx264 | crf 20 | crf 17-18 | crf 20 is good but crf 18 gives noticeably better retention of face detail. |
| libx264 preset | fast | medium | "fast" reduces quality by ~5% compared to "medium" with same crf. |

### 8.2 Audio Bitrate

Current: 128k aac
Recommended: 192k aac

Clear speech requires less bandwidth but music/background audio in podcasts benefits from higher bitrate. 128k can sound watery for applause and crowd reactions.

### 8.3 Source Download Quality

Current format: `bestvideo[height<=1080][vcodec^=avc1]+bestaudio[ext=m4a]/best[height<=1080]`

This prefers AVC (h.264) videos, which limits quality. Many high-end YouTube videos are VP9 (codec=vp9) which is up to 50% better quality at the same bitrate.

**Recommended:** 
```
bestvideo[height<=1080]+bestaudio/best[height<=1080]
```
Remove the `[vcodec^=avc1]` constraint to allow VP9/HDR sources.

### 8.4 Two-Pass Encoding for Final Export

For the best quality, add a two-pass VBR option:
```
Two-pass VBR:
  ffmpeg -y -i input -c:v libx264 -b:v 8M -preset medium -pass 1 -an -f mp4 /dev/null
  ffmpeg -y -i input -c:v libx264 -b:v 8M -preset medium -pass 2 -c:a aac -b:a 192k output.mp4
```

This gives more consistent quality across different content types.

### 8.5 Sharpening

Current `unsharp=5:5:0.8:3:3:0.4` is a good starting point but:
- Should be adaptive — less sharpening for already-sharp sources (1080p), more for upscaled (720p→1080)
- Should not sharpen noise (use a denoise pre-filter on low-quality sources)

**Recommended adaptive approach:**
```
IF sourceWidth >= 1920:
  unsharp=3:3:0.5:3:3:0.25    // Light sharpening only
ELSE IF sourceWidth >= 1280:
  unsharp=5:5:0.8:3:3:0.4     // Current (good for 720p→1080)
ELSE:
  unsharp=7:7:1.0:3:3:0.5     // Heavy sharpening for low-res
  + hqdn3d=2:2:3:3            // Denoise to prevent noise amplification
```

### 8.6 Color Space

Ensure proper color space tagging:
```
-colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv
```

Without these tags, some players (especially mobile) may display colors incorrectly.

---

# PART 9 — OPUSCLIP GAP ANALYSIS

| # | Category | GANYIQ | OpusClip | Gap | Root Cause | Fix Priority |
|---|----------|--------|----------|-----|------------|--------------|
| 1 | Face Tracking | 6/10 | 9/10 | 3 | No rule-of-thirds, no eye-line, no predictive tracking | P0 |
| 2 | Speaker Detection | 6/10 | 9/10 | 3 | Lip motion is weak; no actual AV fusion | P0 |
| 3 | Reaction Detection | 2/10 | 9/10 | 7 | Text-only keyword matching; no audio/visual emotion detection | P0 |
| 4 | Split Screen | 4/10 | 9/10 | 5 | Face-count-based; no conversation awareness; limited layouts | P0 |
| 5 | Subtitle Timing | 5/10 | 9/10 | 4 | No NLP-based chunking; no max duration per line | P1 |
| 6 | Subtitle Style | 4/10 | 9/10 | 5 | No emphasis; small font; no gradient background; no animations | P1 |
| 7 | Emphasis | 1/10 | 8/10 | 7 | No emphasis system at all | P1 |
| 8 | Visual Rhythm | 4/10 | 8/10 | 4 | Reactive cuts; no anticipation; no pacing rules | P1 |
| 9 | Editing Intelligence | 5/10 | 9/10 | 4 | No peak moment escalation; no layout transitions; no visual rhythm | P1 |
| 10 | Export Quality | 7/10 | 9/10 | 2 | CRF slightly high; audio 128k; no color tags; sharpening not adaptive | P2 |

---

# PART A — EDITORIAL VS SPEAKER INTELLIGENCE

## Problem

Current system optimizes for "show whoever is speaking" rather than "show whoever is most interesting."

## What's Missing

The system cannot detect:
- **Laughter** (unless someone says "haha")
- **Surprise** (unless someone says "wow")
- **Silent reactions** (nodding, smiling, shocked expression)
- **Agreement/disagreement** (non-verbal head shaking/nodding)
- **Audience reactions** (group laughter, applause)
- **Emotional build-up** (gradual expression change)

## Design: Reaction Importance Score

```typescript
interface ReactionImportanceScore {
  faceId: number;
  score: number;              // 0-100 — higher = more interesting to show
  factors: {
    audioEnergy: number;       // 0-25 — sudden audio burst from this person's direction
    facialMovement: number;    // 0-25 — sudden expression change detected
    duration: number;          // 0-20 — how long the reaction has been building
    novelty: number;           // 0-15 — hasn't been shown recently (avoids over-showing)
    speakerContext: number;    // 0-15 — is this a response to what was just said?
  };
}
```

The highest-scoring person **overrides** the active speaker as the camera target when their score exceeds the speaker's score by >20 points.

---

# PART B — MULTI-PERSON PODCAST LAYOUTS

## Current State

Only supports 1-person and 2-person layouts (SPLIT_2 is the max).

## Design: 1-4 Person Layouts

### B.1 Single Person

```
┌─────────────────┐
│                 │
│                 │
│    Speaker      │
│                 │
│                 │
│   [Subtitles]   │
└─────────────────┘
```

### B.2 Two Person — Dialogue

```
┌─────────────────┐
│  Speaker A       │
│                  │
├─────────────────┤
│  Speaker B       │
│                  │
│   [Subtitles]    │
└─────────────────┘
```

### B.2b Two Person — Interview (Hero + Reaction)

```
┌─────────────────┐
│                  │
│   Speaker A      │
│   (Host)         │
│                  │
├─────────────────┤
│ Speaker B │     │  ← B at 25% width if Piper
│ (Guest)   │     │
└─────────────────┘
```

### B.3 Three Person

```
┌─────────────────┐
│  Speaker A       │
│                  │
├────────┬────────┤
│  B     │  C     │
│        │        │
└────────┴────────┘
```

### B.3b Three Person — Hero + 2 Reactions

```
┌─────────────────┐
│                  │
│   Speaker A      │
│                  │
├────────┬────────┤
│  Reactor B │ C │
└────────┴────────┘
```

### B.4 Four Person

```
┌────────┬────────┐
│  A     │  B     │
│        │        │
├────────┼────────┤
│  C     │  D     │
│        │        │
└────────┴────────┘
```

### Layout Selection Rules

| Participants | Active Speakers | Best Layout |
|-------------|----------------|-------------|
| 1 | 1 | SINGLE |
| 2 | 1 | SINGLE (speaker) or LISTENER_PIP (if listener reacting) |
| 2 | 2 | SPLIT_2 (dialogue) or HERO_REACTION (if one dominant) |
| 3 | 1-2 | 3-way split (33% each) or HERO + 2 small |
| 3 | 3 | 3-way split |
| 4 | 1-2 | HERO + 3 small or 4-way grid |
| 4 | 3-4 | 4-way grid |

---

# PART C — PEAK MOMENT DETECTION

## Design

A Peak Moment Engine that detects when something particularly engaging is happening and escalates the visual layout temporarily.

### Detection Signals

| Signal | Source | Threshold | Weight |
|--------|--------|-----------|--------|
| Simultaneous laughter | audio reaction detector + facial landmarks | 2+ faces laughing simultaneously | 30 |
| Overlapping speech | VAD + diarization | 2+ speakers talking at once | 25 |
| Audience applause | audio event detector | energy burst > threshold | 25 |
| Sudden volume increase | audio RMS energy | +6dB over 0.5s baseline | 20 |
| Rapid speaker exchange | speaker change detector | 3+ changes in 8s | 20 |
| Emotional words | keyword detection | "incredible", "no way", etc. | 15 |
| Crowd reaction | broadband noise + multiple faces | sustained >1s | 30 |

### Escalation Rules

```
peakScore = sum of all active signal weights

IF peakScore >= 50:
  ESCALATE layout — add more faces to frame
  Duration: hold for peak duration + 0.3s decay

IF peakScore >= 80:
  MAXIMUM escalation (quad layout or hero+reaction)
  Add visual intensity (brighter? zoom? flash?)
  Duration: hold for peak duration + 0.5s decay

IF peakScore < 20 AND currently escalated:
  DECAY back to normal layout
  Decay time: 0.5s crossfade
```

---

# PART D — SUBTITLE QUALITY ROOT CAUSES

## Root Cause Analysis

### 1. Timing Accuracy

**Problem:** Word timestamps from Whisper small have ±200ms error, causing subtitles to appear before/after the spoken word.

**Fix:** Either:
- Use Deepgram (better timing accuracy, ±50ms) as primary instead of fallback
- Post-process Whisper timestamps with forced alignment (e.g., using Montreal Forced Aligner)
- Implement timing correction: shift all word end times by +100ms for readability

### 2. Segmentation Quality

**Problem:** The `pauseThreshold = 0.4s` groups pauses but doesn't create natural reading units.

**Fix:** Add NLP-based chunking:
```
1. Use spaCy or simple regex to identify clause boundaries
2. Prefer breaking at commas, conjunctions, relative clauses
3. Max 2 lines, max 3.5s visible duration
4. Penalize orphan words on new lines
```

### 3. Readability

**Problem:** 28px font, 8% background opacity, no gradient.

**Fix:** 
- Increase to 38px minimum
- Use gradient background (full-width bar, 30%→0% opacity)
- Increase outline to 3px
- Add 2px drop shadow

### 4. Mobile Visibility

**Problem:** Subtitles overlap with system UI elements on modern phones.

**Fix:**
- Define safe area: 56px from bottom (home indicator), 88px from top (notch)
- Position subtitles at 50px from bottom of safe area
- Use 16:9 export with internal safe area guidelines

---

# PART E — WORD-BY-WORD CAPTIONS

## Feasibility Assessment

**Verdict: FEASIBLE but requires significant rework**

### Approach

Option A: ASS-based (Limited)
- ASS supports \\K (karaoke timing) at syllable level
- Can animate word highlighting but cannot create true word-by-word appearance/disappearance
- Each word would need to be a separate Dialogue event with its own start/end time
- This creates thousands of dialogue lines → ASS file size grows linearly
- FFmpeg's ASS renderer may choke on 5000+ events

Option B: Video compositing (Recommended)
- Render each word position/timing to metadata
- Use a custom processing step: render frames with word-by-word text via `drawtext` filter
- Much more flexible but requires per-frame ffmpeg processing
- Significantly slower render times

Option C: Hybrid (Most practical for production)
- Use ASS for standard karaoke subtitles (current system)
- Identify 3-5 KEY moments per clip for word-by-word emphasis
- For those moments only, render a separate overlay video using drawtext
- Overlay with `overlay` filter
- This gives the "viral style" without 10x render time increase

### Production Architecture

```typescript
interface WordByWordSegment {
  startTime: number;
  endTime: number;
  words: Array<{
    text: string;
    appearTime: number;   // when this word appears
    disappearTime: number; // when it disappears
    x: number;             // position in 1080p frame
    y: number;
    scale: number;         // 1.0 = normal, 1.2 = emphasized
    color: string;         // override color
  }>;
}
```

Generation process:
1. Identify 3-5 high-impact moments per clip (punchlines, emotional peaks, key stats)
2. Generate word-by-word sequence for those moments only
3. Render as separate video stream
4. Overlay on main video
5. For all other moments, use standard ASS karaoke

---

# PART F — SUBTITLE TEMPLATE SYSTEM

## Template Engine Design

```typescript
interface SubtitleTemplate {
  name: string;
  fontFamily: string;
  fontSize: number;
  bold: boolean;
  italic: boolean;
  primaryColor: string;    // ASS color format
  outlineColor: string;
  outlineWidth: number;
  shadowColor: string;
  shadowDepth: number;
  backgroundOpacity: number;
  backgroundGradient: boolean;
  verticalPosition: number; // % from bottom
  horizontalAlignment: 'left' | 'center' | 'right';
  maxLines: number;
  maxCharsPerLine: number;
  wordByWordEnabled: boolean;
  emphasisColor: string;
  emphasisStyle: 'color' | 'scale' | 'bold' | 'glow';
  animation: 'none' | 'fade' | 'slide_up' | 'scale';
}
```

### Template Definitions

| Template | Font | Size | Color | Style | When to Use |
|----------|------|------|-------|-------|-------------|
| Opus Style | Geist Sans Bold | 38px | White → Gold emphasis | Gradient bg, karaoke highlight | Default — best retention |
| Alex Hormozi | Inter Bold | 44px | White | No bg, thin outline, large | High-energy, direct-to-camera |
| Iman Gadzhi | Montserrat Bold | 36px | Gold | Dark bg, uppercase key words | Storytelling, inspirational |
| MrBeast Style | Bebas Neue | 48px | Yellow | No bg, thick black outline | High-energy, fast cuts, kids |
| Podcast Minimal | Geist Sans Regular | 32px | White | 10% bg, no emphasis | Professional, clean aesthetic |
| Documentary | Serif (Merriweather) | 34px | Off-white | Subtle shadow, serif font | Serious, educational content |
| Clean Corporate | Inter Regular | 30px | White | 8% bg, minimal karaoke | Professional, B2B content |

---

# PART G — EMPHASIS ENGINE

## NLP Layer Design

### Detection Signals

| Category | Examples | Detection Method | Boost |
|----------|----------|-----------------|-------|
| Numbers | "50 million", "Rp 100 miliar" | regex for digits + unit patterns | Highlight gold |
| Money | "100 juta", "2 miliar" | regex for currency patterns | Highlight gold |
| Names | "Steve Jobs", "Elon" | NER or proper noun detection | Highlight gold |
| Emotional phrases | "this is incredible" | emotion keyword list | Highlight gold + scale 1.1x |
| Hooks | "wait for it", "you won't believe" | hook pattern list | Highlight gold + bold |
| Questions | "Why?", "What if?" | question mark detection | Keep white (don't emphasize) |
| Filler | "uh", "um", "jadi", "anu" | filler word list | Dim (70% opacity) |

### Implementation

```typescript
function identifyEmphasisWords(words: WordTimestamp[]): EmphasisWord[] {
  return words.map(word => {
    let emphasisType: 'none' | 'highlight' | 'dim' | 'scale' = 'none';
    let color = '#FFFFFF';

    if (isNumber(word.text)) { emphasisType = 'highlight'; color = '#E2C266'; }
    else if (isMoney(word.text)) { emphasisType = 'highlight'; color = '#E2C266'; }
    else if (isProperNoun(word.text)) { emphasisType = 'highlight'; color = '#E2C266'; }
    else if (isEmotional(word.text)) { emphasisType = 'scale'; color = '#FFD700'; }
    else if (isFiller(word.text)) { emphasisType = 'dim'; color = '#888888'; }

    return { word, emphasisType, color };
  });
}
```

The emphasis data is injected into the ASS file:
```
{\k20\c&HFFFFFF}this {\k15\c&H00E2C266}IS {\k10\c&HFFFFFF}absolutely {\k25\c&H00FFD700}CRAZY
```

Only 10-15% of words should be emphasized. The rest remain in the base color.

---

# PART H — VISUAL RHYTHM ENGINE

## Design

### Shot Duration Rules

| Context | Min Duration | Max Duration | Ideal Duration |
|---------|-------------|-------------|----------------|
| Single speaker | 1.5s | 8.0s | 2.5-4.0s |
| Active dialogue | 1.0s | 5.0s | 1.5-3.0s |
| Reaction shot | 0.8s | 2.0s | 1.0-1.5s |
| Split screen | 2.0s | 10.0s | 3.0-6.0s |
| Wide shot | 2.0s | 6.0s | 2.5-4.0s |
| Peak moment | 1.5s | 4.0s | 2.0-3.0s |

### Transition Confidence

```typescript
interface TransitionDecision {
  fromSegment: Segment;
  toSegment: Segment;
  confidence: number;         // 0-100
  reason: string;
  suggestedTransition: 'cut' | 'crossfade_0.1s' | 'crossfade_0.2s' | 'crossfade_0.3s';
}
```

- **Cut:** When switching between different speakers (clean, intentional)
- **Crossfade 0.1s:** When switching between same speaker, different position (smooth)
- **Crossfade 0.2s:** When transitioning between layouts (single → split)
- **Crossfade 0.3s:** When entering/exiting reaction shots

### Cut Suppression Rules

```
IF timeSinceLastCut < 0.5s:
  SUPPRESS — merge with previous segment

IF timeSinceLastCut < minHoldForContext:
  SUPPRESS — extend current shot

IF tooManyCutsInWindow (>3 cuts in 5s):
  HOLD current shot — reduce pacing
  Increase minHold by 0.5x for next 5s

IF noCutForTooLong (>8s):
  FORCE cut — even if confidence is low
  Pick most likely target
```

---

# PART I — UPDATED GAP ANALYSIS

| # | Category | GANYIQ | Target | Gap | Root Cause | Priority |
|---|----------|--------|--------|-----|------------|----------|
| 1 | Face Tracking | 6/10 | 9/10 | 3 | No eye-line, rule-of-thirds, predictive tracking, adaptive zoom | P0 |
| 2 | Speaker Diarization | 7/10 | 9/10 | 2 | PyAnnote when available is good; fallback is poor; no real AV fusion | P0 |
| 3 | Reaction Detection | 1/10 | 9/10 | 8 | Text-only keyword matching; no audio/visual emotion detection | P0 |
| 4 | Split Screen Intelligence | 4/10 | 9/10 | 5 | Face-count-based; limited layouts; no conversation awareness | P0 |
| 5 | Subtitle Timing | 5/10 | 9/10 | 4 | Whisper timing error; no NLP chunking; no max line duration | P1 |
| 6 | Subtitle Style | 4/10 | 9/10 | 5 | Small font; no gradient; no emphasis; no animation | P1 |
| 7 | Emphasis Detection | 1/10 | 8/10 | 7 | No emphasis system at all | P1 |
| 8 | Visual Rhythm | 4/10 | 8/10 | 4 | Reactive cuts; no anticipation; no pacing rules | P1 |
| 9 | Editing Intelligence | 5/10 | 9/10 | 4 | No peak moment escalation; no dynamic layout transitions | P1 |
| 10 | Overall Export Quality | 7/10 | 9/10 | 2 | CRF slightly high; audio can improve; no color tags; sharpening not adaptive | P2 |

---

# P0/P1/P2 EXECUTION ROADMAP

## P0 — HIGH IMPACT, MANDATORY (Weeks 1-3)

| # | Task | Expected Impact | Difficulty | Files Affected | Dependencies |
|---|------|----------------|------------|----------------|-------------|
| P0.1 | **Audio Reaction Detector** — Add Python script for real audio event detection (laughter, gasp, applause, silence) using librosa/spectrogram analysis | **HIGHEST** — enables actual reaction cuts | HARD | New: `worker/reaction-detector.py` | None |
| P0.2 | **Visual Reaction Detector** — Compute mouth aspect ratio (MAR), eye aspect ratio (EAR), head pose from existing landmarks for silent reactions | **HIGH** — detects non-verbal reactions | MEDIUM | `worker/face-tracker.ts`, `worker/speaker-detector.ts` | P0.1 (for fusion) |
| P0.3 | **Reaction Scheduler Upgrade** — Merge audio + visual reactions into the Decision Engine with proper scoring | **HIGH** — makes reaction cuts actually work | MEDIUM | `worker/decision-engine.ts`, New: `lib/reaction-engine.ts` | P0.1, P0.2 |
| P0.4 | **Smart Layout Engine** — Replace face-count split logic with conversation-aware layout selection (single, dual, hero+reaction, quad) | **HIGH** — fixes arbitrary split-screen feel | HARD | `worker/decision-engine.ts`, `worker/clip-renderer.ts` | P0.1 (needs speaker context) |
| P0.5 | **Predictive Speaker Transitions** — Add pre-roll, anticipation, and transition confidence | **MEDIUM** — smoother cuts, fewer hard transitions | MEDIUM | `worker/decision-engine.ts`, `worker/speaker-detector.ts` | P0.1 |
| P0.6 | **Eye-Line Composition** — Position faces on rule-of-thirds grid with looking room + headroom | **MEDIUM** — noticeably better framing | MEDIUM | `worker/face-tracker.ts` | None |

## P1 — HIGH IMPACT, IMPORTANT (Weeks 4-6)

| # | Task | Expected Impact | Difficulty | Files Affected | Dependencies |
|---|------|----------------|------------|----------------|-------------|
| P1.1 | **NLP Subtitle Chunking** — Replace timing-only line breaks with clause-aware segmentation | HIGH — subtitles feel natural | MEDIUM | `worker/subtitle-renderer.ts` | None |
| P1.2 | **Emphasis Engine** — Add NLP-based word emphasis (numbers, names, emotional words get highlighted) | HIGH — increases retention significantly | MEDIUM | New: `worker/emphasis-engine.ts`, `worker/subtitle-renderer.ts` | None |
| P1.3 | **Subtitle Template System** — Add 7 templates (Opus, Hormozi, MrBeast, etc.) | HIGH — differentiates the product | MEDIUM | `worker/subtitle-renderer.ts`, API to accept template param | P1.2 (optional) |
| P1.4 | **Peak Moment Detector** — Detect simultaneous laughter, overlapping speech, audience reactions and escalate layout | MEDIUM — makes clips feel alive | HARD | `worker/decision-engine.ts`, `worker/speaker-detector.ts` | P0.1, P0.2 |
| P1.5 | **Visual Rhythm Engine** — Add shot duration rules, cut suppression, transition confidence | MEDIUM — professional pacing | MEDIUM | `worker/decision-engine.ts` | P0.4, P0.5 |
| P1.6 | **Subtitle Visual Upgrade** — Increase font to 38px, add gradient bg, improve positioning | MEDIUM — looks more premium | EASY | `worker/subtitle-renderer.ts` | None |

## P2 — POLISH, ENHANCEMENT (Weeks 7-8)

| # | Task | Expected Impact | Difficulty | Files Affected | Dependencies |
|---|------|----------------|------------|----------------|-------------|
| P2.1 | **Export Quality Tuning** — CRF 18, audio 192k, adaptive sharpening, color space tags, VP9 source | MEDIUM — marginal quality gain | EASY | `worker/clip-renderer.ts` | None |
| P2.2 | **Dead Air Trimming** — Feed export-strategy into renderer to trim leading/trailing silence | LOW — minor improvement | EASY | `worker/clip-renderer.ts`, `lib/export-strategy.ts` | None |
| P2.3 | **Word-by-Word Captions (Hybrid)** — 3-5 key moments per clip get viral word-by-word style | MEDIUM — viral potential | HARD | New: `worker/word-by-word-renderer.ts`, `worker/subtitle-renderer.ts` | P1.2 |
| P2.4 | **Dynamic Zoom** — Slowly push in during emotional moments (1-3% over 2-5s) | LOW — subtle but noticeable | MEDIUM | `worker/face-tracker.ts`, `worker/decision-engine.ts` | P0.6 |
| P2.5 | **Multi-Person Balance** — Ensure consistent headroom and eye positions across all people in split screens | LOW — polish improvement | MEDIUM | `worker/face-tracker.ts` | P0.6 |

---

## Summary

**The single biggest gap** (8/10 gap) is **reaction detection** — text-only keyword matching cannot detect real laughter, gasps, or silent reactions. Adding audio-based reaction detection (P0.1) alone would be the highest-impact change.

**The second biggest gap** is **split-screen intelligence** — making layout decisions based on conversation dynamics rather than face count. This requires the Decision Engine to consider who's actively speaking and who's reacting.

**The third gap** is **visual composition** — applying rule-of-thirds, eye-line, and looking room for framing that feels human-edited.

**The subtitle system** needs a fundamental upgrade (NLP chunking, emphasis, templates, better styling) but this is P1 because it doesn't affect the core editing intelligence — only the visual presentation.

**Export quality** is the smallest gap (2/10) — minor CRF/audio/sharpening tweaks.
