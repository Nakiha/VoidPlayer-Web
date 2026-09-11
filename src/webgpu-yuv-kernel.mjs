// Raw-plane kernel. Apple/CV compensation is available only through explicit
// diagnostic modes, never inferred from a neutral startup probe.
export const yuvKernel = `
@group(0) @binding(0) var<storage,read> bytes:array<u32>;
@group(0) @binding(1) var<uniform> p:array<vec4f,10>;
fn byteAt(i:u32)->u32{return (bytes[i/4u]>>((i%4u)*8u))&255u;}
fn codeAt(i:u32)->f32 {var v=byteAt(i);if(p[2].x>1){v=v|(byteAt(i+1u)<<8u);}return f32(v>>u32(p[2].y));}
fn planeCode(c:u32,xy:vec2f)->f32{
 var plane=c;if(c>0u&&p[2].z>0){plane=1u;}
 let planeInfo=p[3u+plane];
 let shape=planeInfo;
 let pos=clamp(xy,vec2f(0),vec2f(f32(bitcast<u32>(shape.z)),f32(bitcast<u32>(shape.w)))-1);
 var offset=bitcast<u32>(planeInfo.x)+u32(pos.y)*bitcast<u32>(planeInfo.y)+u32(pos.x)*u32(p[2].x);
 if(c>0u&&p[2].z>0){offset=bitcast<u32>(planeInfo.x)+u32(pos.y)*bitcast<u32>(planeInfo.y)+u32(pos.x)*u32(p[2].x)*2u+select(0u,u32(p[2].x),c==2u);}
 return codeAt(offset);
}
fn component(c:u32,xy:vec2f)->f32{
 if(c==0u){return planeCode(c,xy);}
 let pos=(xy-p[9].xy)/p[1].zw;let base=floor(pos);let w=fract(pos);
 return mix(mix(planeCode(c,base),planeCode(c,base+vec2f(1,0)),w.x),mix(planeCode(c,base+vec2f(0,1)),planeCode(c,base+vec2f(1,1)),w.x),w.y);
}
fn srgb(x:vec3f)->vec3f {return select(12.92*x,1.055*pow(max(x,vec3f(0)),vec3f(1.0/2.4))-0.055,x>vec3f(0.0031308));}
fn pixelAt(xy0:vec2f)->vec3f {
 let xy=clamp(xy0,p[1].xy,p[1].xy+p[0].xy-1);
 let maxCode=p[2].w;let scale=p[6].x;let full=p[6].y>0;
 var y=(component(0u,xy)-select(16*scale,0.0,full))/select(219*scale,maxCode,full);
 var cb=(component(1u,xy)-128*scale)/select(224*scale,maxCode,full);
 var cr=(component(2u,xy)-128*scale)/select(224*scale,maxCode,full);
 if(p[7].z>0){
   y=floor(clamp(y,0.0,1.0)*255.0)/255.0;
   cb=(floor(clamp(cb*255.0+128.0,0.0,255.0)+0.5)-127.5)/255.0;
   cr=(floor(clamp(cr*255.0+128.0,0.0,255.0)+0.5)-127.5)/255.0;
 }
 let kr=p[6].z;let kb=p[6].w;let kg=1-kr-kb;
 var rgb=vec3f(y+2*(1-kr)*cr,y-2*kb*(1-kb)/kg*cb-2*kr*(1-kr)/kg*cr,y+2*(1-kb)*cb);
 if(p[7].x>0||p[0].z>0){
   var c=select(max(rgb,vec3f(0))/12.92,pow((max(rgb,vec3f(0))+0.055)/1.055,vec3f(2.4)),rgb>vec3f(0.04045));
   if(p[7].x>0){c=sign(rgb)*pow(abs(rgb),vec3f(p[7].x));}
   if(p[0].z==1){c=vec3f(dot(c,vec3f(0.93954206,0.05018136,0.01027658)),dot(c,vec3f(0.01777222,0.96579286,0.01643491)),dot(c,vec3f(-0.00162160,-0.00436975,1.00599135)));}
   else if(p[0].z==2){c=vec3f(1.04404321*c.r-0.04404321*c.g,c.g,0.01179338*c.g+0.98820662*c.b);}
   else if(p[0].z==3){c=vec3f(dot(c,vec3f(1.660491,-0.587641,-0.072850)),dot(c,vec3f(-0.124550,1.132900,-0.008349)),dot(c,vec3f(-0.018151,-0.100579,1.118730)));}
   rgb=srgb(c);
 }
 return clamp(rgb,vec3f(0),vec3f(1));
}
struct V{@builtin(position) pos:vec4f,@location(0) uv:vec2f}
@vertex fn vs(@builtin(vertex_index)i:u32)->V{
 var v=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));var o:V;o.pos=vec4f(v[i],0,1);o.uv=vec2f((v[i].x+1)*0.5,(1-v[i].y)*0.5);return o;
}
@fragment fn fs(v:V)->@location(0) vec4f{
 var uv=(v.pos.xy-p[8].xy)/p[8].zw;
 if(any(uv<vec2f(0))||any(uv>=vec2f(1))){discard;}
 if(p[7].w==90){uv=vec2f(uv.y,1-uv.x);}else if(p[7].w==180){uv=1-uv;}else if(p[7].w==270){uv=vec2f(1-uv.y,uv.x);}
 let xy=uv*p[0].xy+p[1].xy-0.5;
 if(p[7].y>0){let a=floor(xy);let w=fract(xy);return vec4f(mix(mix(pixelAt(a),pixelAt(a+vec2f(1,0)),w.x),mix(pixelAt(a+vec2f(0,1)),pixelAt(a+vec2f(1,1)),w.x),w.y),1);}
 return vec4f(pixelAt(floor(xy+0.5)),1);
}`;
