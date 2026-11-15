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
}
