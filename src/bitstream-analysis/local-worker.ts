import { emptyCounters, countCore, countProduct } from './counters.ts';
import { analysisIndexIdentity, isProduct } from './products.ts';
import type { AnalysisOutput } from './products.ts';
import { coreAssetUrl } from '../core-url.ts';
import { validateAnalysisCore } from './core-abi.ts';
import { RangeReader } from "../range-reader.ts";
import { analyzePicture, analyzeRange, analyzeStream } from "./runner.ts";
import { failureInfo } from "./failure.ts";
let snapshotReply: ((value: import("./types.ts").AnalysisIndexSnapshot) => void) | undefined;
let cacheReply: ((value: AnalysisOutput | null) => void) | undefined;
const cachedResults = new Set<string>();
let pendingCacheKey="";
let acknowledgement: ((accepted:boolean) => void) | undefined;
let indexReply: ((index: import('./stream.ts').AnalysisIndexFrontier) => void) | undefined;
const scope = globalThis as unknown as {
  onmessage: (event: MessageEvent) => void;
  postMessage: (data: unknown, transfer?: Transferable[]) => void;
};
scope.onmessage = async ({ data }) => {
  if (data.event === 'snapshot') { const reply = snapshotReply; snapshotReply = undefined; reply?.(data.index); return; }
  if (data.event === 'cache') { const reply = cacheReply; cacheReply = undefined; if(data.result)cachedResults.add(JSON.stringify([data.result.picture,data.result.buildId]));else cachedResults.delete(pendingCacheKey); reply?.(data.result ?? null); return; }
  if (data.event === 'index') { const reply = indexReply; indexReply = undefined; reply?.(data.index); return; }
  if(data.event==='coverage-miss'){const ack=acknowledgement;acknowledgement=undefined;ack?.(false);return;}
  if (data.ok) { const ack = acknowledgement; acknowledgement = undefined; ack?.(true); return; }
  try {
    const counters=emptyCounters();const delivered=new Set<number>();
    const response = await fetch(
      coreAssetUrl("/vendor/voidplayer-analysis/manifest.json", data.base),
    );
    if (!response.ok) throw new Error("Analysis core unavailable");
    const manifest = await response.json();
    const loadCore = async () => {
      const initStarted=performance.now();
      const module = await import(
        /* @vite-ignore */ coreAssetUrl(
          "/vendor/voidplayer-analysis/voidplayer-analysis.js",
          data.base,
        )
      );
      const core = await module.default({ locateFile: (name: string) => coreAssetUrl(`/vendor/voidplayer-analysis/${name}`, data.base) });
      validateAnalysisCore(core);
      counters.init++; counters.initMs+=performance.now()-initStarted; return countCore(core,counters);
    };
    const snapshot = () => new Promise<import('./types.ts').AnalysisIndexSnapshot>(resolve => {
      snapshotReply = resolve; scope.postMessage({event:'snapshot'});
    });
    const makeReader = () => {
      return Object.assign(new RangeReader({file:data.file}), {
        ...(data.externalSnapshot ? {flvIndex: async () => await snapshot() as import('../flv-index-cache.ts').FlvIndexDocument} : {}),
      });
    };
    if (data.target.mode === 'stream' || 'startUs' in data.target) {
      const publish = async (result: AnalysisOutput) => {
        const hit=cachedResults.has(JSON.stringify([result.picture,result.buildId]));
        const coverage=hit&&data.target.mode==='stream' ? {event:'coverage',picture:result.picture,buildId:result.buildId,gop:result.gop,product:data.target.product,indexIdentity:analysisIndexIdentity(data.target.indexIdentity)} : undefined;
        countProduct(result,hit,counters,coverage);delivered.add(result.picture.au);counters.uniqueDelivered=delivered.size;
        scope.postMessage({...(coverage ?? {event:'chunk',result}),counters:{...counters}}, !coverage && isProduct(result) && result.product==='blocks' ? [result.payload] : []);
        const accepted=await new Promise<boolean>(resolve => { acknowledgement = resolve; });
        if(!accepted && coverage){
          counters.cacheHit--;countProduct(result,false,counters);
          scope.postMessage({event:'chunk',result,repair:true,counters:{...counters}});
          await new Promise<boolean>(resolve=>{acknowledgement=resolve;});
        }
      };
      const reader = makeReader();
      const signal = new AbortController().signal;
      const buildId = manifest.buildId ?? manifest.revision;
      if (data.target.mode === 'stream')
        await analyzeStream(reader, data.target, loadCore, buildId, signal, publish,
          async progress => scope.postMessage({ event: 'progress', progress }),
          data.externalIndex ? () => new Promise(resolve => {
            indexReply = resolve; scope.postMessage({ event: 'index' });
          }) : undefined, picture => new Promise<AnalysisOutput | null>(resolve => {
            pendingCacheKey=JSON.stringify([picture,buildId]);cacheReply = resolve; scope.postMessage({ event: 'cache', picture, buildId, product: data.target.product, indexIdentity: data.target.indexIdentity ?? null });
          }), plan => scope.postMessage({event:'plan',plan}));
      else
        await analyzeRange(reader, data.target, loadCore, buildId, signal, publish,
          picture => new Promise<AnalysisOutput | null>(resolve => {
            pendingCacheKey=JSON.stringify([picture,buildId]);cacheReply = resolve; scope.postMessage({ event: 'cache', picture, buildId, product: data.target.product, indexIdentity: data.target.indexIdentity ?? null });
          }));
      scope.postMessage({event:'counters',counters});scope.postMessage({ ok: true, range: true });
      return;
    }
    const result = await analyzePicture(
      makeReader(),
      data.target,
      await loadCore(),
      (manifest.buildId ?? manifest.revision),
      new AbortController().signal,
    );
    countProduct(result,false,counters);counters.uniqueDelivered=1;
    scope.postMessage({ ok: true, result, counters }, isProduct(result) && result.product === "blocks" ? [result.payload] : []);
  } catch (error) {
    scope.postMessage({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      reason: failureInfo(error),
    });
  }
};
