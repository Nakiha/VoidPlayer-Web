import { parseJsPacketIndex } from '../../../shared/media/indexing/js-packet-index-parser.ts';
import type {JsPacketIndex} from '../../../shared/media/containers/matroska-packet-index.ts';
import { parseFlvIndex, FLV_INDEX_BYTES } from '../../../shared/media/indexing/flv-index-cache.ts';
import type { MediaLibraryIndex } from '../../library.ts';
import type { MediaIndexIdentity } from '../../../shared/media/indexing/media-index-identity.ts';
import { FFMPEG_INDEX_RECORD_BYTES, FFMPEG_INDEX_BYTES, parseFfmpegIndex } from '../../../shared/media/indexing/ffmpeg-index-cache.ts';
import { AnalysisFailure } from '../../../shared/analysis/bitstream/failure.ts';

/** A separate read-only subscriber to the shared streaming index. Presentation
 * records may be reordered: only a contiguous AU prefix is safe for decoding. */
export async function libraryAnalysisIndex(library: MediaLibraryIndex, id: string, version: string,
  filePath: string, identity: MediaIndexIdentity) {
  const metadata = library.metadata(id);
  if (!metadata || metadata.version !== version) throw new AnalysisFailure('source-changed', 'Index source changed');
  const epoch = await library.indexJobs.call('epoch');
  let buildError: unknown;
  let jsDocument:JsPacketIndex|undefined;
  let flvPrefix = 0, flvComplete = false;
  let flvDocument: import("../../../shared/media/indexing/flv-index-cache.ts").FlvIndexDocument | undefined;
  const build = library.indexJobs.startBuild({ id, version, size: metadata.size, filePath, epoch, identity }, {
    onProgress(progress) {
      // Shared FLV scanner publishes only append-only validated source packets.
      if (identity.kind === 'flv') {
        if (!Number.isSafeInteger(progress.packets) || progress.packets < flvPrefix || progress.packets > 250000)
          buildError = new AnalysisFailure('resource-limit', 'Invalid FLV index prefix');
        else flvPrefix = progress.packets;
      }
    },
  });
  let closed = false, buildId: string | null | undefined, seq = -1, frontier = 0;
  const ordinals = new Set<number>();
  void build.promise.catch(error => { buildError = error; });
  const append = (records: Uint8Array) => {
    if (records.byteLength % FFMPEG_INDEX_RECORD_BYTES) throw new Error('Invalid index batch');
    const view = new DataView(records.buffer, records.byteOffset, records.byteLength);
    for (let offset = 0; offset < records.byteLength; offset += FFMPEG_INDEX_RECORD_BYTES) {
      const au = Number(view.getBigUint64(offset + 40, true));
      if (!Number.isSafeInteger(au) || au < frontier || au >= 250000 || ordinals.has(au))
        throw new AnalysisFailure('incomplete-reference-state', 'Invalid index AU identity');
      ordinals.add(au);
    }
    while (ordinals.delete(frontier)) frontier++;
  };
  return {
    async read() {
      if (closed) throw new AnalysisFailure('cancelled', 'Index subscriber closed');
      if (!await library.resolve(id, version)) throw new AnalysisFailure('source-changed', 'Index source changed');
      if (buildError) throw buildError;
      if (identity.kind === 'flv') {
        if (await library.indexJobs.call('epoch') !== epoch)
          throw new AnalysisFailure('source-changed', 'Index cache reset');
        if (!flvComplete) {
          const snapshot = await library.indexJobs.call('stream-manifest', { id, version, identity });
          if (snapshot.epoch !== epoch) throw new AnalysisFailure('source-changed', 'Index cache reset');
          if (snapshot.manifest?.complete) {
            const bytes = await library.indexJobs.call('get', { id, version, identity });
            if (!bytes || bytes.length > FLV_INDEX_BYTES + 1024)
              throw new AnalysisFailure('resource-limit', 'Invalid FLV index document');
            const envelope = JSON.parse(Buffer.from(bytes).toString('utf8'));
            const index = parseFlvIndex(envelope.index ?? envelope, metadata.size);
            if (index.packets.length < flvPrefix || index.packets.length > 250000)
              throw new AnalysisFailure('incomplete-reference-state', 'Invalid FLV index AU coverage');
            flvDocument = envelope.index ?? envelope;
            flvPrefix = index.packets.length; flvComplete = true;
          }
        }
        return { packets: flvPrefix, complete: flvComplete };
      }
      if(identity.kind==='js-ts'||identity.kind==='js-matroska') {
        const snapshot=await library.indexJobs.call('stream-manifest',{id,version,identity});
        if(snapshot.epoch!==epoch)throw new AnalysisFailure('source-changed','Index cache reset');
        if(!snapshot.manifest?.complete)return {packets:0,complete:false};
        const bytes=await library.indexJobs.call('get',{id,version,identity});
        if(!bytes||bytes.length>64*1024*1024)throw new AnalysisFailure('resource-limit','Invalid JS TS index document');
        const envelope=JSON.parse(Buffer.from(bytes).toString('utf8'));
        const document=parseJsPacketIndex(envelope.index??envelope,`${id}@${version}`,metadata.size);
        if(!document)throw new AnalysisFailure('incomplete-reference-state','Invalid JS TS index identity');
        jsDocument=document;return {packets:document.packets.length,complete:true};
      }
      const snapshot = await library.indexJobs.call('stream-manifest', { id, version, identity });
      if (snapshot.epoch !== epoch) throw new AnalysisFailure('source-changed', 'Index cache reset');
      const manifest = snapshot.manifest;
      if (!manifest) return { packets: frontier, complete: false };
      if (buildId && manifest.buildId !== buildId) throw new AnalysisFailure('source-changed', 'Index build replaced');
      buildId = manifest.buildId;
      if (manifest.state === 'failed') throw new AnalysisFailure('incomplete-reference-state', 'Index build failed');
      if (manifest.complete && !manifest.metadata) {
        const bytes = await library.indexJobs.call('get', { id, version, identity });
        const envelope = JSON.parse(Buffer.from(bytes).toString('utf8'));
        const document = envelope.index ?? envelope;
        if (document.count > 250000) throw new AnalysisFailure('resource-limit', 'Analysis index budget exceeded');
        append(Buffer.from(document.records, 'base64'));
        if (ordinals.size || frontier !== document.count) throw new Error('Incomplete index AU coverage');
        return { packets: frontier, complete: true };
      }
      const rows = await library.indexJobs.call('stream-batches', { id, version, identity, after: seq, limit: 4 });
      for (const row of rows) {
        if (row.seq !== seq + 1 || !Number.isSafeInteger(row.frames) || row.frames <= 0 || row.frames > 1024 || row.payload.length > 65536)
          throw new AnalysisFailure('resource-limit', 'Invalid or oversized index batch');
        const records = Buffer.from(row.payload, 'base64');
        if (records.byteLength !== row.frames * FFMPEG_INDEX_RECORD_BYTES) throw new Error('Index batch length mismatch');
        append(records); seq = row.seq;
      }
      const complete = manifest.complete && seq === manifest.lastSeq;
      if (complete && (ordinals.size || frontier !== manifest.frames)) throw new Error('Incomplete index AU coverage');
      return { packets: frontier, complete };
    },
    async snapshot(active: () => boolean = () => true) {
      if (identity.kind !== 'flv') throw new AnalysisFailure('unsupported-container', 'FLV snapshot required');
      const started = performance.now();
      while (!(await this.read()).complete) {
        if (!active()) throw new AnalysisFailure('cancelled', 'Analysis demand expired during indexing');
        if (performance.now() - started > 120000) throw new AnalysisFailure('resource-limit', 'FLV index snapshot stalled');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      return flvDocument!;
    },
    async jsSnapshot(active:()=>boolean=()=>true){
      if(identity.kind!=='js-ts'&&identity.kind!=='js-matroska')throw new AnalysisFailure('unsupported-container','JS snapshot required');
      const started=performance.now();while(!(await this.read()).complete){if(!active())throw new AnalysisFailure('cancelled','JS index subscriber closed');if(performance.now()-started>120000)throw new AnalysisFailure('resource-limit','JS snapshot stalled');await new Promise(resolve=>setTimeout(resolve,20));}
      if(!await library.resolve(id,version))throw new AnalysisFailure('source-changed','JS snapshot source changed');return jsDocument!;
    },
    async ffmpegSnapshot(active: () => boolean = () => true) {
      if(identity.kind !== 'ffmpeg')throw new AnalysisFailure('unsupported-container','FFmpeg snapshot required');
      const started=performance.now();
      while(!(await this.read()).complete) {
        if(!active())throw new AnalysisFailure('cancelled','Analysis demand expired during indexing');
        if(performance.now()-started>120000)throw new AnalysisFailure('resource-limit','FFmpeg index snapshot stalled');
        await new Promise(resolve=>setTimeout(resolve,20));
      }
      const bytes=await library.indexJobs.call('get',{id,version,identity});
      if(!bytes || bytes.length>FFMPEG_INDEX_BYTES+1024)throw new AnalysisFailure('resource-limit','Invalid FFmpeg index document');
      const envelope=JSON.parse(Buffer.from(bytes).toString('utf8'));
      if(envelope.epoch!==epoch || !await library.resolve(id,version))throw new AnalysisFailure('source-changed','Index source/epoch changed');
      const parsed=parseFfmpegIndex(envelope.index,metadata.size,{indexerBuild:identity.indexerBuild,streamIndex:Number(identity.streamKey.split(':')[1])});
      if(!parsed || parsed.document.count!==frontier)throw new AnalysisFailure('incomplete-reference-state','FFmpeg index coverage/identity mismatch');
      return parsed.document;
    },
    close() { closed = true; build.unsubscribe(); },
  };
}
