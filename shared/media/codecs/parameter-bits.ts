export class ParameterBits {
  private position = 0;
  private bytes: Uint8Array;
  private end: number;
  constructor(bytes: Uint8Array, end = bytes.length * 8) { this.bytes = bytes; this.end = end; }
  align() { this.skip((8 - this.position % 8) % 8); }
  read(n: number): number {
    if (n < 0 || n > 32 || this.position + n > this.end) throw new Error('truncated parameter set');
    let value = 0;
    while (n--) { value = value * 2 + ((this.bytes[this.position >> 3] >> (7 - (this.position & 7))) & 1); this.position++; }
    return value;
  }
  skip(n: number) { while (n > 0) { const step = Math.min(n, 32); this.read(step); n -= step; } }
  ue(max = 0x7fffffff) {
    let zeros = 0;
    while (!this.read(1)) if (++zeros > 30) throw new Error('invalid Exp-Golomb');
    const value = 2 ** zeros - 1 + this.read(zeros);
    if (value > max) throw new Error('parameter set value exceeds limit');
    return value;
  }
  se() { const n = this.ue(); return n & 1 ? (n + 1) / 2 : -n / 2; }
}

export function nalPayload(nal: Uint8Array, header: number) {
  const bytes = new Uint8Array(Math.max(0, nal.length - header));
  let count = 0;
  for (let i = header; i < nal.length; i++) {
    if (i >= header + 2 && !nal[i-2] && !nal[i-1] && nal[i] === 3 && nal[i+1] <= 3) continue;
    bytes[count++] = nal[i];
  }
  return new ParameterBits(bytes.subarray(0, count));
}
