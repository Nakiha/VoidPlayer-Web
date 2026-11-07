import type {LibraryFileCommand,LibraryFileResult} from '../../shared/service/library-files.ts';

export class LibraryFileOutcomeUnknownError extends Error {}
/** A lost reply is unknown: never automatically repeat a filesystem mutation. */
export async function mutateLibraryFiles(command:LibraryFileCommand):Promise<LibraryFileResult> {
  let response:Response,body;
  try {
    response=await fetch('/api/library/files',{method:'POST',headers:{'content-type':'application/json','x-voidplayer-action':'library-files'},body:JSON.stringify(command)});
    body=await response.json();
  } catch {throw new LibraryFileOutcomeUnknownError('File operation reply unavailable');}
  if (!response.ok) throw new Error(body.error??`HTTP ${response.status}`);
  return body;
}
