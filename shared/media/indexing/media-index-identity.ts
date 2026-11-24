import { ANNEX_B_PACKET_BUILD } from './annex-b-index.ts';
import type { JsPacketFormat, JsPacketIndex } from '../containers/matroska-packet-index.ts';
import { TS_PACKET_BUILD } from './ts-packet-index.ts';
import {MATROSKA_PACKET_BUILD} from '../containers/matroska-packet-index.ts';
import { FFMPEG_INDEX_SCHEMA } from './ffmpeg-index-cache.ts';
import { MEDIABUNNY_VERSION } from '../mediabunny-version.ts';
export type MediaIndexKind = 'flv' | 'ffmpeg' | 'js-ts' | 'js-matroska' | 'js-annexb' | 'mp4-playback';

export interface MediaIndexIdentity {
  kind: MediaIndexKind;
  streamKey: string;
  schemaVersion: number;
  indexerBuild: string;
}

export const JS_TS_MEDIA_INDEX_IDENTITY: MediaIndexIdentity = {
  kind: 'js-ts', streamKey: 'video:0', schemaVersion: 2, indexerBuild: TS_PACKET_BUILD,
};
export const JS_MATROSKA_MEDIA_INDEX_IDENTITY:MediaIndexIdentity={kind:'js-matroska',streamKey:'video:0',schemaVersion:1,indexerBuild:MATROSKA_PACKET_BUILD};

export const JS_ANNEX_B_MEDIA_INDEX_IDENTITY: MediaIndexIdentity = {
  kind: 'js-annexb', streamKey: 'video:0', schemaVersion: 1, indexerBuild: ANNEX_B_PACKET_BUILD,
};
export const JS_PACKET_IDENTITIES = {
  ts: JS_TS_MEDIA_INDEX_IDENTITY, matroska: JS_MATROSKA_MEDIA_INDEX_IDENTITY, annexb: JS_ANNEX_B_MEDIA_INDEX_IDENTITY,
} satisfies Record<JsPacketFormat, MediaIndexIdentity>;
export const JS_PACKET_INDEX_KINDS = { 'js-ts': 'js-ts-packets', 'js-matroska': 'js-matroska-packets', 'js-annexb': 'js-annexb-packets' };
export function isJsPacketIndexKind(kind: unknown): kind is keyof typeof JS_PACKET_INDEX_KINDS {
  return typeof kind === 'string' && Object.hasOwn(JS_PACKET_INDEX_KINDS, kind);
}
export function jsPacketIndexIdentity(index: JsPacketIndex) {
  return index.kind === 'js-ts-packets' ? JS_PACKET_IDENTITIES.ts
    : index.kind === 'js-matroska-packets' ? JS_PACKET_IDENTITIES.matroska : JS_PACKET_IDENTITIES.annexb;
}

export const FLV_INDEXER_BUILD = 'flv-demux-v3';
export const MP4_PLAYBACK_MEDIA_INDEX_IDENTITY: MediaIndexIdentity = {
  kind: 'mp4-playback', streamKey: 'video:0', schemaVersion: 2, indexerBuild: `mediabunny-${MEDIABUNNY_VERSION}-mp4-playback-v3`,
};
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
  if (kind !== 'flv' && kind !== 'ffmpeg' && !isJsPacketIndexKind(kind) && kind!=='mp4-playback') throw new Error('未知帧索引类型。');
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
  if (kind === 'js-ts' && (streamKey !== JS_TS_MEDIA_INDEX_IDENTITY.streamKey
    || schemaVersion !== JS_TS_MEDIA_INDEX_IDENTITY.schemaVersion
    || indexerBuild !== JS_TS_MEDIA_INDEX_IDENTITY.indexerBuild)) throw new Error('JS TS 索引版本不受支持。');
  if(kind==='js-matroska'&&(streamKey!==JS_MATROSKA_MEDIA_INDEX_IDENTITY.streamKey||schemaVersion!==JS_MATROSKA_MEDIA_INDEX_IDENTITY.schemaVersion||indexerBuild!==JS_MATROSKA_MEDIA_INDEX_IDENTITY.indexerBuild))throw new Error('JS Matroska 索引版本不受支持。');
  if (kind === 'js-annexb' && mediaIndexIdentityKey({kind, streamKey, schemaVersion, indexerBuild})
    !== mediaIndexIdentityKey(JS_ANNEX_B_MEDIA_INDEX_IDENTITY)) throw new Error('裸码流索引版本不受支持。');
  if (kind === 'mp4-playback' && mediaIndexIdentityKey({kind, streamKey, schemaVersion, indexerBuild})
    !== mediaIndexIdentityKey(MP4_PLAYBACK_MEDIA_INDEX_IDENTITY)) throw new Error('MP4 播放索引版本不受支持。');
  return { kind, streamKey, schemaVersion, indexerBuild };
}
