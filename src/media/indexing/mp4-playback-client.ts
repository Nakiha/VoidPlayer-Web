import { MediaIndexClient } from './media-index-client.ts';
import { MP4_PLAYBACK_MEDIA_INDEX_IDENTITY } from '../../../shared/media/indexing/media-index-identity.ts';
import { MP4_PLAYBACK_INDEX_BYTES, parseMp4Playback } from '../../../shared/media/indexing/mp4-playback-index.ts';
import { MediaOpenError } from '../../../shared/media/io/media-errors.ts';
import { onLoadAbort } from '../../../shared/media/io/media-abort.ts';
import type { RandomAccessInput } from '../../../shared/media/io/range-reader.ts';

export async function loadLibraryMp4Playback(input: Extract<RandomAccessInput, { url: string }>, signal: AbortSignal, onIndex?: () => void) {
  signal.throwIfAborted();
  const identity = MP4_PLAYBACK_MEDIA_INDEX_IDENTITY;
  const client = new MediaIndexClient(input.url, identity.kind, MP4_PLAYBACK_INDEX_BYTES + 1024, 120000, true, identity, onIndex);
  const detach = onLoadAbort(signal, () => client.close());
  try {
    onIndex?.();
    const value = await client.read();
    signal.throwIfAborted();
    if (!value) {
      const failure = client.failureReason;
      throw new MediaOpenError('input', failure ? `${failure.message}${failure.status ? `（HTTP ${failure.status}）` : ''}` : '服务端 MP4 播放索引不可用。');
    }
    return parseMp4Playback(value, input.size, `${input.library!.id}@${input.library!.version}`);
  } finally { detach(); client.close(); }
}
