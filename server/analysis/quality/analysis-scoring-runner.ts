import {ScoringWorkerOwner} from './scoring-worker-owner.ts';
import {AnalysisComponentOwner} from './component-owner.ts';
import type {QualityExecutionContext} from './execution-context.ts';
import type {QualityExecutor} from '../../../shared/service/quality-resources.ts';
/** The application supplies one shared component owner. Standalone runners own
 * theirs explicitly and drain it together with their execution Workers. */
export class AnalysisScoringRunner extends ScoringWorkerOwner {
  protected components:AnalysisComponentOwner;
  readonly ready:Promise<void>;
  private ownsComponents:boolean;
  readonly analysisDir:string;
  private closing?:Promise<void>;
  constructor(library:QualityExecutionContext,coreDir:string,analysisDir:string,executor:QualityExecutor,components?:AnalysisComponentOwner){
    super(library,coreDir,executor);this.analysisDir=analysisDir;this.ownsComponents=!components;
    this.components=components??new AnalysisComponentOwner(analysisDir,library.qualityAdmission);this.ready=this.components.ready;
  }
  override close(){return this.closing??=(async()=>{
    await super.close();
    if(this.ownsComponents)await this.components.close();
  })();}
}
