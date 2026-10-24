import { FramePairClient } from '../analysis/quality/pair-client.ts';
import { AnnotationClient } from '../review/annotation-client.ts';
import { SessionResources } from './resources.ts';
import { PAIR_VIEW_SIDES,pairViewReference,pairViewEvidence,qualityFactKey,verifyInspectedPair,verifyPairViewPresentation } from '../../shared/review/quality-pair-view.ts';
import type { PairViewReference,PairViewSide,PairViewPresentation } from '../../shared/review/quality-pair-view.ts';
import type { QualityEvidence } from '../../shared/review/quality-evidence.ts';
import type { DecodedFrame } from '../media/source.ts';
import type { AnnotationRecord } from '../../shared/review/annotation-record.ts';
import type { InspectedFramePair } from '../../shared/analysis/quality/frame-pair.ts';

export type PairViewState={state:'idle'|'loading'|'ready'|'failed'|'cancelled'|'closed';reference?:PairViewReference;evidence?:QualityEvidence;presented?:Record<PairViewSide,PairViewPresentation>;error?:string};
type Dependencies={read(reference:PairViewReference,signal:AbortSignal):Promise<AnnotationRecord>;inspect(evidence:QualityEvidence,base:string,signal:AbortSignal):Promise<InspectedFramePair>};
/** Two immutable decoded snapshots, no media catalog, playback clock, annotation
 * synchronizer or persistence. Every open supersedes the previous intent. */
export class QualityPairViewSession {
  readonly resources=new SessionResources(64*1024*1024);
  private value:PairViewState={state:'idle'};
  private frames?:[DecodedFrame,DecodedFrame];
  private inspected?:InspectedFramePair['provenance'];
  private sequence=0;
  private controller?:AbortController;
  private pending:Promise<void>=Promise.resolve();
  private listeners=new Set<()=>void>();
  private closed=false;
  private deps:Dependencies;
  private draw:(side:PairViewSide,frame:DecodedFrame)=>void;
  private base:string;
  constructor(draw:(side:PairViewSide,frame:DecodedFrame)=>void,base:string,dependencies?:Dependencies) {
    this.draw=draw;this.base=base;
    const client=new FramePairClient();
    this.deps=dependencies??{read:(r,signal)=>new AnnotationClient(signal).read(r.space,r.annotationId),inspect:(e,b,s)=>client.inspect(e,b,s)};
  }
  getState(){return structuredClone(this.value);}
  subscribe(listener:()=>void){this.listeners.add(listener);return()=>this.listeners.delete(listener);}
  private emit(){for(const listener of this.listeners)listener();}
  private clear(){this.frames?.forEach(frame=>frame.close());this.frames=undefined;this.inspected=undefined;}
  open(input:PairViewReference):Promise<void> {
    const reference=pairViewReference(input);if(this.closed)return Promise.reject(new Error('Pair viewer closed.'));
    const sequence=++this.sequence;this.controller?.abort(new DOMException('View superseded.','AbortError'));
    this.clear();const controller=this.controller=new AbortController(),signal=AbortSignal.any([controller.signal,AbortSignal.timeout(30000)]);
    this.value={state:'loading',reference};this.emit();
    const current=()=>{signal.throwIfAborted();if(sequence!==this.sequence||this.closed)throw new DOMException('View superseded.','AbortError');};
    const read=async()=>{const record=await this.deps.read(reference,signal);current();
      if(record.deleted||record.id!==reference.annotationId||record.space!==reference.space)throw new Error('Shared annotation is unavailable.');
      const evidence=record.document.mark.qualityEvidence?.find(e=>e.id===reference.evidenceId);if(!evidence)throw new Error('Shared evidence was removed or is unavailable.');
      return pairViewEvidence(evidence,new URL(this.base).origin);
    };
    // Await the previous Worker owner's exit before reusing its admission slot.
    const task=this.pending.catch(()=>{}).then(async()=>{
      let frames:DecodedFrame[]=[];
      try {
        current();const evidence=await read(),pair=await this.deps.inspect(evidence,this.base,signal);current();
        verifyInspectedPair(evidence,pair);
        if(qualityFactKey(await read())!==qualityFactKey(evidence))throw new Error('Shared evidence changed while opening.');current();
        for(const [i,side] of PAIR_VIEW_SIDES.entries()) {
          const raw=pair.frames[i],p=pair.provenance[side],release=this.resources.reserve('derived',raw.pixels.byteLength);
          if(!release)throw new Error('Pair snapshot memory budget exceeded.');
          let closed=false;
          frames.push({kind:'yuv',width:raw.description.width,height:raw.description.height,description:raw.description,
            ptsUs:0,sourcePtsUs:raw.pts,durationUs:1,byteSize:raw.pixels.byteLength,rotation:0,sourcePicture:structuredClone(p.picture),
            pixels:new Uint8ClampedArray(raw.pixels.buffer,raw.pixels.byteOffset,raw.pixels.byteLength),close(){if(!closed){closed=true;release();}}});
        }
        current();this.frames=frames as [DecodedFrame,DecodedFrame];this.inspected=pair.provenance;frames=[];
        this.value={state:'loading',reference,evidence};this.redraw();
        this.value={...this.value,state:'ready'};this.emit();
      }catch(error){for(const frame of frames)frame.close();if(sequence===this.sequence){this.clear();this.value={state:signal.aborted?'cancelled':'failed',reference,error:error instanceof Error?error.message:String(error)};this.emit();}throw error;}
    });
    this.pending=task;return task;
  }
  redraw() {
    const evidence=this.value.evidence;if(!this.frames||!evidence)return;
    const presented={} as Record<PairViewSide,PairViewPresentation>;
    for(const [i,side] of PAIR_VIEW_SIDES.entries()) {
      const frame=this.frames[i];this.draw(side,frame);
      if(frame.presentedCommit===undefined)throw new Error('Frame was not successfully presented.');
      const d=frame.description,p=this.inspected![side];
      const token:PairViewPresentation={commit:frame.presentedCommit,picture:structuredClone(frame.sourcePicture!),sourcePtsUs:frame.sourcePtsUs,
        sourceBinding:{mediaId:p.mediaId,mediaVersion:p.mediaVersion,size:p.size,indexIdentity:structuredClone(p.indexIdentity),indexBuildId:p.indexBuildId},
        geometry:{codedWidth:d.codedWidth,codedHeight:d.codedHeight,visibleRect:{...d.visibleRect},displayWidth:d.displayWidth,displayHeight:d.displayHeight,rotation:frame.rotation??0}};
      verifyPairViewPresentation(evidence,side,token);presented[side]=token;
    }
    this.value={...this.value,presented};
  }
  cancel(){if(this.closed)return;this.sequence++;this.controller?.abort(new DOMException('View cancelled.','AbortError'));this.clear();this.value={state:'cancelled'};this.emit();}
  async close(){this.cancel();this.closed=true;this.value={state:'closed'};this.emit();await this.pending.catch(()=>{});this.listeners.clear();}
}
