export const mix = (a: number, b: number, u: number) => a + (b - a) * u;
export function ease(start: number, end: number, time: number) {
  const u = Math.max(0, Math.min(1, (time - start) / (end - start)));
  return u * u * (3 - 2 * u);
}
