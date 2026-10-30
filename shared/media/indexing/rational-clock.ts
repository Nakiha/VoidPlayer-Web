/** Exact source time in seconds. Integer microseconds are a display/decoder
 * transport projection, never a substitute for this correspondence clock. */
export type RationalClock = { ticks: number; timescale: number };
export function clockFraction(value: RationalClock): readonly [bigint, bigint] {
  if (
    !value ||
    Object.keys(value).sort().join(",") !== "ticks,timescale" ||
    !Number.isSafeInteger(value.ticks) ||
    !Number.isSafeInteger(value.timescale) ||
    value.timescale < 1
  )
    throw Error("Invalid rational source clock");
  return [BigInt(value.ticks), BigInt(value.timescale)];
}
function reduced(n: bigint, d: bigint) {
  let a = n < 0n ? -n : n,
    b = d;
  while (b) {
    const r = a % b;
    a = b;
    b = r;
  }
  return `${n / a}/${d / a}`;
}
export function clockKey(value: RationalClock, offset?: RationalClock) {
  const [n, d] = clockFraction(value);
  if (!offset) return reduced(n, d);
  const [a, b] = clockFraction(offset);
  return reduced(n * b + a * d, d * b);
}
export function compareClocks(a: RationalClock, b: RationalClock) {
  const [n, d] = clockFraction(a),
    [m, e] = clockFraction(b),
    delta = n * e - m * d;
  return delta < 0n ? -1 : delta > 0n ? 1 : 0;
}
/** Compare translated interval endpoints without rounding either sum. */
export function compareClockSums(a: RationalClock, offsetA: RationalClock, b: RationalClock, offsetB: RationalClock) {
  const [an, ad] = clockFraction(a), [ao, ax] = clockFraction(offsetA);
  const [bn, bd] = clockFraction(b), [bo, bx] = clockFraction(offsetB);
  const delta = (an * ax + ao * ad) * bd * bx - (bn * bx + bo * bd) * ad * ax;
  return delta < 0n ? -1 : delta > 0n ? 1 : 0;
}
export function normalizeClock(value: RationalClock): RationalClock {
  const key = clockKey(value).split('/');
  return {ticks: Number(key[0]), timescale: Number(key[1])};
}
export function clockDeltaEquals(
  a: RationalClock,
  b: RationalClock,
  delta: RationalClock,
) {
  return clockKey(a) === clockKey(b, delta);
}
/** Round nearest, ties away from zero; exact ticks remain in source evidence. */
export function clockToUs(value: RationalClock, offset?: RationalClock) {
  const [vn, vd] = clockFraction(value), [on, od] = offset ? clockFraction(offset) : [0n, 1n];
  const n = vn * od + on * vd, d = vd * od, scaled = n * 1_000_000n;
  const magnitude = scaled < 0n ? -scaled : scaled;
  const result =
    Number((magnitude * 2n + d) / (d * 2n)) * (scaled < 0n ? -1 : 1);
  if (!Number.isSafeInteger(result))
    throw Error("Source clock exceeds microsecond transport range");
  return result;
}
