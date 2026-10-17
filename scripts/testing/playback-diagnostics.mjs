import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { beginPlaybackTrace } from './playback-trace.mjs';

// Diagnostics preserve the original benchmark verdict and finish every hook.
// Assertions about playback correctness remain with the owning scenario.
export async function observePlaybackBenchmark({page,call,row,engine,input,decoding,playbackProfile=false,artifact,write=writeFile}) {
          if (row.container === 'ts') await page.evaluate(beginPlaybackTrace);
          let profileSession, profile;
          if (row.container === 'ts' && playbackProfile) {
            assert.equal(engine,'chromium','CPU profiler is an explicit Chromium diagnostic');
            profileSession=await page.context().newCDPSession(page);
            await profileSession.send('Profiler.enable');await profileSession.send('Profiler.start');
          }
          let report, readiness, benchmarkError;
          const diagnosticErrors=[];
          try { report = await call("benchmark_review", { durationMs: 2000 }); }
          catch(error) {benchmarkError=error;}
          finally {
            if (row.container === 'ts') try {readiness = await page.evaluate(()=>window.__finishPlaybackTrace());}
            catch(error){diagnosticErrors.push({phase:'trace-finish',error:String(error)});}
            if (profileSession) {
              try {profile=(await profileSession.send('Profiler.stop')).profile;}catch(error){diagnosticErrors.push({phase:'profile-stop',error:String(error)});}
              finally {try {await profileSession.detach();}catch(error){diagnosticErrors.push({phase:'profile-detach',error:String(error)});}}
            }
          }

          // Persist each row before asserting: a no-presentation report has no
          // track measurements and must produce a useful failure, not a TypeError.
          const playbackEvidence = { engine, input, decoding, fixture: row.fixture, report, diagnosticErrors, ...(benchmarkError ? {benchmarkError:String(benchmarkError)} : {}), ...(readiness ? {readiness} : {}) };
          const drawn = report?.measurements.tracks.A?.drawn ?? 0;
          if (benchmarkError || report.error !== null || report.staleAfterPause || drawn === 0) {
            try {playbackEvidence.state = await call('get_review_session');}catch(error){diagnosticErrors.push({phase:'state',error:String(error)});}
            try {playbackEvidence.logs = await call('get_review_logs', { level: 'debug', limit: 2000 });}catch(error){diagnosticErrors.push({phase:'logs',error:String(error)});}
          }
          let artifactError;
          try {
            await write(artifact(`playback-${input}-${decoding}-${row.codec}.json`), JSON.stringify(playbackEvidence, null, 2));
            if (profile) await write(artifact(`playback-cpu-${input}-${decoding}-${row.codec}.json`),JSON.stringify(profile));
          }catch(error){artifactError=error;}
          if (benchmarkError) throw benchmarkError;
          if (artifactError) throw artifactError;

return report;
}
