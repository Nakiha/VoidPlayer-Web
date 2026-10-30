import type {QualityExecutionContract} from '../../../shared/analysis/quality/reexecution.ts';
import type {CambiPrepared,CambiFrame} from '../../../shared/analysis/quality/cambi.ts';
export type CambiHooks={stopRequested?():boolean;expectedExecutionContract?:QualityExecutionContract;contract?(c:QualityExecutionContract):void;admitted():void;phase(name:string):void;progress(n:number,total:number):void;prepared(p:CambiPrepared):void;streamFrame?(frame:CambiFrame,header:Omit<CambiPrepared,'frames'>,score:number,maps:{scale:number;bytes:Uint8Array;sha256:string}[]):Promise<void>};
