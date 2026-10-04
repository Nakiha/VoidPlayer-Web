import { t, onLanguageChange, msg } from '../i18n.ts';
import { ACCENTS, customAccent, customTheme } from './appearance.ts';
type ThemePreference = 'system' | 'light' | 'dark' | 'custom';
const KEY = 'voidplayer.theme';
const ACCENT_KEY = 'voidplayer.accent';
const CUSTOM_KEY = 'voidplayer.custom-accent';
const BASE_KEY = 'voidplayer.custom-theme';
function readBase() { try { const stored = JSON.parse(localStorage.getItem(BASE_KEY) ?? 'null'); return customTheme(stored?.color ?? '') ?? customTheme('#eee7de')!; } catch { return customTheme('#eee7de')!; } }
function readCustom() { try { const stored = JSON.parse(localStorage.getItem(CUSTOM_KEY) ?? 'null'); return customAccent(typeof stored?.color === 'string' ? stored.color : '') ?? customAccent('#007aff')!; } catch { return customAccent('#007aff')!; } }
function readAccent() { try { const value = localStorage.getItem(ACCENT_KEY); return value === 'custom' ? 'custom' : ACCENTS.find(c => c.id === value)?.id ?? 'blue'; } catch { return 'blue'; } }
function readPreference(): ThemePreference {
  try {
    const value = localStorage.getItem(KEY);
    if (value === 'light' || value === 'dark' || value === 'custom') return value;
  } catch { /* Storage restrictions must not prevent changing this page's appearance. */ }
  return 'system';
}

function applyRoot(preference: ThemePreference, accent: string, custom: ReturnType<typeof readCustom>, base: ReturnType<typeof readBase>) {
  document.documentElement.dataset.theme = preference === 'custom' ? (base.dark ? 'dark' : 'light') : preference === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : preference;
  document.documentElement.dataset.accent = accent;
  document.documentElement.style.setProperty('--custom-accent-light', custom.light);
  document.documentElement.style.setProperty('--custom-accent-dark', custom.dark);
  const seed = accent === 'custom' ? custom[base.dark ? 'dark' : 'light'] : ACCENTS.find(c => c.id === accent)![base.dark ? 'dark' : 'light'];
  base.colors.accent = base.accent(seed);
  // Cache only generated, validated colors; the classic bootstrap uses these before modules load.
  try { localStorage.setItem(BASE_KEY, JSON.stringify({ color: base.color, dark: base.dark, colors: base.colors })); } catch {}
  if (preference === 'custom') document.documentElement.dataset.customTheme = '';
  else delete document.documentElement.dataset.customTheme;
  for (const [token, value] of Object.entries(base.colors)) document.documentElement.style.setProperty(`--custom-theme-${token}`, value);
}
/** Companion pages share appearance without mounting the player's settings UI. */
export function observeTheme() {
  const life = new AbortController();
  const apply = () => applyRoot(readPreference(), readAccent(), readCustom(), readBase());
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', apply, { signal: life.signal });
  window.addEventListener('storage', apply, { signal: life.signal });
  apply(); return () => life.abort();
}

/** Appearance is a UI preference, independent of review data and media presentation. */
export function installThemeControls() {
  const system = matchMedia('(prefers-color-scheme: dark)');
  const life = new AbortController();
  const buttons = [...document.querySelectorAll<HTMLButtonElement>('[data-theme-choice]')];
  let preference = readPreference();
  let accent = readAccent(); let custom = readCustom(); let base = readBase();
  const picker = document.getElementById('accent-picker') as HTMLInputElement;
  const hex = document.getElementById('accent-hex') as HTMLInputElement;
  const hint = document.getElementById('accent-input-hint')!;
  const caption = hint.textContent!;
  const basePicker = document.getElementById('theme-base-picker') as HTMLInputElement;
  const baseHex = document.getElementById('theme-base-hex') as HTMLInputElement;
  const baseHint = document.getElementById('theme-base-hint')!;
  const baseButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-base-choice]')];
  function syncBaseInputs() { basePicker.value = base.color; baseHex.value = base.color.toUpperCase(); baseHex.removeAttribute('aria-invalid'); baseHint.textContent = ''; }
  function savePreference() { try { if (preference === 'system') localStorage.removeItem(KEY); else localStorage.setItem(KEY, preference); } catch {} }
  function syncInputs() { picker.value = custom.color; hex.value = custom.color.toUpperCase(); hex.removeAttribute('aria-invalid'); hint.textContent = caption; }
  function saveAccent() {
    try {
      // Write the cached variants before activating custom, including for peers.
      localStorage.setItem(CUSTOM_KEY, JSON.stringify(custom));
      if (accent === 'blue') localStorage.removeItem(ACCENT_KEY); else localStorage.setItem(ACCENT_KEY, accent);
    } catch { /* Keep editing when storage is unavailable. */ }
  }
  const accents = [...document.querySelectorAll<HTMLButtonElement>('[data-accent-choice]')];
  function apply() {
    applyRoot(preference, accent, custom, base);
    document.getElementById('theme-base-controls')!.hidden = preference !== 'custom';
    const selectedBase = baseButtons.find(button => button.dataset.baseChoice === base.color);
    for (const button of baseButtons) { const selected = button === selectedBase; button.setAttribute('aria-checked', String(selected)); button.tabIndex = selected || (!selectedBase && button === baseButtons[0]) ? 0 : -1; }
    const sample = document.querySelector<HTMLElement>('.sample-custom')!;
    for (const token of ['surface', 'panel', 'group', 'accent'] as const) sample.style.setProperty(`--base-preview-${token}`, base.colors[token]);
    const customButton = document.querySelector<HTMLElement>('[data-accent-choice=custom]')!;
    customButton.style.setProperty('--swatch-light', custom.light); customButton.style.setProperty('--swatch-dark', custom.dark);
    document.getElementById('accent-current')!.textContent = accent === 'custom' ? t(msg("theme.custom", "自定义 · {p0}"), { p0: custom.color.toUpperCase() }) : ACCENTS.find(c => c.id === accent)!.name;
    for (const button of accents) { const selected = button.dataset.accentChoice === accent; button.setAttribute('aria-checked', String(selected)); button.tabIndex = selected ? 0 : -1; }
    for (const button of buttons) button.setAttribute('aria-checked', String(button.dataset.themeChoice === preference));
  }
  for (const button of buttons) button.addEventListener('click', () => {
    preference = button.dataset.themeChoice as ThemePreference;
    syncBaseInputs(); apply(); savePreference();
  }, { signal: life.signal });
  for (const button of accents) button.addEventListener('click', () => {
    accent = button.dataset.accentChoice === 'custom' ? 'custom' : ACCENTS.find(c => c.id === button.dataset.accentChoice)!.id;
    saveAccent(); syncInputs();
    apply();
  }, { signal: life.signal });
  for (const group of [buttons, accents, baseButtons]) for (const button of group) button.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault(); const next = group[(group.indexOf(button) + (event.key === 'ArrowRight' ? 1 : -1) + group.length) % group.length]; next.focus(); next.click();
  }, { signal: life.signal });
  function updateCustom(value: string) {
    const next = customAccent(value);
    if (!next) return false;
    custom = next; accent = 'custom'; saveAccent(); apply(); return true;
  }
  picker.addEventListener('input', () => { if (updateCustom(picker.value)) syncInputs(); }, { signal: life.signal });
  hex.addEventListener('input', () => {
    // Partial input remains editable; only complete six-digit values preview live.
    if (/^#?[\da-f]{6}$/i.test(hex.value) && updateCustom(hex.value)) { picker.value = custom.color; hex.removeAttribute('aria-invalid'); hint.textContent = caption; }
  }, { signal: life.signal });
  const commitHex = () => {
    if (updateCustom(hex.value)) syncInputs();
    else { hex.setAttribute('aria-invalid', 'true'); hint.textContent = t(msg("theme.enterAValidHexColorSuchAs", "请输入有效的 HEX 颜色，例如 #3478F6。")); }
  };
  hex.addEventListener('change', commitHex, { signal: life.signal });
  hex.addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); commitHex(); }
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); syncInputs(); }
  }, { signal: life.signal });
  const updateBase = (value: string) => {
    const next = customTheme(value); if (!next) return false;
    base = next; preference = 'custom'; apply(); savePreference(); return true;
  };
  for (const button of baseButtons) button.addEventListener('click', () => { if (updateBase(button.dataset.baseChoice!)) syncBaseInputs(); }, { signal: life.signal });
  basePicker.addEventListener('input', () => { if (updateBase(basePicker.value)) syncBaseInputs(); }, { signal: life.signal });
  baseHex.addEventListener('input', () => {
    if (/^#?[\da-f]{6}$/i.test(baseHex.value) && updateBase(baseHex.value)) { basePicker.value = base.color; baseHex.removeAttribute('aria-invalid'); baseHint.textContent = ''; }
  }, { signal: life.signal });
  const invalidBase = () => { baseHex.setAttribute('aria-invalid', 'true'); baseHint.textContent = t(msg('theme.invalidBase', '请输入有效的 HEX 基调色，例如 #EEE7DE。')); };
  const commitBase = () => { if (updateBase(baseHex.value)) syncBaseInputs(); else invalidBase(); };
  baseHex.addEventListener('change', commitBase, { signal: life.signal });
  baseHex.addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); commitBase(); }
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); syncBaseInputs(); }
  }, { signal: life.signal });
  syncBaseInputs(); syncInputs();
  system.addEventListener('change', apply, { signal: life.signal });
  window.addEventListener('storage', event => {
    if (event.key === KEY || event.key === ACCENT_KEY || event.key === CUSTOM_KEY || event.key === BASE_KEY || event.key === null) { preference = readPreference(); accent = readAccent(); custom = readCustom(); base = readBase(); syncBaseInputs(); syncInputs(); apply(); }
  }, { signal: life.signal });
  onLanguageChange(() => { apply(); if (baseHex.hasAttribute('aria-invalid')) invalidBase(); if (hex.hasAttribute('aria-invalid')) hint.textContent = t(msg("theme.enterAValidHexColorSuchAs", "请输入有效的 HEX 颜色，例如 #3478F6。")); }, life.signal);
  apply();
  return () => life.abort();
}
