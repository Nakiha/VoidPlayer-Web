import type { DecodedFrame } from './media.ts';
import type { PresentationGeometry } from './presentation-surface.ts';
export interface GpuSurface {
  device: unknown;
  available: boolean;
  errors: string[];
  setGeometry(geometry: PresentationGeometry | null, rotation?: number): void;
  present(frame: VideoFrame | DecodedFrame, width?: number, height?: number): void;
  captureSource(target: HTMLCanvasElement): HTMLCanvasElement;
  capture(viewport?: boolean): Promise<Uint8ClampedArray>;
  clear(): void;
  dispose(): void;
}
export function createExternalSurface(canvas: HTMLCanvasElement, device?: unknown, mode?: string): Promise<GpuSurface>;
