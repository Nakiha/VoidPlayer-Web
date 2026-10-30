import {t,msg} from '../i18n.ts';
import { qualityViewVisible } from "./quality-navigation.ts";
import { renderQualitySummary } from "./quality-summary.ts";
import type { QualityScoreSummary } from "./quality-summary.ts";
import { installQualityReexecution } from "./quality-reexecution.ts";
import { confirmedActor, observeIdentity } from "../services/identity.ts";
import {
  FrozenSubmissionJournal,
  assertJobReceipt,
} from "../services/frozen-submission.ts";
import type { FrozenSubmission } from "../services/frozen-submission.ts";
import { QualityObservationScope } from "../analysis/quality/observation-scope.ts";
import { candidateAnnotations } from "../analysis/quality/candidate-evidence.ts";
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
  "id" | "state" | "revision" | "resultDigest" | "resultRetained"
>;
interface ComparisonObserver {
  activate(active: boolean, actor: string): void;
  has(id: string): boolean;
  unavailable?(id:string):void;
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
  const observation = new QualityObservationScope();
  let browsingMore = false,
    active = false,
    actor = "",
    selected = "",
    after = 0,
    next: number | null = null,
    revision = 0,
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
  type Pending = FrozenSubmission<Input>;
  const key = (owner: string) => `voidplayer-${kind}-pending:${owner}`;
  const journal = new FrozenSubmissionJournal(
    sessionStorage,
    key,
    config.parseInput,
  );
  const pending = (owner: string) => journal.pending(owner);
  const context = (
    level: "actor" | "selection" = "selection",
    slot?: string,
  ) => ({
    actor,
    scope: observation.capture(level, slot),
    get signal() {
      return this.scope.signal;
    },
  });
  const valid = (c: ReturnType<typeof context>) =>
    active &&
    !signal.aborted &&
    actor === c.actor &&
    confirmedActor()?.id === c.actor &&
    c.scope.current();
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
    observation.select();
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
    observation.invalidate();
    actor = confirmedActor()?.id ?? "";
    selected = "";
    revision = 0;
    after = 0;
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
  function capability(): Promise<void> {
    return observation.run("capability", "actor", async () => {
      if (!active || !actor) return;
      const c = context("actor", "capability");
      try {
        const value = await api.request(c.actor, `/api/quality/${kind}/capability`, c.signal);
        if (valid(c)) $("capability").textContent = JSON.stringify(value, null, 2);
      } catch (e) {
        if (valid(c)) error(e);
      }
    });
  }
  async function submit(p: Pending, c: ReturnType<typeof context>) {
    const receiptContext = context("actor");
    try {
      const r = await journal.execute(
        c.actor,
        p.key,
        (frozen) =>
          api.request<{ job: ObservationJob }>(
            c.actor,
            `/api/quality/${kind}/jobs`,
            c.signal,
            "POST",
            frozen.body,
            frozen.key,
          ),
        (response, frozen) => assertJobReceipt(response, c.actor, frozen),
      );
      if (!valid(c)) return;
      select(r.job.id);
      void list();
    } finally {
      // Submission controls project actor-owned acceptance, independently of
      // which task is selected when its valid receipt eventually arrives.
      if (valid(receiptContext)) lock();
    }
  }
  function list(more = false): Promise<void> {
    return observation.run("history", "actor", async () => {
      browsingMore = more || browsingMore;
      const c = context("actor", "history");
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
        if (!valid(c)) return;
        after = p.after;
        $("more").hidden = !p.more;
        if (!more) $("history").replaceChildren();
        for (const j of p.entries) {
          if(j.resultRetained===false)comparison?.unavailable?.(j.id);
          const b = document.createElement("button");
          b.type = "button";
          b.dataset[kind + "Job"] = j.id;
          b.textContent = j.id + " · " + j.state;
          b.onclick = () => {
            if (valid(c)) select(j.id);
          };
          if (comparison) {
            const check = document.createElement("input");
            check.type = "checkbox";
            check.setAttribute("aria-label", "Compare " + j.id);
            check.checked = comparison.has(j.id);
            check.disabled = j.state !== "completed" || j.resultRetained === false;
            check.dataset[kind + "Compare"] = j.id;
            check.onchange = () => comparison.toggle(j.id, check.checked);
            const row = document.createElement("div");
            row.className = kind + "-history-entry";
            row.append(check, b);
            $("history").append(row);
          } else $("history").append(b);
        }
      } catch (e) {
        if (valid(c)) error(e);
      }
    });
  }
  function frames(more = false): Promise<boolean> {
    return observation.run("frames", "selection", async () => {
      const c = context("selection", "frames"),
        id = selected;
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
        if (!valid(c) || id !== selected) return false;
        const nodes = document.createDocumentFragment();
        for (const f of p.entries) {
          const root = document.createElement("section"),
            title = document.createElement("h4");
          title.textContent = config.frameLabel(f.index, f.score);
          root.dataset[kind + "Frame"] = String(f.index);
          root.append(title);
          qualityFacts(root, f.pair);
          nodes.append(root);
        }
        if (!valid(c) || id !== selected) return false;
        if (more) $("frames").append(nodes);
        else $("frames").replaceChildren(nodes);
        next = p.next;
        $("frames-more").hidden = next === null;
        return true;
      } catch (e) {
        if (valid(c) && id === selected) error(e);
        return false;
      }
    });
  }
  async function publication(c: ReturnType<typeof context>, id: string) {
    const p = await api.request<{
      policy: { space: string };
      createdIds: string[];
    } | null>(c.actor, `/api/quality/${kind}/jobs/${id}/candidates`, c.signal);
    if (!valid(c) || id !== selected) return;
    const token = JSON.stringify(p);
    if (token === policyToken) return;
    const records = await candidateAnnotations(p, (space, annotationId) =>
      api.request<AnnotationRecord>(
        c.actor,
        `/api/annotations/spaces/${encodeURIComponent(space)}/${annotationId}`,
        c.signal,
      ),
    );
    if (!valid(c) || id !== selected) return;
    const links = document.createDocumentFragment();
    for (const record of records)
      for (const e of record.document.mark.qualityEvidence ?? []) {
        const a = document.createElement("a");
        a.href = qualityPairViewUrl(
          { space: record.space, annotationId: record.id, evidenceId: e.id },
          location.origin,
        );
        a.target = "_blank";
        a.rel = "noopener";
        a.textContent = `Open original frame pair (not a ${label} heatmap)`;
        a.dataset[kind + "Candidate"] = record.id;
        links.append(a);
      }
    if (!valid(c) || id !== selected) return;
    $("publication").textContent = JSON.stringify(p, null, 2);
    $("links").replaceChildren(links);
    ($("policy-inputs") as HTMLFieldSetElement).disabled = !!p;
    if (p)
      for (const [field, value] of Object.entries(p.policy))
        input(field).value = String(value);
    policyToken = token;
  }

  function detail(): Promise<void> {
    return observation.run("detail", "selection", async () => {
      if (!selected) return;
      const c = context("selection", "detail"),
        id = selected;
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
        input("publish").disabled = j.state !== "completed" || j.resultRetained === false;
        if(j.resultRetained === false){
          comparison?.unavailable?.(id);
          observation.cancel("frames");next=null;$("frames").replaceChildren();$("summary").replaceChildren();$("frames-more").hidden=true;$("summary").textContent=t(msg('qualityWorkspace.resultReleased','评分结果已回收；原始摘要与回执保留。'));revision=j.revision;
        }
        if (j.resultDigest && j.resultRetained !== false && revision !== j.revision) {
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
      }
    });
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
      journal.clearConfirmed(actor);
      p = journal.freeze(actor, b);
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
      journal.clearConfirmed(actor);
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
      if (!active || p.actor !== actor || confirmedActor()?.id !== actor)
        return;
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
  observeIdentity(signal, {
    invalidated: reset,
    confirmed: () => {
      reset();
      if (active) {
        void list();
        void capability();
      }
    },
    failed: error,
  });
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
      observation.close();
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
        void capability();
      }
    },
  };
}
