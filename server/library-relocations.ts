import {promises as fs} from 'node:fs';
import path from 'node:path';
import {fileVersion} from './file-stat.ts';
import type {IndexDatabase} from './sqlite.ts';
import type {LibraryFileCommand,LibraryFileResult} from '../shared/service/library-files.ts';
import type {mutateLibraryFiles} from './library-files.ts';

/** Witnessed application moves retain asset identity and content version.
 * Physical file fingerprints remain independent and are checked before each handoff. */
export class LibraryRelocations {
  private db:IndexDatabase;
  constructor(db:IndexDatabase, command:LibraryFileCommand) {
    this.db=db;
    db.exec(`CREATE TEMP TABLE library_relocations(
      owner INTEGER,root_id TEXT,path TEXT,source_id TEXT,source_version TEXT,source_fingerprint TEXT,version TEXT,
      PRIMARY KEY(root_id,path))`);
    const sources=command.operation==='rename'?[command.source]:command.sources;
    if (command.operation==='delete') return;
    sources.forEach((source,owner) => {
      const rootId=command.operation==='move'?command.target.rootId:source.rootId;
      const target=command.operation==='rename'?source.path.slice(0,source.path.lastIndexOf('/')+1)+command.name
        :[command.target.directory,source.path.split('/').at(-1)].filter(Boolean).join('/');
      db.prepare(`INSERT INTO library_relocations(owner,root_id,path,source_id,source_version,source_fingerprint)
        SELECT ?,?,?||substr(path,?),id,version,fingerprint FROM media WHERE root_id=? AND state='ready'
        AND (path=? OR (?='directory' AND substr(path,1,?)=?)) AND (?='directory' OR version=?)`)
        .run(owner,rootId,target,source.path.length+1,source.rootId,source.path,source.kind,source.path.length+1,
          source.path+'/',source.kind,source.version??'');
    });
  }
  async approve(result:Awaited<ReturnType<typeof mutateLibraryFiles>>, roots:readonly {id:string;path:string}[]) {
    result.results.forEach((item:LibraryFileResult['results'][number],owner) => {
      if (!item.ok||!item.destination) return;
      if (item.source.kind==='directory') {
        // Renaming a directory does not change its children's stat versions.
        this.db.prepare('UPDATE library_relocations SET version=source_fingerprint WHERE owner=?').run(owner);
      } else {
        const proof=result.relocatedFiles.find(file => file.source===item.source);
        if (proof) this.db.prepare('UPDATE library_relocations SET version=? WHERE owner=? AND source_fingerprint=?')
          .run(proof.version,owner,proof.sourceVersion);
      }
    });
    // Read one witness at a time; do not retain an entire directory in JS memory.
    const rows = this.db.prepare('SELECT * FROM library_relocations WHERE version IS NOT NULL').iterate();
    for (const row of rows) {
      const root = roots.find(root => root.id === row.root_id);
      if (!root) continue;
      const stat = await fs.lstat(path.join(root.path,String(row.path))).catch(() => null);
      if (!stat?.isFile() || stat.isSymbolicLink() || fileVersion(stat) !== row.version) continue;
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db.prepare("DELETE FROM media WHERE root_id=? AND path=? AND id!=? AND state='missing'").run(row.root_id,row.path,row.source_id);
        const name = String(row.path), parent = path.posix.dirname(name).replace(/^\.$/,'');
        this.db.prepare('UPDATE media SET root_id=?,path=?,parent=?,fingerprint=? WHERE id=? AND version=? AND fingerprint=?')
          .run(row.root_id,name,parent,row.version,row.source_id,row.source_version,row.source_fingerprint);
        this.db.exec('COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    }
  }
  find(rootId:string, path:string, version:string) {
    return this.db.prepare('SELECT source_id AS id,source_version AS version FROM library_relocations WHERE root_id=? AND path=? AND version=?')
      .get(rootId,path,version) as {id:string;version:string}|undefined;
  }
  dispose() {this.db.exec('DROP TABLE library_relocations');}
}
