import { packetFixture } from '.././packet-fixture.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { visiblePixelHash } from '../helpers/visible-pixels.ts';
import { Mp4Engine } from '../../src/mp4-engine.ts';
import {nativeFrames,nativeVisibleHash,nativeVisibleFrameBytes} from '../helpers/media/native-pixels.ts';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
const core = new URL('../../public/vendor/voidplayer-core/', import.meta.url);

for (const name of ['h266_10s_1920x1080.mp4', 'h264_high422p_1s_320x180.mp4', 'hevc-packet-1080p.mp4']) {
  test(`MP4 packet WASM ${name}: metadata-only indexing and exact pixels across GOP seeks and EOF`, { timeout: 120000 }, async () => {
    const bytes = await packetFixture(name);
    let readBytes = 0;
    class ChunkBlob extends Blob {
      override arrayBuffer(): Promise<ArrayBuffer> { throw new Error('whole-file materialization forbidden'); }
      override slice(start = 0, end = this.size) { readBytes += Math.min(end, this.size) - start; assert.ok(end - start <= 256 * 1024); return super.slice(start, end); }
    }
    const engine = new Mp4Engine({ file: new ChunkBlob([bytes]) });
    const deps = { glueURL: new URL('voidplayer-core.js', core).href, wasmBinary: await readFile(new URL('voidplayer-core.wasm', core)) };
    const directory=await mkdtemp(join(tmpdir(),'vp-mp4-oracle-')),file=join(directory,name);await writeFile(file,bytes);
    try {
      const init = await engine.open(deps.glueURL, deps.wasmBinary);
      const probe=JSON.parse(execFileSync('ffprobe',['-v','error','-select_streams','v:0','-show_entries','stream=codec_name,pix_fmt','-of','json',file],{encoding:'utf8'})).streams[0];assert.equal(init.codec,probe.codec_name);assert.equal(init.pixelFormat,probe.pix_fmt);
      const positions=[0,1,2,Math.floor(init.times.length*.6),0,init.times.length-1],first=await engine.extract(0),native=nativeFrames(file,positions,first.description.sourcePixelFormat!,nativeVisibleFrameBytes(first.description));first.frame?.close();
      if (name.startsWith('h266')) assert.ok(readBytes < bytes.length / 2, `initial read ${readBytes}/${bytes.length}`);
      for (const position of positions) {
        const actual = await engine.extract(position);
        assert.equal(actual.pts, init.firstPtsUs + init.times[position]);
        assert.equal(visiblePixelHash(actual.description, actual.pixels!), nativeVisibleHash(actual.description,native.get(position)!),`frame ${position}`);actual.frame?.close();
      }
    } finally { engine.close(); await rm(directory,{recursive:true,force:true}); }
  });
}

test('MP4 packet worker shares the session frame contract, handles EOF and releases pending work', async () => {
  const { openPacketMedia } = await import('../../src/packet-media.ts');
  const bytes = await readFile(new URL('../../fixtures/video/h264_high422p_1s_320x180.mp4', import.meta.url));
  const source = await openPacketMedia('mp4', { file: new Blob([bytes]) }, { name: 'high422.mp4', size: bytes.length, lastModified: 0 }, {
    glueURL: new URL('voidplayer-core.js', core).href, wasmBinary: await readFile(new URL('voidplayer-core.wasm', core)),
  });
  try {
    const first = await source.frameAt(0); assert.equal(first.kind, 'yuv'); first.close();
    const frames = await source.framesAfter(0, 2); assert.equal(frames.length, 2); frames.forEach(f => f.close());
    assert.deepEqual(await source.framesAfter(source.info.durationUs, 2), []);
    source.dispose(); await assert.rejects(source.frameAt(0), /释放/);
  } finally { source.dispose(); }
});
