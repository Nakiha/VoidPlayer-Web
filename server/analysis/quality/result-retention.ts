import type { IndexDatabase } from "../../sqlite.ts";

export type ScoringStore = "vmaf" | "xpsnr" | "cambi";
const table = {
  vmaf: "quality_vmaf_jobs",
  xpsnr: "quality_xpsnr_jobs",
  cambi: "cambi_jobs",
} as const;
/** Logical retained UTF-8/BLOB bytes, including immutable inputs and receipts.
 * SQLite page/WAL overhead is outside this application payload budget. */
export function reserveScoringBytes(
  outputBytes: number,
  input: unknown,
  snapshot?: unknown,
) {
  return (
    outputBytes +
    Buffer.byteLength(JSON.stringify(input)) +
    (snapshot === undefined ? 0 : Buffer.byteLength(JSON.stringify(snapshot))) +
    128 * 1024
  );
}
export function settleScoringReservations(
  db: IndexDatabase,
  kind: ScoringStore,
  id?: string,
) {
  const name = table[kind],
    publication =
      kind === "cambi" ? "cambi_publications" : `quality_${kind}_publications`,
    publicationKey = kind === "cambi" ? "job" : "job_id";
  const snapshot =
    kind === "cambi"
      ? ""
      : "+coalesce(length(CAST(snapshot AS BLOB)),0)+coalesce(length(CAST(prepared AS BLOB)),0)";
  const heat =
    kind === "cambi"
      ? "+coalesce((SELECT sum(length(data)) FROM cambi_heat WHERE job=cambi_jobs.id),0)"
      : "";
  db.prepare(
    `UPDATE ${name} SET reserved=1024+length(CAST(body AS BLOB))+coalesce(length(CAST(result AS BLOB)),0) ${snapshot} ${heat}
  +coalesce((SELECT length(CAST(body AS BLOB)) FROM ${publication} WHERE ${publicationKey}=${name}.id),0)
  +coalesce((SELECT length(CAST(body AS BLOB)) FROM quality_reexecutions WHERE job_id=${name}.id),0)
  WHERE json_extract(body,'$.state') NOT IN ('queued','preparing','running','cancelling')${id ? " AND id=?" : ""}`,
  ).run(...(id ? [id] : []));
}
export function releaseScoringResult(
  db: IndexDatabase,
  kind: ScoringStore,
  id: string,
) {
  const name = table[kind];
  db.exec("BEGIN IMMEDIATE");
  try {
    if (kind === "cambi")
      db.prepare("DELETE FROM cambi_heat WHERE job=?").run(id);
    db.prepare(`UPDATE ${name} SET result=NULL WHERE id=?`).run(id);
    settleScoringReservations(db, kind, id);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
