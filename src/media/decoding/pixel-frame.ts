import type { DecodedFrame } from '../contract.ts';

/** All readers share immutable pixels. Recycle the buffer only after the last
 * independently closable handle, including a presentation hold, is released. */
export function sharePixelFrame<T extends DecodedFrame>(frame: T): T {
  if (!frame.pixels) return frame;
  let references = 0;
  const handle = (snapshot:T): T => {
    references++;
    let closed = false;
    const result:T = {...snapshot,
      retain(this:T) {
        if (closed) throw Error('Cannot retain a closed pixel frame');
        return handle(this);
      },
      close() {
        if (closed) return;
        closed = true;
        if (--references === 0) frame.close();
      },
    };
    return result;
  };
  return handle(frame);
}
