import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { parseOptions } from './options.mjs';

export const repositoryRoot = path.resolve(import.meta.dirname, '../..');
export const testManifest = JSON.parse(readFileSync(new URL('./manifest.json', import.meta.url), 'utf8'));
const engines = new Set(['node', 'bun', 'chromium', 'webkit', 'chrome', 'msedge']);
const kinds = new Set(['regression', 'helper', 'diagnostic', 'performance', 'manual-regression']);

export function validateManifest(manifest = testManifest, root = repositoryRoot) {
  const failures = [], ids = new Set(), registered = new Set(), aliases = new Map();
  const fail = message => failures.push(message);
  if (new Set(manifest.suites).size !== manifest.suites.length) fail('Duplicate suite');
  for (const [name, fixture] of Object.entries(manifest.fixtures)) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) fail(`Unsafe fixture name: ${name}`);
    const safePath = file => typeof file === 'string' && !path.isAbsolute(file) && !file.split(/[\\/]/).includes('..');
    if (!fixture.paths?.length || !fixture.paths.every(safePath)) fail(`${name}: invalid fixture paths`);
    if (fixture.prepareOnDemand !== undefined && typeof fixture.prepareOnDemand !== 'boolean') fail(`${name}: invalid prepareOnDemand flag`);
    if (fixture.prepareOnDemand && (!fixture.inputs?.length || !fixture.inputs.every(safePath)
      || !Array.isArray(fixture.prepare) || fixture.prepare.length < 2 || fixture.prepare.some(arg => typeof arg !== 'string'))) {
      fail(`${name}: on-demand fixture needs explicit local inputs and a preparation command`);
    }
  }
  for (const row of manifest.cases) {
    if (!/^(scripts|test)\//.test(row.script) || row.script.split('/').includes('..')) fail(`${row.id}: unsafe script path`);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(row.id) || ids.has(row.id)) fail(`Invalid or duplicate ID: ${row.id}`);
    ids.add(row.id); registered.add(row.script);
    if(row.retiredAlias!==undefined){
      const file=path.join(root,'docs/evidence/retired-test-entrypoints.json');
      const retired=existsSync(file)?JSON.parse(readFileSync(file,'utf8')).aliases:[];
      if(row.retiredAlias!==true||!row.implementation||existsSync(path.join(root,row.script))||!retired.some(entry=>entry.script===row.script&&entry.implementation===row.implementation&&entry.caseIds.includes(row.id)))fail(`${row.id}: invalid retired alias record`);
    }else if (!existsSync(path.join(root, row.script))) fail(`Dangling script: ${row.script}`);
    if (row.implementation !== undefined) {
      if (typeof row.implementation !== 'string' || !/^(scripts\/testing\/browser|scripts\/tools\/(development|fixtures|diagnostics|perf|release)|test\/(unit|contract|media))\//.test(row.implementation) || row.implementation.split('/').includes('..')) {
        fail(`${row.id}: unsafe implementation path`);
      } else {
        registered.add(row.implementation);
        if (!existsSync(path.join(root, row.implementation))) fail(`Dangling implementation: ${row.implementation}`);
      }
    }
    if (typeof row.required !== 'boolean') fail(`${row.id}: missing required flag`);
    if (!kinds.has(row.kind)) fail(`${row.id}: unknown kind`);
    if (row.kind !== 'regression' && (!row.restrictions?.length || row.required)) fail(`${row.id}: tool exception needs a reason and required=false`);
    for (const suite of row.suites) if (!manifest.suites.includes(suite)) fail(`${row.id}: unknown suite ${suite}`);
    for (const engine of row.engines) if (!engines.has(engine)) fail(`${row.id}: unknown engine ${engine}`);
    if (row.npmAliases !== undefined) {
      if (!Array.isArray(row.npmAliases)) fail(`${row.id}: invalid npm aliases`);
      else for (const binding of row.npmAliases) {
        if (typeof binding?.name !== 'string' || !/^test:[a-z0-9][a-z0-9:-]*$/.test(binding.name) || typeof binding.default !== 'boolean'
          || row.kind !== 'regression' || row.engines.length !== 1
          || binding.argumentPrefixes !== undefined && (!Array.isArray(binding.argumentPrefixes) || binding.argumentPrefixes.some(prefix => typeof prefix !== 'string' || !/^--[a-z][a-z-]*=$/.test(prefix)))) {
          fail(`${row.id}: invalid npm alias binding`); continue;
        }
        const entries = aliases.get(binding.name) ?? [];
        entries.push({ row, binding }); aliases.set(binding.name, entries);
      }
    }
    if (!row.platforms.length || row.platforms.some(p => !['linux', 'darwin', 'win32'].includes(p))) fail(`${row.id}: invalid platforms`);
    if (!row.inputs.length || !row.artifacts.length || !(row.timeoutMs > 0) || typeof row.build !== 'boolean') fail(`${row.id}: missing execution metadata`);
    const entry = row.implementation ?? row.script;
    if (!Array.isArray(row.command) || row.command.length < 2 || row.command.filter(arg => arg === entry || arg === './' + entry).length !== 1
      || row.implementation && row.command.some(arg => arg === row.script || arg === './' + row.script)) fail(`${row.id}: command does not execute its canonical implementation exactly once`);
    for (const fixture of row.fixtures) if (!manifest.fixtures[fixture]) fail(`${row.id}: unknown fixture ${fixture}`);
    if (row.suites.some(suite => ['fast', 'source'].includes(suite)) && (row.fixtures.length || row.tools.length || row.build || row.engines.join() !== 'node')) fail(`${row.id}: source/fast requires source-only Node checks`);
    if (row.kind === 'regression' && row.suites.includes('unit') && !row.fixtures.length && !row.tools.length && !row.build && row.engines.join() === 'node' && !row.suites.includes('source')) fail(`${row.id}: source-only Node check missing from source suite`);
  }
  for (const [name, entries] of aliases) {
    if (entries.filter(entry => entry.binding.default).length !== 1) fail(`${name}: npm alias needs exactly one default`);
    if (new Set(entries.map(entry => entry.row.engines[0])).size !== entries.length) fail(`${name}: duplicate npm alias engine`);
    const scripts = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).scripts;
    if (scripts[name] !== `node scripts/run-tests.mjs --alias ${name}`) fail(`${name}: npm alias must only delegate to runner`);
  }
  for (const [name, recipe] of Object.entries(manifest.npmCommands ?? {})) {
    const scripts=existsSync(path.join(root,'package.json'))?JSON.parse(readFileSync(path.join(root,'package.json'),'utf8')).scripts:{};
    if (!/^test:[a-z0-9][a-z0-9:-]*$/.test(name)||aliases.has(name)||scripts[name]!==`node scripts/run-tests.mjs --alias ${name}`) fail(`${name}: invalid npm command delegation`);
    if (!Array.isArray(recipe.cases)||!recipe.cases.length) {fail(`${name}: missing canonical cases`);continue;}
    const refs=[...recipe.cases.map(step=>step.id),...Object.values(recipe.engineCases??{}),...Object.values(recipe.environmentEngine?.cases??{})];
    if(new Set(recipe.cases.map(step=>step.id)).size!==recipe.cases.length)fail(`${name}: duplicate npm stages`);
    for(const [engine,id] of Object.entries({...recipe.engineCases,...recipe.environmentEngine?.cases})) {
      const row=manifest.cases.find(row=>row.id===id),first=manifest.cases.find(row=>row.id===recipe.cases[0].id);
      if(!engines.has(engine)||!row?.engines.includes(engine)||(row?.implementation??row?.script)!==(first?.implementation??first?.script))fail(`${name}: invalid engine variant`);
    }
    for(const id of refs) if(!manifest.cases.some(row=>row.id===id&&['regression','manual-regression','diagnostic'].includes(row.kind)))fail(`${name}: unknown executable case ${id}`);
    for(const step of recipe.cases)if(step.args!==undefined&&(!Array.isArray(step.args)||step.args.some(arg=>typeof arg!=='string')))fail(`${name}: invalid legacy arguments`);
    if(recipe.sequential!==undefined&&typeof recipe.sequential!=='boolean')fail(`${name}: invalid sequence policy`);
    if(recipe.environmentEngine&&recipe.environmentEngine.name!=='IDENTITY_BROWSER')fail(`${name}: unknown engine environment`);
    if(recipe.matrixArguments&&JSON.stringify(recipe.matrixArguments)!=='["engine","input"]')fail(`${name}: unknown matrix arguments`);
    if(recipe.archiveInput&&(recipe.archiveInput.fixture!=='release-package'||recipe.archiveInput.position!==0||!Array.isArray(recipe.archiveInput.ignoreArgs)||recipe.archiveInput.ignoreArgs.some(arg=>typeof arg!=='string')||recipe.archiveInput.defaultToken!==undefined&&recipe.archiveInput.defaultToken!=='-'))fail(`${name}: invalid archive input policy`);
  }
  function inspect(directory, category) {
    for (const entry of readdirSync(path.join(root, directory), { withFileTypes: true })) {
      const relative = `${directory}/${entry.name}`;
      if (entry.isDirectory()) { inspect(relative, category); continue; }
      const candidate = category === 'test' ? /\.test\.(ts|mjs)$/.test(entry.name)
        : /^(check-|bench-|repro-|diagnose-|test-|compare-index).*\.(mjs|ts|py)$/.test(entry.name)
          || /^(scripts\/testing\/browser|scripts\/tools)\//.test(relative) && /\.mjs$/.test(entry.name);
      if (candidate && !registered.has(relative)) fail(`Unregistered check: ${relative}`);
    }
  }
  for (const category of ['test', 'scripts']) inspect(category, category);
  if (failures.length) throw new AggregateError(failures.map(message => new Error(message)), failures.join('\n'));
  return true;
}

/** Expand the checked-in workflow's explicit suite and case matrices. Fail
 * closed on unsupported interpolation instead of treating it as a wildcard. */
export function validateCiBrowserCoverage(workflows, manifest = testManifest) {
  const covered = new Set();
  for (const source of workflows) {
    const jobs = source.slice(source.indexOf('\njobs:\n') + 7);
    for (const [, body] of jobs.matchAll(/^  [\w-]+:\n([\s\S]*?)(?=^  [\w-]+:\n|$(?![\s\S]))/gm)) {
      for (const [, command] of body.matchAll(/run-tests\.mjs ([^\n]+)/g)) {
        if (command.startsWith('--prepare') || command.startsWith('--check')) continue;
        let expanded = [command];
        for (const variable of new Set([...command.matchAll(/\$\{\{ matrix\.(\w+) \}\}/g)].map(match => match[1]))) {
          const list = new RegExp(`^\\s+${variable}: \\[([^\\]]+)\\]`, 'm').exec(body);
          if (!list) throw new Error(`Unsupported CI matrix ${variable}`);
          const values = list[1].split(',').map(value => value.trim());
          expanded = expanded.flatMap(text => values.map(value => text.replaceAll('${{ matrix.' + variable + ' }}', value)));
        }
        for (const text of expanded) {
          if (text.includes('${{')) throw new Error(`Unsupported CI command: ${text}`);
          const options = parseOptions(text.trim().split(/\s+/));
          if (options.caseArguments?.length || manifest.npmCommands?.[options.alias]) throw new Error('CI coverage cannot claim a filtered or customized compatibility case');
          for (const platform of ['linux', 'darwin', 'win32']) {
            for (const row of selectCases({ ...options, platform }, manifest).selected) covered.add(row.id);
          }
        }
      }
    }
  }
  const missing = manifest.cases.filter(row => row.required && row.kind === 'regression' && row.suites.includes('browser') && !covered.has(row.id));
  if (missing.length) throw new Error(`Required browser cells missing from CI: ${missing.map(row => row.id).join(', ')}`);
  return true;
}

export function selectCases({ suite, caseIds = [], alias, caseArguments = [], engine, input, platform = process.platform } = {}, manifest = testManifest) {
  if (!['linux', 'darwin', 'win32'].includes(platform)) throw new Error(`Unknown platform: ${platform}`);
  if (suite && !manifest.suites.includes(suite)) throw new Error(`Unknown suite: ${suite}`);
  if (engine && !engines.has(engine)) throw new Error(`Unknown engine: ${engine}`);
  if (alias) {
    if (suite || caseIds.length || input) throw new Error('An npm alias cannot be combined with another case selection');
    if(manifest.npmCommands?.[alias])return selectNpmCommand(alias,caseArguments,engine,platform,manifest);
    const bound = manifest.cases.filter(row => row.npmAliases?.some(binding => binding.name === alias));
    if (!bound.length) throw new Error(`Unknown npm alias: ${alias}`);
    const matches = bound.filter(row => engine ? row.engines.includes(engine) : row.npmAliases.some(binding => binding.name === alias && binding.default));
    if (matches.length !== 1) throw new Error(`Ambiguous or unsupported engine for npm alias ${alias}`);
    const binding = matches[0].npmAliases.find(binding => binding.name === alias);
    for (const arg of caseArguments) if (!binding.argumentPrefixes?.some(prefix => arg.startsWith(prefix))) throw new Error(`Unsupported case argument for npm alias ${alias}: ${arg}`);
    caseIds = [matches[0].id];
  }
  for (const id of caseIds) if (!manifest.cases.some(row => row.id === id && row.kind === 'regression')) throw new Error(`Unknown runnable case: ${id}`);
  if (caseArguments.length && !alias) throw new Error('Case arguments require a declared npm alias');
  if (!suite && !caseIds.length) throw new Error('Select a suite or --case ID');
  const selected = [], excluded = [];
  for (const row of manifest.cases) {
    if (row.kind !== 'regression' || suite && !row.suites.includes(suite) || caseIds.length && !caseIds.includes(row.id)) continue;
    const reason = !row.platforms.includes(platform) ? `platform ${platform} outside ${row.platforms.join('/')}`
      : engine && !row.engines.includes(engine) ? `engine ${engine} outside ${row.engines.join('/')}`
      : input && !row.inputs.includes(input) ? `input ${input} outside ${row.inputs.join('/')}` : null;
    if (reason) excluded.push({ id: row.id, reason }); else selected.push(caseArguments.length ? { ...row, command: [...row.command, ...caseArguments], executionScope: 'filtered' } : row);
  }
  return { selected, excluded };
}

function selectNpmCommand(alias,args,engine,platform,manifest){
  const recipe=manifest.npmCommands[alias];let steps=recipe.cases;
  if(recipe.matrixArguments){
    let selectors=args;
    if(engine){
      if(args[0]&&engines.has(args[0])){if(args[0]!==engine)throw new Error(`Conflicting engine for ${alias}`);}
      else selectors=[engine,...args];
    }
    if(selectors.length>2||selectors[0]&&!['webkit','chromium'].includes(selectors[0])||selectors[1]&&!['local','remote'].includes(selectors[1]))throw new Error(`Unsupported matrix arguments for ${alias}`);
    steps=steps.filter(step=>{const row=manifest.cases.find(row=>row.id===step.id);return (!selectors[0]||row.engines.includes(selectors[0]))&&(!selectors[1]||row.inputs.includes(selectors[1]));});
  }else{
    if(engine&&recipe.engineCases&&!Object.hasOwn(recipe.engineCases,engine))throw new Error(`Unsupported engine for ${alias}: ${engine}`);
    if(recipe.engineCases&&args[0]&&!args[0].startsWith('-')&&!Object.hasOwn(recipe.engineCases,args[0]))throw new Error(`Unsupported engine for ${alias}: ${args[0]}`);
    const selected=recipe.environmentEngine?(Object.hasOwn(recipe.environmentEngine.cases,process.env[recipe.environmentEngine.name])?recipe.environmentEngine.cases[process.env[recipe.environmentEngine.name]]:undefined):recipe.engineCases?.[engine??args.find(arg=>Object.hasOwn(recipe.engineCases??{},arg))];
    if(engine&&!recipe.engineCases)throw new Error(`${alias}: use the declared legacy positional arguments`);
    if(selected)steps=steps.map((step,i)=>i?step:{...step,id:selected});
    if(engine)args=[engine,...args];
  }
  const selected=[],excluded=[];
  for(const [i,step]of steps.entries()){
    const row=manifest.cases.find(row=>row.id===step.id);
    if(!row.platforms.includes(platform)){excluded.push({id:row.id,reason:`platform ${platform} outside ${row.platforms.join('/')}`});continue;}
    const entry=row.implementation??row.script,at=row.command.findIndex(arg=>arg===entry||arg==='./'+entry);
    const command=step.args===undefined?[...row.command]:[...row.command.slice(0,at+1),...step.args];
    if(!recipe.matrixArguments&&i===steps.length-1)command.push(...args);
    const archive=recipe.archiveInput,archiveArgs=archive?command.slice(at+1).filter(arg=>!archive.ignoreArgs.includes(arg)):[];
    const explicitArchive=archive&&archiveArgs[archive.position]!==undefined&&archiveArgs[archive.position]!==archive.defaultToken;
    const fixtures=explicitArchive?row.fixtures.filter(name=>name!==archive.fixture):row.fixtures;
    selected.push({...row,command,fixtures,required:true,executionScope:'legacy-npm-alias',npmAlias:alias});
  }
  return {selected,excluded,stopOnFailure:recipe.sequential===true};
}

export function browserEntries(suite) {
  return testManifest.cases.filter(row => row.suites.includes(suite)).sort((a, b) => (a.legacyOrder ?? (a.engines[0] === 'chromium' ? 0 : 1)) - (b.legacyOrder ?? (b.engines[0] === 'chromium' ? 0 : 1)))
    .map(row => ({ ...row, name: `${path.basename(row.script, '.mjs')}-${row.engines[0]}`, args: row.command.slice(1) }));
}
