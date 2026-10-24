import type { BigIntStats } from 'node:fs';
export type FileStatWitness = {size:string;dev:string;ino:string;mtimeNs:string;ctimeNs:string};
export const fileStatWitness=(stat:BigIntStats):FileStatWitness=>({size:String(stat.size),dev:String(stat.dev),ino:String(stat.ino),mtimeNs:String(stat.mtimeNs),ctimeNs:String(stat.ctimeNs)});
export const sameFileStat=(a:FileStatWitness,b:FileStatWitness)=>Object.keys(a).every(key=>a[key as keyof FileStatWitness]===b[key as keyof FileStatWitness]);
