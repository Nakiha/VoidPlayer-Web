import { Viewport, parsePanBasis } from '../presentation/viewport.ts';
import { parseWorkspace } from './workspace-file.ts';
import type { WorkspaceFile, WorkspaceLayout, ComparisonConditions } from './workspace-file.ts';
import type { ViewportSnapshot, PanBasis } from '../presentation/viewport.ts';
import { SLOTS, slotValue, timeUs } from './model.ts';
import type { Slot } from './model.ts';

// ABI 1 is immutable: state fields, defaults and tuple ordering are wire contracts.
export const URI_ABI = 1;
export const URI_MAX_BYTES = 64 * 1024;
export type UriTrack = { slot: Slot; id: string; version: string; origin?: string; local?: { name: string; size: number; lastModified: number }; offsetUs: number; visible: boolean };
export type UriState = { abi: 1; tracks: UriTrack[]; positionUs: number; viewport: ViewportSnapshot;
  comparison?: ComparisonConditions; layout?: WorkspaceLayout; mark?: string; panBasis?: PanBasis };
const hex = /^[0-9a-f]{24}$/;
const defaults: ViewportSnapshot = { mode: 'side-by-side', arrangement: 'horizontal', splitPos: .5, zoom: 1,
  offsetX: 0, offsetY: 0, pixelSize: 'uniform', channel: 'rgb' };
const comparisonDefaults: ComparisonConditions = { version: 2, presentation: 'voidplayer-color-v2', outputColorSpace: 'srgb', colorMode: 'browser', referenceDecode: { decoder: 'software', depth: 1 }, colorOutput: { target: 'sdr', hdrWhiteNits: 203, preview: { presentation: 'voidplayer-hdr-sdr-preview-v1', outputColorSpace: 'srgb', toneMap: 'extended-reinhard-luminance', gamutMap: 'desaturate-to-luminance', sourcePeakNits: 1000, exposureWhiteNits: 203, hlgDisplayPeakNits: 1000, hlgSystemGamma: 1.2 } } };
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
}
export function emptyUriState(): UriState { return { abi: 1, tracks: [], positionUs: 0, viewport: { ...defaults }, comparison: structuredClone(comparisonDefaults) }; }
function originValue(value: unknown): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || value.length > 2048) throw new Error('片源服务地址无效。');
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href !== url.origin + '/')
    throw new Error('片源服务地址必须是 HTTP(S) Origin。');
  return url.origin;
}
export function parseUriState(value: unknown): UriState {
  const input = value as UriState;
  if (!input || input.abi !== 1) throw new Error('不支持此 URI ABI。');
  if (JSON.stringify(input).length > URI_MAX_BYTES || !Array.isArray(input.tracks) || input.tracks.length > 8)
    throw new Error('URI 状态过大或轨道无效。');
  const slots = new Set<string>();
  const tracks = input.tracks.map(track => {
    const slot = slotValue(track.slot);
    if (slots.has(slot) || (track.local ? typeof track.id !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(track.id) || track.version !== '' : !hex.test(track.id) || !hex.test(track.version)) || !Number.isSafeInteger(track.offsetUs) ||
      typeof track.visible !== 'boolean') throw new Error('URI 片源引用无效。');
    slots.add(slot);
    if (track.local && (typeof track.local.name !== 'string' || !track.local.name || track.local.name.length > 2000 || !Number.isSafeInteger(track.local.size) || track.local.size < 0 || !Number.isSafeInteger(track.local.lastModified) || track.local.lastModified < 0 || track.origin)) throw new Error('本地片源引用无效。');
    const origin = originValue(track.origin);
    return { slot, id: track.id, version: track.version, ...(origin ? { origin } : {}), ...(track.local ? { local: { name: track.local.name, size: track.local.size, lastModified: track.local.lastModified } } : {}), offsetUs: track.offsetUs, visible: track.visible };
  });
  const raw = input.viewport;
  if (!raw || !Object.keys(defaults).every(key => key in raw) ||
    ![raw.splitPos, raw.zoom, raw.offsetX, raw.offsetY].every(Number.isFinite) ||
    raw.splitPos < 0 || raw.splitPos > 1 || raw.zoom < 1 || raw.zoom > 500) throw new Error('URI 视口无效。');
  const viewport = new Viewport(); viewport.apply(raw);
  const panBasis = parsePanBasis(input.panBasis);
  // Reuse host-independent validators for the actual comparison and panel contracts.
  const validated = parseWorkspace({ schema: 'voidplayer-workspace', version: 1, generatedAt: 'URI ABI 1',
    serverUrl: 'http://localhost/', media: [], marks: [], tracks: [], positionUs: 0, viewport: viewport.snapshot(),
    comparison: input.comparison ?? comparisonDefaults, ...(input.layout ? { layout: input.layout } : {}) });
  if (input.mark !== undefined && (typeof input.mark !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(input.mark)))
    throw new Error('URI 标注编号无效。');
  return { abi: 1, tracks, positionUs: timeUs(input.positionUs), viewport: viewport.snapshot(),
    ...(panBasis ? { panBasis } : {}),
    ...(validated.comparison ? { comparison: validated.comparison } : {}), ...(validated.layout ? { layout: validated.layout } : {}),
    ...(input.mark ? { mark: input.mark } : {}) };
}
export function uriStateFromDocument(document: WorkspaceFile, base: string): UriState {
  const origin = new URL(base).origin;
  const tracks = document.tracks.map(track => {
    const media = document.media.find(item => item.id === track.mediaId)!;
    if (!media.source) return { slot: track.slot, id: media.id, version: '', local: { name: media.name, size: media.size, lastModified: media.lastModified }, offsetUs: track.offsetUs, visible: track.visible !== false };
    const url = new URL(media.source.url, base), version = url.searchParams.get('v') ?? '';
    return { slot: track.slot, id: media.source.id, version, ...(url.origin !== origin ? { origin: url.origin } : {}),
      offsetUs: track.offsetUs, visible: track.visible !== false };
  });
  return parseUriState({ abi: 1, tracks, positionUs: document.positionUs, viewport: document.viewport,
    comparison: document.comparison, layout: document.layout, panBasis: document.panBasis });
}
// Frozen envelope 1 tuples cannot represent the optional pan basis; use envelope 2 for it.
export function packUriState(value: UriState): unknown[] {
  const state = parseUriState(value);
  if (state.panBasis) throw new Error('平移参考尺寸需要二进制分享编码。');
  const tracks = state.tracks.map(t => {
    const row: unknown[] = [SLOTS.indexOf(t.slot), t.id, t.version, t.offsetUs, t.visible ? 0 : 1, t.origin || '', t.local ?? null];
    while (row.length > 3 && !row.at(-1)) row.pop();
    return row;
  });
  const view = state.viewport;
  const viewport = JSON.stringify(view) === JSON.stringify(defaults) ? null : [view.mode === 'split' ? 1 : 0,
    view.arrangement === 'grid' ? 1 : 0, view.splitPos, view.zoom, view.offsetX, view.offsetY,
    view.pixelSize === 'fill' ? 1 : 0, ['rgb', 'y', 'u', 'v'].indexOf(view.channel)];
  const comparison = canonical(state.comparison) === canonical(comparisonDefaults) ? null : state.comparison;
  const row: unknown[] = [tracks, state.positionUs, viewport, comparison ?? null, state.layout ?? null, state.mark ?? null];
  while (row.length > 1 && !row.at(-1)) row.pop();
  return row;
}
export function unpackUriState(value: unknown): UriState {
  if (!Array.isArray(value) || value.length < 1 || value.length > 6 || !Array.isArray(value[0]))
    throw new Error('压缩 URI 内容无效。');
  const view = value[2];
  if (view != null && (!Array.isArray(view) || view.length !== 8 || ![0, 1].includes(view[0]) ||
    ![0, 1].includes(view[1]) || ![0, 1].includes(view[6]) || ![0, 1, 2, 3].includes(view[7]))) throw new Error('压缩 URI 视口无效。');
  return parseUriState({ abi: 1, tracks: value[0].map((t: unknown) => {
    if (!Array.isArray(t) || t.length < 3 || t.length > 7 || !Number.isInteger(t[0]) || !SLOTS[t[0]] || (t[4] !== undefined && ![0, 1].includes(t[4])))
      throw new Error('压缩 URI 轨道无效。');
    return { slot: SLOTS[t[0]], id: t[1], version: t[2], offsetUs: t[3] ?? 0, visible: !t[4],
      ...(t[5] ? { origin: t[5] } : {}), ...(t[6] ? { local: t[6] } : {}) };
  }), positionUs: value[1] ?? 0, viewport: view == null ? { ...defaults } : { mode: view[0] ? 'split' : 'side-by-side',
    arrangement: view[1] ? 'grid' : 'horizontal', splitPos: view[2], zoom: view[3], offsetX: view[4], offsetY: view[5],
    pixelSize: view[6] ? 'fill' : 'uniform', channel: ['rgb', 'y', 'u', 'v'][view[7]] },
    ...(value[3] != null ? { comparison: value[3] } : {}), ...(value[4] != null ? { layout: value[4] } : {}),
    ...(value[5] != null ? { mark: value[5] } : {}) });
}
export function hasUriState(url: URL) { return url.searchParams.has('s'); }
