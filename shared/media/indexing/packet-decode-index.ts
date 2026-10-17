import type {FlvIndex,FlvPacket} from '../containers/flv-demux.ts';
export type PacketDecodePacket = Omit<FlvPacket, 'dts'> & { dts: number | null; identityKnown?: boolean };
export type PacketDecodeIndex = Omit<FlvIndex, 'packets' | 'codec'> & { codec: FlvIndex['codec'] | 'vp8' | 'vp9' | 'ffv1' | 'mpeg2video' | 'mpeg4' | 'mjpeg' | 'prores'; codecParameters?:import('../containers/matroska-clocks.ts').PacketCodecParameters; codecConfigurations?:import('../containers/matroska-clocks.ts').PacketCodecParameters[]; packets: PacketDecodePacket[] };
