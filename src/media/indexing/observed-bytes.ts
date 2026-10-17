/** Observe existing synchronous Blob reads without ever initiating a read.
 * Muted: 1 MiB consumed-byte cache plus 128 KiB startup metadata. Enabled:
 * retain at most 8 MiB of already-read buffers, without copying their payloads. */
export class ObservedBytes {
  private chunks = new Map<number, Uint8Array>();
  private prefix = new Map<number, Uint8Array>();
  private last?: { offset: number; bytes: Uint8Array };
  private bytes = 0;
  private prefixBytes = 0;
  private enabled = false;
  private trim() {
    while (this.bytes > (this.enabled ? 8 : 1) * 1024 * 1024 || this.chunks.size > 256) {
      const first = this.chunks.keys().next().value!;
      this.bytes -= this.chunks.get(first)!.length; this.chunks.delete(first);
    }
  }
  setEnabled(enabled: boolean) { this.enabled = enabled; this.trim(); }
  add(offset: number, bytes: Uint8Array) {
    if (!bytes.length || bytes.length > 8 * 1024 * 1024) return;
    if (bytes.length <= 256 * 1024) this.last = { offset, bytes };
    if (offset >= 0 && offset < 128 * 1024 && this.prefix.size < 16 && !this.prefix.has(offset)) {
      const count = Math.min(bytes.length, 128 * 1024 - offset, 128 * 1024 - this.prefixBytes);
      if (count > 0) { this.prefix.set(offset, bytes.slice(0, count)); this.prefixBytes += count; }
    }
    this.bytes -= this.chunks.get(offset)?.length ?? 0;
    this.chunks.delete(offset); this.chunks.set(offset, bytes); this.bytes += bytes.length;
    this.trim();
  }
  peek(offset: number, length: number): Uint8Array | undefined {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || length > 65536) return;
    const result = new Uint8Array(length), chunks = [...this.prefix, ...this.chunks];
    if (this.last) chunks.push([this.last.offset, this.last.bytes]);
    let at = offset;
    while (at < offset + length) {
      const part = chunks.find(([start, bytes]) => start <= at && start + bytes.length > at);
      if (!part) return;
      const [start, bytes] = part, count = Math.min(start + bytes.length - at, offset + length - at);
      result.set(bytes.subarray(at - start, at - start + count), at - offset); at += count;
    }
    return result;
  }
  cachedWindows() {
    const chunks = [...this.prefix, ...this.chunks]; if (this.last) chunks.push([this.last.offset, this.last.bytes]);
    return [...new Map(chunks.flatMap(([offset, bytes]) => {
      const windows = [];
      for (let at = 0; at < bytes.length; at += 65536) windows.push([offset + at, { offset: offset + at, length: Math.min(65536, bytes.length - at) }] as const);
      return windows;
    })).values()].sort((a, b) => a.offset - b.offset);
  }
}
