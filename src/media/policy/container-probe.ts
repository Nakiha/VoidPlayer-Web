import { RangeReader } from '../../../shared/media/io/range-reader.ts';
import type { RandomAccessInput } from '../../../shared/media/io/range-reader.ts';
import { loadAborted, onLoadAbort } from '../../../shared/media/io/media-abort.ts';

import { containerFromHeader } from '../../../shared/media/containers/container-header.ts';
import type { ContainerKind } from '../../../shared/media/containers/container-header.ts';
export { containerFromHeader };
export type { ContainerKind };

export async function probeContainer(input: RandomAccessInput, signal?: AbortSignal): Promise<ContainerKind> {
  loadAborted(signal);
  const reader = new RangeReader(input, 4096), detach = onLoadAbort(signal, () => reader.close());
  try { const bytes = await reader.read(0, Math.min(reader.size, 1024)); loadAborted(signal); return containerFromHeader(bytes); }
  finally { detach(); reader.close(); }
}
