import {parentPort,workerData} from 'node:worker_threads';
import {open} from 'node:fs/promises';
import {TsPacketSource} from '../../shared/media/containers/ts-packet-source.ts';

parentPort!.on('message',async request=>{
  const handle=await open(request.filePath,'r');
  const source=new TsPacketSource({size:request.size,
    async read(offset,length){
      if(workerData.stall)await new Promise(()=>{});
      await new Promise(resolve=>setTimeout(resolve,workerData.delayMs));
      const bytes=new Uint8Array(length);let filled=0;
      while(filled<length){const read=await handle.read(bytes,filled,length-filled,offset+filled);if(!read.bytesRead)throw new Error('short test file');filled+=read.bytesRead;}
      return bytes;
    },close(){}},`${request.id}@${request.version}`,new AbortController().signal);
  try {
    const document=await source.open(undefined,data=>parentPort!.postMessage({type:'progress',data:{phase:'scan',...data}}));
    parentPort!.postMessage({value:{built:true,packets:document.packets.length}});
  } catch(error){parentPort!.postMessage({error:String(error)});}
  finally {source.close();await handle.close();parentPort!.close();}
});
