import type {QualityExecutionContract} from '../../../shared/analysis/quality/reexecution.ts';
import type {VmafPrepared} from '../../../shared/analysis/quality/vmaf.ts';
export type VmafHooks={expectedExecutionContract?:QualityExecutionContract;contract?(value:QualityExecutionContract):void;admitted():void;phase(name:string):void;progress(frames:number,total:number):void;prepared(value:VmafPrepared):void};
