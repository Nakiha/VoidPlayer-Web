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
  let geometry: PresentationGeometry | null = null;
  let uploadedWidth = 0, uploadedHeight = 0;
  let texture: WebGLTexture | null = null, program: WebGLProgram | null = null, buffer: WebGLBuffer | null = null;
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
    const position = gl.getAttribLocation(program, 'position'); gl.enableVertexAttribArray(position); gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    texture = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }
  function draw() {
    if (!geometry || !geometry.width || !geometry.height) return;
    const g = geometry, width = Math.max(1, Math.round(g.width * g.dpr)), height = Math.max(1, Math.round(g.height * g.dpr));
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    const w = g.imageWidth * g.zoom, h = g.imageHeight * g.zoom;
    const x = (g.width - w) / 2 + g.offsetX, y = (g.height - h) / 2 + g.offsetY;
    canvas.dataset.sampling = presentationSampling(source.width, g);
    if (gl && program) {
      gl.viewport(0, 0, width, height); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform2f(gl.getUniformLocation(program, 'viewport'), g.width, g.height);
      gl.uniform2f(gl.getUniformLocation(program, 'origin'), x, y); gl.uniform2f(gl.getUniformLocation(program, 'size'), w, h);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    } else if (ctx) {
      ctx.clearRect(0, 0, width, height); ctx.imageSmoothingEnabled = canvas.dataset.sampling === 'bilinear'; ctx.imageSmoothingQuality = 'low';
      ctx.drawImage(source, x * g.dpr, y * g.dpr, w * g.dpr, h * g.dpr);
    }
  }
  function upload(input: TexImageSource | Uint8ClampedArray = source) {
    if (gl) {
      if (input instanceof Uint8ClampedArray) {
        if (uploadedWidth === source.width && uploadedHeight === source.height) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, source.width, source.height, gl.RGBA, gl.UNSIGNED_BYTE, input);
        else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, source.width, source.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, input);
      } else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, input);
      uploadedWidth = source.width; uploadedHeight = source.height;
    }
    draw();
  }
  source.classList.add('frame-source'); upload();
  return {
    upload,
    geometry(value: PresentationGeometry | null) { if (JSON.stringify(geometry) === JSON.stringify(value)) return; geometry = value; canvas.hidden = !value; draw(); },
    dispose() { if (gl) { gl.deleteTexture(texture); gl.deleteBuffer(buffer); gl.deleteProgram(program); gl.getExtension('WEBGL_lose_context')?.loseContext(); } canvas.remove(); source.classList.remove('frame-source'); },
  };
}
