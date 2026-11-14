import { emptyUriState, packUriState, unpackUriState, parseUriState, URI_MAX_BYTES } from './uri-state.ts';
import type { UriState } from './uri-state.ts';
import type { WorkspaceLayout } from './workspace-file.ts';
import { SLOTS } from './model.ts';

// Share envelope 2 is frozen independently of the ABI 1 state. Never reorder this dictionary or its tags.
const dictionary = ['version', 'presentation', 'outputColorSpace', 'colorMode', 'referenceDecode', 'decoder', 'depth',
  'colorOutput', 'target', 'hdrWhiteNits', 'preview', 'toneMap', 'gamutMap', 'sourcePeakNits', 'exposureWhiteNits',
  'hlgDisplayPeakNits', 'hlgSystemGamma', 'voidplayer-color-v2', 'voidplayer-sdr-v1', 'voidplayer-hdr-sdr-preview-v1',
  'srgb', 'display-p3', 'browser', 'reference', 'software', 'hardware', 'sdr', 'hdr',
  'extended-reinhard-luminance', 'desaturate-to-luminance', 'bitrate', 'size', 'qp', 'nalu', 'nalu-size', 'nalu-types',
  'references', 'overview', 'info', 'analysis', 'available', 'recent', ...SLOTS];
const utf8 = new TextEncoder(), text = new TextDecoder('utf-8', { fatal: true });
function invalid(): never { throw new Error('二进制 URI 内容无效。'); }
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function delta(value: unknown, base: unknown): unknown {
  if (!object(value) || !object(base)) return value;
  return Object.fromEntries(Object.entries(value).filter(([key, item]) => JSON.stringify(item) !== JSON.stringify(base[key]))
    .map(([key, item]) => [key, delta(item, base[key])]));
}
function merge(base: unknown, patch: unknown): unknown {
  if (!object(base) || !object(patch)) return patch;
  return Object.fromEntries([...Object.entries(base).filter(([key]) => !Object.hasOwn(patch, key)),
    ...Object.entries(patch).map(([key, item]) => [key, merge(base[key], item)])]);
}
function flags(value: unknown, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > max) invalid();
  return value;
}
const diagrams = ['bitrate', 'size', 'nalu-size', 'nalu-types', 'references'] as const;
const legacyDiagrams = ['overview', 'nalu', 'nalu-size', 'nalu-types', 'references'] as const;
function writeLayout(w: Writer, l: WorkspaceLayout) {
  const p = l.panels, a = l.analysisView, s = l.sources;
  w.uint(Number(p.inspector) | Number(p.subtracks) << 1 | Number(p.sources) << 2 |
    Number(p.analysis !== undefined) << 3 | Number(p.analysis === true) << 4 | Number(l.marksExpanded) << 5 |
    Number(l.inspectorTab !== undefined) << 6 | Number(l.inspectorTab === 'analysis') << 7 |
    Number(l.filenameWidth !== undefined) << 8 | Number(l.marksWidth !== undefined) << 9 |
    Number(!!s) << 10 | Number(!!a) << 11 | Number(l.localSourcesHeight !== undefined) << 12);
  w.byte(SLOTS.indexOf(l.selected)); w.uint(l.dockHeight);
  if (l.filenameWidth !== undefined) w.uint(l.filenameWidth);
  if (l.marksWidth !== undefined) w.uint(l.marksWidth);
  if (s) {
    w.byte(Number(s.tab === 'recent') | Number(s.all) << 1 | Number(!!s.query) << 2 |
      Number(!!s.root) << 3 | Number(!!s.directory) << 4 | Number(s.search !== s.query) << 5);
    if (s.query) w.value(s.query);
    if (s.root) w.value(s.root);
    if (s.directory) w.value(s.directory);
    if (s.search !== s.query) w.value(s.search);
  }
  if (a) {
    w.uint(Number(a.axis === 'dts') | Number(a.layoutMode === 'rows') << 1 | Number(a.showBitrate) << 2 |
      Number(a.showSize) << 3 | Number(a.follow) << 4 | Number(a.numAxis === 'dts') << 5 |
      Number(!!a.view) << 6 | Number(a.loadMetrics !== undefined) << 7 | Number(a.diagrams !== undefined) << 8 |
      Number(a.diagram !== undefined) << 9);
    w.uint(a.windowUs);
    w.byte(a.selected.length);
    for (const slot of a.selected) w.byte(SLOTS.indexOf(slot));
    if (a.view) { w.value(a.view.start); w.value(a.view.end); }
    if (a.loadMetrics) { w.byte(a.loadMetrics.length); for (const metric of a.loadMetrics) w.byte(metric === 'qp' ? 1 : 0); }
    if (a.diagrams) { w.byte(a.diagrams.length); for (const diagram of a.diagrams) w.byte(diagrams.indexOf(diagram)); }
    if (a.diagram) w.byte(legacyDiagrams.indexOf(a.diagram));
  }
  if (l.localSourcesHeight !== undefined) w.uint(l.localSourcesHeight);
}
function readLayout(r: Reader) {
  const f = flags(r.uint(), 8191);
  if (f & 16 && !(f & 8) || f & 128 && !(f & 64)) invalid();
  const layout: Record<string, unknown> = { panels: { inspector: !!(f & 1), subtracks: !!(f & 2), sources: !!(f & 4),
    ...(f & 8 ? { analysis: !!(f & 16) } : {}) }, selected: SLOTS[flags(r.byte(), 7)], dockHeight: r.uint(), marksExpanded: !!(f & 32),
    ...(f & 64 ? { inspectorTab: f & 128 ? 'analysis' : 'info' } : {}) };
  if (f & 256) layout.filenameWidth = r.uint();
  if (f & 512) layout.marksWidth = r.uint();
  if (f & 1024) {
    const s = flags(r.byte(), 63), query = s & 4 ? r.value() : '', root = s & 8 ? r.value() : '';
    const directory = s & 16 ? r.value() : '', search = s & 32 ? r.value() : query;
    layout.sources = { tab: s & 1 ? 'recent' : 'available', all: !!(s & 2), query, root, directory, search };
  }
  if (f & 2048) {
    const a = flags(r.uint(), 1023), windowUs = r.uint();
    const selected = Array.from({ length: flags(r.byte(), 8) }, () => SLOTS[flags(r.byte(), 7)]);
    const view = a & 64 ? { start: r.value(), end: r.value() } : null;
    const loadMetrics = a & 128 ? Array.from({ length: flags(r.byte(), 2) }, () => flags(r.byte(), 1) ? 'qp' : 'bitrate') : undefined;
    const selectedDiagrams = a & 256 ? Array.from({ length: flags(r.byte(), 5) }, () => diagrams[flags(r.byte(), 4)]) : undefined;
    const diagram = a & 512 ? legacyDiagrams[flags(r.byte(), 4)] : undefined;
    layout.analysisView = { axis: a & 1 ? 'dts' : 'pts', layoutMode: a & 2 ? 'rows' : 'merged', showBitrate: !!(a & 4),
      showSize: !!(a & 8), follow: !!(a & 16), numAxis: a & 32 ? 'dts' : 'pts', windowUs, selected, view,
      ...(loadMetrics !== undefined ? { loadMetrics } : {}), ...(selectedDiagrams !== undefined ? { diagrams: selectedDiagrams } : {}),
      ...(diagram !== undefined ? { diagram } : {}) };
  }
  if (f & 4096) layout.localSourcesHeight = r.uint();
  return layout;
}
class Writer {
  bytes: number[] = [];
  strings = new Map<string, number>();
  byte(value: number) { this.bytes.push(value); }
  sint(value: number) {
    const magnitude = Math.abs(value), rest = Math.floor(magnitude / 64);
    this.byte(magnitude % 64 * 2 | Number(value < 0) | (rest ? 128 : 0));
    if (rest) this.uint(rest);
  }
  uint(value: number) {
    do {
      const rest = Math.floor(value / 128);
      this.byte(value % 128 | (rest ? 128 : 0));
      value = rest;
    } while (value);
  }
  value(value: unknown, depth = 0): void {
    if (depth > 16) invalid();
    if (value === null) this.byte(0);
    else if (typeof value === 'boolean') this.byte(value ? 2 : 1);
    else if (typeof value === 'number') {
      if (!Number.isFinite(value)) invalid();
      if (Number.isSafeInteger(value)) {
        if (value >= 0 && value < 32) this.byte(32 + value);
        else { this.byte(value < 0 ? 4 : 3); this.uint(Math.abs(value)); }
      } else {
        this.byte(5);
        const bytes = new Uint8Array(8); new DataView(bytes.buffer).setFloat64(0, value, true);
        for (const byte of bytes) this.byte(byte);
      }
    } else if (typeof value === 'string') {
      const index = dictionary.indexOf(value), ref = this.strings.get(value);
      if (index >= 0) { this.byte(9); this.uint(index); }
      else if (ref !== undefined) { this.byte(10); this.uint(ref); }
      else {
        const bytes = utf8.encode(value);
        if (text.decode(bytes) === value) {
          this.byte(6); this.uint(bytes.length);
          for (const byte of bytes) this.byte(byte);
        } else {
          // Preserve lone UTF-16 surrogates accepted by the state contract instead of replacing user text.
          this.byte(11); this.uint(value.length);
          for (let i = 0; i < value.length; i++) { const code = value.charCodeAt(i); this.byte(code & 255); this.byte(code >>> 8); }
        }
        this.strings.set(value, this.strings.size);
      }
    } else if (Array.isArray(value)) {
      this.byte(7); this.uint(value.length);
      for (const item of value) this.value(item, depth + 1);
    } else if (object(value)) {
      const entries = Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
      this.byte(8); this.uint(entries.length);
      for (const [key, item] of entries) { this.value(key, depth + 1); this.value(item, depth + 1); }
    } else invalid();
    if (this.bytes.length > URI_MAX_BYTES) invalid();
  }
}
class Reader {
  offset = 0;
  strings: string[] = [];
  readonly bytes: Uint8Array;
  constructor(bytes: Uint8Array) { this.bytes = bytes; }
  take(length: number) {
    if (length > this.bytes.length - this.offset) invalid();
    const bytes = this.bytes.subarray(this.offset, this.offset + length); this.offset += length;
    return bytes;
  }
  byte() { return this.take(1)[0]; }
  sint() {
    const first = this.byte(), rest = first & 128 ? this.uint() : 0;
    if (first & 128 && !rest) invalid();
    const value = (first >> 1 & 63) + rest * 64;
    if (!Number.isSafeInteger(value)) invalid();
    return first & 1 ? -value : value;
  }
  uint() {
    let value = 0, factor = 1;
    for (let i = 0; i < 8; i++) {
      const byte = this.byte(); value += (byte & 127) * factor;
      if (!Number.isSafeInteger(value)) invalid();
      if (!(byte & 128)) { if (i && byte === 0) invalid(); return value; }
      factor *= 128;
    }
    return invalid();
  }
  value(depth = 0): unknown {
    if (depth > 16) invalid();
    const tag = this.byte();
    if (tag >= 32 && tag < 64) return tag - 32;
    if (tag === 0) return null;
    if (tag === 1 || tag === 2) return tag === 2;
    if (tag === 3 || tag === 4) return this.uint() * (tag === 4 ? -1 : 1);
    if (tag === 5) {
      const bytes = this.take(8), value = new DataView(bytes.buffer, bytes.byteOffset, 8).getFloat64(0, true);
      if (!Number.isFinite(value)) invalid();
      return value;
    }
    if (tag === 6) { const value = text.decode(this.take(this.uint())); this.strings.push(value); return value; }
    if (tag === 11) {
      const bytes = this.take(this.uint() * 2);
      let value = '';
      for (let i = 0; i < bytes.length; i += 2) value += String.fromCharCode(bytes[i] | bytes[i + 1] << 8);
      this.strings.push(value); return value;
    }
    if (tag === 9 || tag === 10) {
      const value = (tag === 9 ? dictionary : this.strings)[this.uint()];
      if (value === undefined) invalid();
      return value;
    }
    if (tag === 7 || tag === 8) {
      const count = this.uint();
      if (count > this.bytes.length - this.offset) invalid();
      if (tag === 7) return Array.from({ length: count }, () => this.value(depth + 1));
      const entries: [string, unknown][] = [], seen = new Set<string>();
      for (let i = 0; i < count; i++) {
        const key = this.value(depth + 1);
        if (typeof key !== 'string' || seen.has(key)) invalid();
        seen.add(key); entries.push([key, this.value(depth + 1)]);
      }
      return Object.fromEntries(entries);
    }
    return invalid();
  }
}
export function packBinaryUriState(value: UriState): Uint8Array {
  const state = parseUriState(value), packed = packUriState({ ...state, panBasis: undefined }), writer = new Writer();
  if (state.tracks.some(track => track.local)) throw new Error('本地文件不能生成远端分享链接。');
  const header = Number(!!state.positionUs) | Number(packed[2] != null) << 1 | Number(packed[3] != null) << 2 |
    Number(!!state.layout) << 3 | Number(!!state.mark) << 4 | Number(!!state.panBasis) << 5;
  writer.byte(header); writer.byte(state.tracks.length);
  for (const track of state.tracks) {
    writer.byte(SLOTS.indexOf(track.slot) | Number(!track.visible) << 3 | Number(!!track.offsetUs) << 4 | Number(!!track.origin) << 5);
    for (const hex of [track.id, track.version]) for (let i = 0; i < 24; i += 2) writer.byte(parseInt(hex.slice(i, i + 2), 16));
    if (track.offsetUs) writer.sint(track.offsetUs);
    if (track.origin) writer.value(track.origin);
  }
  if (header & 1) writer.uint(state.positionUs);
  if (header & 2) {
    const v = state.viewport, d = emptyUriState().viewport;
    writer.uint(Number(v.mode === 'split') | Number(v.arrangement === 'grid') << 1 | Number(v.pixelSize === 'fill') << 2 |
      ['rgb', 'y', 'u', 'v'].indexOf(v.channel) << 3 | Number(v.splitPos !== d.splitPos) << 5 | Number(v.zoom !== 1) << 6 |
      Number(!!v.offsetX) << 7 | Number(!!v.offsetY) << 8);
    if (v.splitPos !== d.splitPos) writer.value(v.splitPos);
    if (v.zoom !== 1) writer.value(v.zoom);
    if (v.offsetX) writer.value(v.offsetX);
    if (v.offsetY) writer.value(v.offsetY);
  }
  if (header & 4) writer.value(delta(state.comparison, emptyUriState().comparison));
  if (state.layout) writeLayout(writer, state.layout);
  if (state.mark) writer.value(state.mark);
  if (state.panBasis) { writer.value(state.panBasis.width); writer.value(state.panBasis.height); }
  return Uint8Array.from(writer.bytes);
}
export function unpackBinaryUriState(bytes: Uint8Array): UriState {
  if (bytes.length > URI_MAX_BYTES) invalid();
  const reader = new Reader(bytes), header = flags(reader.byte(), 63), count = flags(reader.byte(), 8);
  const tracks = Array.from({ length: count }, () => {
    const flag = flags(reader.byte(), 63), hex = () => Array.from(reader.take(12), byte => byte.toString(16).padStart(2, '0')).join('');
    const id = hex(), version = hex();
    return [flag & 7, id, version, flag & 16 ? reader.sint() : 0, Number(!!(flag & 8)), flag & 32 ? reader.value() : ''];
  });
  const position = header & 1 ? reader.uint() : 0;
  let viewport: unknown = null;
  if (header & 2) {
    const f = flags(reader.uint(), 511);
    viewport = [Number(!!(f & 1)), Number(!!(f & 2)), f & 32 ? reader.value() : .5, f & 64 ? reader.value() : 1,
      f & 128 ? reader.value() : 0, f & 256 ? reader.value() : 0, Number(!!(f & 4)), f >> 3 & 3];
  }
  const comparison = header & 4 ? merge(emptyUriState().comparison, reader.value()) : null;
  const layout = header & 8 ? readLayout(reader) : null, mark = header & 16 ? reader.value() : null;
  const basis = header & 32 ? { width: reader.value(), height: reader.value() } : null;
  if (reader.offset !== bytes.length) invalid();
  return parseUriState({ ...unpackUriState([tracks, position, viewport, comparison, layout, mark]),
    ...(basis ? { panBasis: basis } : {}) });
}

/** Small in-app links use the same binary envelope; the share service additionally compresses it. */
export function createShareUrl(value: UriState, base: string): URL {
  const bytes = packBinaryUriState(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const token = '2.n.' + btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  if (token.length > 16384) throw new Error('分享链接过大。');
  const url = new URL('/', base); url.searchParams.set('s', token); return url;
}
