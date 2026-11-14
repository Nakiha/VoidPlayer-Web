import { brotliCompressSync, brotliDecompressSync, deflateRawSync, inflateRawSync, constants } from 'node:zlib';
import { packUriState, unpackUriState, parseUriState, URI_MAX_BYTES } from '../shared/review/uri-state.ts';
import type { UriState } from '../shared/review/uri-state.ts';
import { packBinaryUriState, unpackBinaryUriState } from '../shared/review/uri-binary.ts';

// Frozen ABI 1 dictionary: only object keys are coded; user text and external IDs remain literal values.
const fields = ['version', 'presentation', 'outputColorSpace', 'colorMode', 'referenceDecode', 'decoder', 'depth', 'colorOutput',
  'target', 'hdrWhiteNits', 'preview', 'panels', 'inspector', 'subtracks', 'sources', 'analysis', 'inspectorTab', 'selected',
  'dockHeight', 'marksExpanded', 'filenameWidth', 'marksWidth', 'tab', 'query', 'root', 'directory', 'search', 'all', 'analysisView',
  'view', 'start', 'end', 'axis', 'windowUs', 'layoutMode', 'showBitrate', 'showSize', 'loadMetrics', 'follow', 'numAxis', 'diagrams',
  'diagram', 'name', 'size', 'lastModified', 'toneMap', 'gamutMap', 'sourcePeakNits', 'exposureWhiteNits', 'hlgDisplayPeakNits', 'hlgSystemGamma'];
const enums: Record<string, string[]> = { presentation: ['voidplayer-color-v2', 'voidplayer-hdr-sdr-preview-v1'],
  colorMode: ['browser', 'reference'], decoder: ['software', 'hardware'], outputColorSpace: ['srgb', 'display-p3'],
  target: ['sdr', 'hdr'], toneMap: ['extended-reinhard-luminance'], gamutMap: ['desaturate-to-luminance'],
  tab: ['available', 'recent'], inspectorTab: ['info', 'analysis'], axis: ['pts', 'dts'], numAxis: ['pts', 'dts'],
  layoutMode: ['merged', 'rows'] };
function keys(value: unknown, decode = false): unknown {
  if (Array.isArray(value)) return value.map(item => keys(item, decode));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    const index = fields.indexOf(key);
    if (decode && !key.startsWith('~') && parseInt(key, 36).toString(36) !== key) throw new Error('URI 字段字典无效。');
    const coded = decode ? key.startsWith('~') ? key.slice(1) : fields[parseInt(key, 36)] : index < 0 ? '~' + key : index.toString(36);
    if (coded === undefined) throw new Error('URI 字段字典无效。');
    let value = item;
    const choices = enums[decode ? coded : key];
    if (choices) {
      if (decode && typeof item === 'number') {
        if (!Number.isInteger(item) || choices[item] === undefined) throw new Error('URI 枚举字典无效。');
        value = choices[item];
      } else if (!decode && typeof item === 'string' && choices.includes(item)) value = choices.indexOf(item);
    }
    return [coded, keys(value, decode)];
  }));
}
export function encodeUriState(value: unknown) {
  const state = parseUriState(value);
  if (state.tracks.some(track => track.local)) throw new Error('本地文件不能生成远端分享链接。');
  const payloads = [{ version: 2, raw: Buffer.from(packBinaryUriState(state)) }];
  if (!state.panBasis) {
    const packed = packUriState(state);
    for (const track of packed[0] as string[][]) for (const field of [1, 2]) track[field] = Buffer.from(track[field], 'hex').toString('base64url');
    const raw = Buffer.from(JSON.stringify(keys(packed)));
    if (raw.length > URI_MAX_BYTES) throw new Error('URI 状态过大。');
    payloads.push({ version: 1, raw });
  }
  const choices = payloads.flatMap(({ version, raw }) => [
    { codec: 'n', data: raw },
    { codec: 'd', data: deflateRawSync(raw, { level: 9 }) },
    { codec: 'b', data: brotliCompressSync(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }) },
  ].map(({ codec, data }) => `${version}.${codec}.${data.toString('base64url')}`));
  const token = choices.sort((a, b) => a.length - b.length || a.localeCompare(b))[0];
  if (token.length > 16384) throw new Error('分享链接过大。');
  return token;
}
export function decodeUriState(token: string): UriState {
  if (typeof token !== 'string' || token.length > 16384) throw new Error('分享链接过大。');
  const match = /^([12])\.([ndb])\.([A-Za-z0-9_-]+)$/.exec(token);
  if (!match) throw new Error('分享链接的 ABI 或编码不受支持。');
  const data = Buffer.from(match[3], 'base64url');
  if (data.toString('base64url') !== match[3]) throw new Error('分享链接编码无效。');
  const raw = match[2] === 'b' ? brotliDecompressSync(data, { maxOutputLength: URI_MAX_BYTES })
    : match[2] === 'd' ? inflateRawSync(data, { maxOutputLength: URI_MAX_BYTES }) : data;
  if (raw.length > URI_MAX_BYTES) throw new Error('URI 状态过大。');
  if (match[1] === '2') return unpackBinaryUriState(raw);
  const packed = keys(JSON.parse(raw.toString('utf8')), true) as unknown[][];
  if (!Array.isArray(packed) || !Array.isArray(packed[0])) throw new Error('URI 内容无效。');
  for (const track of packed[0]) {
    if (!Array.isArray(track)) throw new Error('URI 轨道无效。');
    for (const field of [1, 2]) {
      if (typeof track[field] !== 'string' || !/^[A-Za-z0-9_-]{16}$/.test(track[field])) throw new Error('URI 媒体编号无效。');
      track[field] = Buffer.from(track[field], 'base64url').toString('hex');
    }
  }
  return unpackUriState(packed);
}
