// Real media entry points, byte-range IO, pixels, ordinal stepping and reopen.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {Input,BlobSource,ALL_FORMATS,EncodedPacketSink} from 'mediabunny';
import {wasmFlvDecoder} from '../src/flv-decoder.ts';
import {createServer} from 'vite';
import {webkit,chromium} from 'playwright';
const name='h265_10s_1920x1080.mp4',bytes=await readFile(new URL('../fixtures/video/'+name,import.meta.url));
const oracle=JSON.parse(await readFile(new URL('../test/hevc-order-reference.json',import.meta.url)));
assert.equal(createHash('sha256').update(bytes).digest('hex'),oracle.sha256);
const input=new Input({source:new BlobSource(new Blob([bytes])),formats:ALL_FORMATS});
const track=await input.getPrimaryVideoTrack(),config=await track.getDecoderConfig();
const core=new URL('../public/vendor/voidplayer-core/',import.meta.url);
const decoder=await wasmFlvDecoder({codec:'hevc',description:new Uint8Array(config.description)},new URL('voidplayer-core.js',core).href,await readFile(new URL('voidplayer-core.wasm',core)));
const refs=[];
const collect=()=>{for(;;){const f=decoder.receive(Number.MIN_SAFE_INTEGER);if(!f)break;const p=new Uint8Array(f.pixels),sig=[];
  for(let y=0;y<18;y++)for(let x=0;x<32;x++){const k=(Math.floor((y+.5)*f.height/18)*f.width+Math.floor((x+.5)*f.width/32))*4;sig.push(p[k],p[k+1],p[k+2]);}refs.push(sig);f.frame?.close();}};
try{for await(const p of new EncodedPacketSink(track).packets()){await decoder.send(p.data,{pts:Math.round(p.timestamp*1e6),dts:Math.round(p.timestamp*1e6),key:p.type==='key'});collect();}await decoder.drain();collect();}
finally{decoder.close();input.dispose();}
assert.equal(refs.length,600);
const server=await createServer({server:{host:'127.0.0.1',port:0,headers:{'Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp'}}});
await server.listen();const base=`http://127.0.0.1:${server.httpServer.address().port}`,results=[];
try{for(const [browserName,engine] of Object.entries({webkit,chromium})){
  const browser=await engine.launch({headless:true});
  try{for(const remote of [false,true]){
    const page=await browser.newPage(),requests=[];
    page.on('request',r=>{if(r.url().includes('/fixtures/video/'))requests.push(r.headers());});
    try{
      await page.route('**/timeline-test',r=>r.fulfill({contentType:'text/html',headers:{'Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp'},body:'<div class="frame-stage"><canvas></canvas></div>'}));
      await page.goto(base+'/timeline-test');
      const rows=await page.evaluate(async({name,remote,refs,order})=>{
        const {openMedia,openMediaFromUrl}=await import('/src/media.ts');
        const {paintFrame,captureFrame,disposePresentation,setPresentationGeometry}=await import('/src/presenter.ts');
        const url='/fixtures/video/'+name,bytes=await(await fetch(url)).arrayBuffer(),rows=[];
        const sourceCanvas=document.querySelector('canvas');
        const control=new OffscreenCanvas(1920,1080),controlContext=control.getContext('2d',{willReadFrequently:true});
        const assert=(ok,message)=>{if(!ok)throw Error(message);};
        // Native FFmpeg's independently frozen packet/display permutation is
        // the oracle. Decode it in this browser to keep range/color conversion
        // out of the frame-identity test; production derives order from POC.
        const planes=async(raw)=>{try{
          assert(['I420','NV12'].includes(raw.format),`unsupported plane format ${raw.format}`);
          const data=new Uint8Array(raw.allocationSize()),layout=await raw.copyTo(data),signature=[];
          for(let y=0;y<18;y++)for(let x=0;x<32;x++){
            const px=Math.floor((x+.5)*1920/32),py=Math.floor((y+.5)*1080/18),cx=Math.floor(px/2),cy=Math.floor(py/2);
            signature.push(data[layout[0].offset+py*layout[0].stride+px]);
            if(raw.format==='NV12'){const k=layout[1].offset+cy*layout[1].stride+cx*2;signature.push(data[k],data[k+1]);}
            else signature.push(data[layout[1].offset+cy*layout[1].stride+cx],data[layout[2].offset+cy*layout[2].stride+cx]);
          }return signature;
        }finally{raw.close();}};
        let nativeRefs;
        const nativeReference=async()=>{
          const {Input,BlobSource,ALL_FORMATS,EncodedPacketSink}=await import('/node_modules/mediabunny/dist/bundles/mediabunny.mjs');
          const {preferredVideoConfig}=await import('/src/decoder-policy.ts');
          const input=new Input({source:new BlobSource(new Blob([bytes])),formats:ALL_FORMATS});
          const refs=new Array(600),rank=new Array(600),pending=[];let failure,decoder;
          order.forEach((packet,index)=>rank[packet]=index);
          try{
            const track=await input.getPrimaryVideoTrack(),config=await preferredVideoConfig({...await track.getDecoderConfig(),optimizeForLatency:true});
            assert(config,'reference native configuration');
            decoder=new VideoDecoder({output(frame){const index=frame.timestamp;pending.push(planes(frame).then(sig=>{assert(!refs[index],'duplicate native reference');refs[index]=sig;}));},error(error){failure=error;}});
            decoder.configure(config);let packet=0;
            for await(const p of new EncodedPacketSink(track).packets()){
              decoder.decode(new EncodedVideoChunk({type:p.type,timestamp:rank[packet++],data:p.data}));
              await new Promise(resolve=>setTimeout(resolve,0));if(failure)throw failure;
            }
            await decoder.flush();await Promise.all(pending);if(failure)throw failure;
            assert(packet===600&&refs.filter(Boolean).length===600,'incomplete independent native reference');return refs;
          }finally{if(decoder&&decoder.state!=='closed')decoder.close();input.dispose();}
        };
        for(let round=0;round<2;round++){
          const source=await(remote?openMediaFromUrl(new URL(url,location.href).href,{name,size:bytes.byteLength,lastModified:0}):openMedia(new File([bytes],name)));
          if(source.info.decoder==='webcodecs'&&!nativeRefs)nativeRefs=await nativeReference();
          const row={remote,round,info:structuredClone(source.info),count:0,maxPixelError:0,maxGpuPixelError:0,maxNativePlaneError:0,seeks:[]};
          setPresentationGeometry(sourceCanvas,{width:640,height:360,imageWidth:1920,imageHeight:1080,zoom:1,offsetX:0,offsetY:0,dpr:1});
          const inspect=async(f,index)=>{
            try{
              assert(f.width===1920&&f.height===1080,'frame geometry');
              if(f.sample){const signature=await planes(f.sample.toVideoFrame());
                const error=Math.max(...signature.map((v,i)=>Math.abs(v-nativeRefs[index][i])));
                row.maxNativePlaneError=Math.max(row.maxNativePlaneError,error);
                assert(error===0,`frame ${index}: native planes differ from FFmpeg-order reference (max ${error})`);
              }
              // RGB differences across backends remain diagnostic. Native
              // frame identity above is exact; software retains its RGB oracle.
              // GPU readback is checked against this browser's Canvas2D output.
              if(f.sample)f.sample.draw(controlContext,0,0,1920,1080);
              else controlContext.putImageData(new ImageData(f.pixels,1920,1080),0,0);
              const pixels=controlContext.getImageData(0,0,1920,1080).data;
              paintFrame(sourceCanvas,f);const image=captureFrame(sourceCanvas);
              const gpu=image.getContext('2d').getImageData(0,0,image.width,image.height).data;
              let error=0,n=0;const signature=[];
              for(let y=0;y<18;y++)for(let x=0;x<32;x++){const k=(Math.floor((y+.5)*image.height/18)*image.width+Math.floor((x+.5)*image.width/32))*4;for(let c=0;c<3;c++){signature.push(pixels[k+c]);error+=Math.abs(pixels[k+c]-refs[index][n++]);}}
              error/=n;row.maxPixelError=Math.max(row.maxPixelError,error);
              if(!f.sample&&error>=1.3){const nearest=refs.map((r,i)=>({index:i,error:r.reduce((s,v,k)=>s+Math.abs(v-signature[k]),0)/n})).sort((a,b)=>a.error-b.error).slice(0,3);throw Error(JSON.stringify({index,error,nearest,pts:f.ptsUs,description:f.description,info:source.info}));}
              // Same tolerance as the general FATE RGB oracle. This is a
              // rendering regression, not a claim of identical colorimetry.
              let gpuError=0;
              for(let y=0;y<18;y++)for(let x=0;x<32;x++){const k=(Math.floor((y+.5)*1080/18)*1920+Math.floor((x+.5)*1920/32))*4;for(let c=0;c<3;c++)gpuError+=Math.abs(gpu[k+c]-pixels[k+c]);}
              assert(gpuError/n<3,`GPU upload ${index}: RGB difference ${gpuError/n}`);
              row.maxGpuPixelError=Math.max(row.maxGpuPixelError,gpuError/n);
              return f.ptsUs;
            }finally{f.close();}
          };
          try{
            assert(source.info.timelineSource==='hevc-poc','missing timeline recovery provenance');
            await inspect(await source.frameAt(0),0);
            const times=[];
            for await(const f of source.framesFrom(0)){
              const i=row.count++;assert(i<600,'extra frame');const pts=await inspect(f,i);
              assert(i===0||pts>times.at(-1),'non-increasing output');times.push(pts);
            }
            assert(row.count===600,`lost tail: ${row.count}/600`);
            for(const i of [0,1,63,64,65,255,256,257,599,0,300]){
              assert(await inspect(await source.frameAt(times[i]),i)===times[i],`seek ${i}`);
              if(i<599){const next=await source.framesAfter(times[i],1);assert(next.length===1,'missing successor');assert(await inspect(next[0],i+1)===times[i+1],'step target');}
              row.seeks.push(i);
            }
            assert(await inspect(await source.frameAt(source.info.durationUs-1),599)===times[599],'EOF seek');
          }finally{source.dispose();disposePresentation();}
          rows.push(row);
        }return rows;
      },{name,remote,refs,order:oracle.displayOrder});
      if(browserName==='webkit'&&process.platform==='darwin')for(const row of rows){assert.equal(row.info.decoder,'webcodecs');assert.equal(row.info.hardwareAcceleration,'prefer-hardware');}
      if(remote)assert.ok(requests.some(r=>/^bytes=/.test(r.range??'')),'Range reads');
      results.push({browserName,remote,rows});console.log(JSON.stringify(results.at(-1)));
    }finally{await page.close();}
  }}finally{await browser.close();}
}}finally{await server.close();await mkdir('.run/playback-reports',{recursive:true});await writeFile('.run/playback-reports/hevc-timeline-browser.json',JSON.stringify(results,null,2)+'\n');}
