import { buildInfo } from '../../build-info.ts';

/** Exact asset bytes identify each URL, including glue and manifests. */
export function coreAssetUrl(input: string | URL, base?: string) {
  const url = new URL(input, base);
  if (typeof location !== 'undefined' && url.origin !== location.origin) return url.href;
  const digest = buildInfo?.coreAssetDigests?.[url.pathname];
  if (digest) url.searchParams.set('v', digest);
  return url.href;
}
