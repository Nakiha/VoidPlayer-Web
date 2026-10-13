import { test } from "node:test";
import assert from "node:assert/strict";
import { inspectPacketPicture } from "../../src/packet-picture.ts";
import {
  pictureId,
  validateResult,
} from "../../src/bitstream-analysis/contract.ts";
import { AnalysisCache } from "../../src/bitstream-analysis/cache.ts";
import type { AnalysisResult } from "../../src/bitstream-analysis/contract.ts";
const result = (): AnalysisResult => ({
  schema: 1,
  codec: "h264",
  analyzerVersion: "0.1.0",
  buildId: "test",
  recipe: "blocks-basic-v2",
  picture: {
    sourceVersion: "local:uuid",
    stream: "video",
    configuration: 0,
    au: 3,
    picture: 0,
    layer: 0,
    field: "frame",
  },
  sourcePtsUs: 100,
  width: 16,
  height: 16,
  confidence: "exact",
  reasons: [],
  capabilities: {
    blocks: "ready",
    qp: "ready",
    modes: "ready",
    motion: "unsupported",
  },
  qp: { component: "luma", bitDepth: 8, weighting: "pixel-area", mean: 23 },
  blocks: [{ x: 0, y: 0, width: 16, height: 16, qp: 23, mode: "intra" }],
  metrics: {
    startAu: 0,
    packets: 4,
    bytesRead: 1000,
    elapsedMs: 3,
    recordBytes: 12,
    heapBytes: 67108864,
  },
});
test("AU admission rejects duplicate pictures, enhancement layers and malformed length prefixes", () => {
  const config = new Uint8Array(5);
  config[4] = 3;
  assert.equal(
    inspectPacketPicture(
      "h264",
      config,
      new Uint8Array([0, 0, 0, 2, 0x65, 0x80]),
    ).closedRandomAccess,
    true,
  );
  assert.equal(
    inspectPacketPicture(
      "h264",
      config,
      new Uint8Array([0, 0, 0, 2, 0x65, 0x80, 0, 0, 0, 2, 0x61, 0x80]),
    ).singlePicture,
    false,
  );
  assert.equal(
    inspectPacketPicture(
      "h264",
      config,
      new Uint8Array([0, 0, 0, 20, 0x65, 0x80]),
    ).singlePicture,
    false,
  );
  const hevc = new Uint8Array(22);
  hevc[21] = 3;
  assert.equal(
    inspectPacketPicture(
      "hevc",
      hevc,
      new Uint8Array([0, 0, 0, 3, 0x26, 1, 0x80]),
    ).closedRandomAccess,
    true,
  );
  assert.equal(
    inspectPacketPicture(
      "hevc",
      hevc,
      new Uint8Array([0, 0, 0, 3, 0x2a, 1, 0x80]),
    ).closedRandomAccess,
    false,
    "CRA is not a closed IDR",
  );
  assert.equal(
    inspectPacketPicture(
      "hevc",
      hevc,
      new Uint8Array([0, 0, 0, 3, 0x27, 1, 0x80]),
    ).singlePicture,
    false,
  );
});
test("exact results require complete nonoverlapping coded coverage", () => {
  const r = result();
  validateResult(r);
  r.blocks.push({ ...r.blocks[0] });
  assert.throws(() => validateResult(r), /Overlapping/);
  r.blocks = [];
  assert.throws(() => validateResult(r), /Incomplete/);
});
test("cache uses persistent picture identity and releases detached copies", () => {
  const cache = new AnalysisCache(),
    r = result();
  cache.put(r);
  const shared = cache.peek(r.picture)!;
  assert.equal(
    cache.peek(r.picture),
    shared,
    "presentation hits share a stable owned view",
  );
  assert.ok(Object.isFrozen(shared.blocks));
  assert.ok(Object.isFrozen(shared.blocks[0]));
  assert.throws(() => {
    (shared.blocks[0] as any).qp = 0;
  }, TypeError);
  r.blocks[0].qp = 2;
  const hit = cache.get(r.picture)!;
  assert.equal(hit.blocks[0].qp, 23);
  hit.blocks[0].qp = 0;
  assert.equal(cache.get(r.picture)!.blocks[0].qp, 23);
  assert.equal(cache.get({ ...r.picture, sourceVersion: "other" }), null);
  assert.notEqual(
    pictureId(r.picture),
    pictureId({ ...r.picture, configuration: 1 }),
  );
  cache.clear();
  assert.equal(cache.sizeBytes, 0);
});
test("coded crop and rotation share the presenter rectangle and have an exact inverse", async () => {
  const { codedToViewport, viewportToCoded } = await import(
    "../../src/analysis-overlay/geometry.ts"
  );
  for (const rotation of [0, 90, 180, 270]) {
    const token: any = {
      geometry: {
        visibleRect: { x: 8, y: 4, width: 64, height: 32 },
        rotation,
      },
    };
    const g = {
      width: 500,
      height: 400,
      imageWidth: 256,
      imageHeight: 128,
      zoom: 3,
      offsetX: 11,
      offsetY: -9,
      dpr: 2,
    };
    const projected = codedToViewport(24, 12, token, g),
      inverse = viewportToCoded(projected.x, projected.y, token, g);
    assert.equal(inverse.x, 24);
    assert.equal(inverse.y, 12);
  }
});
test("atomic cache rejects corrupted and incomplete chunks; quota evicts old pictures", async () => {
  const { AnalysisStore } = await import("../../server/analysis/store.ts");
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises"),
    { tmpdir } = await import("node:os"),
    { join } = await import("node:path");
  const folder = await mkdtemp(join(tmpdir(), "vp-analysis-store-"));
  try {
    const store = new AnalysisStore(folder, 1100),
      a = "a".repeat(64),
      b = "b".repeat(64),
      r = result();
    await store.put(a, r);
    assert.deepEqual(await new AnalysisStore(folder).get(a), r);
    await writeFile(join(folder, a + ".json"), "truncated");
    assert.equal(await store.get(a), null);
    await store.put(a, r);
    await store.put(b, { ...r, picture: { ...r.picture, au: 4 } });
    assert.equal(await store.get(a), null);
    assert.ok(await store.get(b));
    await store.put("c".repeat(64), {
      ...r,
      confidence: "partial",
      reasons: ["missing-reference"],
      blocks: [],
    });
    assert.equal(await store.get("c".repeat(64)), null);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("VVC 8-bit luma QP extends to 63 while AVC and HEVC stop at 51", () => {
  const r = result();
  r.blocks[0].qp = 52;
  assert.throws(() => validateResult(r));
  r.codec = "vvc";
  validateResult(r);
  r.blocks[0].qp = 64;
  assert.throws(() => validateResult(r));
});

test("failure transport preserves stable categories and never classifies by message text", async () => {
  const { AnalysisFailure, failureInfo, restoreFailure, coreFailure } =
    await import("../../src/bitstream-analysis/failure.ts");
  const { MediaOpenError } = await import("../../src/media-errors.ts");
  for (const [code, kind] of [
    ["unsupported-container", "unsupported"],
    ["no-safe-anchor-within-budget", "unsupported"],
    ["resource-limit", "limited"],
    ["source-changed", "error"],
    ["internal-error", "error"],
  ] as const) {
    const reason = new AnalysisFailure(code, "source diagnosis").info;
    assert.equal(reason.kind, kind);
    assert.deepEqual(
      failureInfo(restoreFailure(JSON.parse(JSON.stringify(reason)))),
      reason,
    );
  }
  assert.equal(
    failureInfo(new Error("unsupported container resource limit")).code,
    "internal-error",
  );
  assert.equal(
    failureInfo(new MediaOpenError("resource", "anything")).code,
    "resource-limit",
  );
  assert.equal(coreFailure(-48, "allocation").info.kind, "limited");
  assert.equal(
    restoreFailure({ code: "unknown", message: "bad" }).code,
    "internal-error",
  );
  for (const [width, code] of [
    [0, "internal-error"],
    [8192, "resource-limit"],
  ] as const) {
    assert.throws(
      () => validateResult({ ...result(), width }),
      (error) => failureInfo(error).code === code,
    );
  }

  const r = result();
  r.reasonCodes = ["unsupported-qp-depth"];
  r.qp.bitDepth = 10;
  r.qp.mean = null;
  r.blocks[0].qp = null;
  r.capabilities.qp = "unsupported";
  validateResult(r);
  r.reasonCodes = ["unknown" as any];
  assert.throws(() => validateResult(r));
});

test('GOP grouping follows AU order, preserves open-GOP dependence and splits configuration changes', async () => {
  const { groupAnalysisGops, gopForAu } = await import('../../src/bitstream-analysis/stream.ts');
  const packets = [0, 1, 2, 3, 4, 5].map(au => ({ au, pts: [0, 3, 1, 2, 5, 4][au], dts: au,
    key: au === 0 || au === 3, configuration: au < 5 ? 0 : 1, size: 6, offset: au * 6 }));
  const groups = groupAnalysisGops(packets);
  assert.deepEqual(groups.map(g => [g.startAu, g.endAu, g.configuration]), [[0, 3, 0], [3, 5, 0], [5, 6, 1]]);
  assert.equal(gopForAu(groups, 3).startAu, 3, 'PTS reordering does not alter GOP membership');
  assert.equal(gopForAu(groups, 3).anchor, 'unknown', 'container key is not proof of a closed anchor');
  const value = result(); value.gop = { startAu: 0, endAu: 4, configuration: 0, anchor: 'dependent' };
  validateResult(value);
  assert.throws(() => validateResult({ ...value, gop: { ...value.gop!, endAu: 3 } }), /GOP/);
});

test('stream progress waits for transport completion after all pictures, and follows a growing duration', async () => {
  const { BitstreamAnalysisService } = await import('../../src/bitstream-analysis/service.ts');
  const service = new BitstreamAnalysisService(() => {});
  let release!: () => void, reached!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), pending = new Promise<void>(resolve => { reached = resolve; });
  (service as any).localRange = async (_file: unknown, _target: unknown, _signal: unknown, consume: (r: AnalysisResult) => void, progress: (p: unknown) => void) => {
    const r = result(); r.picture.au = 0; r.gop = { startAu: 0, endAu: 1, configuration: 0, anchor: 'closed' };
    progress({ pictures: 0, totalPictures: 1, checkedUs: 0, totalUs: 100, indexComplete: false, waitingForIndex: true });
    consume(r);
    progress({ pictures: 1, totalPictures: 1, checkedUs: 1000, totalUs: 1000, indexComplete: true, waitingForIndex: false });
    reached(); await gate;
  };
  const source = { info: {}, bitstreamFile: new Blob() } as import('../../src/media.ts').MediaSource;
  const run = service.requestStream(source, { mode: 'stream', sourceVersion: 'local:uuid', firstPtsUs: 0, durationUs: 100 }, 'A');
  await pending;
  assert.equal(service.state.state, 'pending'); assert.equal(service.state.stream!.pictures, 1);
  assert.ok(service.state.stream!.checkedUs < service.state.stream!.totalUs, '100 percent requires actual task completion');
  release(); const complete = await run;
  assert.equal(service.state.state, 'ready'); assert.equal(complete.totalUs, 1000); assert.equal(complete.checkedUs, 1000);
});

import { readNalus, validateDiagram, DiagramStore, referenceLayers } from '../../src/bitstream-analysis/diagrams.ts';
test('inferred reference layers repeat between I/P anchors without climbing across historical B references', () => {
  const store = new DiagramStore(), records: AnalysisResult[] = [];
  const put = (au: number, pts: number, frameType: 'I' | 'P' | 'B', refs: number[]) => {
    const r = result(); r.picture.au = au; r.sourcePtsUs = pts * 1000;
    r.nalus = [{ offset: 4, size: 20, type: frameType === 'I' ? 5 : 1, temporalId: 0, layer: 0 }];
    r.references = { kind: 'active-lists', state: 'ready', poc: pts, frameType, edges: refs.map((au, i) => ({ au, list: i % 2 as 0 | 1 })) };
    records.push(r); store.put(r);
  };
  put(0, 0, 'I', []);
  let previousAnchor = 0, previousB: number | undefined;
  const roots: number[] = [], children: number[] = [];
  for (let group = 0; group < 24; group++) {
    const au = 1 + group * 4, start = group * 4;
    put(au, start + 4, 'P', [previousAnchor]);
    put(au + 1, start + 2, 'B', [previousAnchor, au, ...(previousB === undefined ? [] : [previousB])]);
    put(au + 2, start + 1, 'B', [previousAnchor, au + 1]);
    put(au + 3, start + 3, 'B', [au + 1, au]);
    roots.push(au + 1); children.push(au + 2, au + 3); previousAnchor = au; previousB = au + 3;
  }
  const whole = store.queryChart('local:uuid', 0, 100_000).pictures;
  const levels = new Map(whole.map(p => [p.picture.au, p.referenceLayer]));
  for (const au of roots) assert.deepEqual(levels.get(au), { level: 1, source: 'inferred' });
  for (const au of children) assert.deepEqual(levels.get(au), { level: 2, source: 'inferred' });
  for (const p of whole) assert.deepEqual(p.references, records[p.picture.au].references, 'layout preserves all active-list edges');
  const zoom = store.queryChart('local:uuid', 41_000, 44_000).pictures;
  for (const p of zoom) assert.deepEqual(p.referenceLayer, levels.get(p.picture.au), 'off-screen anchors still determine the same layer');
  // Results can arrive out of order or be rechecked; a later anchor must repair
  // a provisional layout without relying on insertion order.
  const replay = new DiagramStore();
  replay.put(records[2]);
  assert.equal(replay.queryChart('local:uuid', 0, 100_000).pictures[0].referenceLayer?.provisional, true);
  for (const r of [...records].reverse()) replay.put(r);
  assert.deepEqual(replay.queryChart('local:uuid', 0, 100_000).pictures.map(p => p.referenceLayer), whole.map(p => p.referenceLayer));
});
test('signaled VCL temporal IDs take priority; metadata IDs and fake AVC zeros never stand in for temporal layers', () => {
  for (const codec of ['hevc', 'vvc'] as const) {
    const p = result(); p.codec = codec;
    p.references = { kind: 'active-lists', state: 'ready', poc: 10, frameType: 'P', edges: [] };
    p.nalus = [{ offset: 4, size: 20, type: 1, temporalId: 2, layer: 0 }, { offset: 24, size: 10, type: codec === 'hevc' ? 39 : 23, temporalId: 0, layer: 0 }];
    assert.deepEqual(referenceLayers([p as any]).get(3), { level: 2, source: 'temporal-id' }, 'SEI must not force an otherwise valid temporal ID to zero');
    p.nalus[0].temporalId = 0;
    assert.deepEqual(referenceLayers([p as any]).get(3), { level: 0, source: 'temporal-id' }, 'a real T0 stays T0');
    p.nalus.push({ offset: 34, size: 10, type: 1, temporalId: 1, layer: 0 });
    assert.equal(referenceLayers([p as any]).get(3)?.source, 'inferred', 'conflicting VCL IDs cannot be presented as a signaled layer');
  }
  const avc = result(); avc.nalus = [{ offset: 4, size: 20, type: 1, temporalId: 0, layer: 0 }];
  avc.references = { kind: 'active-lists', state: 'ready', poc: 10, frameType: 'B', edges: [] };
  assert.deepEqual(referenceLayers([avc as any]).get(3), { level: 1, source: 'inferred', provisional: true });
});
test('NAL charts keep exact payload offsets, header types and byte accounting', () => {
  const avc = new Uint8Array(5); avc[4] = 3;
  const records = readNalus('h264', avc, new Uint8Array([0,0,0,2,0x65,0x80,0,0,0,3,0x06,0,1]));
  assert.deepEqual(records.map(n => [n.offset,n.size,n.type]), [[4,2,5],[10,3,6]]);
  assert.throws(() => readNalus('h264', avc, new Uint8Array([0,0,0,2,0x65])));
  const hevc = new Uint8Array(22); hevc[21] = 0;
  assert.deepEqual(readNalus('hevc', hevc, new Uint8Array([3,0x28,3,0x80]))[0], {offset:1,size:3,type:20,temporalId:2,layer:0});
  assert.equal(readNalus('vvc', new Uint8Array([0]), new Uint8Array([3,0,0x39,0x80]))[0].type, 7);
});
test('mean QP is retained in chart records and whole-source summaries without inventing unsupported values', () => {
  const store=new DiagramStore(2000);
  for(let au=0;au<400;au++) {const r=result();r.picture.au=au;r.sourcePtsUs=au*1000;r.sourceDtsUs=au*1000;r.nalus=[{offset:4,size:2,type:1,temporalId:0,layer:0}];r.qp.mean=au%2?30:20;store.put(r);store.put(r);}
  const chart=store.queryChart('local:uuid',0,400000,32);
  assert.ok(chart.aggregated);
  const count=chart.buckets.reduce((sum,b)=>sum+(b.qpCount ?? 0),0), total=chart.buckets.reduce((sum,b)=>sum+(b.qpSum ?? 0),0);
  assert.equal(count,400);assert.equal(total/count,25,'repeated source/AU results are not counted twice');
  const r=result();r.picture.au=401;r.sourcePtsUs=401000;r.sourceDtsUs=401000;r.nalus=[{offset:4,size:2,type:1,temporalId:0,layer:0}];r.capabilities.qp='unsupported';r.qp.mean=null;store.put(r);
  assert.equal(store.query('local:uuid',401,401000,401,1).pictures[0].qpMean,null);
  r.capabilities.qp='ready';r.qp.mean=33;store.put(r);store.put(r);
  const filled=store.queryChart('local:uuid',0,402000,32);
  assert.equal(filled.buckets.reduce((sum,b)=>sum+(b.qpCount ?? 0),0),401,'a later exact QP fills a previously missing result once');
  assert.equal(filled.buckets.reduce((sum,b)=>sum+(b.qpSum ?? 0),0),10033);
});

test('diagram metadata is detached, source-owned, bounded and retains cross-GOP reference identities', () => {
  const store = new DiagramStore(), r = result();
  r.nalus = [{offset:4,size:2,type:1,temporalId:0,layer:0}];
  r.references = {kind:'active-lists',state:'ready',poc:6,frameType:'B',edges:[{au:1,list:0},{au:2,list:1}]};
  r.gop = {startAu:3,endAu:8,configuration:0,anchor:'dependent'};
  store.put(r); r.nalus[0].size = 100;
  const q = store.query('local:uuid', 3, 100, 0, 256);
  assert.equal(q.pictures[0].nalus[0].size, 2); assert.equal(q.pictures[0].references!.edges[0].au, 1);
  q.pictures[0].references!.edges[0].au = 0;
  assert.equal(store.query('local:uuid', 3, 100).pictures[0].references!.edges[0].au, 1);
  assert.equal(store.query('other-source', 3, 100).count, 0);
  r.references.edges[0].au = 3; assert.throws(() => validateDiagram(r as any));
  r.references.edges = [{au:1,list:0},{au:1,list:0}]; assert.throws(() => validateDiagram(r as any));
  r.references = {kind:'active-lists',state:'unsupported',poc:6,frameType:'B',edges:[]}; assert.doesNotThrow(() => validateDiagram(r as any));
});

test('whole-film chart queries aggregate every frame, deduplicate rechecks and resolve time zoom without a 128-frame window', () => {
  const store = new DiagramStore();
  for (let au = 0; au < 1200; au++) {
    const r = result(); r.picture.au = au; r.sourcePtsUs = au * 33333;
    r.nalus = [{offset:4,size:au % 30 === 0 ? 900 : 90,type:au % 30 === 0 ? 5 : 1,temporalId:0,layer:0}];
    r.references = {kind:'active-lists',state:'ready',poc:au,frameType:au % 30 === 0 ? 'I' : 'P',edges:au ? [{au:au-1,list:0}] : []};
    store.put(r); if (au % 10 === 0) store.put(r);
  }
  const whole = store.queryChart('local:uuid', 0, 40_000_000, 400);
  assert.equal(whole.count, 1200); assert.equal(whole.aggregated, true); assert.equal(whole.pictures.length, 0);
  assert.ok(whole.buckets.length <= 82);
  assert.equal(whole.buckets.reduce((sum, b) => sum + b.pictures, 0), 1200);
  assert.equal(whole.buckets.reduce((sum, b) => sum + b.naluBytes[5], 0), 40 * 900);
  assert.equal(whole.buckets.reduce((sum, b) => sum + b.naluCounts[1], 0), 1160);
  assert.equal(whole.buckets.reduce((sum, b) => sum + b.frames.I, 0), 40);
  const local = store.queryChart('local:uuid', 20_000_000, 21_000_000);
  assert.equal(local.aggregated, false); assert.ok(local.pictures.length >= 29 && local.pictures.length <= 31);
  assert.ok(local.pictures.every(p => p.sourcePtsUs >= 20_000_000 && p.sourcePtsUs < 21_000_000));
  local.pictures[0].nalus[0].size = 0;
  assert.ok(store.queryChart('local:uuid', 20_000_000, 21_000_000).pictures[0].nalus[0].size > 0);
  assert.equal(store.queryChart('other-source', 0, 40_000_000).count, 0);
});
test('whole-film summaries survive raw eviction and sparse gaps remain explicit', () => {
  const store = new DiagramStore(2000);
  for (let au = 0; au < 3000; au++) { const r = result(); r.picture.au = au; r.sourcePtsUs = au * 1_000_000; r.nalus = [{offset:4,size:20,type:1,temporalId:0,layer:0}]; store.put(r); }
  const all = store.queryChart('local:uuid', 0, 3_000_000_000);
  assert.equal(all.count, 3000); assert.equal(all.buckets.reduce((sum, b) => sum + b.pictures, 0), 3000);
  assert.equal(all.buckets.reduce((sum, b) => sum + b.naluBytes[1], 0), 60000);
  assert.equal(all.detailMissing, true); assert.ok(all.buckets.length <= 104);
  const beginning = store.queryChart('local:uuid', 0, 1_000_000);
  assert.equal(beginning.detailMissing, true); assert.equal(beginning.pictures.length, 0); assert.ok(beginning.buckets.length);
  store.clear(); assert.equal(store.queryChart('local:uuid', 0, 3_000_000_000).count, 0);
});


test('container parameter sets parse independently of frame NALs with bounded AVC/HEVC/VVC records', async () => {
  const { readContainerHeader, validateContainerHeader } = await import('../../src/bitstream-analysis/diagrams.ts');
  const avc = Uint8Array.from([1,100,0,31,255,225,0,2,103,1,1,0,2,104,1]);
  const array = (type: number, payload: number[]) => [type,0,1,0,payload.length,...payload];
  const hevc = Uint8Array.from([1,...Array(21).fill(0),3,...array(32,[64,1]),...array(33,[66,1]),...array(34,[68,1])]);
  const vvc = Uint8Array.from([254,3,...array(14,[0,113]),...array(15,[0,121]),...array(16,[0,129])]);
  // Three sublayers, one extra level, a sub-profile and a single implicit-count OPI array.
  const ptl = Uint8Array.from([255,0,48,31,2,2,120,192,0,128,90,1,0,0,0,1,0,32,0,18,0,30,2,12,0,2,0,97,...array(15,[0,121])]);
  const cases: [AnalysisResult['codec'], Uint8Array, number[]][] = [['h264',avc,[7,8]],['hevc',hevc,[32,33,34]],['vvc',vvc,[14,15,16]],['vvc',ptl,[12,15]]];
  for (const [codec, bytes, types] of cases) {
    const header = readContainerHeader(codec, bytes); validateContainerHeader(codec, header);
    assert.deepEqual(header.nalus.map(n=>n.type), types);
    assert.ok(header.nalus.every(n=>n.size===2));
    for (let cut=0;cut<bytes.length;cut++) assert.throws(()=>readContainerHeader(codec,bytes.slice(0,cut)), /configuration|NAL|version/);
  }
  const bad = readContainerHeader('h264',avc); bad.nalus[0].size=100;
  assert.throws(()=>validateContainerHeader('h264',bad), /Invalid container NAL/);
});

test('container configurations survive detail eviction without changing frame totals or type filters', async () => {
  const { DiagramStore, readContainerHeader } = await import('../../src/bitstream-analysis/diagrams.ts');
  const store = new DiagramStore(1200), r = result();
  r.nalus=[{offset:4,size:20,type:5,temporalId:0,layer:0}];
  r.containerHeader=readContainerHeader('h264',Uint8Array.from([1,100,0,31,255,225,0,2,103,1,1,0,2,104,1]));
  for (let au=0;au<20;au++) { r.picture.au=au; r.sourcePtsUs=au*1000; store.put(r); }
  const q=store.queryChart('local:uuid',0,20000);
  assert.equal(q.count,20); assert.deepEqual(q.types,[5]);
  assert.equal(q.containerHeaders.length,1); assert.deepEqual(q.containerHeaders[0].nalus.map(n=>n.type),[7,8]);
  assert.equal(q.buckets.reduce((n,b)=>n+b.naluBytes[5],0),400);
  store.put(r); assert.equal(store.queryChart('local:uuid',0,20000).count,20);
  q.containerHeaders[0].nalus[0].size=999;
  assert.equal(store.queryChart('local:uuid',0,20000).containerHeaders[0].nalus[0].size,2);
  assert.equal(store.queryChart('another-source',0,20000).containerHeaders.length,0);
  store.clear(); assert.equal(store.queryChart('local:uuid',0,20000).containerHeaders.length,0);
});


test('chart time bases reorder exact frames while preserving identities, layers and payload', () => {
  const store = new DiagramStore();
  for (const [au, pts, dts, frameType] of [[0, 0, -20_000, 'I'], [1, 60_000, 0, 'P'], [2, 20_000, 20_000, 'B']] as const) {
    const r = result(); r.picture.au = au; r.sourcePtsUs = pts; r.sourceDtsUs = dts;
    r.nalus = [{ offset: 0, size: 100 + au, type: au ? 1 : 5, temporalId: 0, layer: 0 }];
    r.references = { kind: 'active-lists', state: 'ready', frameType, poc: pts, edges: au ? [{ au: 0, list: 0 }] : [] };
    store.put(r);
  }
  const pts = store.queryChart('local:uuid', -20_000, 80_000, 512, 'pts');
  const dts = store.queryChart('local:uuid', -20_000, 80_000, 512, 'dts');
  assert.deepEqual(pts.pictures.map(p => p.picture.au), [0, 2, 1]);
  assert.deepEqual(dts.pictures.map(p => p.picture.au), [0, 1, 2]);
  for (const p of pts.pictures) assert.deepEqual(dts.pictures.find(d => d.picture.au === p.picture.au), p);
  assert.deepEqual(store.queryChart('local:uuid', 0, 21_000, 512, 'pts').pictures.map(p => p.picture.au), [0, 2]);
  assert.deepEqual(store.queryChart('local:uuid', 0, 21_000, 512, 'dts').pictures.map(p => p.picture.au), [1, 2]);
  assert.deepEqual(store.chartBounds('local:uuid', 'dts'), { start: -20_000, end: 20_001 });
});

test('DTS summaries survive eviction and never substitute PTS for missing DTS', () => {
  const store = new DiagramStore(2000);
  const r = result(); r.sourcePtsUs = 40_000; r.nalus = [{ offset: 0, size: 10, type: 1, temporalId: 0, layer: 0 }];
  store.put(r);
  assert.equal(store.queryChart('local:uuid', -100_000, 1_000_000, 512, 'dts').count, 0);
  assert.equal(store.chartBounds('local:uuid', 'dts'), null);
  for (let au = 0; au < 600; au++) {
    r.picture.au = au; r.sourcePtsUs = au * 20_000 + 40_000; r.sourceDtsUs = au * 20_000 - 40_000;
    store.put(r); store.put(r);
  }
  const pts = store.queryChart('local:uuid', -100_000, 13_000_000, 512, 'pts');
  const dts = store.queryChart('local:uuid', -100_000, 13_000_000, 512, 'dts');
  assert.equal(dts.count, 600); assert.equal(pts.count, 600);
  assert.equal(dts.aggregated, true); assert.equal(dts.detailMissing, true);
  assert.equal(dts.buckets.reduce((n, b) => n + b.pictures, 0), 600);
  assert.equal(dts.buckets.reduce((n, b) => n + b.naluBytes[1], 0), 6000);
  assert.ok(dts.buckets[0].startUs < pts.buckets[0].startUs);
  store.clear(); assert.equal(store.chartBounds('local:uuid', 'dts'), null);
});

test('parallel cache writers share quota and protect other jobs unread chunks', async () => {
  const { AnalysisStore } = await import('../../server/analysis/store.ts');
  const { mkdtemp, rm } = await import('node:fs/promises'), { tmpdir } = await import('node:os'), { join } = await import('node:path');
  const folder = await mkdtemp(join(tmpdir(), 'vp-parallel-cache-'));
  const a = 'a'.repeat(64), b = 'b'.repeat(64), protectedFiles = new Set<string>();
  const store = new AnalysisStore(folder, 1100, () => protectedFiles);
  try {
    protectedFiles.add(store.chunkFile(a));
    const writes = await Promise.allSettled([store.put(a, result()), store.put(b, { ...result(), picture: { ...result().picture, au: 4 } })]);
    assert.equal(writes[0].status, 'fulfilled');
    assert.equal(writes[1].status, 'rejected', 'quota cannot evict a result owned by another pending job');
    assert.ok(await store.get(a)); assert.equal(await store.get(b), null);
    protectedFiles.clear();
    await store.put(b, result());
    assert.equal(await store.get(a), null); assert.ok(await store.get(b));
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('required reference ABI rejects old or incomplete cores before analysis', async () => {
  const { validateAnalysisCore, REFERENCE_EXPORTS } = await import('../../src/bitstream-analysis/core-abi.ts');
  const current = Object.fromEntries(REFERENCE_EXPORTS.map(name => [name, () => name === '_vpa_reference_abi' ? 1 : 0]));
  current._vpa_abi = () => 1;
  assert.doesNotThrow(() => validateAnalysisCore(current));
  assert.throws(() => validateAnalysisCore({ _vpa_abi: () => 1 }), /reference ABI 1/);
  for (const name of REFERENCE_EXPORTS) {
    const broken = {...current}; delete broken[name];
    assert.throws(() => validateAnalysisCore(broken), /ABI mismatch/);
  }
  assert.throws(() => validateAnalysisCore({...current, _vpa_reference_abi: () => 2}), /ABI mismatch/);
});

test('retry admission distinguishes transient failures from unsupported capabilities', async () => {
  const { canRetryAnalysis, AnalysisFailure } = await import('../../src/bitstream-analysis/failure.ts');
  for (const code of ['internal-error', 'resource-limit', 'cancelled'] as const) {
    const reason = new AnalysisFailure(code, code).info;
    assert.equal(canRetryAnalysis({state:reason.kind, reason}), true);
  }
  for (const code of ['unsupported-codec', 'unsupported-container', 'unsupported-qp-depth', 'invalid-request', 'source-changed'] as const) {
    const reason = new AnalysisFailure(code, code).info;
    assert.equal(canRetryAnalysis({state:reason.kind, reason}), false);
  }
  for (const state of ['idle', 'pending', 'ready']) assert.equal(canRetryAnalysis({state}), false);
});

test('session preserves source completion across eviction, multiple picture tasks, failure and replacement', async () => {
  const { ReviewSession } = await import('../../src/session.ts');
  const { rgbaDescription } = await import('../../src/frame-description.ts');
  const workerDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
  const locationDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'location');
  const requests: any[] = [];
  let failPicture = false, commit = 0;
  class FakeWorker {
    onmessage?: (event: {data: unknown}) => void;
    onerror?: (event: unknown) => void;
    postMessage(data: any) {
      if (!data.target) return;
      requests.push(data.target);
      const picture = (au: number) => ({...result(), picture:{...result().picture, au}, sourcePtsUs:100+au*100, gop:{startAu:0,endAu:3,configuration:0,anchor:'closed'}});
      queueMicrotask(() => {
        if (data.target.mode === 'stream') {
          this.onmessage?.({data:{event:'progress',progress:{pictures:0,totalPictures:3,checkedUs:0,totalUs:300,indexComplete:true}}});
          for (let au=0;au<3;au++) this.onmessage?.({data:{event:'chunk',result:picture(au)}});
          this.onmessage?.({data:{ok:true}});
        } else this.onmessage?.({data:failPicture ? {ok:false,error:'network',reason:{code:'internal-error',message:'network'}} : {ok:true,result:picture(data.target.picture.au)}});
      });
    }
    terminate() {}
  }
  Object.defineProperty(globalThis,'Worker',{configurable:true,value:FakeWorker});
  Object.defineProperty(globalThis,'location',{configurable:true,value:{href:'http://localhost/'}});
  const source = {
    info:{id:'local:uuid',name:'coverage.mp4',size:1,lastModified:0,codec:'h264',decoder:'webcodecs',width:16,height:16,firstPtsUs:100,durationUs:300},
    bitstreamFile:new Blob(['fixture']),
    async frameAt(time: number) { const au=Math.min(2,Math.floor(time/100)); return {kind:'video-sample',ptsUs:au*100,sourcePtsUs:100+au*100,durationUs:100,description:rgbaDescription(16,16),width:16,height:16,byteSize:1024,sourcePicture:{...result().picture,au},close(){}}; },
    async framesAfter(){return[];}, async *framesFrom(){}, dispose(){},
  } as unknown as import('../../src/media.ts').MediaSource;
  const session = new ReviewSession((_slot,frame)=>{frame.presentedCommit=++commit;});
  try {
    await session.load('A',async()=>source);
    await session.requestBitstreamStream('A');
    const completed=session.getBitstreamAnalysisState('A').completedStream!;
    assert.equal(completed.sourceVersion,'local:uuid'); assert.equal(completed.pictures,3);
    // Remove full frame records exactly as the bounded cache does; completion is independent.
    (session as any).bitstream.cache.clear();
    for (const time of [100,200]) {
      await session.seek(time);
      assert.equal(session.cachedBitstreamAnalysis('A'),null);
      await session.requestBitstreamAnalysis('A');
      assert.equal(session.getBitstreamAnalysisState('A').stream,undefined,'latest picture task is not whole-stream coverage');
      assert.deepEqual(session.getBitstreamAnalysisState('A').completedStream,completed);
    }
    assert.equal(requests.filter(target=>target.mode==='stream').length,1);
    assert.equal(requests.filter(target=>target.picture).length,2);
    (session as any).bitstream.cache.clear(); failPicture=true;
    await assert.rejects(session.requestBitstreamAnalysis('A'));
    assert.equal(session.getBitstreamAnalysisState('A').state,'error');
    assert.deepEqual(session.getBitstreamAnalysisState('A').completedStream,completed);
    failPicture=false; await session.requestBitstreamAnalysis('A');
    assert.equal(session.getBitstreamAnalysisState('A').state,'ready');
    await session.removeTrack('A');
    assert.equal(session.getBitstreamAnalysisState('A').completedStream,undefined);
    await session.load('A',async()=>source);
    assert.equal(session.getBitstreamAnalysisState('A').completedStream,undefined,'replacement generation cannot inherit coverage');
  } finally {
    await session.dispose();
    if(workerDescriptor)Object.defineProperty(globalThis,'Worker',workerDescriptor);else Reflect.deleteProperty(globalThis,'Worker');
    if(locationDescriptor)Object.defineProperty(globalThis,'location',locationDescriptor);else Reflect.deleteProperty(globalThis,'location');
  }
});


test('remote queue wait does not consume decoder time and repeated polling never renews a stalled stream', async () => {
  const { AnalysisPollingBudget } = await import('../../src/bitstream-analysis/task-pool.ts');
  const picture = new AnalysisPollingBudget(false, 0);
  picture.observe({state:'queued',seq:0}, 60000);
  picture.observe({state:'running',seq:1}, 119000);
  picture.observe({state:'running',seq:1}, 148999);
  assert.throws(()=>picture.observe({state:'running',seq:1}, 149000), /execution stalled/);
  const queued = new AnalysisPollingBudget(false, 0);
  assert.throws(()=>queued.observe({state:'queued',seq:0}, 120000), /queue wait/);
  const stream = new AnalysisPollingBudget(true, 0);
  stream.observe({state:'queued',seq:0}, 60000);
  stream.observe({state:'running',seq:1}, 90000);
  stream.observe({state:'running',seq:2}, 110000);
  stream.observe({state:'running',seq:2}, 139999);
  assert.throws(()=>stream.observe({state:'running',seq:2}, 140000), /execution stalled/);
  assert.throws(()=>stream.observe({state:'unknown',seq:3}, 140000), /Invalid/);
  assert.throws(()=>stream.observe({state:'queued',seq:3}, 110001), /returned to queue/);
});
