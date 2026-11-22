import { t, th, msg, onLanguageChange } from '../i18n.ts';
import { gpuApplyEnhancement } from '../presentation/webgpu-presenter.ts';
import { createPresentationEnhancement } from '../presentation/enhancement.ts';
import type { SharpenSettings } from '../presentation/sharpen.ts';
import type { EnhancementSettings, EnhancementStatus } from '../presentation/enhancement.ts';
import type { ReviewSession } from '../session.ts';
import type { Slot } from '../../shared/review/model.ts';
import { sourceKey } from '../../shared/media/io/source-identity.ts';
import { parseWorkspaceEnhancements, type WorkspaceEnhancement } from '../../shared/review/workspace-file.ts';
import { icon } from './icons.ts';
import { installFloatingPanelAvoidance } from './floating-panels.ts';
import { createLocalizedFragment } from './localized-shell.ts';

type Status = Exclude<EnhancementStatus, { state: 'closed' }> | { state: 'off' | 'loading' };

interface EnhancementRun {
  controller: AbortController;
  options: EnhancementSettings;
  redraw?: () => void;
}

type Preferences = Omit<WorkspaceEnhancement, 'slot'>;

interface TrackEnhancement extends Preferences {
  sourceGen: number;
  sourceKey: string;
  run?: EnhancementRun;
  status: Status;
}

const preferenceKey = (slot: Slot) => `voidplayer.enhancement-preferences.v1.${slot}`;
const defaultPreferences = (): Preferences => ({ scale: 2, sharpened: false, sharpen: { radius: 2, strength: 0.6 } });

function capturePreferences(slot: Slot, rule: TrackEnhancement): WorkspaceEnhancement {
  return { slot, scale: rule.scale, sharpened: rule.sharpened, sharpen: { ...rule.sharpen } };
}

function loadPreferences(slot: Slot, sourceKey: string): Preferences {
  try {
    const raw = sessionStorage.getItem(preferenceKey(slot));
    const data = raw && JSON.parse(raw);
    if (data?.sourceKey === sourceKey) {
      const [entry] = parseWorkspaceEnhancements([data.preferences]);
      if (entry.slot === slot) return entry;
    }
  } catch { /* Preferences are optional when storage is unavailable or invalid. */ }
  return defaultPreferences();
}

function savePreferences(slot: Slot, rule: TrackEnhancement) {
  try {
    sessionStorage.setItem(preferenceKey(slot), JSON.stringify({ sourceKey: rule.sourceKey, preferences: capturePreferences(slot, rule) }));
  } catch { /* Keep the current workspace usable without storage. */ }
}

export function installEnhancement(canvases: Record<Slot, HTMLCanvasElement>, signal: AbortSignal) {
  const annotations = document.getElementById('toggle-annotations')!;
  const viewport = annotations.closest('.viewport-surface')!;
  const trigger = document.createElement('button');
  trigger.id = 'toggle-super-resolution';
  trigger.type = 'button';
  trigger.className = 'icon-button';
  trigger.disabled = true;
  trigger.setAttribute('aria-controls', 'super-resolution-panel');
  trigger.innerHTML = icon('sparkle');
  annotations.before(trigger);

  const panel = document.createElement('section');
  panel.id = 'super-resolution-panel';
  panel.className = 'viewport-options-panel viewport-tool-panel';
  panel.hidden = true;
  viewport.append(panel);
  const scaleOption = (factor: EnhancementSettings['scale'], label: string) => `
    <button type="button" value="${factor}" aria-label="${label}" data-tooltip="${label}" aria-pressed="${factor === 2}">${factor}×</button>`;
  const localize = createLocalizedFragment(panel, () => `
    <div class="viewport-tool-controls super-resolution-controls">
      <div class="viewport-tool-head">
        <button class="icon-button viewport-tool-grip" type="button" data-floating-grip
          aria-label="${th(msg('shell.dragToolbar', '拖动工具条'))}" data-tooltip="${th(msg('shell.dragToolbar', '拖动工具条'))}">${icon('grip')}</button>
        <div class="viewport-tool-tracks" data-tracks role="group" aria-label="${th(msg('enhancement.track', '轨道'))}"></div>
        <button class="icon-button viewport-tool-close" type="button" data-close aria-label="${th(msg('enhancement.close', '关闭增强面板'))}">${icon('close')}</button>
      </div>
      <div class="enhancement-field">
        <div class="enhancement-scale-info">
          <span id="enhancement-scale-label">${th(msg('enhancement.scale', '超分倍率'))}</span>
          <output data-status role="status"></output>
        </div>
        <div class="enhancement-scale-actions">
          <button class="icon-button" type="button" data-enable aria-label="${th(msg('enhancement.enable', '应用增强'))}"
            data-tooltip="${th(msg('enhancement.enable', '应用增强'))}">${icon('sparkle')}</button>
          <div class="segmented" data-scale role="group" aria-labelledby="enhancement-scale-label">
            ${scaleOption(2, th(msg('enhancement.websrRealLife', 'WebSR 实拍 S 2×')))}
            ${scaleOption(4, th(msg('enhancement.websrRealLife4x', 'WebSR 实拍 S 4×')))}
          </div>
        </div>
      </div>
      <div class="enhancement-field">
        <span id="enhancement-kernel-label">${th(msg('enhancement.sharpen', '锐化'))}</span>
        <div class="segmented" data-kernel role="group" aria-labelledby="enhancement-kernel-label">
          <button type="button" value="0" aria-pressed="true">${th(msg('enhancement.sharpenOff', '关闭'))}</button>
          ${[1, 2, 3].map(radius => `<button type="button" value="${radius}" aria-pressed="false">${2 * radius + 1}×${2 * radius + 1}</button>`).join('')}
        </div>
      </div>
      <label class="enhancement-field enhancement-strength" hidden><span>${th(msg('enhancement.strength', '锐化强度'))}</span>
        <input type="range" min="0" max="200" step="5" value="60" data-strength><span data-strength-value aria-hidden="true">60%</span>
      </label>
    </div>`);
  const tracksGroup = panel.querySelector<HTMLElement>('[data-tracks]')!;
  const scale = panel.querySelector<HTMLElement>('[data-scale]')!;
  const kernel = panel.querySelector<HTMLElement>('[data-kernel]')!;
  const strength = panel.querySelector<HTMLInputElement>('[data-strength]')!;
  const strengthValue = panel.querySelector<HTMLSpanElement>('[data-strength-value]')!;
  const strengthRow = strength.closest('label')!;
  const enable = panel.querySelector<HTMLButtonElement>('[data-enable]')!;
  enable.disabled = true;
  const output = panel.querySelector<HTMLOutputElement>('[data-status]')!;
  const floating = installFloatingPanelAvoidance(panel, panel.firstElementChild as HTMLElement,
    document.getElementById('annotation-toolbar')!, signal);
  const rules = new Map<Slot, TrackEnhancement>();
  let selection: Slot | undefined, trackKey = '';
  const currentRule = () => selection && rules.get(selection);
  function renderStatus() {
    const rule = currentRule();
    const status = rule?.status ?? { state: 'off' };
    enable.setAttribute('aria-pressed', String(!!rule?.run));
    for (const badge of tracksGroup.querySelectorAll<HTMLButtonElement>('button[data-slot]')) {
      const slot = badge.dataset.slot as Slot;
      badge.setAttribute('aria-pressed', String(!!rules.get(slot)?.run));
      if (slot === selection) badge.setAttribute('aria-current', 'true');
      else badge.removeAttribute('aria-current');
    }
    output.dataset.state = status.state;
    trigger.classList.toggle('enhancement-active', [...rules.values()].some(item => item.status.state === 'active'));
    switch (status.state) {
      case 'active': output.textContent = `${status.width} × ${status.height}`; break;
      case 'unsupported': output.textContent = t(msg('enhancement.unsupported', '当前画面无法增强。请选择 SDR RGB 视频。')); break;
      case 'overloaded':
        output.textContent = t(msg('enhancement.overloaded', 'GPU 未能跟上播放，已回到原画。可降低倍率或重新应用增强。'));
        break;
      case 'error': output.textContent = t(msg('enhancement.error', '当前画面增强失败。{reason}'), { reason: status.reason }); break;
      case 'off':
      case 'loading': output.textContent = ''; break;
    }
    if (status.state !== 'active' && output.textContent) output.dataset.tooltip = output.textContent;
    else delete output.dataset.tooltip;
  }
  function stop(rule: TrackEnhancement) {
    const run = rule.run;
    rule.run = undefined;
    rule.status = { state: 'off' };
    run?.controller.abort();
  }
  function effectiveSharpen(rule: TrackEnhancement): SharpenSettings {
    return rule.sharpened ? rule.sharpen : { radius: rule.sharpen.radius, strength: 0 };
  }
  function start(slot: Slot, rule: TrackEnhancement) {
    stop(rule);
    const controller = new AbortController();
    const options: EnhancementSettings = { scale: rule.scale, sharpen: effectiveSharpen(rule) };
    const run: EnhancementRun = { controller, options };
    rule.run = run;
    rule.status = { state: 'loading' };
    renderStatus();
    const update = (next: EnhancementStatus) => {
      if (rule.run !== run) return;
      if (next.state === 'closed') stop(rule);
      else rule.status = next;
      renderStatus();
    };
    const create = (device: GPUDevice) => createPresentationEnhancement(device, options, controller.signal, update);
    void gpuApplyEnhancement(canvases[slot], controller.signal, create).then(redraw => {
      if (rule.run === run) run.redraw = redraw;
    }).catch(error => {
      if (rule.run !== run) return;
      stop(rule);
      rule.status = { state: 'error', reason: error instanceof Error ? error.message : String(error) };
      renderStatus();
    });
  }
  function syncSharpenControls() {
    strength.style.setProperty('--progress-ratio', String(strength.valueAsNumber / Number(strength.max)));
    strength.setAttribute('aria-valuetext', `${strength.value}%`);
    strengthValue.textContent = `${strength.value}%`;
  }
  function renderSettings() {
    const rule = currentRule();
    if (rule) {
      for (const button of scale.querySelectorAll('button')) button.setAttribute('aria-pressed', String(Number(button.value) === rule.scale));
      const radius = rule.sharpened ? rule.sharpen.radius : 0;
      for (const button of kernel.querySelectorAll('button')) button.setAttribute('aria-pressed', String(Number(button.value) === radius));
      strengthRow.hidden = !rule.sharpened;
      strength.value = String(Math.round(rule.sharpen.strength * 100));
      syncSharpenControls();
    }
    renderStatus();
  }
  function setOpen(open: boolean) {
    trigger.setAttribute('aria-expanded', String(open));
    panel.hidden = !open;
    if (open) {
      floating.place();
      tracksGroup.querySelector<HTMLButtonElement>('[aria-current=true]')?.focus({ preventScroll: true });
    }
  }
  const localizeLabels = () => {
    localize();
    const title = t(msg('enhancement.title', '画面增强'));
    trigger.setAttribute('aria-label', title);
    trigger.dataset.tooltip = title;
    panel.setAttribute('aria-label', title);
    renderStatus();
  };
  localizeLabels();
  onLanguageChange(localizeLabels, signal);
  trigger.onclick = () => setOpen(panel.hidden === true);
  const close = () => { setOpen(false); trigger.focus(); };
  panel.querySelector<HTMLButtonElement>('[data-close]')!.onclick = close;
  panel.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    event.preventDefault();
    event.stopPropagation();
    close();
  }, { signal });
  tracksGroup.onclick = event => {
    const slot = (event.target as Element).closest<HTMLButtonElement>('button[data-slot]')?.dataset.slot as Slot | undefined;
    if (!slot) return;
    const rule = rules.get(slot)!;
    const wasSelected = selection === slot;
    selection = slot;
    if (!rule.run) start(slot, rule);
    else if (wasSelected) stop(rule);
    renderSettings();
  };
  enable.onclick = () => {
    if (!selection) return;
    const rule = rules.get(selection)!;
    if (rule.run) { stop(rule); renderStatus(); }
    else start(selection, rule);
  };
  scale.onclick = event => {
    const factor = Number((event.target as Element).closest<HTMLButtonElement>('button')?.value);
    if (!selection || (factor !== 2 && factor !== 4)) return;
    const rule = rules.get(selection)!;
    if (rule.scale === factor) return;
    rule.scale = factor;
    savePreferences(selection, rule);
    if (rule.run) start(selection, rule);
    renderSettings();
  };
  function updateSharpen(slot: Slot, rule: TrackEnhancement) {
    savePreferences(slot, rule);
    if (rule.run) {
      rule.run.options.sharpen = effectiveSharpen(rule);
      rule.run.redraw?.();
    }
  }
  kernel.onclick = event => {
    const radius = Number((event.target as Element).closest<HTMLButtonElement>('button')?.value);
    if (!selection || (radius !== 0 && radius !== 1 && radius !== 2 && radius !== 3)) return;
    const rule = rules.get(selection)!;
    rule.sharpened = radius !== 0;
    if (radius !== 0) rule.sharpen = { ...rule.sharpen, radius };
    updateSharpen(selection, rule);
    renderSettings();
  };
  strength.oninput = () => {
    if (!selection) return;
    const rule = rules.get(selection)!;
    rule.sharpen = { ...rule.sharpen, strength: strength.valueAsNumber / 100 };
    updateSharpen(selection, rule);
    syncSharpenControls();
  };
  signal.addEventListener('abort', () => {
    for (const rule of rules.values()) stop(rule);
    floating.dispose();
    trigger.remove();
    panel.remove();
  }, { once: true });
  setOpen(false);
  return {
    snapshot() {
      return rules.size ? [...rules].map(([slot, rule]) => capturePreferences(slot, rule)) : undefined;
    },
    restore(enhancements: WorkspaceEnhancement[]) {
      for (const [slot, rule] of rules) {
        stop(rule);
        const preferences = enhancements.find(entry => entry.slot === slot) ?? defaultPreferences();
        rule.scale = preferences.scale;
        rule.sharpened = preferences.sharpened;
        rule.sharpen = { ...preferences.sharpen };
        savePreferences(slot, rule);
      }
      renderSettings();
    },
    render(state: ReturnType<ReviewSession['getState']>) {
      const available = state.tracks.filter(item => item.visible && item.frame && !item.failure);
      const key = state.tracks.map(({ slot, sourceGen }) => `${slot}:${sourceGen}`).join(',') + '/' + available.map(item => item.slot).join(',');
      if (key === trackKey) return;
      trackKey = key;
      for (const [slot, rule] of rules) {
        if (!state.tracks.some(track => track.slot === slot && track.sourceGen === rule.sourceGen)) {
          stop(rule);
          rules.delete(slot);
        } else if (rule.run && !available.some(track => track.slot === slot)) stop(rule);
      }
      for (const track of state.tracks) {
        const { slot, sourceGen, source } = track;
        if (rules.has(slot)) continue;
        const identity = source ? new URL(source.url, location.href).href : sourceKey(track);
        rules.set(slot, { sourceGen, sourceKey: identity, ...loadPreferences(slot, identity), status: { state: 'off' } });
      }
      if (!available.some(track => track.slot === selection)) selection = available[0]?.slot;
      tracksGroup.innerHTML = available.map(({ slot }) => `
        <button type="button" class="viewport-tool-track" data-slot="${slot}">
          <span class="slot slot-${slot}">${slot}</span></button>`).join('');
      enable.disabled = trigger.disabled = !selection;
      if (!selection) setOpen(false);
      renderSettings();
    },
  };
}
