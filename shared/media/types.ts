import type { FrameDescription } from './frame-description.ts';
import type { ColorInfo } from '../color/color-info.ts';
import type { PresentationInfo } from '../presentation/presentation-info.ts';

export type FrameInfo = { ptsUs: number; sourcePtsUs: number; durationUs: number };
export type MediaInfo = {
  trackMetadata?: import('./containers/cached-track-metadata.ts').CachedTrackMetadata;
  opportunisticAudio?: 'flv-aac' | 'cached-container';
  jsIndexReused?:boolean;
  jsIndexPacketsScanned?:number;
  demuxBackend?:string;
  indexBackend?:string;
  container?: 'flv' | 'isobmff' | 'mpegts' | 'matroska' | 'other';
  indexKind?: 'packet-offsets' | 'packet-locators' | 'timestamps' | 'container';
  seekStrategy?: 'packet-anchor' | 'demuxer-keyframe' | 'demuxer-timestamp' | 'browser';
  seekAnchorCount?: number;
  metadataRevision?:number;
  /** Description of the currently presented frame; prefetch never updates it. */
  output?:FrameDescription;
  presentation?: PresentationInfo;
  indexSource?: 'client' | 'server';
  indexState?: 'building' | 'complete' | 'error';
  indexError?: string;
  /** Exclusive end of the stable, seekable timeline prefix while indexing. */
  stableCoverageUs?: number;
  indexProgress?: { scannedBytes: number; totalBytes: number; packets: number };
  indexWaiting?: boolean;
  indexWarning?: string;
  /** Index completion does not certify an undamaged, fully covered source. */
  indexIntegrity?: import('./indexing/index-integrity.ts').IndexIntegrity;
  indexTruncatedAt?: number;
  /** Explicit recovery provenance; original packet timestamps remain in the demux index. */
  timelineSource?: 'hevc-poc';
  id: string; name: string; size: number; lastModified: number;
  source?: { kind: 'library'; id: string; url: string };
  coreVariant?: 'single-thread' | 'multi-thread';
  /** Requested WebCodecs preference; does not attest actual hardware use. */
  hardwareAcceleration?: 'prefer-hardware' | 'no-preference';
  codec: string; decoder: 'webcodecs' | 'ffmpeg-wasm'; width: number; height: number; durationUs: number; firstPtsUs: number;
  color?: ColorInfo;
  colorSource?: 'container' | 'decoder';
  /** Source decoder format before conversion to presentation RGBA (FFmpeg). */
  pixelFormat?: string | null;
  /** Browser output buffer layout; may differ from the encoded source format. */
  decodedPixelFormat?: string | null;
};
