import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';

export type IndexDatabase = Pick<DatabaseSync, 'exec' | 'prepare' | 'close'>;
type BunDatabase = Pick<DatabaseSync, 'exec' | 'prepare'> & { close(force?: boolean): void };

/** Bun's node:sqlite close defers statement finalization to GC, which can keep
 * Windows files open. Its native close(true) finalizes all outstanding statements.
 * https://github.com/oven-sh/bun/blob/bun-v1.4.2/src/jsc/bindings/sqlite/JSSQLStatement.cpp
 */
export function openIndexDatabase(file: string, options: { readOnly?: boolean } = {}): IndexDatabase {
  if (!process.versions.bun) return new DatabaseSync(file, options);
  const { Database } = createRequire(import.meta.url)('bun:sqlite') as { Database: new (file: string, options: { readonly: boolean; create: boolean }) => BunDatabase };
  const db = new Database(file, { readonly: options.readOnly ?? false, create: !options.readOnly });
  return { exec: sql => db.exec(sql), prepare: sql => db.prepare(sql), close: () => db.close(true) };
}
