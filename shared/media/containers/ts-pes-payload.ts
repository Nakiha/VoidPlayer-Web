import {MediaOpenError} from '../io/media-errors.ts';
const error=(message:string):never=>{throw new MediaOpenError('container',`JS TS PES: ${message}`);};
/** Reassemble one bounded physical PES without a decoder or shared cursor. */
export async function readTsPesPayload(read:(at:number,n:number)=>Promise<Uint8Array>,start:number,end:number,pid:number,checkPsi:(bytes:Uint8Array)=>void){
    const parts:Uint8Array[]=[];let total=0,first=true,counter:number|undefined,pesLength:number|undefined;
    for(let base=start;base<end;base+=188*1024){const bytes=await read(base,Math.min(188*1024,end-base));checkPsi(bytes);
      for(let at=0;at<bytes.length;at+=188){if(bytes[at]!==0x47)error('sync mismatch');if(((bytes[at+1]&31)*256+bytes[at+2])!==pid)continue;
        const control=bytes[at+3]>>4&3;if(!control||bytes[at+1]&128||bytes[at+3]&192)error('invalid transport');
        let p=at+4;if(control&2){const length=bytes[p++];if(p+length>at+188||length&&bytes[p]&128)error('invalid/discontinuous adaptation');p+=length;}
        if(!(control&1)||p===at+188)continue;
        const cc=bytes[at+3]&15;if(counter!==undefined&&cc!==(counter+1)%16)error('continuity gap');counter=cc;
        if(first){if(!(bytes[at+1]&64)||p+9>at+188||bytes[p]||bytes[p+1]||bytes[p+2]!==1||bytes[p+3]<0xe0||bytes[p+3]>0xef||bytes[p+6]>>6!==2)error('invalid PES start');
          const header=9+bytes[p+8],declared=bytes[p+4]*256+bytes[p+5];if(p+header>at+188)error('split PES header');if(declared){pesLength=declared+6-header;if(pesLength<0)error('invalid PES length');}p+=header;first=false;
        }else if(bytes[at+1]&64)error('multiple PES in packet range');
        const part=bytes.slice(p,at+188);total+=part.length;if(total>8*1024*1024)throw new MediaOpenError('resource','MPEG-2 PES payload budget');parts.push(part);
      }
    }
    if(first||pesLength!==undefined&&pesLength!==total)error('truncated PES payload');const out=new Uint8Array(total);let at=0;for(const p of parts){out.set(p,at);at+=p.length;}return out;
}
