/** Deterministic pseudo-speech peaks for demos (landing page, empty states). */
export function demoPeaks(seed: number, length = 400, activeRanges: [number, number][]): number[] {
  let s = seed;
  const rnd = () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
  return Array.from({ length }, (_, i) => {
    const f = i / length;
    const active = activeRanges.some(([a, b]) => f >= a && f <= b);
    if (!active) return 0.03 + rnd() * 0.04;
    const envelope = 0.45 + 0.55 * Math.abs(Math.sin(i * 0.35 + seed));
    return Math.min(1, envelope * (0.5 + rnd() * 0.6));
  });
}
