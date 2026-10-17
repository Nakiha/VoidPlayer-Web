/** Keeps references to moov bytes already returned to the video demuxer. No IO,
 * no sample expansion, and no cache promotion. */
export class Mp4CachedMetadata {
  private nextBox = 0;
  private moov?: { start: number; end: number };
  private body?: { offset: number; bytes: Uint8Array };
  private header?: { offset: number; bytes: Uint8Array };
  private prefix?: Uint8Array;
  observe(offset: number, bytes: Uint8Array) {
    while (this.nextBox >= offset && this.nextBox + 8 <= offset + bytes.length) {
      const at = this.nextBox - offset, view = new DataView(bytes.buffer, bytes.byteOffset + at, bytes.length - at);
      let size = view.getUint32(0), header = 8;
      if (size === 1) { if (view.byteLength < 16) break; size = Number(view.getBigUint64(8)); header = 16; }
      if (!Number.isSafeInteger(size) || size < header || !Number.isSafeInteger(this.nextBox + size)) break;
      if (String.fromCharCode(...bytes.subarray(at + 4, at + 8)) === 'moov' && size <= 4 * 1024 * 1024) {
        this.moov = { start: this.nextBox + header, end: this.nextBox + size };
        this.header = { offset: this.nextBox, bytes: bytes.slice(at, at + header) };
      }
      this.nextBox += size;
    }
    if (this.moov && offset <= this.moov.start && offset + bytes.length >= this.moov.end && bytes.length <= 4 * 1024 * 1024 + 65536)
      this.body = { offset: this.moov.start, bytes: bytes.subarray(this.moov.start - offset, this.moov.end - offset) };
  }
  retainPrefix(bytes?: Uint8Array) { this.prefix ??= bytes; }
  peek(offset: number, length: number): Uint8Array | undefined {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || length > 65536) return;
    if (this.prefix && offset + length <= this.prefix.length) return this.prefix.slice(offset, offset + length);
    if (this.header && offset >= this.header.offset && offset + length <= this.header.offset + this.header.bytes.length)
      return this.header.bytes.slice(offset - this.header.offset, offset - this.header.offset + length);
    if (this.body && offset >= this.body.offset && offset + length <= this.body.offset + this.body.bytes.length)
      return this.body.bytes.slice(offset - this.body.offset, offset - this.body.offset + length);
  }
}
