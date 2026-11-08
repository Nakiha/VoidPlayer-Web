export interface PresentationGeometry { width: number; height: number; imageWidth: number; imageHeight: number; zoom: number; offsetX: number; offsetY: number; dpr: number; }
export function presentationRect(g:PresentationGeometry){const width=g.imageWidth*g.zoom,height=g.imageHeight*g.zoom;return {x:(g.width-width)/2+g.offsetX,y:(g.height-height)/2+g.offsetY,width,height};}
export function presentationSampling(sourceWidth: number, geometry: PresentationGeometry) {
  return geometry.imageWidth * geometry.zoom * geometry.dpr > sourceWidth ? 'nearest' : 'bilinear';
}
