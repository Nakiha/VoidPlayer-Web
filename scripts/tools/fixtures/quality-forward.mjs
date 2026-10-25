import {encodedForwardFixture} from '../../../test/helpers/forward-pair-fixture.ts';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import path from 'node:path';
import {createHash} from 'node:crypto';import {execFileSync} from 'node:child_process';
const dir=await mkdtemp(path.join(tmpdir(),'vp-forward-fixtures-')),samples=[],sha=b=>createHash('sha256').update(b).digest('hex');
try{for(const [codec,depth]of [['h264',8],['hevc',10]]){
 const f=await encodedForwardFixture(dir,codec,depth),frame=1536*(depth===8?1:2),selectedAus=[2,5],native=Buffer.concat(selectedAus.map(au=>f.native.subarray(au*frame,(au+1)*frame)));
 samples.push({codec,depth,tagged:true,selectedAus,packets:f.packets,flv:f.bytes.toString('base64'),flvSha256:sha(f.bytes),native:native.toString('base64'),nativeSha256:sha(native),allNative:f.native.toString('base64'),allNativeSha256:sha(f.native)});
}
await writeFile(new URL('../../../test/helpers/quality-forward-samples.json',import.meta.url),JSON.stringify({schema:'voidplayer-forward-native-fixtures',version:1,ffmpeg:execFileSync('ffmpeg',['-version'],{encoding:'utf8'}).split('\n')[0],generator:'node scripts/tools/fixtures/quality-forward.mjs',samples},null,2)+'\n');
}finally{await rm(dir,{recursive:true,force:true});}
