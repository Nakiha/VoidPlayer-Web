import type { FrameDescription } from './frame-description.ts';
import { resolveYuvColor, yuvCoefficients, validateYuv, chromaOffset } from './yuv-color.ts';

/** Source-coordinate color conversion, quantization, then viewport sampling.
 * Only explicit capture materializes a full RGB texture. Byte channels preserve
 * all 16 bits; chroma reconstruction precedes RGB minification. */
export function createYuvSurface(gl: WebGLRenderingContext) {
  const compile=(type:number,code:string)=>{
    const s=gl.createShader(type)!;gl.shaderSource(s,code);gl.compileShader(s);
    if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(s)??'YUV shader');
    return s;
  };
  const v=compile(gl.VERTEX_SHADER,'attribute vec2 position; void main(){gl_Position=vec4(position,0.0,1.0);}');
  const f=compile(gl.FRAGMENT_SHADER,`precision highp float;
    uniform sampler2D planeY; uniform sampler2D planeU; uniform sampler2D planeV;
    uniform vec2 shapeY; uniform vec2 shapeU; uniform vec2 shapeV;
    uniform vec2 outputSize; uniform vec2 visibleSize; uniform vec2 crop;
    uniform vec2 subsample; uniform vec2 chromaOrigin; uniform vec2 chromaSize; uniform float bytes; uniform float shift;
    uniform float semi; uniform float maximum; uniform float codeScale;
    uniform float fullRange; uniform vec2 coefficients; uniform float wide;
    uniform float rotation; uniform vec2 origin; uniform vec2 imageSize; uniform float direct; uniform float bilinear;
    float code(vec4 value) {
      return floor((floor(value.r*255.0+0.5)+(bytes>1.0?floor(value.a*255.0+0.5)*256.0:0.0))/shift);
    }
    vec3 linear(vec3 x){x=max(x,0.0);return mix(x/12.92,pow((x+0.055)/1.055,vec3(2.4)),step(vec3(0.04045),x));}
    vec3 encoded(vec3 x){x=max(x,0.0);return mix(x*12.92,1.055*pow(x,vec3(1.0/2.4))-0.055,step(vec3(0.0031308),x));}
    vec2 chromaAt(vec2 chroma){
      chroma=clamp(chroma,vec2(0.0),chromaSize-1.0);
      vec4 uv=texture2D(planeU,(chroma+0.5)/shapeU);
      float u; float vv;
      if(semi>0.5){
        u=floor((floor(uv.r*255.0+0.5)+(bytes>1.0?floor(uv.g*255.0+0.5)*256.0:0.0))/shift);
        vv=floor((bytes>1.0?floor(uv.b*255.0+0.5)+floor(uv.a*255.0+0.5)*256.0:floor(uv.a*255.0+0.5))/shift);
      }else {u=code(uv);vv=code(texture2D(planeV,(chroma+0.5)/shapeV));}
      return vec2(u,vv);
    }
    vec4 colorAt(vec2 pixel){
      pixel=clamp(pixel,crop,crop+visibleSize-1.0);
      vec2 pos=(pixel-chromaOrigin)/subsample,base=floor(pos),weight=fract(pos);
      vec2 uv=mix(mix(chromaAt(base),chromaAt(base+vec2(1.0,0.0)),weight.x),mix(chromaAt(base+vec2(0.0,1.0)),chromaAt(base+vec2(1.0,1.0)),weight.x),weight.y);
      float u=uv.x,vv=uv.y;
      float y=code(texture2D(planeY,(pixel+0.5)/shapeY));
      y=(y-(fullRange>0.5?0.0:16.0*codeScale))/(fullRange>0.5?maximum:219.0*codeScale);
      float cb=(u-128.0*codeScale)/(fullRange>0.5?maximum:224.0*codeScale);
      float cr=(vv-128.0*codeScale)/(fullRange>0.5?maximum:224.0*codeScale);
      float kr=coefficients.x,kb=coefficients.y,kg=1.0-kr-kb;
      vec3 rgb=vec3(y+2.0*(1.0-kr)*cr,y-2.0*kb*(1.0-kb)/kg*cb-2.0*kr*(1.0-kr)/kg*cr,y+2.0*(1.0-kb)*cb);
      if(wide>0.5){vec3 c=linear(rgb);rgb=encoded(vec3(dot(c,vec3(1.660491,-0.587641,-0.072850)),dot(c,vec3(-0.124550,1.132900,-0.008349)),dot(c,vec3(-0.018151,-0.100579,1.118730))));}
      return vec4(floor(clamp(rgb,0.0,1.0)*255.0+0.5)/255.0,1.0);
    }
    void main(){
      vec2 target=gl_FragCoord.xy;
      if(direct>0.5)target.y=outputSize.y-target.y;
      vec2 p=(target-origin)/imageSize;
      if(any(lessThan(p,vec2(0.0)))||any(greaterThanEqual(p,vec2(1.0))))discard;
      if(rotation==90.0)p=vec2(p.y,1.0-p.x);
      else if(rotation==180.0)p=1.0-p;
      else if(rotation==270.0)p=vec2(1.0-p.y,p.x);
      vec2 pixel=p*visibleSize+crop-0.5;
      if(bilinear<0.5)gl_FragColor=colorAt(floor(pixel+0.5));
      else {
        vec2 base=floor(pixel),weight=fract(pixel);
        gl_FragColor=mix(mix(colorAt(base),colorAt(base+vec2(1.0,0.0)),weight.x),mix(colorAt(base+vec2(0.0,1.0)),colorAt(base+vec2(1.0,1.0)),weight.x),weight.y);
      }
    }`);
  const program=gl.createProgram()!;gl.attachShader(program,v);gl.attachShader(program,f);gl.linkProgram(program);gl.deleteShader(v);gl.deleteShader(f);
  if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error('YUV program');
  const buffer=gl.createBuffer()!;gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,3,-1,-1,3]),gl.STATIC_DRAW);
  const textures=[gl.createTexture()!,gl.createTexture()!,gl.createTexture()!];
  const framebuffer=gl.createFramebuffer()!;
  const sizes=textures.map(()=>[0,0,0]);
  const locations=new Map(['planeY','planeU','planeV','shapeY','shapeU','shapeV','outputSize','visibleSize','crop','subsample','chromaOrigin','chromaSize','bytes','shift','semi','maximum','codeScale','fullRange','coefficients','wide','rotation','origin','imageSize','direct','bilinear'].map(name=>[name,gl.getUniformLocation(program,name)]));
  const loc=(name:string)=>locations.get(name)!;
  const position=gl.getAttribLocation(program,'position');
  const max=gl.getParameter(gl.MAX_TEXTURE_SIZE);
  let description:FrameDescription;
  return {
    upload(d:FrameDescription,pixels:Uint8ClampedArray){
      validateYuv(d,pixels.byteLength);
      const l=d.yuv!,plan=resolveYuvColor(d);
      if(!plan.supported)throw new Error('Unsupported YUV color plan');
      if(l.planes.some((p,i)=>{const channels=(l.bitDepth>8?2:1)*(i&&l.semiplanar?2:1);return p.stride%channels!==0||p.stride/channels>max||p.height>max;}))return false;
      gl.useProgram(program);gl.bindBuffer(gl.ARRAY_BUFFER,buffer);
      gl.enableVertexAttribArray(position);gl.vertexAttribPointer(position,2,gl.FLOAT,false,0,0);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT,1);gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,false);
      for(let i=0;i<3;i++){
        const p=l.planes[Math.min(i,l.planes.length-1)];
        const channels=(l.bitDepth>8?2:1)*(i&&l.semiplanar?2:1);
        const textureWidth=p.stride/channels;
        const format=channels===4?gl.RGBA:channels===2?gl.LUMINANCE_ALPHA:gl.LUMINANCE;
        const length=p.stride*p.height;
        let data=new Uint8Array(pixels.buffer,pixels.byteOffset+p.offset,Math.min(length,pixels.byteLength-p.offset));
        if(data.length<length){const padded=new Uint8Array(length);padded.set(data);data=padded;}
        gl.activeTexture(gl.TEXTURE1+i);gl.bindTexture(gl.TEXTURE_2D,textures[l.semiplanar&&i===2?1:i]);
        gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
        if(!(l.semiplanar&&i===2)){
          if(sizes[i][0]===textureWidth && sizes[i][1]===p.height && sizes[i][2]===format)gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,textureWidth,p.height,format,gl.UNSIGNED_BYTE,data);
          else {gl.texImage2D(gl.TEXTURE_2D,0,format,textureWidth,p.height,0,format,gl.UNSIGNED_BYTE,data);sizes[i]=[textureWidth,p.height,format];}
        }
        const name=['Y','U','V'][i];gl.uniform1i(loc('plane'+name),i+1);gl.uniform2f(loc('shape'+name),textureWidth,p.height);
      }
      description=d;
      return true;
    },
    draw(target:WebGLTexture|null,width:number,height:number,rect:{x:number;y:number;width:number;height:number},rotation:number,bilinear:boolean,allocate=false){
      const d=description,l=d.yuv!,plan=resolveYuvColor(d);
      gl.useProgram(program);gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.enableVertexAttribArray(position);gl.vertexAttribPointer(position,2,gl.FLOAT,false,0,0);
      for(let i=0;i<3;i++){gl.activeTexture(gl.TEXTURE1+i);gl.bindTexture(gl.TEXTURE_2D,textures[l.semiplanar&&i===2?1:i]);}
      gl.activeTexture(gl.TEXTURE0);
      if(target){
        gl.bindTexture(gl.TEXTURE_2D,target);
        if(allocate)gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,width,height,0,gl.RGBA,gl.UNSIGNED_BYTE,null);
        gl.bindFramebuffer(gl.FRAMEBUFFER,framebuffer);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,target,0);
        if(allocate && gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE)throw new Error('YUV render target incomplete');
      }else gl.bindFramebuffer(gl.FRAMEBUFFER,null);
      gl.viewport(0,0,width,height);gl.disable(gl.DITHER);gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform2f(loc('origin'),rect.x,rect.y);gl.uniform2f(loc('imageSize'),rect.width,rect.height);gl.uniform1f(loc('direct'),target?0:1);gl.uniform1f(loc('bilinear'),bilinear?1:0);
      gl.uniform2f(loc('outputSize'),width,height);gl.uniform2f(loc('visibleSize'),d.width,d.height);gl.uniform2f(loc('crop'),d.visibleRect.x,d.visibleRect.y);
      gl.uniform2f(loc('subsample'),2**l.subsampleX,2**l.subsampleY);
      gl.uniform2f(loc('chromaOrigin'),...chromaOffset(l));gl.uniform2f(loc('chromaSize'),l.planes[1].width,l.planes[1].height);
      for(const [key,value]of Object.entries({bytes:l.bitDepth>8?2:1,shift:2**l.bitShift,semi:Number(l.semiplanar),maximum:2**l.bitDepth-1,codeScale:2**(l.bitDepth-8),fullRange:Number(plan.fullRange),wide:Number(plan.primaries==='bt2020'),rotation}))gl.uniform1f(loc(key),value);
      gl.uniform2f(loc('coefficients'),...yuvCoefficients(plan.matrix));
      gl.drawArrays(gl.TRIANGLES,0,3);gl.bindFramebuffer(gl.FRAMEBUFFER,null);
    },
    dispose(){textures.forEach(t=>gl.deleteTexture(t));gl.deleteFramebuffer(framebuffer);gl.deleteBuffer(buffer);gl.deleteProgram(program);},
  };
}
