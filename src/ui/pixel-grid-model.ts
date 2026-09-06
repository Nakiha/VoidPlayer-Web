export type GridView = {
  width: number; height: number;
  imageWidth: number; imageHeight: number; sourceWidth: number; sourceHeight: number;
  zoom: number; panX: number; panY: number;
};

/** A cell always represents 320×320 source pixels, at every resolution and zoom. */
export function pixelGrid(view: GridView) {
  if (!Object.values(view).every(Number.isFinite) || view.width <= 0 || view.height <= 0 ||
    view.sourceWidth <= 0 || view.sourceHeight <= 0 || view.imageWidth <= 0 || view.imageHeight <= 0 || view.zoom <= 0) return null;
  const scale = view.imageWidth * view.zoom / view.sourceWidth;
  const cellWidth = 320, cellHeight = 320;
  const spacingX = cellWidth * scale, spacingY = cellHeight * scale;
  const originX = view.width / 2 + view.panX - view.imageWidth * view.zoom / 2;
  const originY = view.height / 2 + view.panY - view.imageHeight * view.zoom / 2;
  const modulo = (n: number, spacing: number) => ((n % spacing) + spacing) % spacing;
  return { cellWidth, cellHeight, spacingX, spacingY, startX: modulo(originX, spacingX), startY: modulo(originY, spacingY), scale,
    label: `${view.sourceWidth}×${view.sourceHeight}` };
}
