import { qualityViewVisible } from "./quality-navigation.ts";
import { renderQualitySummary } from "./quality-summary.ts";
import type { QualityScoreSummary } from "./quality-summary.ts";
import { installQualityReexecution } from "./quality-reexecution.ts";
import { currentActor } from "../services/identity.ts";
import { ApiError } from "../services/api-error.ts";
import { QualityClient } from "../services/quality-jobs.ts";
import { qualityFacts } from "../ui/quality-evidence.ts";
import { qualityPairViewUrl } from "../../shared/review/quality-pair-view.ts";
import { terminalVmaf as terminalObservation } from "../../shared/analysis/quality/vmaf.ts";
import type { VmafJob } from "../../shared/analysis/quality/vmaf.ts";
import type { LibraryPairResult } from "../../shared/analysis/quality/library-pair.ts";
import type { AnnotationRecord } from "../../shared/review/annotation-record.ts";
import { randomUUID } from "../../shared/utils/uuid.ts";
type ObservationJob = Pick<
  VmafJob,
  "id" | "state" | "revision" | "resultDigest"
>;
interface ComparisonObserver {
  activate(active: boolean, actor: string): void;
  has(id: string): boolean;
  toggle(id: string, on: boolean): void;
}
export interface TemporalObserverConfig<Input, Score> {
  kind: "vmaf" | "xpsnr";
  parseInput(value: unknown): Input;
  readInput(field: (name: string) => HTMLInputElement): Input;
  frameLabel(index: number, score: Score | null): string;
  installComparison?(select: (id: string) => void): ComparisonObserver;
}
/** One owner for draft receipts, view/actor fences, paging and observation.
 * Inputs, frame score formatting and optional comparison remain metric-specific. */
export function installTemporalQuality<Input, Score>(
  signal: AbortSignal,
  config: TemporalObserverConfig<Input, Score>,
) {
  const kind = config.kind,
    label = kind.toUpperCase();
  const $ = (id: string) => document.getElementById(`${kind}-` + id)!;
  const input = (id: string) => $(id) as HTMLInputElement;
  const comparison = config.installComparison?.((id) => select(id));
  const api = new QualityClient();
  let browsingMore = false,
    active = false,
    actor = "",
    controller = new AbortController(),
    epoch = 0,
    view = 0,
    selected = "",
    after = 0,
    next: number | null = null,
    revision = 0,
    busy = false,
    listToken = 0,
    detailToken = 0,
    frameToken = 0,
    policyToken = "";
  const reexecutionRoot = document.createElement("section");
  reexecutionRoot.id = `${kind}-reexecution`;
  $("detail").append(reexecutionRoot);
  const reexecution = installQualityReexecution(
    reexecutionRoot,
    kind,
    signal,
    (id) => select(id),
  );
  type Pending = { body: Input; key: string; confirmed?: boolean };
  const key = (owner: string) => `voidplayer-${kind}-pending:` + owner;
  const pending = (owner: string): Pending | null => {
    const p = JSON.parse(sessionStorage.getItem(key(owner)) ?? "null");
    if (!p) return null;
    if (typeof p.key !== "string")
      throw Error(`Invalid stored ${label} receipt`);
    return { ...p, body: config.parseInput(p.body) };
  };
  const context = () => ({ actor, epoch, view, signal: controller.signal });
  const valid = (c: ReturnType<typeof context>, sameView = true) =>
    active &&
    !signal.aborted &&
    !c.signal.aborted &&
    actor === c.actor &&
    currentActor()?.id === c.actor &&
    epoch === c.epoch &&
    (!sameView || view === c.view);
  const error = (e: unknown) => {
    $("status").textContent = e instanceof Error ? e.message : String(e);
  };
  const lock = () => {
    let p: Pending | null = null;
    try {
      p = pending(actor);
    } catch (e) {
      error(e);
      return;
    }
    const frozen = !!p && !p.confirmed;
    ($("inputs") as HTMLFieldSetElement).disabled = frozen;
    input("submit").disabled = frozen;
    input("preflight").disabled = frozen;
    $("retry").hidden = !frozen;
    $("new").hidden = !p?.confirmed;
    $("pending").textContent = frozen ? JSON.stringify(p, null, 2) : "";
  };
  function select(id: string) {
    reexecution.clear();
    view++;
    detailToken++;
    frameToken++;
    busy = false;
    selected = id;
    revision = 0;
    next = null;
    policyToken = "";
    $("detail").hidden = true;
    for (const id of ["frames", "summary", "publication", "links"])
      $(id).replaceChildren();
    ($("policy-inputs") as HTMLFieldSetElement).disabled = false;
    void detail();
  }
  function reset() {
    browsingMore = false;
    reexecution.clear();
    controller.abort();
    controller = new AbortController();
    epoch++;
    view++;
    actor = currentActor()?.id ?? "";
    selected = "";
    revision = 0;
    after = 0;
    busy = false;
    listToken++;
    detailToken++;
    frameToken++;
    $("detail").hidden = true;
    for (const id of [
      "history",
      "status",
      "summary",
      "frames",
      "publication",
      "links",
      "capability",
      "title",
      "state",
    ])
      $(id).replaceChildren();
    $("more").hidden = true;
    for (const field of ["plan", "attempt", "digest", "text"])
      input(field).value = "";
    input("space").value = "default";
    lock();
    comparison?.activate(active, actor);
  }
  function body() {
    return config.readInput(input);
  }
  async function submit(p: Pending, c: ReturnType<typeof context>) {
    let r: { job: ObservationJob };
    try {
      r = await api.request<{ job: ObservationJob }>(
        c.actor,
        `/api/quality/${kind}/jobs`,
        c.signal,
        "POST",
        p.body,
        p.key,
      );
    } catch (e) {
      if (
        e instanceof ApiError &&
        e.status >= 400 &&
        e.status < 500 &&
        e.code !== "idempotency-conflict"
      ) {
        const stored = pending(c.actor);
        if (stored?.key === p.key) sessionStorage.removeItem(key(c.actor));
        if (valid(c)) lock();
      }
      throw e;
    }
    const stored = pending(c.actor);
    if (stored?.key === p.key)
      sessionStorage.setItem(
        key(c.actor),
        JSON.stringify({ ...stored, confirmed: true }),
      );
    if (!valid(c)) return;
    lock();
    select(r.job.id);
    void list();
  }
  async function list(more = false) {
    browsingMore = more || browsingMore;
    const c = context(),
      token = ++listToken;
    if (!c.actor) return;
    try {
      const p = await api.request<{
        entries: ObservationJob[];
        after: number;
        more: boolean;
      }>(
        c.actor,
        `/api/quality/${kind}/jobs?after=${more ? after : 0}&limit=8`,
        c.signal,
      );
      if (!valid(c, false) || token !== listToken) return;
      after = p.after;
      $("more").hidden = !p.more;
      if (!more) $("history").replaceChildren();
      for (const j of p.entries) {
        const b = document.createElement("button");
        b.type = "button";
        b.dataset[kind + "Job"] = j.id;
        b.textContent = j.id + " · " + j.state;
        b.onclick = () => {
          if (valid(c, false)) select(j.id);
        };
        if (comparison) {
          const check = document.createElement("input");
          check.type = "checkbox";
          check.setAttribute("aria-label", "Compare " + j.id);
          check.checked = comparison.has(j.id);
          check.disabled = j.state !== "completed";
          check.dataset[kind + "Compare"] = j.id;
          check.onchange = () => comparison.toggle(j.id, check.checked);
          const row = document.createElement("div");
          row.className = kind + "-history-entry";
          row.append(check, b);
          $("history").append(row);
        } else $("history").append(b);
      }
    } catch (e) {
      if (valid(c, false) && token === listToken) error(e);
    }
  }
  async function frames(more = false) {
    const c = context(),
      id = selected,
      token = ++frameToken;
    try {
      const p = await api.request<{
        entries: {
          index: number;
          score: Score | null;
          pair: LibraryPairResult;
        }[];
        next: number | null;
      }>(
        c.actor,
        `/api/quality/${kind}/jobs/${id}/frames?after=${more ? (next ?? 0) : 0}&limit=4`,
        c.signal,
      );
      if (!valid(c) || id !== selected || token !== frameToken) return false;
      if (!more) $("frames").replaceChildren();
      next = p.next;
      $("frames-more").hidden = next === null;
      for (const f of p.entries) {
        const root = document.createElement("section"),
          title = document.createElement("h4");
        title.textContent = config.frameLabel(f.index, f.score);
        root.dataset[kind + "Frame"] = String(f.index);
        root.append(title);
        qualityFacts(root, f.pair);
        $("frames").append(root);
      }
      return true;
    } catch (e) {
      if (valid(c) && id === selected && token === frameToken) error(e);
      return false;
    }
  }
  async function publication(c: ReturnType<typeof context>, id: string) {
    const p = await api.request<{
      policy: { space: string };
      createdIds: string[];
    } | null>(c.actor, `/api/quality/${kind}/jobs/${id}/candidates`, c.signal);
    if (!valid(c) || id !== selected) return;
    const token = JSON.stringify(p);
    if (token === policyToken) return;
    policyToken = token;
    $("publication").textContent = JSON.stringify(p, null, 2);
    $("links").replaceChildren();
    ($("policy-inputs") as HTMLFieldSetElement).disabled = !!p;
    if (p)
      for (const [field, value] of Object.entries(p.policy))
        input(field).value = String(value);
    if (p)
      for (const annotationId of p.createdIds) {
        const record = await api.request<AnnotationRecord>(
          c.actor,
          `/api/annotations/spaces/${encodeURIComponent(p.policy.space)}/${annotationId}`,
          c.signal,
        );
        if (!valid(c) || id !== selected) return;
        for (const e of record.document.mark.qualityEvidence ?? []) {
          const a = document.createElement("a");
          a.href = qualityPairViewUrl(
            { space: record.space, annotationId: record.id, evidenceId: e.id },
            location.origin,
          );
          a.target = "_blank";
          a.rel = "noopener";
          a.textContent = `Open original frame pair (not a ${label} heatmap)`;
          a.dataset[kind + "Candidate"] = annotationId;
          $("links").append(a);
        }
      }
  }
  async function detail() {
    if (!selected || busy) return;
    busy = true;
    const c = context(),
      id = selected,
      token = ++detailToken;
    try {
      const j = await api.request<ObservationJob>(
        c.actor,
        `/api/quality/${kind}/jobs/${id}`,
        c.signal,
      );
      if (!valid(c) || id !== selected) return;
      reexecution.show(j.id);
      $("detail").hidden = false;
      $("title").textContent = id + " · " + j.state;
      $("state").textContent = JSON.stringify(j, null, 2);
      input("cancel").disabled = terminalObservation(j.state);
      input("publish").disabled = j.state !== "completed";
      if (j.resultDigest && revision !== j.revision) {
        const r = await api.request<QualityScoreSummary>(
          c.actor,
          `/api/quality/${kind}/jobs/${id}/result`,
          c.signal,
        );
        if (!valid(c) || id !== selected) return;
        renderQualitySummary($("summary"), r);
        if (await frames()) revision = j.revision;
      }
      if (!valid(c) || id !== selected) return;
      await publication(c, id);
    } catch (e) {
      if (valid(c) && id === selected) error(e);
    } finally {
      if (token === detailToken) busy = false;
    }
  }
  try {
    input("client").value =
      sessionStorage.getItem(`voidplayer-${kind}-client`) ?? randomUUID();
    sessionStorage.setItem(`voidplayer-${kind}-client`, input("client").value);
  } catch {
    input("client").value = randomUUID();
  }
  $("form").onsubmit = (e) => {
    e.preventDefault();
    const c = context();
    try {
      if (!c.actor) throw Error("Choose an identity first");
      let p = pending(actor);
      if (p && !p.confirmed) throw Error("Retry the frozen submission first");
      const b = body();
      p = { body: b, key: randomUUID() };
      sessionStorage.setItem(key(actor), JSON.stringify(p));
      lock();
      void submit(p, c).catch((e) => {
        if (valid(c)) error(e);
      });
    } catch (e) {
      error(e);
    }
  };
  $("retry").onclick = () => {
    const c = context();
    try {
      const p = pending(actor);
      if (p)
        void submit(p, c).catch((e) => {
          if (valid(c)) error(e);
        });
    } catch (e) {
      error(e);
    }
  };
  $("new").onclick = () => {
    try {
      if (!pending(actor)?.confirmed) return;
      sessionStorage.removeItem(key(actor));
      lock();
    } catch (e) {
      error(e);
    }
  };
  $("preflight").onclick = () => {
    const c = context();
    try {
      const b = body();
      void api
        .request(
          c.actor,
          `/api/quality/${kind}/preflight`,
          c.signal,
          "POST",
          b,
          undefined,
          "quality-job",
          35000,
        )
        .then(
          (r) => {
            if (valid(c)) $("status").textContent = JSON.stringify(r);
          },
          (e) => {
            if (valid(c)) error(e);
          },
        );
    } catch (e) {
      error(e);
    }
  };
  $("cancel").onclick = () => {
    const c = context(),
      id = selected;
    void api
      .request(
        c.actor,
        `/api/quality/${kind}/jobs/${id}/cancel`,
        c.signal,
        "POST",
        {},
      )
      .then(
        () => {
          if (valid(c) && id === selected) void detail();
        },
        (e) => {
          if (valid(c)) error(e);
        },
      );
  };
  $("policy").onsubmit = (e) => {
    e.preventDefault();
    const c = context(),
      id = selected;
    const policy = {
      space: input("space").value,
      side: input("side").value,
      maxScore: Number(input("maxScore").value),
      limit: Number(input("limit").value),
      minFrameDistance: Number(input("minFrameDistance").value),
      text: input("text").value,
      severity: Number(input("severity").value),
    };
    void api
      .request(
        c.actor,
        `/api/quality/${kind}/jobs/${id}/candidates`,
        c.signal,
        "POST",
        policy,
      )
      .then(
        () => {
          if (valid(c) && id === selected) {
            policyToken = "";
            void detail();
          }
        },
        (e) => {
          if (valid(c)) error(e);
        },
      );
  };
  $("refresh").onclick = () => {
    browsingMore = false;
    void list();
    void detail();
  };
  $("more").onclick = () => void list(true);
  $("frames-more").onclick = () => void frames(true);
  window.addEventListener(
    `voidplayer-${kind}-plan`,
    (event) => {
      const p = (
        event as CustomEvent<{
          actor: string;
          id: string;
          attemptId: string;
          digest: string;
        }>
      ).detail;
      if (!active || p.actor !== actor || currentActor()?.id !== actor) return;
      try {
        if (pending(actor) && !pending(actor)?.confirmed)
          throw Error(`Retry the original frozen ${label} submission first`);
        for (const [id, value] of Object.entries({
          plan: p.id,
          attempt: p.attemptId,
          digest: p.digest,
        }))
          input(id).value = value;
        document
          .getElementById(`quality-${kind}`)!
          .scrollIntoView({ block: "start" });
      } catch (e) {
        error(e);
      }
    },
    { signal },
  );
  window.addEventListener(
    "voidplayer-identity-change",
    () => {
      reset();
      if (active) void list();
    },
    { signal },
  );
  window.addEventListener(
    "storage",
    (e) => {
      if (e.key === "voidplayer.identity") {
        reset();
        actor = "";
        comparison?.activate(active, "");
      }
    },
    { signal },
  );
  const timer = setInterval(() => {
    if (active && qualityViewVisible(kind)) {
      if (selected) void detail();
      else if (!browsingMore) void list();
    }
  }, 1000);
  signal.addEventListener(
    "abort",
    () => {
      clearInterval(timer);
      controller.abort();
    },
    { once: true },
  );
  return {
    activate(value: boolean) {
      if (active === value) return;
      active = value;
      reset();
      if (active) {
        void list();
        const c = context();
        void api
          .request(c.actor, `/api/quality/${kind}/capability`, c.signal)
          .then(
            (r) => {
              if (valid(c, false))
                $("capability").textContent = JSON.stringify(r, null, 2);
            },
            (e) => {
              if (valid(c, false)) error(e);
            },
          );
      }
    },
  };
}
