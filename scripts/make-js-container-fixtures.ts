import {mkdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
await mkdir('fixtures/js-container',{recursive:true});
const output=(name:string,...args:string[])=>execFileSync('ffmpeg',['-y','-hide_banner','-loglevel','error',...args,`fixtures/js-container/${name}`]);
const source=['-f','lavfi','-i','testsrc2=size=128x96:rate=30:duration=20','-an'];
output('h264.ts',...source,'-c:v','libx264','-x264-params','keyint=30:min-keyint=30:scenecut=0:open-gop=0:slices=1','-pix_fmt','yuv420p');
output('hevc.ts',...source,'-c:v','libx265','-x265-params','pools=1:frame-threads=1:log-level=error:keyint=30:min-keyint=30:scenecut=0:open-gop=0','-pix_fmt','yuv420p');
output('hevc10.ts',...source,'-c:v','libx265','-x265-params','pools=1:frame-threads=1:log-level=error:keyint=30:min-keyint=30:scenecut=0:open-gop=0','-pix_fmt','yuv420p10le');
for(const codec of ['h264','hevc','hevc10'])output(`${codec}.mkv`,'-i',`fixtures/js-container/${codec}.ts`,'-c','copy');
output('hevc-audio.mkv','-i','fixtures/js-container/hevc.ts','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=20','-c:v','copy','-c:a','libopus','-shortest');
for(const codec of ['vp8','vp9'])output(`${codec}.webm`,...source,'-c:v',codec==='vp9'?'libvpx-vp9':'libvpx','-lag-in-frames','0','-auto-alt-ref','0','-g','30','-deadline','realtime','-pix_fmt','yuv420p');
output('ffv1-unmigrated.mkv','-f','lavfi','-i','testsrc2=size=128x96:rate=10:duration=1','-an','-c:v','ffv1');
// Independent malformed inputs keep the same original fixture, never replace
// correctness gates with an unsupported result for the admitted simple files.
console.log('Prepared 600-picture H264/HEVC TS/MKV and VP8/VP9 WebM fixtures, plus explicit unmigrated FFV1');
