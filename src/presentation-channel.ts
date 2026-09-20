/** Presentation-only YUV channel isolation state. The viewport owns the
 * user-facing value (snapshot/agent/workspace); presentation backends read
 * this global at paint time so geometry-only redraws stay consistent without
 * threading a parameter through session draw callbacks. */
export type PresentationChannel = 'rgb' | 'y' | 'u' | 'v';

let current: PresentationChannel = 'rgb';

export const getPresentationChannel = (): PresentationChannel => current;

export function setPresentationChannel(channel: PresentationChannel) {
  if (!['rgb', 'y', 'u', 'v'].includes(channel)) throw new Error('通道模式必须是 rgb、y、u 或 v。');
  current = channel;
}

/** Shader code: 0 = RGB, 1 = Y, 2 = U, 3 = V. */
export const presentationChannelCode = (channel: PresentationChannel): number =>
  channel === 'y' ? 1 : channel === 'u' ? 2 : channel === 'v' ? 3 : 0;
