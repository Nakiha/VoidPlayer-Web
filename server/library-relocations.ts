import type {IndexDatabase} from './sqlite.ts';
import type {LibraryFileCommand,LibraryFileResult} from '../shared/service/library-files.ts';
import type {mutateLibraryFiles} from './library-files.ts';

/** Operation-owned metadata only. Never remaps review, frame-index or quality
 * identities. A temp table bounds JS memory for a large directory move. */
export class LibraryRelocations {
  private db:IndexDatabase;
  readonly epoch:number;
  constructor(db:IndexDatabase, command:LibraryFileCommand, epoch:number) {
    this.db=db;this.epoch=epoch;
    db.exec(`CREATE TEMP TABLE library_relocations(
      owner INTEGER,root_id TEXT,path TEXT,source_id TEXT,source_version TEXT,version TEXT,
      PRIMARY KEY(root_id,path))`);
    const sources=command.operation==='rename'?[command.source]:command.sources;
    if (command.operation==='delete') return;
    sources.forEach((source,owner) => {
      const rootId=command.operation==='move'?command.target.rootId:source.rootId;
      const target=command.operation==='rename'?source.path.slice(0,source.path.lastIndexOf('/')+1)+command.name
        :[command.target.directory,source.path.split('/').at(-1)].filter(Boolean).join('/');
      db.prepare(`INSERT INTO library_relocations(owner,root_id,path,source_id,source_version)
        SELECT ?,?,?||substr(path,?),id,version FROM media WHERE root_id=? AND state='ready'
        AND (path=? OR (?='directory' AND substr(path,1,?)=?)) AND (?='directory' OR version=?)`)
        .run(owner,rootId,target,source.path.length+1,source.rootId,source.path,source.kind,source.path.length+1,
          source.path+'/',source.kind,source.version??'');
    });
  }
  approve(result:Awaited<ReturnType<typeof mutateLibraryFiles>>) {
    result.results.forEach((item:LibraryFileResult['results'][number],owner) => {
      if (!item.ok||!item.destination) return;
      if (item.source.kind==='directory') {
        // Renaming a directory does not change its children's stat versions.
        this.db.prepare('UPDATE library_relocations SET version=source_version WHERE owner=?').run(owner);
      } else {
        const proof=result.relocatedFiles.find(file => file.source===item.source);
        if (proof) this.db.prepare('UPDATE library_relocations SET version=? WHERE owner=? AND source_version=?')
          .run(proof.version,owner,proof.sourceVersion);
      }
    });
  }
  find(rootId:string, path:string, version:string) {
    return this.db.prepare('SELECT source_id AS id,source_version AS version FROM library_relocations WHERE root_id=? AND path=? AND version=?')
      .get(rootId,path,version) as {id:string;version:string}|undefined;
  }
  dispose() {this.db.exec('DROP TABLE library_relocations');}
}
