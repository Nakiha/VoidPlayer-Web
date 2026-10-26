import {createHash,createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import type {IndexDatabase} from '../sqlite.ts';
import {AdminError} from '../admin-error.ts';
import {DISCOVERY_LIMITS as LIMITS,DISCOVERY_SCHEMA,evaluateDiscovery} from '../../shared/media/discovery.ts';
import type {DiscoveryQuery,DiscoverySource,MediaProbe} from '../../shared/media/discovery.ts';
import type {DiscoveryField,DiscoveryStream} from '../../shared/media/discovery.ts';
import {MediaIndexQueryStore} from '../media-index-query.ts';

const digest=(s:string)=>createHash('sha256').update(s).digest('hex');
type MediaRow={id:string;version:string;size:number;modified:number;path:string;root_name:string;root_id:string;root_state:string;state:string;probe_json:string|null;probe_digest:string|null;prepared_at:number|null};
type Counts={inspected:number;match:number;unknown:number;notMatch:number};
const emptyCounts=():Counts=>({inspected:0,match:0,unknown:0,notMatch:0});
const mediaColumns=`m.id,m.version,m.size,m.modified,m.path,m.state,m.root_id,r.name AS root_name,r.state AS root_state,
  CASE WHEN octet_length(p.probe_json)<=32768 THEN p.probe_json END AS probe_json,p.probe_digest,p.prepared_at`;
const mediaFrom=`media m JOIN roots r ON r.id=m.root_id LEFT JOIN discovery_probes p ON p.media_id=m.id AND p.media_version=m.version`;

/** Read-only projections; safe in the existing bounded cache-query Worker.
 * It never creates tables, recovers jobs, migrates indexes or reads media bytes. */
export class DiscoveryCatalog {
  readonly db:IndexDatabase;
  private secret=randomBytes(32);
  private cached:MediaIndexQueryStore;
  constructor(db:IndexDatabase){this.db=db;this.cached=new MediaIndexQueryStore(db);}
  private changed():never{throw new AdminError(409,'Library or technical evidence changed; restart discovery from its first page.','discovery-snapshot-changed');}
  private stamp(){return [this.db.prepare('PRAGMA data_version').get()!.data_version,this.db.prepare('SELECT total_changes() AS n').get()!.n,
    this.db.prepare('SELECT revision FROM library_revision WHERE id=1').get()!.revision,this.db.prepare('SELECT revision FROM discovery_meta WHERE id=1').get()!.revision];}
  private decodeProbe(row:MediaRow):MediaProbe|null{
    if(!row.probe_json||digest(row.probe_json)!==row.probe_digest)return null;
    try{const p=JSON.parse(row.probe_json) as MediaProbe;
      if(p.schema!=='voidplayer-media-probe'||p.version!==1||p.source.id!==row.id||p.source.version!==row.version||!Array.isArray(p.streams)||p.streams.length>LIMITS.probeStreams
        ||typeof p.streamInventoryComplete!=='boolean'||!p.container||typeof p.parser!=='string')return null;
      for(const s of p.streams){if(typeof s.id!=='string'||s.id.length>100||!['video','audio','subtitle','data','other'].includes(s.type)||!s.fields||Object.keys(s.fields).length>32)return null;
        for(const f of Object.values(s.fields))if(!f||!['known','unknown','derived','not-probed','unsupported'].includes(f.status)
          ||!(f.value===null||typeof f.value==='string'&&f.value.length<=300||typeof f.value==='number'&&Number.isFinite(f.value)||typeof f.value==='boolean'))return null;}
      return p;
    }catch{return null;}
  }
  private describe(row:MediaRow){const probe=this.decodeProbe(row),cached=this.cached.discoveryEvidence(row.id,row.version,LIMITS.cachedIdentitiesPerSource);
    const cachedStreams:DiscoveryStream[]=cached.indexes.map(({identity,buildId,overview,eligible,reason},ordinal)=>{
      const fields:Record<string,DiscoveryField>={};
      for(const [key,value]of Object.entries(overview.technical))fields[key.startsWith('sourceColor')?'color'+key.slice(11):key]=eligible?value:{value:null,status:'unknown',source:'unavailable',reason};
      fields.recordsReady=eligible&&overview.capabilities.records.implemented&&overview.capabilities.records.enabled&&overview.capabilities.records.ready
        ?{value:true,status:'known',source:'index-observation',reason:'bounded-record-adapter-ready;payload-not-rehashed'}:{value:null,status:'unknown',source:'unavailable',reason:'record-adapter-not-ready-or-unavailable'};
      const video=probe?.streams.filter(s=>s.type==='video');
      if(fields.codec?.status==='known'&&probe?.streamInventoryComplete&&video?.every(s=>s.fields.codec?.status==='known')&&!video.some(s=>s.fields.codec.value===fields.codec?.value))
        for(const key of Object.keys(fields))fields[key]={value:null,status:'unknown',source:'unavailable',reason:'prepared-inventory-and-cache-codec-conflict'};
      const timeBase=overview.clock.timeBase;
      return {id:`cached-index:${ordinal}`,type:'video',ordinal,fields,cachedIndex:{identity,buildId,state:overview.state},
        clock:{timeBase:timeBase?{numerator:timeBase.numerator,denominator:timeBase.denominator}:null,domain:'cached-stream-ticks',origin:null,relationToQualityAu:'not-established'}};
    });
    const streams=[...(probe?.streams??[]),...cachedStreams];
    return {source:{id:row.id,version:row.version},file:{name:row.path,root:row.root_name,rootId:row.root_id,rootState:row.root_state,size:row.size,lastModified:row.modified,state:row.state,basis:'library-file-stat',liveChecked:false},
    technical:{state:probe?'prepared':cached.identitiesRead?'cached-streams-only':row.probe_json?'unknown':'not-probed',reason:probe?null:row.probe_json?'invalid-prepared-evidence':streams.length?'cached-stream-inventory-incomplete':cached.identitiesRead?'cached-evidence-unavailable':'no-bounded-probe',
      preparedAt:probe?row.prepared_at:null,digest:probe?row.probe_digest:null,probe,streams,streamInventoryComplete:probe?.streamInventoryComplete??false,cachedEvidenceTruncated:cached?.truncated??false,
      cacheProjection:{identitiesRead:cached?.identitiesRead??0,bytes:cached?.readBytes??0}},
    scoring:{state:'requires-quality-source-check',reason:'metadata-is-not-quality-admission',source:`/api/media/${row.id}/psnr-source?v=${row.version}`,frames:`/api/media/${row.id}/psnr-frames?v=${row.version}`},
    links:{describedBy:'/api/library/discovery-schema',indexes:`/api/media/${row.id}/info?v=${row.version}`,prepare:'/api/library/preparations'}};}
  detail(source:DiscoverySource){
    const row=this.db.prepare(`SELECT ${mediaColumns} FROM ${mediaFrom} WHERE m.id=? AND r.active=1 AND m.state!='missing'`).get(source.id) as unknown as MediaRow|undefined;
    if(!row)throw new AdminError(404,'Media not found in active library.','media-not-found');
    if(row.version!==source.version)throw new AdminError(409,'Media version changed; browse again.','media-version-changed');
    const result={schema:DISCOVERY_SCHEMA,version:1,...this.describe(row)};
    if(Buffer.byteLength(JSON.stringify(result))>LIMITS.responseBytes)throw new AdminError(413,'Discovery detail exceeds response budget.','discovery-response-budget');return result;
  }
  private cursor(value:unknown){const text=Buffer.from(JSON.stringify(value)).toString('base64url');return text+'.'+createHmac('sha256',this.secret).update(text).digest('hex');}
  private readCursor(token:string):{snapshot:string;lastId:string;counts:Counts;scanned:number}{
    try{const [text,mac,...rest]=token.split('.');if(rest.length||!/^[a-f0-9]{64}$/.test(mac))throw Error();
      const actual=Buffer.from(mac,'hex'),expected=createHmac('sha256',this.secret).update(text).digest();if(!timingSafeEqual(actual,expected))throw Error();
      const c=JSON.parse(Buffer.from(text,'base64url').toString());if(typeof c.snapshot!=='string'||typeof c.lastId!=='string'||!/^[a-f0-9]{24}$/.test(c.lastId)
        ||!Number.isSafeInteger(c.scanned)||c.scanned<1||!c.counts||Object.keys(emptyCounts()).some(k=>!Number.isSafeInteger(c.counts[k])||c.counts[k]<0)
        ||c.counts.inspected>c.scanned||c.counts.inspected!==c.counts.match+c.counts.unknown+c.counts.notMatch)throw Error();return c;
    }catch{throw new AdminError(409,'Discovery cursor expired, changed or is invalid; restart.','discovery-snapshot-changed');}
  }
  browse(query:DiscoveryQuery,cancellation?:SharedArrayBuffer){
    const check=()=>{if(cancellation&&Atomics.load(new Int32Array(cancellation),0))throw new AdminError(499,'Discovery query cancelled.','discovery-query-cancelled');};check();
    const {cursor,...scope}=query,before=this.stamp(),snapshot=digest(JSON.stringify([scope,before]));
    const previous=cursor?this.readCursor(cursor):{snapshot,lastId:'',counts:emptyCounts(),scanned:0};if(previous.snapshot!==snapshot)this.changed();
    if(query.root&&!this.db.prepare('SELECT id FROM roots WHERE id=? AND active=1').get(query.root))throw new AdminError(400,'Unknown library root.','invalid-discovery-query');
    const counts={...previous.counts},page=emptyCounts();
    this.db.exec('BEGIN');
    try{
      // Seek the existing TEXT primary-key index. Scope predicates are applied
      // only AFTER this bounded candidate window, never an unbounded SQL filter,
      // count, OFFSET walk or path sort. One lookahead establishes continuation.
      const rows=this.db.prepare(`SELECT id,root_id,path,state FROM media INDEXED BY sqlite_autoindex_media_1 WHERE id>? ORDER BY id LIMIT ?`)
        .all(previous.lastId,LIMITS.inspectedPerPage+1) as unknown as {id:string;root_id:string;path:string;state:string}[];
      const rootLookup=this.db.prepare('SELECT active FROM roots WHERE id=?'),roots=new Map<string,boolean>();
      const projection=this.db.prepare(`SELECT ${mediaColumns} FROM ${mediaFrom} WHERE m.id=?`),search=query.search.toLowerCase();
      const entries:unknown[]=[];let consumed=0,lastId=previous.lastId,sourceRowsProjected=0,probeProjectionBytes=0,cacheIdentitiesRead=0,cacheProjectionBytes=0;
      for(const candidate of rows.slice(0,LIMITS.inspectedPerPage)){check();
        if(!roots.has(candidate.root_id))roots.set(candidate.root_id,rootLookup.get(candidate.root_id)?.active===1);
        const inScope=roots.get(candidate.root_id)&&candidate.state!=='missing'&&(!query.root||candidate.root_id===query.root)&&(!search||candidate.path.toLowerCase().includes(search));
        if(!inScope){consumed++;lastId=candidate.id;continue;}
        const row=projection.get(candidate.id) as unknown as MediaRow;if(!row)throw Error('Discovery projection disappeared within snapshot');
        sourceRowsProjected++;probeProjectionBytes+=Buffer.byteLength(row.probe_json??'');const item=this.describe(row);
        cacheIdentitiesRead+=item.technical.cacheProjection.identitiesRead;cacheProjectionBytes+=item.technical.cacheProjection.bytes;
        const useCache=!!query.filters.recordsReady||!item.technical.probe;
        const candidates=useCache?item.technical.streams.filter(s=>!!s.cachedIndex):item.technical.probe!.streams;
        const decision={...(row.state!=='ready'||row.root_state!=='ready'?{state:'unknown' as const,evidence:[],reason:row.state!=='ready'?'library-source-not-ready':'library-root-not-ready'}:evaluateDiscovery(candidates,!useCache&&item.technical.streamInventoryComplete,query.filters)),evidenceBasis:useCache?'cached-index-identities':'prepared-streams'};
        const include=decision.state==='match'||query.includeUnknown&&decision.state==='unknown';
        if(include){const value={...item,decision};if(Buffer.byteLength(JSON.stringify([...entries,value]))>LIMITS.responseBytes-16384){if(!entries.length)throw new AdminError(413,'One discovery result exceeds response budget.','discovery-response-budget');break;}entries.push(value);}
        consumed++;lastId=candidate.id;page.inspected++;counts.inspected++;const key=decision.state==='not-match'?'notMatch':decision.state;page[key]++;counts[key]++;
        if(entries.length>=query.limit)break;
      }
      const scanned=previous.scanned+consumed,exhausted=consumed===rows.length,nextCursor=exhausted?null:this.cursor({snapshot,lastId,scanned,counts});
      check();if(JSON.stringify(this.stamp())!==JSON.stringify(before))this.changed();
      return {schema:DISCOVERY_SCHEMA,version:1,snapshot,query:scope,entries,nextCursor,coverage:{scope:'registered-library-rows',total:exhausted?counts.inspected:null,page,cumulative:counts,exhausted,
        candidates:{page:consumed,cumulative:scanned},order:'media-id-ascending',totals:exhausted?{match:counts.match,unknown:counts.unknown,notMatch:counts.notMatch}:null,liveFilesystemChecked:false,filesystemCompleteness:'not-established'},
        work:{candidateRowsRead:rows.length,sourceRowsProjected,probeProjectionBytes,cacheIdentitiesRead,cacheProjectionBytes},
        limits:LIMITS,links:{describedBy:'/api/library/discovery-schema',prepare:'/api/library/preparations',scanStatus:'/api/library/scan',help:'/agent/library.md'}};
    }finally{this.db.exec('ROLLBACK');}
  }
}
