import { MediaOpenError } from './media-errors.ts';
import { TsCombinationNotMigrated } from './ts-packet-source.ts';

/** Product admission supplements the shared demuxer with stable, bounded PSI
 * evidence. No payload, AU or codec parsing is implemented here. */
export function staticTsPsi(prefix:Uint8Array):(bytes:Uint8Array)=>void {
  const malformed=(reason:string):never=>{throw new MediaOpenError('container',`JS TS: ${reason}`);};
  const outside=(reason:string):never=>{throw new TsCombinationNotMigrated(reason);};
  if(![0,188,376].every(at=>prefix[at]===0x47))outside('product migration requires 188-byte TS');
  const section=(bytes:Uint8Array,at:number):Uint8Array|undefined=>{
    if(!(bytes[at+1]&64)||!(bytes[at+3]&16))return;
    if(bytes[at+1]&128||bytes[at+3]&192)malformed('invalid PSI transport');
    let p=at+4;if(bytes[at+3]&32)p+=1+bytes[p];
    if(p>=at+188)return;
    p+=1+bytes[p];if(p+3>at+188)outside('PSI pointer or fragmentation is outside product admission');
    const end=p+3+((bytes[p+1]&15)*256+bytes[p+2]);
    if(end>at+188)outside('fragmented PSI is outside product admission');
    if(end-p<12)malformed('invalid PSI length');
    const value=bytes.subarray(p,end);let crc=0xffffffff;
    for(const b of value){crc^=b<<24;for(let i=0;i<8;i++)crc=(crc<<1)^(crc&0x80000000?0x04c11db7:0);}
    if(crc!==0)malformed('invalid PSI CRC');
    return value;
  };
  const first=(pid:number)=>{
    for(let at=0;at+188<=prefix.length;at+=188)if(((prefix[at+1]&31)*256+prefix[at+2])===pid){const value=section(prefix,at);if(value)return value.slice();}
    return outside('complete startup PSI is outside product admission');
  };
  const pat=first(0);
  const programs=[];
  for(let at=8;at+4<=pat.length-4;at+=4)if(pat[at]||pat[at+1])programs.push((pat[at+2]&31)*256+pat[at+3]);
  if(pat[0]!==0||programs.length!==1)outside('single-program TS is required for product admission');
  const pmtPid=programs[0],pmt=first(pmtPid);
  if(pmt[0]!==2)malformed('invalid startup PMT');
  return bytes=>{
    for(let at=0;at+188<=bytes.length;at+=188){
      const pid=(bytes[at+1]&31)*256+bytes[at+2];if(pid!==0&&pid!==pmtPid)continue;
      const current=section(bytes,at);if(!current)continue;
      const expected=pid===0?pat:pmt;
      if(current.length!==expected.length||current.some((b,i)=>b!==expected[i]))outside('program-map changes are outside static product admission');
    }
  };
}
