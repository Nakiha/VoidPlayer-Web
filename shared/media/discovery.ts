import type { CachedField } from './indexing/semantic-query.ts';

/** Technical discovery is evidence for selection, never quality admission. */
export const DISCOVERY_SCHEMA = 'voidplayer-library-discovery';
export const DISCOVERY_PATH = '/api/library/discovery';
export const PREPARATION_PATH = '/api/library/preparations';
export const DISCOVERY_LIMITS = Object.freeze({ pageSize: 32, inspectedPerPage: 64, responseBytes: 262144,
  cachedIdentitiesPerSource:4,cachedProjectionBytesPerIdentity:45056,
  probeBytes: 4 * 1024 * 1024, probeReadCalls: 512, probeStreams: 32, probeResultBytes: 32768,
  flvPrefixBytes:65536,flvTagHeaders:8,flvConfigurationBytes:4096,
  elapsedMs: 30000, workerHeapMiB: 256, queued: 8, actorOutstanding: 4, historyRows: 1000,
  historyBytes: 64 * 1024 * 1024, queueWaitMs: 60000 });
export type DiscoveryField = Omit<CachedField,'source'> & {source:CachedField['source']|'container-or-codec-metadata'};
export type DiscoverySource = { id: string; version: string };
export type DiscoveryStream = {
  /** Local to this versioned parser result; NOT a quality cache streamKey. */
  id: string; type: 'video' | 'audio' | 'subtitle' | 'data' | 'other'; ordinal: number;
  cachedIndex?:{identity:import('./indexing/media-index-identity.ts').MediaIndexIdentity;buildId:string|null;state:string};
  fields: Record<string, DiscoveryField>;
  clock: { timeBase: { numerator: number; denominator: number } | null;
    domain: 'container-track-ticks' | 'flv-native-milliseconds' | 'cached-stream-ticks'; origin: null;
    relationToQualityAu: 'not-established' };
};
export type MediaProbe = {
  schema: 'voidplayer-media-probe'; version: 1; source: DiscoverySource;
  parser: string; container: DiscoveryField; streams: DiscoveryStream[];
  streamInventoryComplete: boolean; coverage: { scope: 'metadata-only' | 'initial-video-configuration'|'bounded-container-prefix';
    fullPacketEnumeration: false; decodedPictures: false; bytesRead: number; readCalls: number;
    prefix?:{endOffset:number;tagHeadersInspected:number;stop:string} };
  inventory?:{scope:'initial-container-declarations';reason:string|null;declaredTrackCount:number|null};
};
export type DiscoveryFilters = { codec?: string; minWidth?: number; maxWidth?: number;
  minHeight?: number; maxHeight?: number; bitDepth?: number; colorTransfer?: string; minDurationUs?: number; maxDurationUs?: number;recordsReady?:true };
export type DiscoveryQuery = { search: string; root: string; filters: DiscoveryFilters; includeUnknown: boolean; limit: number; cursor?: string };
export type DiscoveryDecision = 'match' | 'not-match' | 'unknown';
export function parseDiscoveryQuery(params: URLSearchParams): DiscoveryQuery {
  const allowed = ['search','root','codec','minWidth','maxWidth','minHeight','maxHeight','bitDepth','colorTransfer','minDurationUs','maxDurationUs','recordsReady','includeUnknown','limit','cursor'];
  for (const key of params.keys()) if (!allowed.includes(key) || params.getAll(key).length !== 1) throw Error('Unknown or duplicate discovery parameter.');
  const search = params.get('search') ?? '', root = params.get('root') ?? '';
  if (search.length > 300 || root.length > 100) throw Error('Discovery scope is too long.');
  const filters: DiscoveryFilters = {};
  for (const key of ['codec','colorTransfer'] as const) if (params.has(key)) {
    const value = params.get(key)!;
    if (!/^[a-z0-9_.+-]{1,64}$/i.test(value)) throw Error('Invalid technical token.');
    filters[key] = value.toLowerCase();
  }
  for (const key of ['minWidth','maxWidth','minHeight','maxHeight','bitDepth','minDurationUs','maxDurationUs'] as const) if (params.has(key)) {
    const value = params.get(key)!, number = Number(value);
    if (!/^(?:0|[1-9][0-9]{0,15})$/.test(value) || !Number.isSafeInteger(number) || number < 1
      || (/Width|Height/.test(key) && number > 16384) || key === 'bitDepth' && number > 16) throw Error('Invalid technical number.');
    filters[key] = number;
  }
  for (const [low, high] of [['minWidth','maxWidth'],['minHeight','maxHeight'],['minDurationUs','maxDurationUs']] as const)
    if (filters[low] !== undefined && filters[high] !== undefined && filters[low]! > filters[high]!) throw Error('Minimum exceeds maximum.');
  if(params.has('recordsReady')){if(params.get('recordsReady')!=='1')throw Error('recordsReady supports 1 only.');filters.recordsReady=true;}
  const limit = params.get('limit') ?? '16';
  if (!/^[1-9][0-9]?$/.test(limit) || Number(limit) > DISCOVERY_LIMITS.pageSize) throw Error('limit must be 1..32.');
  const include = params.get('includeUnknown') ?? '1';
  if (include !== '0' && include !== '1') throw Error('includeUnknown must be 0 or 1.');
  const cursor = params.get('cursor') ?? undefined;
  if (cursor !== undefined && (cursor.length > 2048 || !/^[a-zA-Z0-9_.-]+$/.test(cursor))) throw Error('Invalid discovery cursor.');
  return { search, root, filters, includeUnknown: include === '1', limit: Number(limit), ...(cursor ? {cursor} : {}) };
}
/** All predicates use ONE stream's evidence. Unobserved streams cannot prove a whole-source negative. */
export function evaluateDiscovery(streams: DiscoveryStream[], complete: boolean, filters: DiscoveryFilters) {
  if(!Object.keys(filters).length)return {state:'match' as DiscoveryDecision,evidence:[],reason:null};
  const evidence = streams.filter(s => s.type === 'video').map(stream => {
    const checks = Object.entries(filters).map(([condition, target]) => {
      const key = condition.includes('Width') ? 'width' : condition.includes('Height') ? 'height' : condition.includes('Duration') ? 'durationUs' : condition;
      const field = stream.fields[key]; let state: DiscoveryDecision = 'unknown';
      if (field?.status === 'known' && field.value !== null) {
        if (typeof target === 'string' && typeof field.value === 'string') state = field.value.toLowerCase() === target ? 'match' : 'not-match';
        else if(typeof target==='boolean'&&typeof field.value==='boolean')state=field.value===target?'match':'not-match';
        else if (typeof target === 'number' && typeof field.value === 'number') state = (condition.startsWith('min') ? field.value >= target : condition.startsWith('max') ? field.value <= target : field.value === target) ? 'match' : 'not-match';
      }
      return { condition, state, reason: state === 'unknown' ? field?.reason ?? 'field-not-observed' : null };
    });
    const state: DiscoveryDecision = checks.some(c=>c.state==='not-match') ? 'not-match' : checks.some(c=>c.state==='unknown') ? 'unknown' : 'match';
    return { stream: stream.id, state, checks };
  });
  const state: DiscoveryDecision = evidence.some(e=>e.state==='match') ? 'match' : !complete || streams.some(s=>s.type==='other') || evidence.some(e=>e.state==='unknown') ? 'unknown' : 'not-match';
  return { state, evidence, reason: state === 'unknown' ? !complete ? 'stream-inventory-incomplete' : streams.some(s=>s.type==='other')?'unclassified-initial-stream-kind':'condition-evidence-unavailable' : null };
}
export type PreparationInput = { source: DiscoverySource; operation: 'probe' | 'quality-index'; client: {id: string; name: string} };
export function preparationInput(value: unknown): PreparationInput {
  const v = value as PreparationInput;
  const keys = (o: unknown, expected: string[]) => !!o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).length === expected.length && expected.every(k=>Object.hasOwn(o,k));
  if (!keys(v,['source','operation','client']) || !keys(v.source,['id','version']) || !keys(v.client,['id','name'])
    || typeof v.source.id!=='string'||typeof v.source.version!=='string'||!/^[a-f0-9]{24}$/.test(v.source.id) || !/^[a-f0-9]{24}$/.test(v.source.version)
    || !['probe','quality-index'].includes(v.operation) || typeof v.client.id !== 'string' || !/^[a-zA-Z0-9._:-]{1,80}$/.test(v.client.id)
    || typeof v.client.name !== 'string' || !v.client.name.trim() || v.client.name.length > 120) throw Error('Invalid version-pinned preparation request.');
  return {source:{id:v.source.id,version:v.source.version},operation:v.operation,client:{id:v.client.id,name:v.client.name.trim()}};
}
export type PreparationState = 'queued'|'running'|'cancelling'|'completed'|'failed'|'cancelled'|'interrupted';
export type PreparationJob = {schema:'voidplayer-library-preparation';version:1;id:string;revision:number;state:PreparationState;
  input:PreparationInput;submitted:{actorId:string;clientId:string;requestId:string;idempotencyKey:string};
  createdAt:number;queueUntil:number;startedAt:number|null;endedAt:number|null;attemptId:string|null;
  reason:{code:string;message:string}|null;result:unknown|null};
export const DISCOVERY_DICTIONARY = {
  schema:DISCOVERY_SCHEMA,version:1,discovery:DISCOVERY_PATH,preparations:PREPARATION_PATH,limits:DISCOVERY_LIMITS,
  query:{scope:['root: configured root ID','search: case-insensitive relative path substring'],
    conditions:['codec','minWidth','maxWidth','minHeight','maxHeight','bitDepth','colorTransfer','minDurationUs','maxDurationUs','recordsReady=1'],
    combination:'AND within one video evidence stream; OR across streams. Only known facts can satisfy or disprove a condition.',
    paging:{limit:'1..32, default16',includeUnknown:'0|1, default1',cursor:'Repeat the identical scope, conditions, includeUnknown and limit with nextCursor. Primary-key media-ID seek; at most64 candidate rows plus one lookahead. Scope/search predicates run only on this window. No synchronous whole-library COUNT, OFFSET walk or path sort; sparse searches can return empty continuation pages.'}},
  preparationRequest:{method:'POST',path:PREPARATION_PATH,
    body:{source:{id:'24 lowercase hexadecimal library ID',version:'24 lowercase hexadecimal stat version'},operation:['probe','quality-index'],client:{id:'1..80 ASCII letters/digits/._:-',name:'1..120 characters; trimmed'}},
    headers:['Origin: same origin','Content-Type: application/json','X-VoidPlayer-Action: library-preparation','X-VoidPlayer-Actor: captured selected actor','Idempotency-Key'],
    ownership:'Identity cookie scopes private history and receipts. Actor mismatch is409 actor-changed before side effects. Same actor/client/key and normalized body replay the receipt even if source or prepared evidence no longer exists.',
    responses:{accepted:202,replayed:200,conflict:409,budgetFull:429,ephemeralDatabase:503},
    states:{queued:'No execution permit/attempt yet; queueUntil is an absolute Unix-millisecond deadline.',running:'Owned actual Worker or trusted index builder.',cancelling:'Explicit cancellation requested; permit remains held through IO drain and physical exit.',completed:'Immutable result published atomically with terminal state.',failed:'One attempt failed; no automatic retry.',cancelled:'No running Worker remains.',interrupted:'Recovered after shutdown/restart; never automatically resumed.'},
    history:'GET collection with limit=1..32 (default32) and before=next. Summaries omit result payload; GET /JOB returns detail. POST /JOB/cancel body={} explicitly cancels. Closing an observer is not cancellation.'},
  fields:{source:'Exact library ID and stat-derived version; not content authentication.',
    stream:'Parser-local stream id and ordinal. Never reuse as a quality cache streamKey or infer an AU.',
    field:'value=null with status and reason for absent facts; known is parser/container evidence, derived may include parser defaults and is excluded from exact filtering.',
    fieldSource:'container-or-codec-metadata means the pinned parser reports initial/container metadata without exposing which declaration won. It is not decoded-picture or display-conversion evidence and does not certify container/SPS agreement.',
    filtering:'Without recordsReady, prepared metadata is preferred; otherwise bounded cache identities are used. recordsReady=1 uses cache identities only. Never combine probe fields and cache fields or join fields across namespaces/streams. Conflicting/truncated cached evidence is unknown.',
    emptyConditions:'No technical conditions matches registered rows regardless of metadata readiness. Inspect technical.state separately; a match is never scoring admission.',
    clock:'timeBase is seconds per original container-track tick; origin=null and relationToQualityAu=not-established. Never seek a quality AU by matching PTS.',
    coverage:'Metadata or bounded initial prefix/configuration only; no full packet enumeration or decoded-picture verification. FLV prefix coverage reports tag headers inspected, stop reason and end offset; absent/late video remains unknown without searching to EOF. Cached index overview/records are separate versioned endpoints.',
    streamInventory:'streamInventoryComplete refers only to bounded initial container declarations: MP4/QuickTime trak and Matroska/WebM Tracks include subtitle/data/unknown rows. It never certifies later configuration changes, packets, or reference integrity. Header/inventory budget or parser disagreement leaves it incomplete; FLV and TS initial probes remain incomplete.',
    durationUs:'Container-declared duration/end metadata in integer microseconds, not decoded duration or CFR. Unknown remains null.',
    quality:'Probe success does not imply scoring support. Only existing psnr-source/psnr-frames admission can establish trusted FLV source/cache/AU identity.',
    counts:'candidates counts all ID-ordered rows visited; page/cumulative decisions count only active, non-missing rows inside root/path scope. total and whole-scope match/unknown totals are null until exhausted=true, then exact for registered rows. Unknown is retained by default, never silently counted as not-match.',
    cacheProjection:'Up to four identities plus one lookahead per projected source, each at most45056 text bytes. Metadata/header/storage projections only, never packet documents or record batches. Existing caches are reused without an implicit probe.',
    pixelFormat:'Nominal encoded chroma/bit-depth from bounded codec configuration, not the actual decoder pixel resource, byte order or a promise about every picture.',
    cursor:'Opaque server-authenticated continuation bound to scope/filter and library/probe/cache snapshot. Changes return 409; restart from the first page.',
    preparation:'Explicit service-owned one-attempt jobs; observation disconnect never cancels. Explicit cancel settles after physical Worker exit; no automatic retry or implicit indexing.'},
  support:{probe:['FLV/Enhanced FLV bounded initial audio/video prefix (64KiB, at most8 tag headers, configuration up to4096 bytes)','MP4/QuickTime metadata','Matroska/WebM metadata','MPEG-TS bounded metadata'],
    scoring:['Only existing trusted FLV/Enhanced FLV quality contracts; metadata readability never extends this matrix'],
    unsupported:['No external ffprobe process','No decode or full packet scans during probe','No inferred reference pairing, frame type, CFR, continuous coverage or content integrity']},
};
