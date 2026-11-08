import path from 'node:path';
import { loadConfig } from '../server/config.ts';
import { publishFrontend } from '../server/frontend-releases.ts';

const args = process.argv.slice(2);
const source = args[0] && !args[0].startsWith('--') ? args.shift() : 'dist';
const retain = args.indexOf('--retain');
if (retain >= 0) args.splice(retain, 1);
const config = await loadConfig(args, 'production', process.cwd(), { allowEmptyRoots: true });
const store = path.join(config.dataDir, 'frontend-releases');
console.log(retain >= 0 ? 'Retained' : 'Published', await publishFrontend(path.resolve(source), store, retain >= 0 ? 'retain' : 'activate'), 'to', store);
