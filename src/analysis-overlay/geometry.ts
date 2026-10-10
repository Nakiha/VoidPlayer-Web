import { presentationRect } from "../presentation-surface.ts";
import type { PresentationGeometry } from "../presentation-surface.ts";
import type { PresentedFrameToken } from "../bitstream-analysis/contract.ts";
export function codedToViewport(
  x: number,
  y: number,
  token: PresentedFrameToken,
  g: PresentationGeometry,
) {
  const crop = token.geometry.visibleRect,
    rect = presentationRect(g);
  let u = (x - crop.x) / crop.width,
    v = (y - crop.y) / crop.height;
  switch (token.geometry.rotation) {
    case 90:
      [u, v] = [1 - v, u];
      break;
    case 180:
      [u, v] = [1 - u, 1 - v];
      break;
    case 270:
      [u, v] = [v, 1 - u];
      break;
  }
  return { x: rect.x + u * rect.width, y: rect.y + v * rect.height };
}
export function viewportToCoded(
  x: number,
  y: number,
  token: PresentedFrameToken,
  g: PresentationGeometry,
) {
  const rect = presentationRect(g),
    crop = token.geometry.visibleRect;
  let u = (x - rect.x) / rect.width,
    v = (y - rect.y) / rect.height;
  switch (token.geometry.rotation) {
    case 90:
      [u, v] = [v, 1 - u];
      break;
    case 180:
      [u, v] = [1 - u, 1 - v];
      break;
    case 270:
      [u, v] = [1 - v, u];
      break;
  }
  return { x: crop.x + u * crop.width, y: crop.y + v * crop.height };
}
