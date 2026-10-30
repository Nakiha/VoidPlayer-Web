import {MediaOpenError} from '../../../shared/media/io/media-errors.ts';
import { openPacketMedia } from './packet-media.ts';
import { WorkerRpc } from '../workers/worker-rpc.ts';
import type { PacketCommands } from '../workers/worker-protocol.ts';
import type { RandomAccessInput } from '../../../shared/media/io/range-reader.ts';
import type { MediaMeta, MediaSource } from '../source.ts';
import type { FallbackDeps } from './ffmpeg-media.ts';
import { loadAborted, onLoadAbort } from '../../../shared/media/io/media-abort.ts';

export type JsContainerAdmission = {
  kind:'js-packet-static'; open(forceWasm:boolean):Promise<MediaSource>; close():void;
};
/** Select the declared combination before decoding. Successful admission keeps
 * the actual source/index in its Worker; serialized metadata is not authority.
 * Only an explicit unsupported combination selects the unmigrated route. */
export async function admitJsContainerMedia(format:'ts'|'matroska',input:RandomAccessInput,meta:MediaMeta,sourceVersion:string,deps:FallbackDeps):Promise<JsContainerAdmission> {
  loadAborted(deps.signal);
  const worker = deps.workerFactory ? deps.workerFactory() : typeof Worker !== 'undefined'
    ? new Worker(new URL('./packet-worker.ts',import.meta.url),{type:'module'})
    : new (await import('node:worker_threads')).Worker(new URL('./packet-worker.ts',import.meta.url)) as unknown as Worker;
  const rpc = new WorkerRpc<PacketCommands>(worker,undefined,deps.onProgress);
  const detach = onLoadAbort(deps.signal,()=>rpc.terminate(deps.signal!.reason));
  try {
    deps.onProgress?.('index');
    const prepared = await rpc.call('prepare-js',{input,sourceVersion,format,persistent:'file' in input||!!input.library},[],60000,true);
    loadAborted(deps.signal);
    if(!prepared.admitted) {
      rpc.terminate();
      throw new MediaOpenError('container',`JS ${format} unsupported combination: ${prepared.reason}`);
    }
    let consumed=false;
    return {kind:'js-packet-static',close(){if(!consumed)rpc.terminate();},async open(forceWasm){
      if(consumed)throw new Error('JS TS admission was already consumed');
      consumed=true;
      try{return await openPacketMedia(format,input,meta,{...deps,forceWasm,sourceVersion:prepared.index.sourceVersion,
        preparedTs:{rpc,session:prepared.session,hasDts:prepared.index.packets.some(p=>p.timing.dts!==null)}});}
      catch(error){rpc.terminate();throw error;}
    }};
  } catch(error){rpc.terminate();throw error;}
  finally{detach();}
}

export const admitTsMedia=(...args:Parameters<typeof admitJsContainerMedia> extends [unknown,...infer Rest]?Rest:never)=>admitJsContainerMedia('ts',...args);
