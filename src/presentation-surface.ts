import { createYuvSurface } from './yuv-surface.ts';
import type { FrameDescription } from './frame-description.ts';
/** A viewport-sized surface avoids rasterizing a fitted image and magnifying
 * that intermediate bitmap. Texture minification is bilinear, magnification
 * is nearest-neighbour, independent of CSS zoom and devicePixelRatio. */
export interface PresentationGeometry { width: number; height: number; imageWidth: number; imageHeight: number; zoom: number; offsetX: number; offsetY: number; dpr: number; }
export function presentationSampling(sourceWidth: number, geometry: PresentationGeometry) {
  return geometry.imageWidth * geometry.zoom * geometry.dpr > sourceWidth ? 'nearest' : 'bilinear';
}
export function createPresentationSurface(source: HTMLCanvasElement) {
  const stage = source.closest<HTMLElement>('.frame-stage');
  if (!stage) return null;
  const canvas = document.createElement('canvas'); canvas.className = 'frame-presentation'; canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', source.getAttribute('aria-label') ?? '当前视频画面');
  stage.prepend(canvas);
  const gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: false, antialias: false, preserveDrawingBuffer: true });
  const ctx = gl ? null : canvas.getContext('2d');
  let useGl=!!gl;
  canvas.addEventListener('webglcontextlost', () => {
    useGl=false;canvas.hidden=true;source.classList.remove('frame-source');
  });
  let yuv: ReturnType<typeof createYuvSurface> | null = null;
  let activeYuv=false,yuvRotation=0;
  let geometry: PresentationGeometry | null = null;
  let uploadedWidth = 0, uploadedHeight = 0;
  let sourceReady = true;
  let texture: WebGLTexture | null = null, program: WebGLProgram | null = null, buffer: WebGLBuffer | null = null;
  let position=0;
  let viewportLocation:WebGLUniformLocation|null=null,originLocation:WebGLUniformLocation|null=null,sizeLocation:WebGLUniformLocation|null=null;
  if (gl) {
    const shader = (type: number, code: string) => {
      const shader = gl.createShader(type)!; gl.shaderSource(shader, code); gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? 'Presentation shader failed');
      return shader;
    };
    const vertex = shader(gl.VERTEX_SHADER, 'attribute vec2 position; varying vec2 uv; void main(){ uv=(position+1.0)*0.5; gl_Position=vec4(position,0.0,1.0); }');
    const fragment = shader(gl.FRAGMENT_SHADER, 'precision highp float; varying vec2 uv; uniform sampler2D image; uniform vec2 viewport; uniform vec2 origin; uniform vec2 size; void main(){ vec2 p=(vec2(uv.x,1.0-uv.y)*viewport-origin)/size; if(any(lessThan(p,vec2(0.0)))||any(greaterThanEqual(p,vec2(1.0)))) discard; gl_FragColor=texture2D(image,p); }');
    program = gl.createProgram()!; gl.attachShader(program, vertex); gl.attachShader(program, fragment); gl.linkProgram(program);
    gl.deleteShader(vertex); gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('Presentation program failed');
    gl.useProgram(program);
    buffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buffer); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,3,-1,-1,3]), gl.STATIC_DRAW);
    viewportLocation=gl.getUniformLocation(program,'viewport');originLocation=gl.getUniformLocation(program,'origin');sizeLocation=gl.getUniformLocation(program,'size');
    position = gl.getAttribLocation(program, 'position'); gl.enableVertexAttribArray(position); gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    texture = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }
  function draw() {
    if (!geometry || !geometry.width || !geometry.height || (gl && !useGl)) return;
    const g = geometry, width = Math.max(1, Math.round(g.width * g.dpr)), height = Math.max(1, Math.round(g.height * g.dpr));
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    const w = g.imageWidth * g.zoom, h = g.imageHeight * g.zoom;
    const x = (g.width - w) / 2 + g.offsetX, y = (g.height - h) / 2 + g.offsetY;
    canvas.dataset.sampling = presentationSampling(source.width, g);
    if(gl && activeYuv && yuv){
      yuv.draw(null,width,height,{x:x*g.dpr,y:y*g.dpr,width:w*g.dpr,height:h*g.dpr},yuvRotation,canvas.dataset.sampling==='bilinear');
    } else if (gl && program) {
      gl.useProgram(program);gl.bindBuffer(gl.ARRAY_BUFFER,buffer);
      gl.enableVertexAttribArray(position);gl.vertexAttribPointer(position,2,gl.FLOAT,false,0,0);
      gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,texture);
      gl.viewport(0, 0, width, height); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform2f(viewportLocation, g.width, g.height);
      gl.uniform2f(originLocation, x, y); gl.uniform2f(sizeLocation, w, h);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    } else if (ctx) {
      ctx.clearRect(0, 0, width, height); ctx.imageSmoothingEnabled = canvas.dataset.sampling === 'bilinear'; ctx.imageSmoothingQuality = 'low';
      ctx.drawImage(source, x * g.dpr, y * g.dpr, w * g.dpr, h * g.dpr);
    }
  }
  function upload(input: TexImageSource | Uint8ClampedArray = source) {
    activeYuv=false;
    if (gl && useGl && !gl.isContextLost()) {
      gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,texture);
      if (input instanceof Uint8ClampedArray) {
        if (uploadedWidth === source.width && uploadedHeight === source.height) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, source.width, source.height, gl.RGBA, gl.UNSIGNED_BYTE, input);
        else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, source.width, source.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, input);
      } else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, input);
      uploadedWidth = source.width; uploadedHeight = source.height;
      sourceReady = input === source;
    }
    draw();
  }
  source.classList.add('frame-source'); upload();
  return {
    upload,
    uploadYuv(d:FrameDescription,pixels:Uint8ClampedArray,rotation=0) {
      if(!gl || !useGl || !texture || gl.isContextLost())return false;
      yuv ??= createYuvSurface(gl);
      if(!yuv.upload(d,pixels)){useGl=false;canvas.hidden=true;source.classList.remove('frame-source');return false;}
      activeYuv=true;yuvRotation=rotation;sourceReady=false;draw();return true;
    },
    get directUpload() { return useGl && !!gl && !gl.isContextLost(); },
    captureSource() {
      if (!gl || !useGl || gl.isContextLost() || sourceReady) return source;
      // Read the source texture only for explicit pixel/thumbnail requests.
      // Texture row zero is the source's top row, independent of viewport transforms.
      const previous = gl.getParameter(gl.FRAMEBUFFER_BINDING);
      if(activeYuv && yuv){
        yuv.draw(texture,source.width,source.height,{x:0,y:0,width:source.width,height:source.height},yuvRotation,false,uploadedWidth!==source.width||uploadedHeight!==source.height);
        uploadedWidth=source.width;uploadedHeight=source.height;
      }
      const framebuffer = gl.createFramebuffer();
      try {
        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('无法读取当前视频帧。');
        const pixels = new Uint8Array(source.width * source.height * 4);
        gl.readPixels(0, 0, source.width, source.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        const context = source.getContext('2d');
        if (!context) throw new Error('浏览器无法创建画布。');
        context.putImageData(new ImageData(new Uint8ClampedArray(pixels.buffer), source.width, source.height), 0, 0);
        sourceReady = true;
      } finally { gl.bindFramebuffer(gl.FRAMEBUFFER, previous); gl.deleteFramebuffer(framebuffer); }
      return source;
    },
    geometry(value: PresentationGeometry | null) { if (JSON.stringify(geometry) === JSON.stringify(value)) return; geometry = value; canvas.hidden = !value || (!!gl && !useGl); draw(); },
    dispose() { if (gl) { yuv?.dispose(); gl.deleteTexture(texture); gl.deleteBuffer(buffer); gl.deleteProgram(program); gl.getExtension('WEBGL_lose_context')?.loseContext(); } canvas.remove(); source.classList.remove('frame-source'); },
  };
}
