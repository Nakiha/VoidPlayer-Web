import type { MediaLibraryIndex } from '../library.ts';
import type { MediaIndexIdentity } from '../../src/media-index-identity.ts';
import { FFMPEG_INDEX_RECORD_BYTES } from '../../src/ffmpeg-index-cache.ts';
import { AnalysisFailure } from '../../src/bitstream-analysis/failure.ts';

/** A separate read-only subscriber to the shared streaming index. Presentation
 * records may be reordered: only a contiguous AU prefix is safe for decoding. */
export async function libraryAnalysisIndex(library: MediaLibraryIndex, id: string, version: string,
  filePath: string, identity: MediaIndexIdentity) {
  const metadata = library.metadata(id);
  if (!metadata || metadata.version !== version) throw new AnalysisFailure('source-changed', 'Index source changed');
  const epoch = await library.indexJobs.call('epoch');
  const build = library.indexJobs.startBuild({ id, version, size: metadata.size, filePath, epoch, identity });
  let buildError: unknown, closed = false, buildId: string | undefined, seq = -1, frontier = 0;
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
    close() { closed = true; build.unsubscribe(); },
  };
}
