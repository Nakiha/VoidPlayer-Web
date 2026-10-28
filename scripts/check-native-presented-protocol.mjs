import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {chromium,webkit} from 'playwright';
import {checkNativePresentedProtocol} from './testing/browser/media/native-presented-protocol.mjs';
import {cleanupResources} from './testing/lifecycle.mjs';

const engine=process.argv[2]??'chromium';
assert.ok(['chromium','webkit'].includes(engine));
const directory=process.env.VOIDPLAYER_TEST_ARTIFACTS??path.resolve('.run/native-presented-protocol',engine);
const fixtures=JSON.parse(await readFile(new URL('../test/helpers/native-presented-samples.json',import.meta.url),'utf8'));
let browser,failure;
try{
 await mkdir(directory,{recursive:true});
 browser=await({chromium,webkit}[engine]).launch({headless:true});
 const reports=await checkNativePresentedProtocol(browser,fixtures,engine);
 assert.equal(reports.length,fixtures.samples.length*5+1);
 await writeFile(path.join(directory,'report.json'),JSON.stringify({engine,reports},null,2));
 console.log(JSON.stringify({engine,checks:reports.length,reports}));
}catch(error){failure={error};}
finally{await cleanupResources([['browser',()=>browser?.close()]],failure);}
