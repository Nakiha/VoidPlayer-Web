import path from 'node:path';
import type { MediaLibraryIndex } from './library.ts';
import { AdminError } from './admin-error.ts';
import { closeResources, cleanupAfterFailure } from './shutdown.ts';
import { LibraryPairRunner } from './analysis/quality/runner.ts';
import { QualityJobService } from './analysis/quality/job-service.ts';
import { QualityRangeService } from './analysis/quality/range-service.ts';
import { CorrespondenceService } from './analysis/quality/correspondence-service.ts';
import { QualityReexecutionService } from './analysis/quality/reexecution-service.ts';
import { LibraryDiscoveryService } from './discovery/service.ts';
import { NativeCambiService } from './analysis/cambi/service.ts';
import { NativeVmafService } from './analysis/vmaf/service.ts';
import { NativeXpsnrService } from './analysis/xpsnr/service.ts';
import { WasmCambiRunner } from './analysis/cambi/wasm-runner.ts';
import { WasmVmafRunner } from './analysis/vmaf/wasm-runner.ts';
import { WasmXpsnrRunner } from './analysis/xpsnr/wasm-runner.ts';
import { TaskCenterService } from './tasks/service.ts';

/** Composition root for quality services. Property reads never create resources.
 * The application owns execution drain, dependent readers and final disposal. */
export class QualityApplication {
  readonly ready: Promise<void>;
  private closing?: Promise<void>;
  private jobs?: QualityJobService;
  private ranges?: QualityRangeService;
  private correspondence?: CorrespondenceService;
  private cambi?: NativeCambiService;
  private vmaf?: NativeVmafService;
  private xpsnr?: NativeXpsnrService;
  private reexecutions?: QualityReexecutionService;
  private taskCenter?: TaskCenterService;
  readonly quality: LibraryPairRunner;
  private preparation?:LibraryDiscoveryService;
  get discovery(){return this.required(this.preparation);}
  constructor(privateLibrary: MediaLibraryIndex, options: {coreDir?:string;analysisCoreDir?:string;pairRunner?:LibraryPairRunner} = {}) {
    this.library = privateLibrary;
    const coreDir=path.resolve(options.coreDir ?? privateLibrary.corePaths.decoding);
    const analysisDir=options.analysisCoreDir ?? privateLibrary.corePaths.analysis;
    const execution={indexDatabase:privateLibrary.indexDatabase,qualityAdmission:privateLibrary.qualityAdmission};
    this.quality=options.pairRunner??new LibraryPairRunner(execution,coreDir);
    privateLibrary.attachQualityApplication(this);
    this.ready=this.initialize(coreDir,analysisDir,execution);
    void this.ready.catch(()=>{});
  }
  private library: MediaLibraryIndex;
  private async initialize(coreDir:string,analysisDir:string,execution:{indexDatabase:string;qualityAdmission:MediaLibraryIndex['qualityAdmission']}) {
    try {
      this.preparation=new LibraryDiscoveryService({...execution,durableQualityJobsEnabled:this.library.durableQualityJobsEnabled,quality:this.quality});
      if(!this.library.durableQualityJobsEnabled)return;
      const file=this.library.indexDatabase;
      this.jobs=new QualityJobService(file+'.quality.sqlite',this.quality);
      this.ranges=new QualityRangeService(file+'.quality-ranges.sqlite',this.jobs);
      this.correspondence=new CorrespondenceService(file+'.quality-correspondence.sqlite',this.quality,this.ranges);
      this.cambi=new NativeCambiService(file+'.quality-cambi.sqlite',new WasmCambiRunner(execution,coreDir,analysisDir));
      this.xpsnr=new NativeXpsnrService(file+'.quality-xpsnr.sqlite',new WasmXpsnrRunner(execution,coreDir,analysisDir),this.correspondence);
      this.vmaf=new NativeVmafService(file+'.quality-vmaf.sqlite',new WasmVmafRunner(execution,coreDir,analysisDir),this.correspondence);
      const services={quality:this.quality,qualityJobs:this.jobs,qualityRanges:this.ranges,qualityCorrespondence:this.correspondence,
        qualityCambi:this.cambi,qualityVmaf:this.vmaf,qualityXpsnr:this.xpsnr};
      this.reexecutions=new QualityReexecutionService(services);
      this.taskCenter=new TaskCenterService({...services,qualityReexecutions:this.reexecutions,discovery:this.discovery,durableQualityJobsEnabled:true},{
        preparation:(id,actor)=>this.discovery.cancel(id,actor),
        correspondence:(id,actor)=>this.correspondence!.cancel(id,actor),
        single:(id,actor,requestId)=>this.jobs!.cancel(id,actor,requestId),
        range:(id,actor)=>this.ranges!.cancel(id,actor),
        vmaf:(id,actor)=>this.vmaf!.cancel(id,actor),
        xpsnr:(id,actor)=>this.xpsnr!.cancel(id,actor),
        cambi:(id,actor)=>this.cambi!.cancel(id,actor),
      });
      await Promise.all([this.cambi.ready,this.xpsnr.ready,this.vmaf.ready]);
    } catch(error) {
      return cleanupAfterFailure(error,'Quality application initialization failed',[['application',()=>this.close()]]);
    }
  }
  private required<T>(value:T|undefined):T {
    if(!value)throw new AdminError(503,'Quality tasks require initialized persistent storage.','quality-storage-unavailable');
    return value;
  }
  get qualityJobs(){return this.required(this.jobs);}
  get qualityRanges(){return this.required(this.ranges);}
  get qualityCorrespondence(){return this.required(this.correspondence);}
  get qualityCambi(){return this.required(this.cambi);}
  get qualityVmaf(){return this.required(this.vmaf);}
  get qualityXpsnr(){return this.required(this.xpsnr);}
  get qualityReexecutions(){return this.required(this.reexecutions);}
  get tasks(){return this.required(this.taskCenter);}
  get nativeCambiDescriptor(){return this.cambi?.descriptor??null;}
  get nativeVmafDescriptor(){return this.vmaf?.descriptor??null;}
  get nativeXpsnrDescriptor(){return this.xpsnr?.descriptor??null;}
  close(external?:Promise<void>) {
    return this.closing??=this.closeOwned(external);
  }
  private async closeOwned(external?:Promise<void>) {
    const internal=(async()=>{
      // Start every independent stop before waiting; stores remain readable to
      // range/reexecution/coordinator consumers until the entire drain succeeds.
      await closeResources('Quality execution drain incomplete',[
        ['task observations',()=>this.taskCenter?.close()],
        ['reexecution planning',()=>this.reexecutions?.close()],
        ['correspondence',()=>this.correspondence?.stopExecution()],
        ['CAMBI',()=>this.cambi?.stopExecution()],
        ['XPSNR',()=>this.xpsnr?.stopExecution()],
        ['VMAF',()=>this.vmaf?.stopExecution()],
        ['preparation',()=>this.preparation?.stopExecution()],
        ['ranges',()=>this.ranges?.stopExecution()],
        ['single jobs',()=>this.jobs?.stopExecution()],
        ['pair executor',()=>this.quality.close()],
        ['media execution',()=>this.library.stopExecution()],
      ]);
      await closeResources('Quality storage disposal incomplete',[
        ['range storage',()=>this.ranges?.close()],
        ['correspondence storage',()=>this.correspondence?.close()],
        ['single storage',()=>this.jobs?.close()],
        ['CAMBI storage',()=>this.cambi?.close()],
        ['XPSNR storage',()=>this.xpsnr?.close()],
        ['VMAF storage',()=>this.vmaf?.close()],
        ['preparation storage',()=>this.preparation?.close()],
      ]);
    })();
    await closeResources('Application shutdown incomplete; shared media ownership retained',[
      ['quality owners',()=>internal],['external media owners',()=>external],
    ]);
    this.library.releaseStorage();
  }
}
