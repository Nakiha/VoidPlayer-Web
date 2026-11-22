import { createSharpen } from './sharpen.ts';
import type { SharpenSettings } from './sharpen.ts';

export interface EnhancementSettings {
  scale: 2 | 4;
  sharpen: SharpenSettings;
}
export type EnhancementStatus =
  | { state: 'active'; width: number; height: number }
  | { state: 'unsupported' | 'overloaded' }
  | { state: 'closed' }
  | { state: 'error'; reason: string };

interface Engine {
  configureTexture(width: number, height: number): void;
  renderTexture(input: GPUTexture): GPUTexture;
  clear(): void;
  dispose(): void;
}

export interface PresentationEnhancement {
  paint(frame: object, width: number, height: number, source: (texture: GPUTexture) => void,
    display: (texture: GPUTexture) => void, retry: () => void): boolean;
  unsupported(): void;
  clear(): void;
  dispose(): void;
}

declare const GPUTextureUsage: { readonly RENDER_ATTACHMENT: number; readonly TEXTURE_BINDING: number };
const errorScopes = ['validation', 'out-of-memory', 'internal'] as const;

function gpuAction<T>(device: GPUDevice, action: () => T, settled: (reason?: string) => void) {
  for (const scope of errorScopes) device.pushErrorScope(scope);
  try { return action(); }
  finally {
    const pending = errorScopes.map(() => device.popErrorScope());
    void Promise.all(pending).then(errors => settled(errors.find(error => error)?.message),
      error => settled(error instanceof Error ? error.message : String(error)));
  }
}

function initializeGpu<T>(device: GPUDevice, action: () => T) {
  return new Promise<T>((resolve, reject) => {
    let value: T;
    value = gpuAction<T>(device, action, reason => reason ? reject(new Error(reason)) : resolve(value));
  });
}

async function loadWebSr(device: GPUDevice, scale: 2 | 4, signal: AbortSignal): Promise<Engine> {
  const { createWebSrUpscaler } = await import('./websr-engine.ts');
  signal.throwIfAborted();
  const [first, second] = await initializeGpu(device, () => [
    createWebSrUpscaler(device),
    scale === 4 ? createWebSrUpscaler(device) : undefined,
  ] as const);
  if (signal.aborted) {
    first.dispose();
    second?.dispose();
    signal.throwIfAborted();
  }
  if (!second) return first;
  return {
    configureTexture(width, height) {
      first.configureTexture(width, height);
      second.configureTexture(2 * width, 2 * height);
    },
    renderTexture(input) { return second.renderTexture(first.renderTexture(input)); },
    clear() { first.clear(); second.clear(); },
    dispose() { first.dispose(); second.dispose(); },
  };
}

export async function createPresentationEnhancement(device: GPUDevice, settings: EnhancementSettings, signal: AbortSignal,
  update: (status: EnhancementStatus) => void): Promise<PresentationEnhancement> {
  const { scale } = settings;
  const engine = await loadWebSr(device, scale, signal);
  let sharpen: ReturnType<typeof createSharpen> | undefined;
  let input: GPUTexture | undefined, base: GPUTexture | undefined, output: GPUTexture | undefined;
  let lastFrame: object | undefined, lastSharpen: SharpenSettings | undefined;
  let inFlight = 0, missed = false, overloaded = false, disposed = false, failed = false, revision = 0;
  let lastStatus = '';
  const report = (status: EnhancementStatus) => {
    const key = JSON.stringify(status);
    if (key !== lastStatus && !signal.aborted) { lastStatus = key; update(status); }
  };
  const clear = () => {
    ++revision;
    input?.destroy();
    input = base = output = undefined;
    lastFrame = lastSharpen = undefined;
    inFlight = 0;
    missed = false;
    engine.clear();
    sharpen?.clear();
  };
  const fail = (reason: string) => {
    failed = true;
    clear();
    report({ state: 'error', reason });
  };
  return {
    paint(frame, width, height, source, display, retry) {
      if (disposed || failed || overloaded || signal.aborted) return false;
      const filter = settings.sharpen;
      if (lastFrame === frame && lastSharpen === filter && output) { display(output); return true; }
      // Keep playback on the original picture after saturation. Alternating
      // between enhanced and original frames produces flicker.
      if (inFlight >= 2) {
        if (lastFrame === frame && output) { missed = true; display(output); return true; }
        overloaded = true;
        report({ state: 'overloaded' });
        return false;
      }
      const fits = width > 0 && height > 0 && Math.max(width, height) * scale <= device.limits.maxTextureDimension2D;
      if (!fits) {
        report({ state: 'error', reason: `${width}×${height} → ${width * scale}×${height * scale} · WebGPU resource limit` });
        return false;
      }
      const generation = revision;
      ++inFlight;
      try {
        gpuAction(device, () => {
          if (!input || input.width !== width || input.height !== height) {
            input?.destroy();
            input = device.createTexture({ size: [width, height], format: 'rgba8unorm',
              usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
            engine.configureTexture(width, height);
          }
          if (lastFrame !== frame || !base) {
            source(input);
            base = engine.renderTexture(input);
          }
          if (filter.strength) {
            sharpen ??= createSharpen(device);
            output = sharpen.render(base, filter);
          } else output = base;
          display(output);
          lastFrame = frame;
          lastSharpen = filter;
        }, reason => {
          if (generation !== revision) return;
          if (reason) { fail(reason); retry(); return; }
          if (!overloaded && lastFrame === frame && filter === settings.sharpen) {
            report({ state: 'active', width: width * scale, height: height * scale });
          }
        });
        void device.queue.onSubmittedWorkDone().then(() => {
          if (generation !== revision) return;
          --inFlight;
          if (overloaded && inFlight === 0) clear();
          else if (!overloaded && missed) { missed = false; retry(); }
        }, error => { if (generation === revision) { fail(String(error)); retry(); } });
        return true;
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
        return false;
      }
    },
    unsupported() { if (!overloaded) report({ state: 'unsupported' }); },
    clear,
    dispose() {
      if (disposed) return;
      disposed = true;
      clear();
      engine.dispose();
      sharpen?.dispose();
      report({ state: 'closed' });
    },
  };
}
