import { SLOTS } from "../model.ts";
import type { Slot } from "../model.ts";
import type { ReadonlyAnalysisResult } from "../bitstream-analysis/contract.ts";
import type { ReviewSession } from "../session.ts";
import { t, msg } from "../i18n.ts";
import { failureInfo } from "../bitstream-analysis/failure.ts";
import { bitstreamReasonText } from "./bitstream-reasons.ts";
export function installBitstreamControls(
  session: ReviewSession,
  canvases: Record<Slot, HTMLCanvasElement>,
) {
  const active = new Map<
    Slot,
    {
      controller: AbortController;
      overlay?: import("../analysis-overlay/controller.ts").ReturnOverlay;
      tooltip?: HTMLOutputElement;
    }
  >();
  for (const slot of SLOTS) {
    const button = document.getElementById(
      `bitstream-${slot}`,
    ) as HTMLButtonElement;
    const mode = document.getElementById(
      `bitstream-mode-${slot}`,
    ) as HTMLSelectElement;
    const status = document.getElementById(`bitstream-status-${slot}`)!;
    const stage = canvases[slot].closest<HTMLElement>(".frame-stage")!;
    let hoverIdentity: string | null = null;
    stage.append(status);
    const showResult = (result: ReadonlyAnalysisResult) => {
      mode.hidden = result.confidence !== "exact";
      status.textContent =
        result.confidence === "exact"
          ? `${result.picture.stream} / AU ${result.picture.au} · ${result.blocks.length} ${t(msg("bitstream.blocks", "块"))}${result.qp.mean === null ? "" : ` · QP ${result.qp.mean.toFixed(1)}`}`
          : bitstreamReasonText(
              result.reasonCodes?.[0] ?? "incomplete-reference-state",
            );
      if (result.confidence === "exact" && result.capabilities.qp !== "ready") {
        status.textContent += ` · ${bitstreamReasonText("unsupported-qp-depth")}`;
        if (mode.value === "qp") {
          mode.value = "blocks";
          active.get(slot)?.overlay?.setMode("blocks");
        }
      }
      mode.querySelector<HTMLOptionElement>('[value="qp"]')!.disabled =
        result.capabilities.qp !== "ready";
    };
    const off = () => {
      const entry = active.get(slot);
      entry?.controller.abort();
      entry?.overlay?.dispose();
      entry?.tooltip?.remove();
      active.delete(slot);
      button.setAttribute("aria-pressed", "false");
      mode.hidden = true;
      status.hidden = true;
      stage.removeAttribute("title");
      hoverIdentity = null;
      session.cancelBitstreamAnalysis();
    };
    button.onclick = async () => {
      if (active.has(slot)) {
        off();
        return;
      }
      const entry: {
        controller: AbortController;
        overlay?: import("../analysis-overlay/controller.ts").ReturnOverlay;
        tooltip?: HTMLOutputElement;
      } = { controller: new AbortController() };
      active.set(slot, entry);
      button.setAttribute("aria-pressed", "true");
      status.hidden = false;
      status.textContent = t(msg("bitstream.pending", "正在分析当前帧…"));
      try {
        const { createAnalysisOverlay } = await import(
          "../analysis-overlay/controller.ts"
        );
        if (entry.controller.signal.aborted) return;
        entry.overlay = createAnalysisOverlay(session, slot, canvases[slot]);
        entry.tooltip = document.createElement("output");
        entry.tooltip.className = "bitstream-status bitstream-hit-tooltip";
        entry.tooltip.hidden = true;
        stage.append(entry.tooltip);
        const requested = session.getPresentedFrame(slot);
        const result = await session.requestBitstreamAnalysis(
          slot,
          entry.controller.signal,
        );
        if (
          entry.controller.signal.aborted ||
          JSON.stringify(session.getPresentedFrame(slot)?.picture) !==
            JSON.stringify(requested?.picture) ||
          session.getPresentedFrame(slot)?.generation !== requested?.generation
        )
          return;
        entry.overlay.setResult(result);
        showResult(result);
      } catch (error) {
        if (!entry.controller.signal.aborted)
          status.textContent = bitstreamReasonText(failureInfo(error).code);
      }
    };
    session.subscribePresentedFrames((changed, next) => {
      if (changed === slot && active.has(slot)) {
        const cached = session.cachedBitstreamAnalysis(slot, next);
        if (cached) showResult(cached);
        else
          status.textContent = next.picture
            ? `${next.picture.stream} / AU ${next.picture.au}`
            : (next.identityReason ?? "");
        status.title = "";
        if (hoverIdentity !== JSON.stringify([next.picture, next.generation])) {
          stage.removeAttribute("title");
          const tooltip = active.get(slot)?.tooltip;
          if (tooltip) tooltip.hidden = true;
          hoverIdentity = null;
        }
      }
    });
    mode.onchange = () =>
      active
        .get(slot)
        ?.overlay?.setMode(mode.value as "blocks" | "qp" | "modes");
    canvases[slot]
      .closest(".frame-stage")!
      .addEventListener("pointermove", (event) => {
        const e = event as PointerEvent,
          rect = (event.currentTarget as HTMLElement).getBoundingClientRect(),
          b = active
            .get(slot)
            ?.overlay?.hit(e.clientX - rect.left, e.clientY - rect.top);
        const tooltip = active.get(slot)?.tooltip;
        if (!tooltip) return;
        tooltip.hidden = !b;
        tooltip.textContent = b
          ? `${b.x},${b.y} · ${b.width}×${b.height} · ${b.mode} · QP ${b.qp ?? "—"}`
          : "";
        tooltip.style.left = `${Math.max(8, Math.min(e.clientX - rect.left + 12, rect.width - 260))}px`;
        tooltip.style.top = `${Math.max(8, Math.min(e.clientY - rect.top + 12, rect.height - 40))}px`;
        const token = session.getPresentedFrame(slot);
        hoverIdentity =
          b && token ? JSON.stringify([token.picture, token.generation]) : null;
      });
    stage.addEventListener("pointerleave", () => {
      const tooltip = active.get(slot)?.tooltip;
      if (tooltip) tooltip.hidden = true;
    });
    session.subscribe(() => {
      const state = session.getState();
      const track = state.tracks.find((track) => track.slot === slot);
      button.disabled =
        !track || !!track.failure || (state.playing && !active.has(slot));
      if (!track && active.has(slot)) off();
    });
  }
}
