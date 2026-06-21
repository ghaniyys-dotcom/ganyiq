export function removeDuplicateMoments(
  moments: any[]
) {
  const best = new Map();

  for (const m of moments) {
    const id =
      String(m.clipId || "");

    const base =
      id.replace(/_DUP$/, "");

    const existing =
      best.get(base);

    if (
      !existing ||
      m.final_score >
      existing.final_score
    ) {
      best.set(base, m);
    }
  }

  return Array.from(best.values());
}
