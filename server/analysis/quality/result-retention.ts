import type { IndexDatabase } from "../../sqlite.ts";

export type ScoringStore = "vmaf" | "xpsnr" | "cambi";
const table = {
  vmaf: "quality_vmaf_jobs",
  xpsnr: "quality_xpsnr_jobs",
  cambi: "cambi_jobs",
} as const;
/** Submission reserves worst-case output while a task can still write. Once
 * physically stopped, charge retained output bytes instead. Idempotency receipts,
 * frozen inputs and annotation operations have a separate lifetime. */
export function settleScoringReservations(
  db: IndexDatabase,
  kind: ScoringStore,
) {
  const name = table[kind];
  const heat =
    kind === "cambi"
      ? "+ coalesce((SELECT sum(length(data)) FROM cambi_heat WHERE job=cambi_jobs.id),0)"
      : "";
  db.exec(`UPDATE ${name} SET reserved=coalesce(length(CAST(result AS BLOB)),0) ${heat}
    WHERE json_extract(body,'$.state') NOT IN ('queued','preparing','running','cancelling')`);
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
    db.prepare(`UPDATE ${name} SET result=NULL,reserved=0 WHERE id=?`).run(id);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
