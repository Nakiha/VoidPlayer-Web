import type {AnalysisResult} from './contract.ts';
import type {ContainerHeader,DiagramPicture} from './diagrams.ts';
import {BUDGET} from './limits.ts';
export function validateContainerHeader(codec: AnalysisResult['codec'], header: ContainerHeader) {
  if (!header || !(codec === 'h264' ? ['avcC','annexb'] : codec==='hevc'?['hvcC','annexb']:['vvcC']).includes(header.box) ||
      !Number.isSafeInteger(header.byteLength) || header.byteLength < 1 || header.byteLength > 1024 * 1024 || !Array.isArray(header.nalus) || header.nalus.length > 256) throw new Error('Invalid container header');
  let end = 0;
  for (const n of header.nalus) {
    if (![n.offset, n.size, n.type, n.temporalId, n.layer].every(Number.isSafeInteger) || n.offset < end || n.size < 1 || n.offset + n.size > header.byteLength ||
        n.type < 0 || n.type > (codec === 'hevc' ? 63 : 31) || n.temporalId < 0 || n.temporalId > 6 || n.layer < 0 || n.layer > 63) throw new Error('Invalid container NAL');
    end = n.offset + n.size;
  }
}
export function validateDiagram(result: DiagramPicture) {
  if (result.qpMean != null && (!Number.isFinite(result.qpMean) || result.qpMean < 0 || result.qpMean > (result.codec === 'vvc' ? 63 : 51))) throw new Error('Invalid mean QP');
  if (result.sourceDtsUs != null && !Number.isSafeInteger(result.sourceDtsUs)) throw new Error('Invalid source DTS');
  if (!Array.isArray(result.nalus) || !result.nalus.length || result.nalus.length > 4096) throw new Error('Invalid NAL records');
  let end = 0;
  for (const n of result.nalus) {
    if (![n.offset, n.size, n.type, n.temporalId, n.layer].every(Number.isSafeInteger) || n.offset < end || n.size < 1 || n.offset + n.size > BUDGET.packetBytes ||
      n.type < 0 || n.type > (result.codec === 'h264' ? 31 : result.codec === 'hevc' ? 63 : 31) || n.temporalId < 0 || n.temporalId > 6 || n.layer < 0 || n.layer > 63) throw new Error('Invalid NAL record');
    end = n.offset + n.size;
  }
  const r = result.references;
  if (r) {
    if (r.kind !== 'active-lists' || !['ready', 'unsupported'].includes(r.state) || !['I', 'P', 'B'].includes(r.frameType) || !Number.isSafeInteger(r.poc) || !Array.isArray(r.edges) || r.edges.length > 64) throw new Error('Invalid picture references');
    const seen = new Set<string>();
    for (const e of r.edges) {
      const id = `${e.au}:${e.list}`;
      if (!Number.isSafeInteger(e.au) || e.au < 0 || e.au >= result.picture.au || ![0, 1].includes(e.list) || seen.has(id)) throw new Error('Invalid reference edge');
      seen.add(id);
    }
    if (r.state !== 'ready' && r.edges.length) throw new Error('Unsupported reference edges');
  }
}
