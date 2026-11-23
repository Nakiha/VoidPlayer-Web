import {parseTsPacketIndex} from './ts-packet-index.ts';
import {parseMatroskaPacketIndex} from '../containers/matroska-packet-index.ts';
import { parseAnnexBPacketIndex } from './annex-b-index.ts';
export function parseJsPacketIndex(value:unknown,version:string,size:number){return parseTsPacketIndex(value,version,size)??parseMatroskaPacketIndex(value,version,size)??parseAnnexBPacketIndex(value,version,size);}
