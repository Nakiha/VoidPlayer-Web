import json,hashlib,statistics,gzip,argparse
from pathlib import Path
parser=argparse.ArgumentParser();parser.add_argument('--output',default='.run/demux-evidence-summary');options=parser.parse_args();
root=Path('.');output=Path(options.output);output.mkdir(exist_ok=True);raw=output/'raw';raw.mkdir(exist_ok=True)
summary={'schema':'voidplayer-demux-removal-evidence-v1','baseline':'c787553ed98818085fc49fc6cdc400a6ebd2261e','core':'e88064cb20e4ae4dfad5395a6bf1103a9efa0154','benchmarkMethod':{'durationMs':8000,'repetitions':3,'scenarios':'all four original defaults','headless':True,'thresholdsModified':False,'hardwareUseVerified':False,'statisticalNonRegressionClaim':False,'earlyWebkitBaselineConfounded':'early baseline ~0.5x, adjacent baseline later passes; retain both cohorts, do not infer a2x product improvement'},'ioMethod':{'fixturesPerFullCell':8,'repeats':['cold','warm1','warm2'],'latePositions':[0.6,0.93],'osCacheFlushed':False,'coldDefinition':'fresh source-index DB and browser context; host OS cache remains warm','timing':'page performance.now around actual load/seek tool until presentation; wrapper wallMs includes observation','bodyBytes':'completed HTTP response Content-Length; aborted bodies remain unknown, HEAD contributes0','diskBytes':'real filesystem reads reported by index build; includes OS cache, not physical device IO','wasm':'instrumented supplemental ccall boundary records actual HEAPU8.byteLength reserved capacity and accepted packet inputs; container-internal packet advancement remains null','memory':'server Node RSS sampled10ms incl its Workers; Chromium main-context heap snapshots and client WASM linear capacity are separate components; browser Worker JS/GPU/combined peak remain null'},'benchmarks':[],'io':[],'raw':[]}
def stat(values):
 a=[x for x in values if x is not None];return {'values':values,'min':min(a)if a else None,'median':statistics.median(a)if a else None,'max':max(a)if a else None}
def archive(p,cohort):
 b=p.read_bytes();name=f'{cohort}-{p.name}.gz';compressed=gzip.compress(b,mtime=0);(raw/name).write_bytes(compressed);rec={'file':'raw/'+name,'sourceCohort':cohort,'sha256':hashlib.sha256(b).hexdigest(),'gzipSha256':hashlib.sha256(compressed).hexdigest(),'uncompressedBytes':len(b),'bytes':len(compressed)};summary['raw'].append(rec);return rec['file']
for cohort,folder in [('initial','demux-removal-evidence'),('components','demux-removal-instrumented'),('preroll','demux-removal-final')]:
 for p in sorted((root/'.run'/folder).glob('*.json')):
  d=json.loads(p.read_text())
  if not isinstance(d,dict)or not d.get('finishedAt')or d.get('mode')not in ['bench','io','io-plain']:continue
  ref=archive(p,cohort);base={k:d.get(k)for k in ['label','engine','mode','head','startedAt','finishedAt','instrumented','fixtureFilter']};base.update({'cohort':cohort,'sourceDigest':d.get('build',{}).get('sourceDigest'),'raw':ref})
  if d['mode']=='bench':
   groups=[]
   for scenario in dict.fromkeys(r['scenario']for r in d['rows']):
    rows=[r for r in d['rows']if r['scenario']==scenario];groups.append({'scenario':scenario,'passes':sum(r.get('passed',False)for r in rows),'runs':len(rows),'speed':stat([r.get('measurements',{}).get('speed')for r in rows]),'startupAfterLoadMs':stat([r.get('startupMs')for r in rows]),'firstPresentationAfterPlayMs':stat([r.get('measurements',{}).get('firstPresentationMs')for r in rows]),'failures':[r.get('failures',r.get('error'))for r in rows],'backends':[[{'name':t.get('name'),'decoder':t.get('decoder'),'coreVariant':t.get('coreVariant')}for t in r.get('tracks',[])]for r in rows]})
   summary['benchmarks'].append({**base,'exit':d.get('exit'),'passes':sum(r.get('passed',False)for r in d['rows']),'runs':len(d['rows']),'groups':groups});continue
  fixtures=[]
  for row in d['rows']:
   phases=row['phases'];groups={}
   for suffix in ['open','seek0.6','seek0.93','analysis-cancel','close']:
    a=[r for r in phases if r['phase'].split(':',1)[-1]==suffix];key='loadAndPresentMs'if suffix=='open'else'seekAndPresentMs'if suffix.startswith('seek')else None
    groups[suffix]={'latencyMs':stat([r.get('result',{}).get(key,r.get('wallMs'))for r in a]),'mediaBodyBytes':[r.get('completedMediaBodyBytes')for r in a],'indexBodyBytes':[r.get('completedIndexBodyBytes')for r in a],'requestCount':[len(r.get('mediaRequests',[]))for r in a],'incompleteBodies':[r.get('incompleteResponseBodies')for r in a],'decoderPacketsAdvanced':[r.get('decoderPacketsAdvanced')for r in a],'errors':[r.get('error')for r in a]}
   rss=[r.get('serverMaxObservedRssBytes')for r in phases if r.get('serverMaxObservedRssBytes')is not None];wasm=[r.get('wasmLinearCapacityMaxObservedBytes')for r in phases if r.get('wasmLinearCapacityMaxObservedBytes')is not None];heap=[r.get(k,{}).get('usedJSHeapSize')for r in phases for k in ['mainHeapBefore','mainHeapAfter']if r.get(k)and r[k].get('usedJSHeapSize')is not None]
   fixtures.append({'name':row['name'],'size':row['size'],'sha256':row['sha256'],'error':row.get('error'),'pageErrors':row.get('errors'),'operations':groups,'indexBuilds':[b for b in row.get('serverBuilds',[])if b.get('built')],'memory':{'serverMaxObservedRssBytes':max(rss)if rss else None,'clientMaxObservedActiveWasmLinearCapacityBytes':max(wasm)if wasm else None,'chromiumMainHeapMaxSnapshotBytes':max(heap)if heap else None,'workerJsHeapBytes':None,'gpuBytes':None,'totalApplicationPeakBytes':None}})
  summary['io'].append({**base,'fixtures':fixtures})
(output/'summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2)+'\n')
print('cohorts',len(summary['benchmarks']),len(summary['io']),'rawBytes',sum(x['bytes']for x in summary['raw']))
for x in summary['benchmarks']:print(x['label'],x['engine'],x['head'][:8],x['passes'],x['runs'])
