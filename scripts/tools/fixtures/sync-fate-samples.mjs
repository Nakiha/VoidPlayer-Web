import { fileURLToPath } from 'node:url';
import { fateManifest, readFateManifests, syncFateFixtures } from '../../testing/fate-fixtures.ts';

const args = process.argv.slice(2);
if (args.length > 1 || args.some(arg => !['--cache-key', '--verify'].includes(arg)))
  throw new Error('Usage: node scripts/sync-fate-samples.mjs [--cache-key|--verify]');
const documents = await readFateManifests();
if (args[0] === '--cache-key') console.log(fateManifest(documents).key);
else {
  const result = await syncFateFixtures(fileURLToPath(new URL('../../../fixtures/fate/', import.meta.url)), documents,
    {verifyOnly:args[0] === '--verify'});
  console.log(`FATE ${result.key}: verified ${result.verified}; cached ${result.cached}; downloaded ${result.downloaded}`);
}
