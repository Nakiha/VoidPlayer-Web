/** Versioned JS TS metadata shape; complete-source verification belongs to TsPacketSource. */
export const JS_TS_INDEX_BYTES = 64 * 1024 * 1024;
export const TS_PACKET_BUILD = 'mediabunny-1.55.7-ts-packets-v2';
export interface TsPacketRecord {
  au: number;
  /** Opaque Mediabunny locator. Never used as a payload byte offset. */
  locator: number;
  configuration: 0;
  /** Validated physical PES header position; never a compressed payload range. */
  pesOffset: number | null;
  timestamp: number;
  ptsUs: number;
  durationUs: number;
  size: number;
  key: boolean;
  timing: { pts: number | null; dts: number | null; timebase: [1, 90000]; origin: 'pes' | 'derived' };
}
export interface TsPacketIndex {
  schema: 2;
  completeness: { state: 'complete'; packets: number };
  kind: 'js-ts-packets';
  build: typeof TS_PACKET_BUILD;
  sourceVersion: string;
  size: number;
  streamKey: 'video:0';
  pid: number;
  codec: 'h264';
  configuration: number[];
  packets: TsPacketRecord[];
}
/** Include the demux build and selected PID in exact picture/cache identity. */
export function tsPictureStream(index: TsPacketIndex) { return `${index.streamKey}:${index.pid}@${index.build}`; }

/** Old FFmpeg indexes and mismatched JS builds rebuild with JS; never load an old demuxer. */
export function parseTsPacketIndex(value: unknown, sourceVersion: string, size: number): TsPacketIndex | undefined {
  if (!value || typeof value !== 'object') return;
  const doc = value as Partial<TsPacketIndex>;
  if (doc.schema !== 2 || doc.kind !== 'js-ts-packets' || doc.build !== TS_PACKET_BUILD || doc.sourceVersion !== sourceVersion || doc.size !== size
    || doc.streamKey !== 'video:0' || doc.codec !== 'h264' || !Number.isSafeInteger(doc.pid) || doc.pid! < 1 || doc.pid! > 8190
    || !Array.isArray(doc.configuration) || !doc.configuration.length || doc.configuration.length > 4096 || !doc.configuration.every(n=>Number.isInteger(n)&&n>=0&&n<=255)
    || !Array.isArray(doc.packets) || !doc.packets.length || doc.packets.length > 250000) return;
  if (doc.completeness?.state !== 'complete' || doc.completeness.packets !== doc.packets.length) return;
  const times = new Set<number>();
  for (let au = 0; au < doc.packets.length; au++) {
    const p = doc.packets[au];
    if (!p || p.au !== au || p.configuration !== 0 || !Number.isSafeInteger(p.locator) || p.locator < 0 || p.locator >= size
      || au > 0 && p.locator <= doc.packets[au - 1].locator || !Number.isFinite(p.timestamp) || !Number.isSafeInteger(p.ptsUs) || Math.round(p.timestamp*1e6)!==p.ptsUs
      || !Number.isSafeInteger(p.durationUs) || p.durationUs < 0 || !Number.isSafeInteger(p.size) || p.size <= 0 || p.size > 32*1024*1024 || typeof p.key !== 'boolean'
      || times.has(p.ptsUs) || !p.timing || p.timing.timebase?.[0] !== 1 || p.timing.timebase?.[1] !== 90000) return;
    times.add(p.ptsUs);
    for (const clock of [p.timing.pts,p.timing.dts]) if(clock!==null&&(!Number.isSafeInteger(clock)||clock<0||clock>=2**33))return;
    if(p.pesOffset!==null&&(!Number.isSafeInteger(p.pesOffset)||p.pesOffset<0||p.pesOffset%188||p.pesOffset+188>size))return;
    if(p.timing.pts!==null&&p.timing.dts!==null&&Math.abs(p.timing.pts-p.timing.dts)>2**32)return;
    if(p.timing.origin==='pes') {if(p.timing.pts===null||p.pesOffset===null||Math.round(p.timing.pts*1e6/90000)!==p.ptsUs)return;}
    else if(p.timing.origin!=='derived'||p.timing.pts!==null||p.timing.dts!==null)return;
  }
  return doc as TsPacketIndex;
}
