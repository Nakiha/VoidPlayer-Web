import { FFMPEG_INDEX_SCHEMA } from './ffmpeg-index-cache.ts';
export type MediaIndexKind = 'flv' | 'ffmpeg';

export interface MediaIndexIdentity {
  kind: MediaIndexKind;
  streamKey: string;
  schemaVersion: number;
  indexerBuild: string;
}

export const FLV_INDEXER_BUILD = 'flv-demux-v3';
export const FLV_MEDIA_INDEX_IDENTITY: MediaIndexIdentity = {
  kind: 'flv',
  streamKey: 'video:0',
  schemaVersion: 3,
  indexerBuild: FLV_INDEXER_BUILD,
};

export function mediaIndexIdentityKey(identity: MediaIndexIdentity): string {
  return [identity.kind, identity.streamKey, identity.schemaVersion, identity.indexerBuild].join('\u001f');
}

export function parseMediaIndexIdentity(kind: string, params: URLSearchParams): MediaIndexIdentity {
  if (kind !== 'flv' && kind !== 'ffmpeg') throw new Error('未知帧索引类型。');
  const streamKey = params.get('stream') ?? '';
  const schemaVersion = Number(params.get('schema'));
  const indexerBuild = params.get('indexer') ?? '';
  if (!/^video:(?:0|[1-9][0-9]{0,2})$/.test(streamKey)
    || !Number.isSafeInteger(schemaVersion) || schemaVersion < 1 || schemaVersion > 100
    || !/^[a-zA-Z0-9._-]{1,80}$/.test(indexerBuild)) throw new Error('帧索引身份参数无效。');
  if (kind === 'flv' && (streamKey !== FLV_MEDIA_INDEX_IDENTITY.streamKey
    || schemaVersion !== FLV_MEDIA_INDEX_IDENTITY.schemaVersion
    || indexerBuild !== FLV_MEDIA_INDEX_IDENTITY.indexerBuild)) throw new Error('FLV 索引版本不受支持。');
  if (kind === 'ffmpeg' && (schemaVersion !== FFMPEG_INDEX_SCHEMA || !/^[a-f0-9]{40}$/.test(indexerBuild))) throw new Error('FFmpeg 索引版本不受支持。');
  return { kind, streamKey, schemaVersion, indexerBuild };
}
