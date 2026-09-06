import assert from 'node:assert/strict';
import { webkit, chromium } from 'playwright';
import path from 'node:path';
import { createMediaServer } from '../server/app.ts';
const root = path.resolve(import.meta.dirname, '..');
const server = createMediaServer({roots:[path.join(root,'fixtures/video')],staticDir:path.join(root,'dist'),onLog(){}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser = await (process.argv[2] === 'chromium' ? chromium : webkit).launch({headless:true});
try {
 const page = await browser.newPage({ viewport:{width:1408,height:789}, deviceScaleFactor:2 });
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`http://127.0.0.1:${server.address().port}/`);
 await page.evaluate(async()=>{const tool=n=>window.voidPlayer.tools.find(t=>t.name===n);const lib=await tool('list_library').execute({});for(const [slot,name]of [['A','av1_10s_1920x1080.webm'],['B','ffv1_yuv422p_8bit.mkv']]) await tool('load_library_item').execute({slot,id:lib.entries.find(e=>e.name===name).id});});
 await page.locator('#toggle-sources').click();
 await page.evaluate(()=>window.voidPlayer.setViewport({zoom:4.568,offsetX:-52,offsetY:-81}));
 await page.locator('.brand').click(); await page.keyboard.press('n');
 await page.locator('[data-drawing-tool=rect]').click();
 const b=await page.locator('#image-B').boundingBox();
 await page.mouse.move(b.x+b.width*.25,b.y-b.height*.2);await page.mouse.down();await page.mouse.move(b.x+b.width*.6,b.y+b.height*1.2,{steps:10});await page.mouse.up();
 for(const [zoom,offsetX,offsetY]of [[5.26,-48,-82],[10.653,-50,-86],[11.354,-51,-86],[8.721,-50,-84],[11.995,-46,-71],[8.142,261,-74],[6.435,245,-67],[3.135,158,-53],[7.142,-45,-97],[12.988,93,-82],[5.872,-54,-76]]){
  await page.evaluate(p=>window.voidPlayer.setViewport(p),{zoom,offsetX,offsetY});
  await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  const sample = await page.evaluate(()=>{
    const c=document.querySelector('#stage-A .frame-presentation'),r=c.getBoundingClientRect(),gl=c.getContext('webgl');
    const x=Math.floor(r.left+r.width/2),y=Math.floor(r.top+r.height/2),p=new Uint8Array(4);
    gl.readPixels(Math.round((x-r.left)*devicePixelRatio),c.height-Math.round((y-r.top)*devicePixelRatio)-1,1,1,gl.RGBA,gl.UNSIGNED_BYTE,p);
    const handle=document.querySelector('#drawing-B [data-corner=nw] ellipse:last-child').getBoundingClientRect();
    return {x,y,pixel:[...p],error:gl.getError(),lost:gl.isContextLost(),handleWidth:handle.width,handleHeight:handle.height};
  });
  assert.equal(sample.error,0);assert.equal(sample.lost,false);assert.equal(sample.pixel[3],255);
  assert.ok(Math.abs(sample.handleWidth-9)<.1 && Math.abs(sample.handleHeight-9)<.1,'handles keep their screen size');
  const png=await page.screenshot({clip:{x:sample.x,y:sample.y,width:1,height:1}});
  const displayed=await page.evaluate(async bytes=>{const b=await createImageBitmap(new Blob([new Uint8Array(bytes)],{type:'image/png'}));const c=document.createElement('canvas');c.width=b.width;c.height=b.height;const ctx=c.getContext('2d');ctx.drawImage(b,0,0);b.close();return [...ctx.getImageData(0,0,1,1).data];},[...png]);
  assert.ok(displayed.every((v,i)=>Math.abs(v-sample.pixel[i])<=3),`visible AV1 differs from decoded presentation at ${zoom}: ${displayed} / ${sample.pixel}`);

 }
 if(process.env.ANNOTATION_SCREENSHOT) await page.screenshot({path:process.env.ANNOTATION_SCREENSHOT});
 const alignment=await page.evaluate(()=>{
  const svg=document.querySelector('#drawing-B'),d=window.voidPlayer.getState().marks[0].drawings[0],m=svg.getScreenCTM(),image=document.querySelector('#image-B').getBoundingClientRect();
  return {parent:svg.parentElement.id,dx:Math.abs(m.a*d.points[0].x*1000+m.e-image.left-d.points[0].x*image.width),dy:Math.abs(m.d*d.points[0].y*1000/(320/180)+m.f-image.top-d.points[0].y*image.height)};
 });
 assert.equal(alignment.parent,'stage-B');assert.ok(alignment.dx<1 && alignment.dy<1,'annotation follows source coordinates');
 await page.locator('[data-drawing-tool=select]').click();
 const shape=await page.locator('#drawing-B .annotation-object').first().boundingBox();
 await page.mouse.move(shape.x+shape.width*.4,shape.y);await page.mouse.down();await page.mouse.move(shape.x+shape.width*.4+12,shape.y+8,{steps:8});await page.mouse.up();
 await page.locator('#drawing-undo').click();
 const toolbar=await page.locator('#annotation-toolbar').boundingBox(),viewport=await page.locator('.viewport-surface').boundingBox();
 assert.ok(toolbar.x>=viewport.x && toolbar.x+toolbar.width<=viewport.x+viewport.width,'toolbar stays inside viewport');
 assert.equal(await page.locator('#annotation-toolbar').evaluate(e=>e.parentElement.classList.contains('viewport-surface')),true);
 assert.ok(toolbar.height<60,'single toolbar row');
 // The grid must not change any of the video pixels in final compositing.
 const crop=await page.locator('#stage-A').boundingBox();
 const clip={x:crop.x+20,y:crop.y+60,width:Math.floor(crop.width)-40,height:Math.floor(crop.height)-180};
 const withGrid=await page.screenshot({clip});
 await page.locator('#grid-A').evaluate(e=>e.style.visibility='hidden');
 const withoutGrid=await page.screenshot({clip});
 assert.deepEqual(withGrid,withoutGrid,'background grid leaked over video');
 await page.locator('#grid-A').evaluate(e=>e.style.visibility='');
 await checkWorkspace(browser, `http://127.0.0.1:${server.address().port}/`);
 assert.deepEqual(errors,[]);
 console.log(`PASS ${process.argv[2]??'webkit'}: DPR 2 log replay, actual video pixels, grid compositing, constant round handles, zoomed editing, viewport toolbar`);

}finally{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));}


async function checkWorkspace(browser, url) {
 const page = await browser.newPage({viewport:{width:1408,height:789},deviceScaleFactor:2});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(url);
 await page.evaluate(async()=>{const tool=n=>window.voidPlayer.tools.find(t=>t.name===n);const lib=await tool('list_library').execute({});for(const [slot,name]of [['A','av1_10s_1920x1080.webm'],['B','ffv1_yuv422p_8bit.mkv']]) await tool('load_library_item').execute({slot,id:lib.entries.find(e=>e.name===name).id});});
 const state=()=>page.evaluate(()=>window.voidPlayer.tools.find(t=>t.name==='get_review_session').execute({}));
 const zoom=async value=>{await page.evaluate(zoom=>window.voidPlayer.setViewport({zoom,offsetX:0,offsetY:0}),value);await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));};
 const drag=async(a,b)=>{await page.mouse.move(...a);await page.mouse.down();await page.mouse.move(...b,{steps:10});await page.mouse.up();};
 await zoom(1);
 const stage=await page.locator('#stage-B').boundingBox(),image=await page.locator('#image-B').boundingBox();
 const first={x:image.x-20,y:image.y-70,width:80,height:140};
 await page.mouse.click(stage.x+30,stage.y+100);
 assert.equal(await page.locator('#annotation-toolbar').isVisible(),false,'plain clicks do not open an editor or create a mark');
 // No annotate-button entry: eight handles must be present during the first drag.
 await page.mouse.move(first.x,first.y);await page.mouse.down();await page.mouse.move(first.x+first.width,first.y+first.height,{steps:8});
 assert.equal(await page.locator('#drawing-B [data-corner]').count(),8,'first live drag uses the same eight round handles');
 assert.equal(await page.locator('[id^=region-]').count(),0,'old blue region overlay is removed');
 await page.mouse.up();
 let shapes=(await state()).marks.flatMap(m=>m.drawings);
 assert.equal(shapes.length,1);assert.ok(shapes[0].points[0].x<0 && shapes[0].points[0].y<0,'creation is allowed outside the video');
 const original=structuredClone(shapes[0]);
 const deselect=async()=>{await page.locator('[data-drawing-tool=select]').click();await page.mouse.click(stage.x+30,stage.y+100);};
 await deselect();
 await drag([first.x+40,first.y+40],[first.x+55,first.y+50]);
 assert.ok((await state()).marks[0].drawings[0].points[0].x>original.points[0].x,'rectangle interior selects and moves');
 await page.locator('#drawing-undo').click();
 await deselect();await page.mouse.click(first.x-7,first.y+40);
 assert.equal(await page.locator('#drawing-B [data-corner]').count(),8,'near a thin border is selectable');
 const handle=await page.locator('#drawing-B [data-corner=e]').boundingBox();
 await drag([handle.x+handle.width/2,handle.y+handle.height/2],[image.x+image.width+40,handle.y+handle.height/2]);
 assert.ok((await state()).marks[0].drawings[0].points[1].x>1,'resize continues beyond source bounds');
 await page.locator('#drawing-undo').click();
 await page.locator('#mark-close').click();
 assert.equal(await page.locator('#annotations-B').evaluate(e=>getComputedStyle(e).clipPath),'none');
 // Final composited pixels, not just SVG attributes, must contain the ink in the margin.
 async function redWidth(x,y) {
   const png=await page.screenshot({clip:{x:Math.floor(x)-10,y:Math.floor(y),width:20,height:1}});
   return page.evaluate(async bytes=>{const bitmap=await createImageBitmap(new Blob([new Uint8Array(bytes)],{type:'image/png'}));const c=document.createElement('canvas');c.width=bitmap.width;c.height=bitmap.height;const ctx=c.getContext('2d');ctx.drawImage(bitmap,0,0);bitmap.close();const pixels=ctx.getImageData(0,0,c.width,1).data;let red=0;for(let i=0;i<pixels.length;i+=4)if(pixels[i]>190 && pixels[i+1]<130 && pixels[i+2]<130)red++;return red/devicePixelRatio;},[...png]);
 }
 assert.ok(await redWidth(first.x,first.y+30)>=3,'saved stroke renders outside the video');
 await page.locator('.brand').click(); await page.keyboard.press('n');await deselect();await page.mouse.click(first.x+40,first.y+40);
 assert.equal(await page.locator('#drawing-B [data-corner]').count(),8,'out-of-frame object can be reopened');
 // A drawing tool must still create nested objects despite the enlarged hit area.
 await page.locator('[data-drawing-tool=rect]').click();await drag([first.x+15,first.y+20],[first.x+50,first.y+60]);
 assert.equal((await state()).marks[0].drawings.length,2);await page.locator('#drawing-undo').click();
 await zoom(5);await page.locator('[data-drawing-tool=rect]').click();
 const five=await page.locator('#image-B').boundingBox();
 await drag([five.x+five.width*.8,five.y-50],[Math.min(stage.x+stage.width-20,five.x+five.width+30),five.y+40]);
 await zoom(10);
 const ten=await page.locator('#image-B').boundingBox();
 await drag([ten.x+ten.width/2-80,ten.y+40],[ten.x+ten.width/2+80,ten.y+120]);
 shapes=(await state()).marks.flatMap(m=>m.drawings);
 assert.equal(shapes.length,3);assert.deepEqual(shapes.map(d=>d.strokeWidth),[4,4,4],'creation zoom does not enter stroke style');
 for(const value of [1,5,10,1]) {
   await zoom(value);await deselect();
   for(const node of await page.locator('#drawing-B .annotation-object').all()) {
     assert.equal(await node.getAttribute('stroke-width'),'4');assert.equal(await node.getAttribute('vector-effect'),'non-scaling-stroke');
   }
 }
 // Both differently-created rectangles have the same four-pixel visible stroke.
 const rects=await page.locator('#drawing-B .annotation-object').evaluateAll(nodes=>nodes.map(n=>n.getBoundingClientRect().toJSON()));
 for(const rect of rects.slice(0,2)) {const measured=await redWidth(rect.left,rect.top+rect.height*.25);assert.ok(measured>=3 && measured<=5,`visible stroke is ${measured}px, expected 4px`);}
 const exported=await page.evaluate(()=>window.voidPlayer.tools.find(t=>t.name==='export_review').execute({}));
 assert.ok(JSON.stringify(exported).includes('strokeWidth'),'export retains fixed screen styles');
 assert.deepEqual(errors,[]);
 await page.close();
 console.log('PASS annotation workspace: first-drag handles, interior/edge hits, margin creation/move/resize/reopen, nested drawing, CSS stroke pixels across zooms');
}
