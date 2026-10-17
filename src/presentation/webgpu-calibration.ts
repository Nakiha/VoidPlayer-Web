// Locally generated 512x256 neutral ramp, libx264 QP1, BT.709 video range.
// Annex-B keyframe and reference codes independently decoded by FFmpeg. No user
// media is sampled. A finite named profile is verified; no curve fitting or UA sniff.
import { createExternalSurface } from './webgpu-color-surface.mjs';
const payload = "AAAAAQYF//953EXpvebZSLeWLNgg2SPu73gyNjQgLSBjb3JlIDE2NSByMzIyMiBiMzU2MDVhIC0gSC4yNjQvTVBFRy00IEFWQyBjb2RlYyAtIENvcHlsZWZ0IDIwMDMtMjAyNSAtIGh0dHA6Ly93d3cudmlkZW9sYW4ub3JnL3gyNjQuaHRtbCAtIG9wdGlvbnM6IGNhYmFjPTEgcmVmPTMgZGVibG9jaz0xOjA6MCBhbmFseXNlPTB4MzoweDExMyBtZT1oZXggc3VibWU9NyBwc3k9MSBwc3lfcmQ9MS4wMDowLjAwIG1peGVkX3JlZj0xIG1lX3JhbmdlPTE2IGNocm9tYV9tZT0xIHRyZWxsaXM9MSA4eDhkY3Q9MSBjcW09MCBkZWFkem9uZT0yMSwxMSBmYXN0X3Bza2lwPTEgY2hyb21hX3FwX29mZnNldD0tMiB0aHJlYWRzPTggbG9va2FoZWFkX3RocmVhZHM9MSBzbGljZWRfdGhyZWFkcz0wIG5yPTAgZGVjaW1hdGU9MSBpbnRlcmxhY2VkPTAgYmx1cmF5X2NvbXBhdD0wIGNvbnN0cmFpbmVkX2ludHJhPTAgYmZyYW1lcz0zIGJfcHlyYW1pZD0yIGJfYWRhcHQ9MSBiX2JpYXM9MCBkaXJlY3Q9MSB3ZWlnaHRiPTEgb3Blbl9nb3A9MCB3ZWlnaHRwPTIga2V5aW50PTI1MCBrZXlpbnRfbWluPTIgc2NlbmVjdXQ9NDAgaW50cmFfcmVmcmVzaD0wIHJjPWNxcCBtYnRyZWU9MCBxcD0xIGlwX3JhdGlvPTEuNDAgcGJfcmF0aW89MS4zMCBhcT0wAIAAAAABZ2QAFazZQIAhpqBAQCgAAAMACAAAAwAgeLFssAAAAAFo6+BnLIsAAAFliIQBr+t1fj9+RjwODOP8Hlv3tfncZQilz+AQf94dmctVjnj0/abzR9KGaF2zxVnG25WK+uf2hzphuejvs9rbTPHSg+EMFfQPPKGIy9gMbdD6uc5GMINbibbinF3V8PkYw/GhSg4VcTBBTm6d/koC3j5MjmD+mCB46noY/tN9cADm49H2mBFK3hbjpLKZ7+XmNw3oUs+U6Y8gVipMWfx00KYDyVNexSxu5VQZIlplSLiNZZCbw/U15H9NQXGNrSkdgFviDjKG8ODxLFXtMQfW/o/k9HttvEPsgwtK2z2QCMQ2zRx6JgRxlsfhQ6kzeUohEjMeRwotpAdu7m4mQ8XpTGL08yw+8w3s9tgp45NGRo7ke2cbpOHiUnSUi6jMNUqr1FgAAAMAAAVDwAAAjbBVJHopF8KuyRYgDIHSmo6yTOIXinlv";
const references = [{"x": 0, "y": 128, "apple": [0, 0, 0], "srgb": [0, 0, 0]}, {"x": 30, "y": 128, "apple": [8, 12, 11], "srgb": [12, 15, 14]}, {"x": 60, "y": 128, "apple": [28, 31, 30], "srgb": [26, 28, 28]}, {"x": 90, "y": 128, "apple": [47, 50, 49], "srgb": [41, 44, 43]}, {"x": 120, "y": 128, "apple": [64, 67, 66], "srgb": [56, 59, 58]}, {"x": 150, "y": 128, "apple": [82, 85, 84], "srgb": [73, 75, 75]}, {"x": 180, "y": 128, "apple": [99, 101, 100], "srgb": [88, 90, 90]}, {"x": 210, "y": 128, "apple": [114, 117, 116], "srgb": [103, 105, 105]}, {"x": 240, "y": 128, "apple": [128, 131, 130], "srgb": [117, 119, 119]}, {"x": 271, "y": 128, "apple": [143, 145, 145], "srgb": [132, 134, 134]}, {"x": 301, "y": 128, "apple": [158, 160, 159], "srgb": [147, 150, 149]}, {"x": 331, "y": 128, "apple": [171, 173, 173], "srgb": [161, 164, 163]}, {"x": 361, "y": 128, "apple": [185, 187, 187], "srgb": [176, 179, 178]}, {"x": 391, "y": 128, "apple": [199, 201, 200], "srgb": [191, 194, 193]}, {"x": 421, "y": 128, "apple": [214, 216, 215], "srgb": [208, 210, 210]}, {"x": 451, "y": 128, "apple": [227, 229, 229], "srgb": [223, 225, 225]}, {"x": 481, "y": 128, "apple": [240, 242, 242], "srgb": [238, 240, 240]}];
export async function detectGpuProfile():Promise<'hybrid'|'webkit-planes'|'planes'|null> {
  if(typeof VideoDecoder==='undefined')return null;
  const canvas=document.createElement('canvas');
  let frame:VideoFrame|undefined,decoder:VideoDecoder|undefined,timer:ReturnType<typeof setTimeout>|undefined;
  let surface:Awaited<ReturnType<typeof createExternalSurface>>|undefined;
  try {
    surface=await createExternalSurface(canvas);
    let failure:Error|undefined;
    decoder=new VideoDecoder({output:f=>{frame?.close();frame=f;},error:e=>{failure=e;}});
    decoder.configure({codec:'avc1.640015',hardwareAcceleration:'prefer-hardware'});
    decoder.decode(new EncodedVideoChunk({type:'key',timestamp:0,data:Uint8Array.from(atob(payload),c=>c.charCodeAt(0))}));
    timer=setTimeout(()=>{if(decoder?.state!=='closed')decoder?.close();},3000);
    await decoder.flush();clearTimeout(timer);if(failure||!frame)return null;
    surface.present(frame);const pixels=await surface.capture();
    const error=(key:'apple'|'srgb')=>Math.max(...references.flatMap(r=>r[key].map((v,c)=>Math.abs(v-pixels[(r.y*512+r.x)*4+c]))));
    const color=frame.colorSpace;
    if(color.matrix!=='bt709'||surface.errors.length)return null;
    if(error('apple')<=1)return 'hybrid';
    if(error('srgb')<=2){
      if(color.fullRange===true&&color.transfer==='iec61966-2-1')return 'webkit-planes';
      return 'planes';
    }
    return null;
  } catch {return null;}
  finally {clearTimeout(timer);if(decoder?.state!=='closed')decoder?.close();frame?.close();surface?.dispose();}
}
