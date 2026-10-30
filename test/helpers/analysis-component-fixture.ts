import {AnalysisComponentOwner} from '../../server/analysis/quality/component-owner.ts';
/** Replace the explicit verifier and its execution location together. Tests
 * never mutate the application-shared owner used by another metric. */
export async function replaceRunnerAnalysisDirectory(runner:any,directory:string){
 const previous={components:runner.components,analysisDir:runner.analysisDir,ownsComponents:runner.ownsComponents};
 const components=new AnalysisComponentOwner(directory,runner.admission);await components.ready;
 runner.components=components;runner.analysisDir=directory;runner.ownsComponents=true;
 return async()=>{await components.close();Object.assign(runner,previous);};
}
