import type { QualityJobInput } from '../../shared/analysis/quality/jobs.ts';
import type { PairTarget } from '../../shared/analysis/quality/frame-pair.ts';
import { FLV_MEDIA_INDEX_IDENTITY } from '../../shared/media/indexing/media-index-identity.ts';
import { pairRequest } from './frame-pair-fixture.ts';
export function jobInput(): QualityJobInput {
  const target: PairTarget = {mediaId:'a'.repeat(24),mediaVersion:'b'.repeat(24),size:100,indexBuildId:'trusted-test',
    indexIdentity:{...FLV_MEDIA_INDEX_IDENTITY},sourcePtsUs:0,
    picture:{sourceVersion:`${'a'.repeat(24)}@${'b'.repeat(24)}`,stream:'video',configuration:0,au:0,picture:0,layer:0,field:'frame'}};
  return {schema:'voidplayer-psnr-frame-job',version:1,client:{id:'test-agent',kind:'agent'},request:pairRequest(target)};
}
