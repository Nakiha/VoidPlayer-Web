import {instantiateCore} from '../../../shared/wasm/core.ts';
import { coreAssetUrl } from './core-url.ts';
export async function loadCore(glueURL: string, binary?: Uint8Array) {
  const mod = await import(/* @vite-ignore */ glueURL);
  if (!binary) {
    const url = new URL(glueURL); url.pathname = url.pathname.replace(/\.js$/, '.wasm');
    const response = await fetch(coreAssetUrl(url)); if (!response.ok) throw new Error(`WASM 下载失败：${response.status}`);
    binary = new Uint8Array(await response.arrayBuffer());
  }
  return instantiateCore(mod.default, binary);
}

