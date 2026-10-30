import {CAMBI_LIMITS} from '../analysis/quality/cambi.ts';
import {DISCOVERY_LIMITS} from '../media/discovery.ts';
import {QUALITY_JOB_LIMITS} from '../analysis/quality/jobs.ts';
import {QUALITY_RANGE_LIMITS} from '../analysis/quality/ranges.ts';
import {CORRESPONDENCE_LIMITS} from '../analysis/quality/correspondence.ts';
import {VMAF_LIMITS} from '../analysis/quality/vmaf.ts';

export const TASK_KINDS=['preparation','correspondence','single','range','vmaf','xpsnr','cambi'] as const;
export type TaskKind=typeof TASK_KINDS[number];
export const TASK_RESULT_KINDS:readonly TaskKind[]=['single','range','vmaf','xpsnr','cambi'];
export const TASK_METRICS=['probe','quality-index','correspondence','psnr','ssim','vmaf','xpsnr','cambi'] as const;
export const TASK_STATES=['queued','preparing','running','cancelling','completed','blocked','partial','failed','cancelled','interrupted'] as const;
export const TASK_HISTORY_ROWS={preparation:DISCOVERY_LIMITS.historyRows,correspondence:CORRESPONDENCE_LIMITS.historyRows,single:QUALITY_JOB_LIMITS.historyRows,range:QUALITY_RANGE_LIMITS.historyRows,vmaf:VMAF_LIMITS.historyRows,xpsnr:VMAF_LIMITS.historyRows,cambi:CAMBI_LIMITS.historyRows} as const;
export const TASK_LIMITS=Object.freeze({page:50,snapshots:8,actorSnapshots:2,snapshotMs:60000,snapshotBytes:8*1024*1024,rows:Object.values(TASK_HISTORY_ROWS).reduce((a,b)=>a+b,0)});
export type TaskFilter={mediaId?:string;mediaVersion?:string;kind?:TaskKind;metric?:typeof TASK_METRICS[number];state?:typeof TASK_STATES[number];createdFrom?:number;createdTo?:number};
export type TaskQuery={filter:TaskFilter;limit:number;cursor?:string};
export type TaskLink={rel:string;href:string};
export type TaskSummary={kind:TaskKind;id:string;revision:number;state:string;phase:string|null;actorId:string;clientId:string;requestId:string;
  createdAt:number;startedAt:number|null;endedAt:number|null;reason:{code:string;message:string}|null;
  sources:{role:'source'|'reference'|'distorted';mediaId:string;mediaVersion:string}[];metrics:string[];
  progress:{scored?:number;target?:number;prepared?:number;metrics?:unknown};
  result:{available:boolean;scored?:number;retained?:number;released?:boolean;releasePending?:boolean};attemptId:string|null;resultDigest:string|null;links:TaskLink[]};
export type TaskPage={schema:'voidplayer-task-page';version:1;filter:TaskFilter;capturedAt:number;expiresAt:number;entries:TaskSummary[];nextCursor:string|null;total:number;limits:typeof TASK_LIMITS};
export type TaskDetail={schema:'voidplayer-task-detail';version:1;task:TaskSummary;related:{kind:TaskKind;id:string;relation:string;href:string}[];links:TaskLink[]};
export const taskPath=(kind:TaskKind,id:string)=>`/api/tasks/${kind}/${encodeURIComponent(id)}`;
export const taskPending=(state:string)=>['queued','preparing','running','cancelling'].includes(state);

/** One strict query parser shared by HTTP, GUI persistence and discovery. */
export function taskQuery(params:URLSearchParams):TaskQuery{
  const fields=['mediaId','mediaVersion','kind','metric','state','createdFrom','createdTo','limit','cursor'];
  for(const k of params.keys())if(!fields.includes(k)||params.getAll(k).length!==1)throw Error('Unknown or repeated task query field');
  const filter:TaskFilter={};
  for(const k of ['mediaId','mediaVersion'] as const)if(params.has(k)){const v=params.get(k)!;if(!/^[a-f0-9]{24}$/.test(v))throw Error(`Invalid ${k}`);filter[k]=v;}
  if(filter.mediaVersion&&!filter.mediaId)throw Error('mediaVersion requires mediaId');
  const enums={kind:TASK_KINDS,metric:TASK_METRICS,state:TASK_STATES};
  for(const k of ['kind','metric','state'] as const)if(params.has(k)){const v=params.get(k)!;if(!(enums[k] as readonly string[]).includes(v))throw Error(`Invalid task ${k}`);Object.assign(filter,{[k]:v});}
  const integer=(key:string)=>{const s=params.get(key)!;if(!/^(0|[1-9][0-9]*)$/.test(s)||!Number.isSafeInteger(Number(s)))throw Error(`Invalid ${key}`);return Number(s);};
  for(const k of ['createdFrom','createdTo'] as const)if(params.has(k))filter[k]=integer(k);
  if(filter.createdFrom!==undefined&&filter.createdTo!==undefined&&filter.createdFrom>=filter.createdTo)throw Error('Empty creation time interval');
  const limit=params.has('limit')?integer('limit'):20;if(limit<1||limit>TASK_LIMITS.page)throw Error('Invalid task page size');
  const cursor=params.get('cursor')??undefined;if(cursor!==undefined&&!/^[a-f0-9]{32}\.[0-9]{1,5}\.[a-f0-9]{64}$/.test(cursor))throw Error('Invalid task cursor');
  return {filter,limit,...(cursor?{cursor}:{})};
}
export function taskMatches(task:TaskSummary,filter:TaskFilter){
  return (!filter.kind||task.kind===filter.kind)&&(!filter.state||task.state===filter.state)&&(!filter.metric||task.metrics.includes(filter.metric))
    &&(!filter.mediaId||task.sources.some(s=>s.mediaId===filter.mediaId&&(!filter.mediaVersion||s.mediaVersion===filter.mediaVersion)))
    &&(filter.createdFrom===undefined||task.createdAt>=filter.createdFrom)&&(filter.createdTo===undefined||task.createdAt<filter.createdTo);
}
