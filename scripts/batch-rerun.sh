#!/bin/bash
# Batch Rerun VALIDATION_BATCH_002 — 15 videos parallel, 20s timeout each
# Output: JSON results for each video

OUTDIR="/tmp/val_rerun"
mkdir -p "$OUTDIR"
rm -f "$OUTDIR"/*.json 2>/dev/null

API_URL="https://ganyiq.ganys.me/api/analyze"

declare -A VIDEOS
VIDEOS[BUS-01]="2QFV58h8BsU"
VIDEOS[BUS-02]="FIXQQ7X7tZE"
VIDEOS[BUS-03]="R8rLV9PhQg0"
VIDEOS[MOT-01]="y10GDKyPmfg"
VIDEOS[MOT-02]="hN-V0YYDSak"
VIDEOS[COM-01]="qG2Rf_mtmiQ"
VIDEOS[COM-02]="pFJ5L6F55Jw"
VIDEOS[COM-03]="ytalcSHJYik"
VIDEOS[STL-01]="6AaD_80wh4g"
VIDEOS[STL-02]="i2W5y8fqb9I"
VIDEOS[STL-03]="6BpIg7jtE_4"
VIDEOS[FIN-01]="0yu5yFkZmKo"
VIDEOS[FIN-02]="E5ctwVEl4KM"
VIDEOS[CON-01]="i-VLCYAlANI"
VIDEOS[CON-02]="ydE9TD6vhE8"

echo "=== Launching 15 parallel test requests ==="
START_TIME=$(date +%s)

for id in "${!VIDEOS[@]}"; do
  vid="${VIDEOS[$id]}"
  URL="https://www.youtube.com/watch?v=$vid"
  (
    RESULT=$(curl -s -w "\n%{http_code}" -X POST "$API_URL" \
      -H "Content-Type: application/json" \
      -d "{\"url\":\"$URL\"}" \
      --max-time 25 2>/dev/null)
    HTTP_CODE=$(echo "$RESULT" | tail -1)
    BODY=$(echo "$RESULT" | head -n -1)
    echo "{\"id\":\"$id\",\"videoId\":\"$vid\",\"http\":$HTTP_CODE,\"body\":$BODY}" > "$OUTDIR/$id.json"
    echo "  [$id] HTTP $HTTP_CODE"
  ) &
done

# Wait for all to finish
wait
END_TIME=$(date +%s)
echo ""
echo "=== All done in $((END_TIME - START_TIME))s ==="

# Aggregate results
echo ""
echo "=== RESULTS ==="
for id in BUS-01 BUS-02 BUS-03 MOT-01 MOT-02 COM-01 COM-02 COM-03 STL-01 STL-02 STL-03 FIN-01 FIN-02 CON-01 CON-02; do
  if [ -f "$OUTDIR/$id.json" ]; then
    HTTP=$(jq -r '.http' "$OUTDIR/$id.json" 2>/dev/null)
    ERR=$(jq -r '.body.error // "N/A"' "$OUTDIR/$id.json" 2>/dev/null)
    MOMENTS=$(jq '.body.moments | length // 0' "$OUTDIR/$id.json" 2>/dev/null)
    echo "  $id | HTTP $HTTP | $ERR | moments: $MOMENTS"
  else
    echo "  $id | NO RESPONSE"
  fi
done