import { openPacketMedia } from './packet-media.ts';
import { WorkerRpc } from './worker-rpc.ts';
import type { PacketCommands } from './worker-protocol.ts';
import type { RandomAccessInput } from './range-reader.ts';
import type { MediaMeta, MediaSource } from './media.ts';
import type { FallbackDeps } from './ffmpeg-media.ts';
import { loadAborted, onLoadAbort } from './media-abort.ts';
import { contextLog } from './log.ts';

export type TsMediaAdmission = {kind:'unmigrated'; reason:string} | {
  kind:'js-h264-static'; open(forceWasm:boolean):Promise<MediaSource>; close():void;
};
/** Select the declared combination before decoding. Successful admission keeps
 * the actual source/index in its Worker; serialized metadata is not authority.
 * Only an explicit unsupported combination selects the unmigrated route. */
export async function admitTsMedia(input:RandomAccessInput,meta:MediaMeta,sourceVersion:string,deps:FallbackDeps):Promise<TsMediaAdmission> {
  loadAborted(deps.signal);
  const worker = deps.workerFactory ? deps.workerFactory() : typeof Worker !== 'undefined'
    ? new Worker(new URL('./packet-worker.ts',import.meta.url),{type:'module'})
    : new (await import('node:worker_threads')).Worker(new URL('./packet-worker.ts',import.meta.url)) as unknown as Worker;
  const rpc = new WorkerRpc<PacketCommands>(worker,undefined,deps.onProgress);
  const detach = onLoadAbort(deps.signal,()=>rpc.terminate(deps.signal!.reason));
  try {
    deps.onProgress?.('index');
    const prepared = await rpc.call('prepare-ts',{input,sourceVersion},[],60000,true);
    loadAborted(deps.signal);
    if(!prepared.admitted) {
      rpc.terminate();
      contextLog().info('media','TS 组合尚未迁移，保留既有容器路径',{reason:prepared.reason});
      return {kind:'unmigrated',reason:prepared.reason};
    }
    let consumed=false;
    return {kind:'js-h264-static',close(){if(!consumed)rpc.terminate();},async open(forceWasm){
      if(consumed)throw new Error('JS TS admission was already consumed');
      consumed=true;
      try{return await openPacketMedia('ts',input,meta,{...deps,forceWasm,sourceVersion,
        preparedTs:{rpc,session:prepared.session,hasDts:prepared.index.packets.some(p=>p.timing.dts!==null)}});}
      catch(error){rpc.terminate();throw error;}
    }};
  } catch(error){rpc.terminate();throw error;}
  finally{detach();}
}
