/** Explicit filesystem commands. Mounts themselves are never mutable entries. */
export type LibraryFileRef = {rootId:string; path:string; kind:'file'|'directory'; version?:string};
export type LibraryFileTarget = {rootId:string; directory:string};
export type LibraryFileCommand =
  | {operation:'move'; sources:LibraryFileRef[]; target:LibraryFileTarget}
  | {operation:'rename'; source:LibraryFileRef; name:string}
  | {operation:'delete'; sources:LibraryFileRef[]};
export type LibraryFileResult = {
  results:{source:LibraryFileRef; destination?:{rootId:string; path:string}; ok:boolean; error?:string}[];
  indexRefreshed:boolean;
};
export const LIBRARY_FILE_BATCH_LIMIT = 100;
