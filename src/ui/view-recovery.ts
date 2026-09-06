/** Compare the transformed image with the visible split portion in CSS pixels. */
export function needsViewRecovery(view: { width: number; height: number; imageWidth: number; imageHeight: number; zoom: number; offsetX: number; offsetY: number }, clipLeft = 0, clipRight = 1) {
  const left = view.width / 2 + view.offsetX - view.imageWidth * view.zoom / 2;
  const top = view.height / 2 + view.offsetY - view.imageHeight * view.zoom / 2;
  const width = Math.min(view.width * clipRight, left + view.imageWidth * view.zoom) - Math.max(view.width * clipLeft, left);
  const height = Math.min(view.height, top + view.imageHeight * view.zoom) - Math.max(0, top);
  return width <= 0 || height <= 0;
}
