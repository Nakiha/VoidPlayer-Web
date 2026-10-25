/** Test-only brute windows + BigInt sufficient statistics. Independent of tile kernel. */
export function ssimOracle(reference,distorted,depth,width,height,roi) {
 const bytes=depth===8?1:2,peak=2**depth-1;
 const c1=BigInt(Math.floor(.0001*peak*peak*64+.5)),c2=BigInt(Math.floor(.0009*peak*peak*64*63+.5));
 const scores=[];let offset=0;
 for(let c=0;c<3;c++) {
  const scale=c?2:1,pw=width/scale,ph=height/scale,w=Math.floor(roi.width/scale/4)*4,h=Math.floor(roi.height/scale/4)*4;
  let score=0,windows=0;
  for(let y=0;y+8<=h;y+=4)for(let x=0;x+8<=w;x+=4) {
   let sx=0n,sy=0n,xx=0n,yy=0n,xy=0n;
   for(let dy=0;dy<8;dy++)for(let dx=0;dx<8;dx++) {
    const at=(offset+(roi.y/scale+y+dy)*pw+roi.x/scale+x+dx)*bytes;
    const a=BigInt(reference[at]+(bytes===2?reference[at+1]*256:0)),b=BigInt(distorted[at]+(bytes===2?distorted[at+1]*256:0));
    sx+=a;sy+=b;xx+=a*a;yy+=b*b;xy+=a*b;
   }
   const numerator=(2n*sx*sy+c1)*(2n*(64n*xy-sx*sy)+c2);
   const denominator=(sx*sx+sy*sy+c1)*(64n*(xx+yy)-sx*sx-sy*sy+c2);
   score+=Number(numerator)/Number(denominator);windows++;
  }
  scores.push({score:score/windows,windows,coverage:{x:roi.x,y:roi.y,width:w*scale,height:h*scale}});offset+=pw*ph;
 }
 return {y:scores[0],u:scores[1],v:scores[2],all:(4*scores[0].score+scores[1].score+scores[2].score)/6};
}
export function referencePattern(depth,width=32,height=32) {
 const count=width*height*3/2,bytes=depth===8?1:2,peak=2**depth-1,a=new Uint8Array(count*bytes),b=new Uint8Array(count*bytes);
 for(let i=0;i<count;i++) {
  const x=(i*73+Math.floor(i/width)*19+17)%(peak+1),y=i%5===0?peak-x:Math.min(peak,x+1+i%13);
  a[i*bytes]=x&255;b[i*bytes]=y&255;if(bytes===2){a[i*bytes+1]=x>>8;b[i*bytes+1]=y>>8;}
 }
 return [a,b];
}
