import {mkdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
await mkdir('fixtures/demux-removal',{recursive:true});
// Preserve the frozen H264 bitstream; add an interleaved, ordinary AAC track.
execFileSync('ffmpeg',['-y','-hide_banner','-loglevel','error','-i','fixtures/ts-analysis/h264-static.ts','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-map','0:v:0','-map','1:a:0','-c:v','copy','-c:a','aac','-shortest','fixtures/demux-removal/h264-audio.ts']);

for(const [name,codec,container,pix] of [['mpeg4.mp4','mpeg4','mp4','yuv420p'],['mjpeg.mov','mjpeg','mov','yuvj420p'],['prores.mov','prores_ks','mov','yuv422p10le']] as const){
 execFileSync('ffmpeg',['-y','-v','error','-f','lavfi','-i','testsrc2=size=160x90:rate=24:duration=1','-an','-c:v',codec,'-pix_fmt',pix,'-color_primaries','bt709','-color_trc','bt709','-colorspace','bt709','-f',container,`fixtures/demux-removal/${name}`]);
}
