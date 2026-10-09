/** Optional audio observes video-owned bytes; it has no file/URL read API. */
export interface CachedAudioConfig {
  codec: string;
  sampleRate: number;
  numberOfChannels: number;
  description: Uint8Array;
}
export interface CachedAudioPacket { ptsUs: number; durationUs: number; data: Uint8Array; }
export interface CachedAudioBatch { config?: CachedAudioConfig; packets: CachedAudioPacket[]; }
export interface CachedWindow { offset: number; length: number; }
export type AudioStatus = 'muted' | 'waiting' | 'playing' | 'unsupported' | 'blocked';
