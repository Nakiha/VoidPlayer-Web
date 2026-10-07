import type { ReviewSession } from '../../session.ts';
import type { Slot } from '../../model.ts';
import { getLocale, t, msg } from '../../i18n.ts';
import { formatAxis } from '../analysis-canvas.ts';
import type { AnalysisPreferences } from './preferences.ts';
import type { AnalysisQueryTrack } from './queries.ts';
import type { AnalysisAction } from './shared.ts';

/** Frame-number UI owns its pending ranks, editing and invalidation. */
export function installAnalysisStatus(options: {
  session: ReviewSession; act: AnalysisAction; signal: AbortSignal; prefs: AnalysisPreferences;
  statusEl: HTMLElement; numAxisEl: HTMLElement; itemsEl: HTMLElement; live: HTMLElement;
  tracks(): readonly AnalysisQueryTrack[]; colors(): ReadonlyMap<Slot, string>; save(): void;
}) {
  const { session, act, signal, prefs, statusEl, numAxisEl, itemsEl, live, save } = options;
  // ---- 右侧状态区：当前上屏帧 PTS + 双帧号（展示序 / 解码序） ----
  // PTS 取会话真实上屏帧（frame.ptsUs + offsetUs），与各视口 canvas 一致；
  // PTS序是展示序排名（PTS 严格小于该帧的样本数，0-based），DTS序是解码
  // 顺序号（包表下标）。两者经 session.rankAnalysisFrame 一次只读查询返回，
  // 复用各后端包表的有序轴缓存，O(log N)，不解码、不物化样本。重复 PTS
  // 共享展示排名；无精确 PTS 匹配时 DTS序显示 —；索引构建中为暂定值（~）。
  const framesBySlot = new Map<Slot, { ptsUs: number; sourcePtsUs: number } | null>();
  const rankCache = new Map<Slot, { pts: number; rank: number | null; total: number | null; ordinal: number | null; complete: boolean; note?: string }>();
  const rankSeq = new Map<Slot, number>();
  // Keep the source's reserved width while each new frame awaits its rank.
  // Pending placeholders and index invalidation must not shrink the toolbar.
  const numberWidths = new Map<Slot, { mediaId: string; sourceGen: number; chars: number }>();
  let lastStatusSig = '';
  let editingNumber = false;
  /** 展示序排名按（slot，会话 PTS）缓存；换片/重建时由调用方清理。 */
  function fetchRank(slot: Slot, sessionPts: number) {
    const seq = (rankSeq.get(slot) ?? 0) + 1;
    rankSeq.set(slot, seq);
    void session.rankAnalysisFrame(slot, sessionPts, 'pts').then(res => {
      if (signal.aborted || rankSeq.get(slot) !== seq) return;
      const entry = options.tracks().find(t => t.slot === slot);
      const f = framesBySlot.get(slot);
      // 只接受仍是当前上屏帧的结果，旧帧的迟到回答直接丢弃。
      if (!entry || !f || f.ptsUs + entry.offsetUs !== sessionPts) return;
      rankCache.set(slot, 'rank' in res
        ? { pts: sessionPts, rank: res.rank, total: res.total, ordinal: res.ordinal, complete: res.complete }
        : { pts: sessionPts, rank: null, total: null, ordinal: null, complete: false, note: res.reason });
      renderStatus();
    }).catch(() => { /* RPC 异常不覆盖显示，保留占位，下次帧变化再试。 */ });
  }
  function statusEntry(slot: Slot, offsetUs: number) {
    const f = framesBySlot.get(slot);
    const sessionPts = f ? f.ptsUs + offsetUs : null;
    const cached = rankCache.get(slot);
    const hit = sessionPts != null && cached?.pts === sessionPts ? cached : undefined;
    return { frame: f ?? null, sessionPts, hit };
  }
  /** 同步渲染：只显示主题色点 + 槽位 + 帧号（PTS序/解码序由切换决定），时间只进 tooltip。 */
  function renderStatus() {
    if (editingNumber) return;
    const sig = [prefs.numAxis, ...options.tracks().map(t => {
      const { sessionPts, hit } = statusEntry(t.slot, t.offsetUs);
      const num = hit ? (prefs.numAxis === 'pts' ? hit.rank : hit.ordinal) : undefined;
      return `${t.slot}:${sessionPts ?? 'x'}:${num ?? (hit ? 'x' : '-')}${hit && !hit.complete ? '~' : ''}`;
    })].join('|');
    if (sig === lastStatusSig) return;
    lastStatusSig = sig;
    itemsEl.replaceChildren();
    const axisLabel = prefs.numAxis === 'pts' ? t(msg("analysis.ptsOrder", "PTS序")) : t(msg("analysis.dtsOrder", "DTS序"));
    if (!options.tracks().length) {
      const empty = document.createElement('span');
      empty.className = 'st-empty';
      empty.textContent = '—';
      empty.title = t(msg("analysis.noVideoYet", "尚未载入视频"));
      itemsEl.append(empty);
      statusEl.setAttribute('aria-label', t(msg("analysis.currentFrameNumbersEmpty", "当前上屏帧号：尚未载入视频")));
      return;
    }
    const summary: string[] = [];
    for (const entry of options.tracks()) {
      const { frame: f, sessionPts, hit } = statusEntry(entry.slot, entry.offsetUs);
      const wrap = document.createElement('span');
      wrap.className = 'st-item';
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.background = options.colors().get(entry.slot) ?? '#888';
      const label = document.createElement('span');
      label.className = 'st-slot';
      label.textContent = entry.slot;
      const num = document.createElement('button');
      num.type = 'button';
      num.className = 'st-num';
      const value = hit ? (prefs.numAxis === 'pts' ? hit.rank : hit.ordinal) : undefined;
      const previousWidth = numberWidths.get(entry.slot);
      const sameSource = previousWidth?.mediaId === entry.mediaId && previousWidth.sourceGen === entry.sourceGen;
      const maxFrame = Math.max(value ?? 0, (hit?.total ?? 1) - 1);
      const chars = Math.max(sameSource ? previousWidth.chars : 4, String(maxFrame).length + 2);
      numberWidths.set(entry.slot, { mediaId: entry.mediaId, sourceGen: entry.sourceGen, chars });
      wrap.style.setProperty('--frame-number-width', `${chars}ch`);
      if (hit == null) num.textContent = '…';
      else if (value == null) num.textContent = '—';
      else num.textContent = `#${value}${hit.complete ? '' : '~'}`;
      num.disabled = value == null || !hit?.complete;
      num.title = num.disabled ? t(msg("analysis.indexNotReady", "帧索引尚未就绪")) : t(msg("analysis.enterFrameNumber", "输入轨道 {slot} 的{axis}帧号后按回车跳转"), { slot: entry.slot, axis: axisLabel });
      num.setAttribute('aria-label', t(msg("analysis.editTrackFrameNumber", "轨道 {slot} {axis}帧号，点击编辑"), { slot: entry.slot, axis: axisLabel }));
      num.onclick = () => {
        if (value == null || !hit?.complete) return;
        const axis = prefs.numAxis;
        editingNumber = true;
        const input = document.createElement('input');
        input.className = 'st-num-input'; input.type = 'text'; input.inputMode = 'numeric';
        input.autocomplete = 'off'; input.spellcheck = false; input.value = String(value);
        input.setAttribute('aria-label', t(msg("analysis.trackFrameNumber", "轨道 {slot} {axis}帧号"), { slot: entry.slot, axis: axisLabel }));
        num.replaceWith(input); input.focus(); input.select();
        let finished = false;
        const finish = (commit: boolean) => {
          if (finished) return; finished = true;
          const raw = input.value.trim().replace(/^#/, '');
          editingNumber = false; lastStatusSig = ''; renderStatus();
          if (!commit) return;
          if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
            live.textContent = t(msg("analysis.frameNumberMustBeNonNegativeInteger", "帧号必须是非负整数。")); return;
          }
          const number = Number(raw);
          void act(async () => {
            const result = await session.seekAnalysisFrameNumber(entry.slot, number, axis);
            if ('reason' in result) throw new Error(result.reason);
          }, 'analysis.seek-frame-number', { slot: entry.slot, number, axis });
        };
        input.onkeydown = event => {
          if (event.key === 'Enter') { event.preventDefault(); finish(true); }
          else if (event.key === 'Escape') { event.preventDefault(); finish(false); }
        };
        input.onblur = () => finish(true);
      };
      wrap.append(dot, label, num);
      if (sessionPts == null) {
        wrap.title = t(msg("analysis.trackHasNoFrame", "轨道 {slot}：暂无上屏帧"), { slot: entry.slot });
      } else if (hit?.rank != null) {
        wrap.title = t(msg("analysis.frameTitleBase", "轨道 {slot} 上屏帧：会话 PTS {pts}（{ptsUs} µs）"), { slot: entry.slot, pts: formatAxis(sessionPts), ptsUs: sessionPts })
          + (f != null ? t(msg("analysis.frameTitleSourcePts", " · 源 PTS {sourcePtsUs} µs"), { sourcePtsUs: f.sourcePtsUs }) : '')
          + t(msg("analysis.frameTitlePtsRank", " · PTS序 #{rank}"), { rank: hit.rank })
          + (hit.total != null ? t(msg("analysis.frameTitlePtsTotal", " / 共 {total} 帧"), { total: hit.total }) : '')
          + (hit.ordinal == null ? t(msg("analysis.frameTitleDtsMissing", " · DTS序 —（解码 PTS 不在包表内，不猜测）")) : t(msg("analysis.frameTitleDtsOrdinal", " · DTS序 #{ordinal}（解码顺序号）"), { ordinal: hit.ordinal }))
          + (hit.complete ? '' : t(msg("analysis.frameTitleProvisional", "（索引构建中，暂定）")));
      } else {
        wrap.title = t(msg("analysis.frameTitleBase", "轨道 {slot} 上屏帧：会话 PTS {pts}（{ptsUs} µs）"), { slot: entry.slot, pts: formatAxis(sessionPts), ptsUs: sessionPts })
          + (f != null ? t(msg("analysis.frameTitleSourcePts", " · 源 PTS {sourcePtsUs} µs"), { sourcePtsUs: f.sourcePtsUs }) : '')
          + (hit?.note ? t(msg("analysis.frameTitleRankPending", " · 帧号 —（{note}）"), { note: hit.note }) : t(msg("analysis.frameTitleQuerying", " · 帧号查询中")));
      }
      itemsEl.append(wrap);
      summary.push(sessionPts == null || value == null ? `${entry.slot} —` : `${entry.slot} #${value}`);
      if (sessionPts != null && !hit) fetchRank(entry.slot, sessionPts);
    }
    statusEl.setAttribute('aria-label', t(msg("analysis.statusLabel", "当前上屏帧号（{axis}）：{summary}"), { axis: axisLabel, summary: summary.join(getLocale() === 'en' ? '; ' : '；') }));
  }
  function updateStatus() {
    // 暂定排名在索引完成后自动转正：仍是当前帧但缓存未完成时重查一次。
    for (const t of options.tracks()) {
      const { sessionPts, hit } = statusEntry(t.slot, t.offsetUs);
      if (sessionPts != null && hit?.rank != null && !hit.complete) fetchRank(t.slot, sessionPts);
    }
    renderStatus();
  }

  // ---- 帧号顺序切换（PTS序/解码序）：复用全局 .segmented 样式 ----
  const numAxisButtons = [...numAxisEl.querySelectorAll<HTMLButtonElement>('[data-num-axis]')];
  function refreshNumAxis() {
    for (const b of numAxisButtons) b.setAttribute('aria-pressed', String(b.dataset.numAxis === prefs.numAxis));
  }
  for (const b of numAxisButtons) b.onclick = () => {
    const v = b.dataset.numAxis as 'pts' | 'dts';
    if (prefs.numAxis === v) return;
    prefs.numAxis = v;
    save(); refreshNumAxis(); renderStatus();
  };

  function invalidate(slot?: Slot) {
    lastStatusSig = '';
    const slots = slot ? [slot] : [...rankCache.keys(), ...rankSeq.keys()];
    for (const key of slots) { rankCache.delete(key); rankSeq.set(key, (rankSeq.get(key) ?? 0) + 1); }
  }
  function syncFrames(frames: readonly { slot: string; frame?: { ptsUs: number; sourcePtsUs: number } | null }[]) {
    for (const track of frames) framesBySlot.set(track.slot as Slot, track.frame ?? null);
    for (const slot of framesBySlot.keys()) if (!frames.some(track => track.slot === slot)) { framesBySlot.delete(slot); numberWidths.delete(slot); invalidate(slot); }
  }
  return { update: updateStatus, refreshAxis: refreshNumAxis, invalidate, syncFrames };
}
