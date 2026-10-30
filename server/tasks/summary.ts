import type { IndexDatabase } from "../sqlite.ts";
import { AdminError } from "../admin-error.ts";
import { TASK_LIMITS } from "../../shared/service/tasks.ts";
import { QUALITY_RANGE_LIMITS } from "../../shared/analysis/quality/ranges.ts";
import type {
  TaskKind,
  TaskSummary,
  TaskFilter,
} from "../../shared/service/tasks.ts";

export const originalPath = (kind: TaskKind, id: string) =>
  ({
    preparation: "/api/library/preparations/",
    correspondence: "/api/quality/correspondence-plans/",
    single: "/api/quality/jobs/",
    range: "/api/quality/ranges/",
    vmaf: "/api/quality/vmaf/jobs/",
    xpsnr: "/api/quality/xpsnr/jobs/",
    cambi: "/api/quality/cambi/jobs/",
  })[kind] + encodeURIComponent(id);
export type TaskEdge = {
  from: TaskKind;
  id: string;
  to: TaskKind;
  target: string;
  relation: string;
  attemptId?: string;
  digest?: string;
};
// At most 8 * 1024 minimal edges/results at once, independent of history size.
export const TASK_RETENTION_BATCH = 8;
const retentionChildren = TASK_RETENTION_BATCH * QUALITY_RANGE_LIMITS.samples;
export function rangeTaskChildren(
  db: IndexDatabase,
  actor: string,
  parents: readonly string[],
): TaskEdge[] {
  if (parents.length > TASK_RETENTION_BATCH)
    throw new Error("Range retention batch exceeds its metadata budget");
  if (!parents.length) return [];
  const rows = db
    .prepare(
      `SELECT p.id,json_extract(s.value,'$.jobId') AS target,json_extract(s.value,'$.result.attemptId') AS attempt,json_extract(s.value,'$.result.digest') AS digest
    FROM json_each(?) selected CROSS JOIN quality_ranges p JOIN json_each(p.body,'$.samples') s
    WHERE p.id=selected.value AND p.actor=? LIMIT ?`,
    )
    .all(JSON.stringify([...new Set(parents)]), actor, retentionChildren + 1);
  if (rows.length > retentionChildren)
    throw new AdminError(
      503,
      "Range samples exceed the metadata budget.",
      "task-snapshot-budget",
    );
  return edgeRows(rows, "range");
}
export function retainedTaskResults(
  db: IndexDatabase,
  actor: string,
  ids: readonly string[],
) {
  if (ids.length > retentionChildren)
    throw new Error("Child retention batch exceeds its metadata budget");
  if (!ids.length)
    return new Map<string, Pick<TaskSummary, "attemptId" | "resultDigest">>();
  // Never copy/parse result_json, input_json, or unrelated actors' records.
  const rows = db
    .prepare(
      `SELECT q.id,q.attempt_id,q.result_sha FROM json_each(?) selected CROSS JOIN quality_jobs q
    WHERE q.id=selected.value AND q.actor_id=? AND q.result_sha IS NOT NULL AND q.result_json IS NOT NULL LIMIT ?`,
    )
    .all(JSON.stringify([...new Set(ids)]), actor, retentionChildren + 1);
  return new Map(
    rows.map((row) => [
      String(row.id),
      {
        attemptId: row.attempt_id === null ? null : String(row.attempt_id),
        resultDigest: String(row.result_sha),
      },
    ]),
  );
}
function edgeRows(
  rows: Record<string, unknown>[],
  kind: "range" | "correspondence" | "vmaf" | "xpsnr",
): TaskEdge[] {
  return rows.map((r) => ({
    from: kind,
    id: String(r.id),
    to:
      kind === "range"
        ? "single"
        : kind === "correspondence"
          ? "range"
          : "correspondence",
    target: String(r.target),
    relation:
      kind === "range"
        ? "child-sample"
        : kind === "correspondence"
          ? "submitted-range"
          : "frozen-plan",
    ...(r.attempt
      ? { attemptId: String(r.attempt), digest: String(r.digest) }
      : {}),
  }));
}
export function taskEdges(
  db: IndexDatabase,
  kind: "range" | "correspondence" | "vmaf" | "xpsnr",
  actor: string,
  id?: string,
): TaskEdge[] {
  let sql =
    kind === "range"
      ? `SELECT p.id,json_extract(s.value,'$.jobId') AS target,json_extract(s.value,'$.result.attemptId') AS attempt,json_extract(s.value,'$.result.digest') AS digest FROM quality_ranges p,json_each(p.body,'$.samples') s WHERE actor=? LIMIT ?`
      : kind === "correspondence"
        ? `SELECT p.id,json_extract(e.body,'$.rangeId') AS target,NULL AS attempt,NULL AS digest FROM quality_correspondence_plans p JOIN quality_plan_executions e ON e.plan_id=p.id WHERE actor=? AND json_extract(e.body,'$.rangeId') IS NOT NULL LIMIT ?`
        : `SELECT id,json_extract(body,'$.input.plan.id') AS target,json_extract(body,'$.input.plan.attemptId') AS attempt,json_extract(body,'$.input.plan.digest') AS digest FROM quality_${kind}_jobs WHERE actor=? LIMIT ?`;
  const max = TASK_LIMITS.rows * 64;
  sql = sql.replace(" LIMIT ?", "");
  const query = db.prepare(
    `SELECT * FROM (${sql}) WHERE ${id ? "(id=? OR target=?)" : "1"} LIMIT ?`,
  );
  const rows = id
    ? query.all(actor, id, id, max + 1)
    : query.all(actor, max + 1);
  if (rows.length > max)
    throw new AdminError(
      503,
      "Task relations exceed the metadata budget.",
      "task-snapshot-budget",
    );

  return edgeRows(rows, kind);
}
/** Filter before applying the snapshot budget; never truncate matching history. Never select input/body/result
 * blobs into JS, read an index or decode pixels to populate the task center. */
export function taskSummaries(
  db: IndexDatabase,
  kind: TaskKind,
  actor: string,
  id?: string,
  filter: TaskFilter = {},
): TaskSummary[] {
  if (filter.kind && filter.kind !== kind) return [];
  const j = (path: string, field = "body") =>
    `json_extract(${field},'$.${path}')`;
  const body =
    kind === "preparation"
      ? "input_json"
      : kind === "single"
        ? "input_json"
        : "body";
  const sources =
    kind === "cambi"
      ? [["source", "input.source.mediaId", "input.source.mediaVersion"]]
      : kind === "preparation"
        ? [["source", "source.id", "source.version"]]
        : kind === "single"
          ? [
              [
                "reference",
                "request.reference.mediaId",
                "request.reference.mediaVersion",
              ],
              [
                "distorted",
                "request.distorted.mediaId",
                "request.distorted.mediaVersion",
              ],
            ]
          : kind === "range"
            ? [
                [
                  "reference",
                  "plan.input.pairs[0].reference.mediaId",
                  "plan.input.pairs[0].reference.mediaVersion",
                ],
                [
                  "distorted",
                  "plan.input.pairs[0].distorted.mediaId",
                  "plan.input.pairs[0].distorted.mediaVersion",
                ],
              ]
            : kind === "correspondence"
              ? [
                  [
                    "reference",
                    "relation.input.reference.mediaId",
                    "relation.input.reference.mediaVersion",
                  ],
                  [
                    "distorted",
                    "relation.input.distorted.mediaId",
                    "relation.input.distorted.mediaVersion",
                  ],
                ]
              : [
                  [
                    "reference",
                    "value.sources.reference.binding.mediaId",
                    "value.sources.reference.binding.mediaVersion",
                  ],
                  [
                    "distorted",
                    "value.sources.distorted.binding.mediaId",
                    "value.sources.distorted.binding.mediaVersion",
                  ],
                ];
  const sourceFields = sources
    .map(
      ([, id, v], i) =>
        `${j(id, kind === "vmaf" || kind === "xpsnr" ? "snapshot" : body)} AS source${i},${j(v, kind === "vmaf" || kind === "xpsnr" ? "snapshot" : body)} AS version${i}`,
    )
    .join(",");
  const table = {
    preparation: "discovery_jobs",
    single: "quality_jobs",
    range: "quality_ranges",
    correspondence: "quality_correspondence_plans",
    vmaf: "quality_vmaf_jobs",
    xpsnr: "quality_xpsnr_jobs",
    cambi: "cambi_jobs",
  }[kind];
  const columnar = kind === "single" || kind === "preparation";
  const times = columnar
    ? "revision,state,created_at,started_at,ended_at,reason_json,request_id,client_id"
    : `${j("revision")} AS revision,${j("state")} AS state,${j("createdAt")} AS created_at,${j("startedAt")} AS started_at,${j("endedAt")} AS ended_at,${j("reason")} AS reason_json,${j("requestId")} AS request_id,${j(kind === "range" ? "plan.input.client.id" : "input.client.id")} AS client_id`;
  const phase =
    kind === "single"
      ? "phase"
      : kind === "vmaf" || kind === "xpsnr" || kind === "cambi"
        ? j("phase")
        : "NULL";
  const result =
    kind === "cambi"
      ? `${j("state")} IN ('completed','partial') AND result IS NOT NULL AND ${j("resultDigest")} IS NOT NULL`
      : kind === "single"
        ? "result_sha IS NOT NULL AND result_json IS NOT NULL"
        : kind === "preparation"
          ? "result_json IS NOT NULL"
          : kind === "range"
            ? `${j("summary.scoredPairs")}>0 AND ${j("resultRetention.releasedAt")} IS NULL`
            : `result IS NOT NULL AND ${j("resultDigest")} IS NOT NULL`;
  const metric =
    kind === "preparation"
      ? `${j("operation", body)} AS operation,0 AS ssim`
      : kind === "single"
        ? `NULL AS operation,json_type(input_json,'$.request.ssim')='object' AS ssim`
        : kind === "range"
          ? `NULL AS operation,EXISTS(SELECT 1 FROM json_each(body,'$.plan.input.pairs') p WHERE json_type(p.value,'$.ssim')='object') AS ssim`
          : kind === "correspondence"
            ? `NULL AS operation,0 AS ssim`
            : `NULL AS operation,${j("input.metrics.ssim")} AS ssim`;
  const progress =
    kind === "cambi"
      ? `${j("progress.scoredFrames")} AS scored,${j("progress.targetFrames")} AS target,${j("progress.preparedFrames")} AS prepared,NULL AS metrics`
      : kind === "range"
        ? `${j("summary.scoredPairs")} AS scored,${j("plan.targets")} AS target,NULL AS prepared,NULL AS metrics`
        : kind === "single"
          ? `CASE WHEN state='completed' THEN 1 ELSE 0 END AS scored,1 AS target,NULL AS prepared,NULL AS metrics`
          : kind === "vmaf" || kind === "xpsnr"
            ? `NULL AS scored,${j("progress.targetFrames")} AS target,${j("progress.preparedFrames")} AS prepared,${j("metrics")} AS metrics`
            : "NULL AS scored,NULL AS target,NULL AS prepared,NULL AS metrics";
  const attempt = columnar
    ? "attempt_id"
    : kind === "range"
      ? "NULL"
      : j("attemptId");
  const resultDigest =
    kind === "single"
      ? "result_sha"
      : kind === "preparation" || kind === "range"
        ? "NULL"
        : j("resultDigest");
  const predicates: string[] = [],
    args: (string | number)[] = [actor];
  if (id) {
    predicates.push("id=?");
    args.push(id);
  }
  if (filter.state) {
    predicates.push("state=?");
    args.push(filter.state);
  }
  if (filter.createdFrom !== undefined) {
    predicates.push("created_at>=?");
    args.push(filter.createdFrom);
  }
  if (filter.createdTo !== undefined) {
    predicates.push("created_at<?");
    args.push(filter.createdTo);
  }
  if (filter.mediaId) {
    predicates.push(
      "(" +
        sources
          .map((_, i) => {
            args.push(filter.mediaId!);
            if (filter.mediaVersion) args.push(filter.mediaVersion);
            return `(source${i}=?${filter.mediaVersion ? ` AND version${i}=?` : ""})`;
          })
          .join(" OR ") +
        ")",
    );
  }
  if (filter.metric) {
    const m = filter.metric;
    if (kind === "preparation") {
      predicates.push("operation=?");
      args.push(m);
    } else if (
      m === "ssim" &&
      ["single", "range", "vmaf", "xpsnr"].includes(kind)
    )
      predicates.push("ssim=1");
    else if (
      !(kind === "correspondence"
        ? m === "correspondence"
        : kind === "cambi"
          ? m === "cambi"
          : m === "psnr" || m === kind)
    )
      return [];
  }
  const retention = kind === "range" ? `${j("resultRetention.releasedAt")} AS released_at,${j("resultRetention.settledAt")} AS settled_at` : "NULL AS released_at,NULL AS settled_at";
  const projection = `SELECT id,${retention},${times},${phase} AS phase,${sourceFields},${result} AS available,${metric},${progress},${attempt} AS attempt_id,${resultDigest} AS result_digest FROM ${table} WHERE ${columnar ? "actor_id" : "actor"}=?`;
  const rows = db
    .prepare(
      `SELECT * FROM (${projection}) WHERE ${predicates.length ? predicates.join(" AND ") : "1"} ORDER BY created_at DESC,id DESC LIMIT ?`,
    )
    .all(...args, id ? 1 : TASK_LIMITS.rows + 1);
  if (rows.length > TASK_LIMITS.rows)
    throw new AdminError(
      503,
      "Matching task history exceeds the snapshot budget. Narrow the date, source or state filters.",
      "task-snapshot-budget",
    );
  return rows.map((r) => {
    const id = String(r.id),
      url = originalPath(kind, id),
      available = !!r.available;
    const metrics =
      kind === "cambi"
        ? ["cambi"]
        : kind === "preparation"
          ? [String(r.operation)]
          : kind === "correspondence"
            ? ["correspondence"]
            : [
                "psnr",
                ...(r.ssim ? ["ssim"] : []),
                ...(kind === "vmaf" || kind === "xpsnr" ? [kind] : []),
              ];
    return {
      kind,
      id,
      revision: Number(r.revision),
      state: String(r.state),
      phase: r.phase === null ? null : String(r.phase),
      actorId: actor,
      clientId: String(r.client_id),
      requestId: String(r.request_id),
      createdAt: Number(r.created_at),
      startedAt: r.started_at === null ? null : Number(r.started_at),
      endedAt: r.ended_at === null ? null : Number(r.ended_at),
      reason: r.reason_json ? JSON.parse(String(r.reason_json)) : null,
      sources: sources.map(([role], i) => ({
        role: role as "source" | "reference" | "distorted",
        mediaId: String(r[`source${i}`]),
        mediaVersion: String(r[`version${i}`]),
      })),
      metrics,
      progress: {
        ...(r.scored !== null ? { scored: Number(r.scored) } : {}),
        ...(r.target !== null ? { target: Number(r.target) } : {}),
        ...(r.prepared !== null ? { prepared: Number(r.prepared) } : {}),
        ...(r.metrics ? { metrics: JSON.parse(String(r.metrics)) } : {}),
      },
      result: {
        available,
        ...(kind === "range" ? {released:r.released_at!==null,releasePending:r.released_at!==null&&r.settled_at===null,retained:0} : {}),
        ...(r.scored !== null ? { scored: Number(r.scored) } : {}),
      },
      attemptId: r.attempt_id === null ? null : String(r.attempt_id),
      resultDigest: r.result_digest === null ? null : String(r.result_digest),
      links: [
        { rel: "original", href: url },
        ...(available
          ? [
              {
                rel: "result",
                href:
                  url +
                  (kind === "range"
                    ? "/results"
                    : kind === "correspondence"
                      ? "/rows"
                      : kind === "preparation"
                        ? ""
                        : "/result"),
              },
            ]
          : []),
      ],
    };
  });
}
