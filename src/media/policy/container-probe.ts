import { RangeReader } from '../../../shared/media/io/range-reader.ts';
import type { RandomAccessInput } from '../../../shared/media/io/range-reader.ts';
import { loadAborted, onLoadAbort } from '../../../shared/media/io/media-abort.ts';

import { containerFromHeader, readPlaybackContainer } from '../../../shared/media/containers/container-header.ts';
import type { ContainerKind } from '../../../shared/media/containers/container-header.ts';
export { containerFromHeader };
export type { ContainerKind };

export async function probeContainer(input: RandomAccessInput, signal?: AbortSignal): Promise<ContainerKind> {
  loadAborted(signal);
  const reader = new RangeReader(input, 4096), detach = onLoadAbort(signal, () => reader.close());
  try { return await readPlaybackContainer({ size: reader.size, read: (at, length) => reader.readMetadata(at, length) }, signal); }
  finally { detach(); reader.close(); }
}
