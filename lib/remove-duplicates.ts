export function removeDuplicateMoments(
  moments: any[]
) {
  const best = new Map();

  for (const m of moments) {
    // When clipId is missing (main pipeline flow), fall back to startTime-endTime as unique key
    const id = String(m.clipId || `${m.startTime || ''}-${m.endTime || ''}`);
    const base = id.replace(/_DUP$/, "");

    const existing =
      best.get(base);

    if (
      !existing ||
      (m.final_score ?? -999) >
      (existing.final_score ?? -999)
    ) {
      best.set(base, m);
    }
  }

  const result = Array.from(best.values());
  const reduced = moments.length - result.length;
  if (reduced > 0) {
    console.log(`[DEDUP] removeDuplicateMoments: ${moments.length} → ${result.length} (removed ${reduced} dupes)`);
  }
  return result;
}
