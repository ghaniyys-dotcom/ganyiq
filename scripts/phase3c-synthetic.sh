#!/usr/bin/env bash
# Phase 3C: Speaker Diarization Validation
# Uses synthetic speaker labels on actual YouTube transcripts
# Run A: YouTube transcript (no speaker) via API
# Run B: YouTube transcript + synthetic speakers via direct analysis

set -euo pipefail

OUTPUT_DIR="/root/.hermes/audit-v41"
mkdir -p "$OUTPUT_DIR"

# Load env vars
export $(grep -v '^#' /root/GANYIQ/.env.local 2>/dev/null | xargs)

PAD="%-40s"

echo '╔══════════════════════════════════════════════════════════╗'
echo '║  Phase 3C — Speaker Diarization A/B Validation         ║'
echo '║  Using synthetic speaker labels on YouTube transcripts ║'
echo '╚══════════════════════════════════════════════════════════╝'

# ── Test Videos ──
TEST_VIDEOS=(
  "https://youtu.be/hN-V0YYDSak|podcast-47min|Podcast (2-3 speakers)"
  "https://youtu.be/FN283CT4rgg|debate|Debate/Discussion" 
  "https://youtu.be/fq1-l0thkm8|interview|Interview/Podcast"
  "https://youtu.be/spgzk9jvQyc|educational|Educational/Motivational"
  "https://youtu.be/dtdPS0oBkCU|comedy-1h|Long-form Comedy"
)

TOTAL_A_CLIPS=0
TOTAL_A_ELITE=0
TOTAL_B_CLIPS=0
TOTAL_B_ELITE=0

for ENTRY in "${TEST_VIDEOS[@]}"; do
  URL="${ENTRY%%|*}"
  REMAINING="${ENTRY#*|}"
  VID="${REMAINING%%|*}"
  TYPE="${REMAINING#*|}"
  
  echo ""
  echo '──────────────────────────────────────────────────────────────'
  echo "  [$TYPE] ${VID}"
  echo '──────────────────────────────────────────────────────────────'
  
  # ── RUN A: YouTube Transcript (no speaker) via API ──
  echo -n "  A (no speaker): "
  RESULT_A=$(curl -s -X POST "http://127.0.0.1:3003/api/analyze" \
    -H "Content-Type: application/json" \
    -d "{\"url\":\"${URL}\"}" --max-time 600 2>&1)
  
  if echo "$RESULT_A" | python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d.get('moments',[])))" 2>/dev/null; then
    A_CLIPS=$(echo "$RESULT_A" | python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d['moments']))")
    A_ELITE=$(echo "$RESULT_A" | python3 -c "import json,sys; d=json.load(sys.stdin); print(sum(1 for m in d['moments'] if m.get('tier')=='elite'))")
    A_MAX=$(echo "$RESULT_A" | python3 -c "import json,sys; d=json.load(sys.stdin); print(max(m['worthClippingScore'] for m in d['moments']))" 2>/dev/null || echo "?")
    echo "  ${A_CLIPS} clips, ${A_ELITE} elite, top=${A_MAX}"
    
    # Save moments for comparison
    echo "$RESULT_A" > "${OUTPUT_DIR}/${VID}_A.json"
  else
    echo "  ERROR"
    A_CLIPS=0
    A_ELITE=0
    continue
  fi
  
  # ── RUN B: Synthetic Speaker Labels ──
  echo -n "  B (synthetic speakers): "
  
  # Create a Python script for Run B analysis
  python3 << 'PYEOF'
import json, sys, os, subprocess, time, math

video_id = sys.argv[1]
vid_name = sys.argv[2]

# Load the A result to get metadata
with open(f"/root/.hermes/audit-v41/{vid_name}_A.json") as f:
  a_data = json.load(f)

# Create a simple analysis using the YouTube captions with synthetic speaker labels
# First fetch the actual YouTube transcript
import urllib.request
try:
    # Try the InnerTube approach via youtube-dl or direct API
    yt_id = video_id.split('/')[-1].split('?')[0]
    
    # Use yt-dlp to get transcript with cookies
    result = subprocess.run(
        ["yt-dlp", "--cookies", "/root/GANYIQ/cookies.txt", "--print", "title", "--skip-download", video_id],
        capture_output=True, text=True, timeout=30
    )
    title = result.stdout.strip() if result.returncode == 0 else "Unknown"
    
    result2 = subprocess.run(
        ["yt-dlp", "--cookies", "/root/GANYIQ/cookies.txt", "--print", "duration", "--skip-download", video_id],
        capture_output=True, text=True, timeout=30
    )
    duration = int(result2.stdout.strip()) if result2.returncode == 0 and result2.stdout.strip() else 0
    
    print(f"  Metadata: {title[:50]}... {math.floor(duration/60)}min")
    
    # Get transcript via yt-dlp subtitles
    tmp_dir = f"/tmp/phase3c_{vid_name}"
    os.makedirs(tmp_dir, exist_ok=True)
    
    # Try to get subtitle/transcript
    subprocess.run(
        ["yt-dlp", "--cookies", "/root/GANYIQ/cookies.txt",
         "--write-auto-subs", "--sub-lang", "id,en", "--sub-format", "vtt",
         "--skip-download", "-o", f"{tmp_dir}/%(id)s",
         video_id],
        capture_output=True, text=True, timeout=60
    )
    
    # Parse VTT subtitles into TranscriptSegments
    import glob
    vtt_files = glob.glob(f"{tmp_dir}/*.vtt") + glob.glob(f"{tmp_dir}/*.vtt?*")
    
    if not vtt_files:
        print("  No VTT subtitles found")
        sys.exit(1)
    
    vtt_path = vtt_files[0]
    segments_raw = []
    
    with open(vtt_path) as f:
        lines = f.readlines()
    
    # Parse VTT format
    i = 0
    while i < len(lines):
        line = lines[i].strip()
        # Match timestamp line like "00:12:34.567 --> 00:12:37.890"
        if '-->' in line:
            parts = line.split('-->')
            start_str = parts[0].strip().replace(',', '.')
            end_str = parts[1].strip().replace(',', '.')
            
            # Parse timestamps
            def parse_ts(ts):
                t = ts.split(':')
                if len(t) == 3:
                    return int(t[0])*3600 + int(t[1])*60 + float(t[2])
                return int(t[0])*60 + float(t[1])
            
            start = parse_ts(start_str)
            end = parse_ts(end_str)
            
            # Collect text lines until blank
            texts = []
            i += 1
            while i < len(lines) and lines[i].strip():
                t = lines[i].strip()
                if t != '' and not t.startswith('WEBVTT') and not t.startswith('Kind:') and not t.startswith('Language:'):
                    texts.append(t)
                i += 1
            
            text = ' '.join(texts).strip()
            if text:
                segments_raw.append({
                    'start': start,
                    'duration': end - start,
                    'text': text
                })
        i += 1
    
    print(f"  Parsed {len(segments_raw)} segments from VTT")
    
    if not segments_raw:
        print("  No segments parsed")
        sys.exit(1)
    
    # Add synthetic speaker labels
    # Simulate a 3-speaker podcast:
    # Speaker A: segments where text contains emotion/strong words
    # Speaker B: segments with questions/disagreement
    # Speaker C: segments with educational/factual content
    # Alternate: A, B, A, C, A, B, B, A, C, A, A, B, C...
    
    speaker_pattern = 'ABACABBACABAC'
    spk_idx = 0
    debate_zones = []  # segments with rapid A/B exchange
    
    for idx, seg in enumerate(segments_raw):
        speaker = speaker_pattern[idx % len(speaker_pattern)]
        seg['speaker'] = speaker
        
        # Create debate zones: rapid A/B every 5 segments
        if idx % 8 >= 3 and idx % 8 <= 6:
            seg['speaker'] = 'B' if seg['speaker'] == 'A' else 'A'
    
    # Count speaker changes
    changes = sum(1 for i in range(1, len(segments_raw))
                  if segments_raw[i].get('speaker') != segments_raw[i-1].get('speaker')
                  and segments_raw[i].get('speaker') and segments_raw[i-1].get('speaker')
                  and segments_raw[i].get('speaker') != 'mixed' and segments_raw[i-1].get('speaker') != 'mixed')
    
    unique_speakers = len(set(s.get('speaker') for s in segments_raw if s.get('speaker') and s.get('speaker') != 'mixed'))
    print(f"  Speakers: {unique_speakers} unique, {changes} changes (synthetic)")
    
    # Save segments for analysis
    with open(f"{tmp_dir}/segments.json", 'w') as f:
        json.dump(segments_raw, f)
    
    print(f"  DONE: segments saved")
    
except Exception as e:
    print(f"  ERROR: {str(e)[:100]}")
    sys.exit(1)
PYEOF "$URL" "$VID" 2>&1 | tail -3
  
  echo "  ---"
  
  # Update totals
  TOTAL_A_CLIPS=$((TOTAL_A_CLIPS + A_CLIPS))
  TOTAL_A_ELITE=$((TOTAL_A_ELITE + A_ELITE))
done

echo ""
echo '══════════════════════════════════════════════════════════'
echo "  TOTAL: A=${TOTAL_A_CLIPS} clips (${TOTAL_A_ELITE} elite)"
echo '══════════════════════════════════════════════════════════'
