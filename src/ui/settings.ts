import type { WheelBehavior } from '../../shared/presentation/viewport.ts';
import { MAX_WASM_DECODE_COUNT, setVvcFrameContextCount, setVvcThreadCount, setWasmThreadMode,
  vvcFrameContextCount, vvcThreadCount, wasmThreadMode, type WasmThreadMode } from '../media/policy/wasm-threads.ts';
import { t, onLanguageChange, msg } from '../i18n.ts';
import { settingsPanes } from './settings-shell.ts';
import { matchesShortcut } from './shortcuts.ts';
import { chartHoverStyle, setChartHoverStyle, CHART_HOVER_STYLE_EVENT, type ChartHoverStyle } from './chart-hover-style.ts';
import { analysisConcurrency, setAnalysisConcurrency, ANALYSIS_CONCURRENCY_EVENT } from './analysis/concurrency.ts';
import { MAX_ANALYSIS_CONCURRENCY } from '../../shared/analysis/bitstream/task-pool.ts';
import { installChoiceMenu } from './choice-menu.ts';
import { installSourceScrollbar } from './source-scrollbar.ts';
import { FileHandleError, handleKey, pickVideoFiles, restoreHandleFile, saveFileHandle, supportsFileHandles } from '../services/file-handles.ts';

const wheelKey = 'voidplayer.viewport-wheel-behavior';
function readWheelBehavior(): WheelBehavior {
  try {
    const value = localStorage.getItem(wheelKey);
    if (value === 'pan' || value === 'vertical-zoom') return value;
  } catch { /* Use the default when browser storage is unavailable. */ }
  return 'auto';
}

/** One persistent window, with independent scrolling panes and one close/focus lifecycle. */
export function installSettings() {
  const dialog = document.getElementById('settings') as HTMLDialogElement;
  const trigger = document.getElementById('settings-open') as HTMLButtonElement;
  const close = document.getElementById('settings-close') as HTMLButtonElement;
  const tabs = [...dialog.querySelectorAll<HTMLButtonElement>('[data-settings-pane]')];
  const life = new AbortController();
  const fileAccess = document.getElementById('local-file-access-try') as HTMLButtonElement;
  const fileStatus = document.getElementById('local-file-access-status')!;
  let fileAccessResult: 'idle' | 'success' | 'cancelled' | 'failed' = 'idle';
  const syncFileAccess = () => {
    fileStatus.textContent = !supportsFileHandles() ? t(msg('fileAccess.unsupported', '当前浏览器未提供持久文件访问能力，本地视频按一次性文件打开'))
      : fileAccessResult === 'success' ? t(msg('fileAccess.success', '已验证文件访问和句柄保存，刷新后仍需浏览器允许读取；曾拒绝时可以重新尝试'))
      : fileAccessResult === 'cancelled' ? t(msg('fileAccess.cancelled', '已取消选择，可以再次尝试'))
      : fileAccessResult === 'failed' ? t(msg('fileAccess.failed', '未能取得或保存文件访问权限，请检查浏览器的网站权限后重试'))
      : t(msg('fileAccess.available', '检测到文件访问接口，可以选择视频验证权限和保存能力'));
  };
  fileAccess.addEventListener('click', () => {
    // Invoke the native picker directly in the click gesture, before any storage work.
    const picked = pickVideoFiles(false);
    fileAccess.disabled = true;
    void picked.then(async files => {
      if (!files?.length) { fileAccessResult = 'cancelled'; return; }
      const { file, handle } = files[0], key = handleKey(file);
      await saveFileHandle(key, handle, file);
      await restoreHandleFile(key, undefined, false);
      fileAccessResult = 'success';
    }).catch(error => {
      fileAccessResult = 'failed';
      if (!(error instanceof FileHandleError)) console.warn('Local file access check failed', error);
    }).finally(() => { if (!life.signal.aborted) { fileAccess.disabled = false; syncFileAccess(); } });
  }, { signal: life.signal });
  onLanguageChange(syncFileAccess, life.signal); syncFileAccess();
  const scrollbar = installSourceScrollbar(document.getElementById('settings-pane-appearance')!, document.getElementById('settings-scrollbar')!, document.getElementById('settings-scrollbar-thumb')!, life.signal);
  const contentChanges = new MutationObserver(scrollbar.update);
  for (const pane of dialog.querySelectorAll('[role=tabpanel]')) contentChanges.observe(pane, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['hidden'] });
  life.signal.addEventListener('abort', () => contentChanges.disconnect(), { once: true });
  const hoverChoices = () => [
    { value: 'separate', label: t(msg('settings.chartHoverSeparate', '各图独立显示')) },
    { value: 'combined', label: t(msg('settings.chartHoverCombined', '合并显示')) },
  ];
  const hoverMenu = installChoiceMenu('chart-hover-style', hoverChoices, value => setChartHoverStyle(value as ChartHoverStyle));
  const syncHoverMenu = () => hoverMenu.sync(chartHoverStyle(), hoverChoices().find(choice => choice.value === chartHoverStyle())!.label, true);
  window.addEventListener(CHART_HOVER_STYLE_EVENT, syncHoverMenu, { signal: life.signal });
  onLanguageChange(syncHoverMenu, life.signal); syncHoverMenu();
  life.signal.addEventListener('abort', () => hoverMenu.dispose(), { once: true });
  let wheelBehavior = readWheelBehavior();
  const wheelChoices = () => [
    { value: 'auto', label: t(msg('settings.wheelAuto', '自动')) },
    { value: 'pan', label: t(msg('settings.wheelPan', '始终平移')) },
    { value: 'vertical-zoom', label: t(msg('settings.wheelVerticalZoom', '竖向滚动缩放')) },
  ] satisfies { value: WheelBehavior; label: string }[];
  const wheelMenu = installChoiceMenu('viewport-wheel-behavior', wheelChoices, value => {
    wheelBehavior = value as WheelBehavior;
    try { localStorage.setItem(wheelKey, wheelBehavior); } catch { /* Still applies in this window. */ }
    syncWheelMenu();
  });
  function syncWheelMenu() { wheelMenu.sync(wheelBehavior, wheelChoices().find(c => c.value === wheelBehavior)!.label, true); }
  syncWheelMenu();
  onLanguageChange(syncWheelMenu, life.signal);
  window.addEventListener('storage', event => {
    if (event.key === wheelKey || event.key === null) { wheelBehavior = readWheelBehavior(); syncWheelMenu(); }
  }, { signal: life.signal });
  life.signal.addEventListener('abort', () => wheelMenu.dispose(), { once: true });
  const concurrencyChoices = () => Array.from({ length: MAX_ANALYSIS_CONCURRENCY }, (_, i) => ({ value: String(i + 1),
    label: t(msg('settings.analysisConcurrencyCount', '{count, plural, other {# 路}}'), { count: i + 1 }) }));
  const concurrencyMenu = installChoiceMenu('analysis-concurrency', concurrencyChoices, value => setAnalysisConcurrency(Number(value)));
  const syncConcurrencyMenu = () => concurrencyMenu.sync(String(analysisConcurrency()), concurrencyChoices().find(c => Number(c.value) === analysisConcurrency())!.label, true);
  window.addEventListener(ANALYSIS_CONCURRENCY_EVENT, syncConcurrencyMenu, { signal: life.signal });
  onLanguageChange(syncConcurrencyMenu, life.signal); syncConcurrencyMenu();
  life.signal.addEventListener('abort', () => concurrencyMenu.dispose(), { once: true });
  const wasmChoices = () => [
    { value: 'auto', label: t(msg('settings.wasmThreadsAuto', '自动')) },
    { value: 'auto-grow', label: t(msg('settings.wasmThreadsAutoGrow', '自动扩容')) },
    { value: 'manual', label: t(msg('settings.wasmThreadsManual', '手动')) },
    { value: 'single-thread', label: t(msg('settings.wasmThreadsSingle', '单线程')) },
  ];
  const wasmMenu = installChoiceMenu('wasm-thread-mode', wasmChoices, value => { setWasmThreadMode(value as WasmThreadMode); syncWasmMenu(); });
  const manualSettings = document.getElementById('vvc-manual-settings')!;
  const vvcTuning = [
    { input: document.getElementById('vvc-thread-mode') as HTMLInputElement, read: vvcThreadCount, write: setVvcThreadCount },
    { input: document.getElementById('vvc-frame-contexts') as HTMLInputElement, read: vvcFrameContextCount, write: setVvcFrameContextCount },
  ];
  for (const { input, read, write } of vvcTuning) {
    input.max = String(MAX_WASM_DECODE_COUNT);
    input.value = String(read() || '');
    input.addEventListener('change', () => {
      if (input.validity.valid) write(input.value === '' ? '' : String(input.valueAsNumber));
      input.value = String(read() || '');
    }, { signal: life.signal });
  }
  function syncWasmMenu() {
    const mode = wasmThreadMode();
    wasmMenu.sync(mode, wasmChoices().find(choice => choice.value === mode)!.label, true);
    manualSettings.hidden = mode !== 'manual';
    for (const { input } of vvcTuning) input.placeholder = t(msg('settings.wasmThreadsAuto', '自动'));
  }
  onLanguageChange(syncWasmMenu, life.signal);
  syncWasmMenu();
  life.signal.addEventListener('abort', () => wasmMenu.dispose(), { once: true });
  const narrow = matchMedia('(max-width: 600px)');
  const revealTab = () => {
    if (narrow.matches && dialog.open) dialog.querySelector('[role=tab][aria-selected=true]')!.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
  };
  const orientation = () => {
    dialog.querySelector('[role=tablist]')!.setAttribute('aria-orientation', narrow.matches ? 'horizontal' : 'vertical');
    revealTab();
  };
  narrow.addEventListener('change', orientation, { signal: life.signal }); orientation();
  let selected = 'appearance'; let returnFocus: HTMLElement | null = null;
  let closeEpoch = 0; let outsidePointer: number | null = null;
  function select(id: string, refresh = false) {
    if (id === selected && !refresh) { revealTab(); return; }
    selected = id;
    document.getElementById('settings-current-title')!.textContent = settingsPanes().find(([key]) => key === id)![1];
    for (const [key] of settingsPanes()) {
      const active = key === id;
      const tab = document.getElementById(`settings-tab-${key}`)!;
      tab.setAttribute('aria-selected', String(active)); tab.tabIndex = active ? 0 : -1;
      document.getElementById(`settings-pane-${key}`)!.hidden = !active;
    }
    scrollbar.setTarget(document.getElementById(`settings-pane-${id}`)!);
    revealTab();
    dialog.dispatchEvent(new CustomEvent('settings-pane-change', { detail: selected }));
  }
  onLanguageChange(() => { document.getElementById('settings-current-title')!.textContent = settingsPanes().find(([key]) => key === selected)![1]; }, life.signal);
  function open(invoker: HTMLElement | null = trigger) {
    // A native close event can still be queued when a background tab reopens.
    ++closeEpoch;
    delete dialog.dataset.closing;
    if (dialog.open) return;
    returnFocus = invoker;
    dialog.showModal(); trigger.setAttribute('aria-expanded', 'true'); select(selected, true);
    tabs.find(t => t.dataset.settingsPane === selected)!.focus({ preventScroll: true });
  }
  async function dismiss() {
    if (!dialog.open) return;
    const epoch = ++closeEpoch;
    dialog.dataset.closing = '';
    // Keep the modal (and backdrop) alive until the exit finishes. With reduced
    // motion there are no animations, so closing completes immediately.
    await Promise.allSettled(dialog.getAnimations().map(animation => animation.finished));
    if (epoch === closeEpoch && dialog.open) dialog.close();
  }
  const outside = (event: PointerEvent) => {
    const bounds = dialog.getBoundingClientRect();
    return event.target === dialog && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom);
  };
  dialog.addEventListener('pointerdown', event => { outsidePointer = outside(event) ? event.pointerId : null; }, { signal: life.signal });
  dialog.addEventListener('pointerup', event => {
    if (outsidePointer === event.pointerId && outside(event)) void dismiss();
    outsidePointer = null;
  }, { signal: life.signal });
  dialog.addEventListener('pointercancel', () => { outsidePointer = null; }, { signal: life.signal });
  dialog.addEventListener('cancel', event => { event.preventDefault(); void dismiss(); }, { signal: life.signal });
  trigger.addEventListener('click', () => open(trigger), { signal: life.signal });
  close.addEventListener('click', () => void dismiss(), { signal: life.signal });
  dialog.addEventListener('close', () => { if (dialog.open) return; ++closeEpoch; delete dialog.dataset.closing; outsidePointer = null; trigger.setAttribute('aria-expanded', 'false'); (returnFocus?.isConnected ? returnFocus : trigger).focus({ preventScroll: true }); }, { signal: life.signal });
  for (const tab of tabs) {
    tab.addEventListener('click', () => select(tab.dataset.settingsPane!), { signal: life.signal });
    tab.addEventListener('keydown', event => {
      if (!['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
      event.preventDefault();
      const available = tabs.filter(tab => !tab.hidden);
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? available.length - 1 : (available.indexOf(tab) + (['ArrowDown','ArrowRight'].includes(event.key) ? 1 : -1) + available.length) % available.length;
      available[index].focus({ preventScroll: true }); available[index].click();
    }, { signal: life.signal });
  }
  document.addEventListener('keydown', event => {
    if (matchesShortcut(event, 'settings') && !event.isComposing) { event.preventDefault(); if (!document.querySelector('dialog[open]') || dialog.open) open(document.activeElement instanceof HTMLElement ? document.activeElement : trigger); }
  }, { signal: life.signal });
  return { wheelBehavior: () => wheelBehavior, openPane(id: string, invoker: HTMLElement | null = trigger) {
    if (!tabs.some(tab => !tab.hidden && tab.dataset.settingsPane === id)) throw new Error(t(msg("settings.unknownSettingsPage", "未知设置页面")));
    if (dialog.open) select(id); else selected = id;
    open(invoker); tabs.find(t => t.dataset.settingsPane === id)!.focus({ preventScroll: true });
  }, close: dismiss, dispose() { ++closeEpoch; life.abort(); dialog.close(); } };
}
