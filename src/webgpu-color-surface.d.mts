import type { DecodedFrame } from './media.ts';
import type { PresentationGeometry } from './presentation-surface.ts';
export interface GpuSurface {
  device: unknown;
  available: boolean;
  outputTarget: 'sdr' | 'hdr';
  outputFallbackReason: string | null;
  nativeHdrAvailable: boolean;
  nativeHdrReason: string | null;
  outputConfiguration: { displayHdr: boolean; format: string; colorSpace: 'srgb' | 'display-p3'; toneMapping: 'standard' | 'extended' };
  errors: string[];
  setGeometry(geometry: PresentationGeometry | null, rotation?: number): void;
  present(frame: VideoFrame | DecodedFrame, width?: number, height?: number): void;
  captureSource(target: HTMLCanvasElement): HTMLCanvasElement;
  capture(viewport?: boolean): Promise<Uint8ClampedArray>;
  captureHdrPixels(): Promise<Float32Array>;
  clear(): void;
  dispose(): void;
}
export function createExternalSurface(canvas: HTMLCanvasElement, device?: unknown, mode?: string): Promise<GpuSurface>;
