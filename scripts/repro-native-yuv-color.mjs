// Generates a standalone, shareable synthetic WebCodecs reproduction and runs it.
// Requires ffmpeg, Playwright, and installed target browser. No application imports.
import {execFileSync} from 'node:child_process';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright';

const out=resolve('artifacts/color/native-yuv-repro');await mkdir(out,{recursive:true});
const ffmpeg=args=>execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-y',...args],{timeout:60000});
const raw=Buffer.alloc(192*144*3/2),patches=[[16,128,128],[235,128,128],[64,128,128],[160,128,128],[100,80,180],[140,180,80],[120,70,90],[150,170,160],[100,110,150],[180,140,100],[80,160,140],[200,100,120]];
let offset=0;
for(let p=0;p<3;p++){const w=p?96:192,h=p?72:144;for(let y=0;y<h;y++)for(let x=0;x<w;x++)raw[offset++]=patches[Math.floor(y*3/h)*4+Math.floor(x*4/w)][p];}
const input=resolve(out,'input.yuv');await writeFile(input,raw);
const fixtures=[];
for(const encoder of ['libx264','libx265'])for(const matrix of ['bt709','smpte170m']){
 const hevc=encoder==='libx265',name=`${hevc?'hevc':'h264'}-${matrix}`,video=resolve(out,`${name}.${hevc?'hevc':'h264'}`),ref=resolve(out,`${name}.yuv`);
 ffmpeg(['-f','rawvideo','-pixel_format','yuv420p','-video_size','192x144','-i',input,'-frames:v','1','-c:v',encoder,'-preset','fast',...(hevc?['-x265-params','qp=1:keyint=1:log-level=error']:['-qp','1','-g','1']),'-color_range','tv','-colorspace',matrix,'-color_primaries','bt709','-color_trc','bt709',video]);
 ffmpeg(['-i',video,'-frames:v','1','-f','rawvideo','-pix_fmt','yuv420p',ref]);
 const annexb=await readFile(video),reference=await readFile(ref);
 fixtures.push({name,matrix,codec:hevc?'hvc1.1.6.L30.B0':'avc1.64000A',annexb:annexb.toString('base64'),reference:reference.toString('base64'),sha256:createHash('sha256').update(annexb).digest('hex')});
}
const html=(await readFile(new URL('./repro-native-yuv-color.html',import.meta.url),'utf8')).replace('__FIXTURES__',JSON.stringify(fixtures));
await writeFile(resolve(out,'index.html'),html);
const server=createServer((req,res)=>{res.setHeader('Content-Type','text/html; charset=utf-8');res.end(html);});
await new Promise(done=>server.listen(0,'127.0.0.1',done));
const reports=[];
try {for(const channel of process.argv.slice(2).length?process.argv.slice(2):['chrome','msedge']){
 if(!['chrome','msedge'].includes(channel))throw Error('Expected chrome or msedge');
 const browser=await chromium.launch({headless:false,...(channel==='chrome'&&process.env.CHROME_EXECUTABLE_PATH?{executablePath:process.env.CHROME_EXECUTABLE_PATH}:{channel})});
 try {
  const page=await browser.newPage(),cdp=await page.context().newCDPSession(page),events=[];
  cdp.on('Tracing.dataCollected',({value})=>events.push(...value.filter(e=>e.name==='CreateExternalTexture')));
  await cdp.send('Tracing.start',{categories:'disabled-by-default-webgpu',transferMode:'ReportEvents'});
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const rows=await page.evaluate(()=>window.runRepro());
  const ended=new Promise(done=>cdp.once('Tracing.tracingComplete',done));await cdp.send('Tracing.end');await ended;
  reports.push({channel,version:browser.version(),rows,externalTextureTrace:events});
  console.log(JSON.stringify({channel,rows},null,2));
 } finally {await browser.close();}
}} finally {await new Promise(done=>server.close(done));await writeFile(resolve(out,'report.json'),JSON.stringify({fixtures:fixtures.map(({name,sha256})=>({name,sha256})),reports},null,2));}
// A diagnostic run succeeds only if all supported cases could be measured.
if(reports.some(report=>report.rows.some(row=>row.error)))process.exitCode=1;
