import { WorkerRpc } from '../../src/worker-rpc.ts';
import { workerReply } from '../../src/worker-protocol.ts';
import type { FfmpegCommands, PacketCommands, WorkerRequest } from '../../src/worker-protocol.ts';

// Compiled by build and the registered contract test; never executed.
export function workerProtocolTypeChecks(ffmpeg: WorkerRpc, packet: WorkerRpc<PacketCommands>) {
  const frame: Promise<FfmpegCommands['extract']['response']> = ffmpeg.call('extract', { ctx: 1, index: 0 });
  const rank: Promise<PacketCommands['analysis-rank']['response']> = packet.call('analysis-rank', { axis: 'pts', tUs: 0 });
  void [frame, rank];
  // @ts-expect-error Unknown commands must not cross the transport.
  ffmpeg.call('not-a-command', {});
  // @ts-expect-error Packet-only commands are not FFmpeg commands.
  ffmpeg.call('analysis-number', { axis: 'pts', number: 0 });
  // @ts-expect-error Extraction needs its context and index.
  ffmpeg.call('extract', { ctx: 1 });
  // @ts-expect-error Prepare must carry its source input.
  packet.call('prepare', {});
  // @ts-expect-error Payload field types follow the command.
  packet.call('at', { pts: 'zero' });
  // @ts-expect-error A caller cannot choose an arbitrary response type.
  ffmpeg.call<number>('extract', { ctx: 1, index: 0 });
  // @ts-expect-error The command returns a frame, not a number.
  const wrongResult: Promise<number> = ffmpeg.call('extract', { ctx: 1, index: 0 });
  void wrongResult;
  const reply = workerReply<PacketCommands>();
  const request: WorkerRequest<PacketCommands, 'analysis-number'> = { id: 1, type: 'analysis-number', axis: 'pts', number: 0 };
  reply({ id: 2, type: 'native' }, null);
  reply({ id: 3, type: 'dispose' }, null);
  reply(request, 42);
  reply(request, null);
  // @ts-expect-error A responder cannot return a rank object for a number query.
  reply(request, { rank: 1, total: 2, ordinal: 0 });
  const wasmReply = workerReply<FfmpegCommands>();
  // @ts-expect-error An extraction response must contain its frame descriptor and pixels.
  wasmReply({ id: 1, type: 'extract', ctx: 1, index: 0 }, { pixels: new ArrayBuffer(0) });
}
