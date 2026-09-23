/** Object URL ownership follows image consumers. Only unused entries are LRU
 * cached; replaced URLs live exactly until the last image releases them. */
export class ThumbnailUrlCache {
  private entries = new Map<string, { url: string; bytes: number }>();
  private retained = new Map<string, number>();
  private retired = new Set<string>();
  readonly maxBytes: number; readonly maxCount: number;
  private create: (blob: Blob) => string; private revoke: (url: string) => void;
  constructor(maxBytes = 8 * 1024 * 1024, maxCount = 128,
    create = (blob: Blob) => URL.createObjectURL(blob), revoke = (url: string) => URL.revokeObjectURL(url)) {
    this.maxBytes = maxBytes; this.maxCount = maxCount; this.create = create; this.revoke = revoke;
  }
  get(key: string) { const entry = this.entries.get(key); if (!entry) return; this.entries.delete(key); this.entries.set(key, entry); return entry.url; }
  put(key: string, blob: Blob) {
    const previous = this.entries.get(key);
    if (previous) this.retire(previous.url);
    const url = this.create(blob); this.entries.delete(key); this.entries.set(key, { url, bytes: blob.size });
    return url;
  }
  retain(url: string) { this.retained.set(url, (this.retained.get(url) ?? 0) + 1); }
  release(url: string) {
    const count = (this.retained.get(url) ?? 0) - 1;
    if (count > 0) this.retained.set(url, count);
    else { this.retained.delete(url); if (this.retired.delete(url)) this.revoke(url); }
    this.trim();
  }
  private retire(url: string) { if (this.retained.has(url)) this.retired.add(url); else this.revoke(url); }
  trim() {
    let bytes = 0, count = 0;
    for (const entry of this.entries.values()) if (!this.retained.has(entry.url)) { bytes += entry.bytes; count++; }
    for (const [key, entry] of this.entries) {
      if (bytes <= this.maxBytes && count <= this.maxCount) break;
      if (this.retained.has(entry.url)) continue;
      this.entries.delete(key); this.revoke(entry.url); bytes -= entry.bytes; count--;
    }
  }
  clear() {
    for (const entry of this.entries.values()) this.revoke(entry.url);
    for (const url of this.retired) this.revoke(url);
    this.entries.clear(); this.retained.clear(); this.retired.clear();
  }
}
