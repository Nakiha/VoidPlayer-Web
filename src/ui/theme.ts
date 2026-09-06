import { ACCENTS, customAccent } from './appearance.ts';
type ThemePreference = 'system' | 'light' | 'dark';
const KEY = 'voidplayer.theme';
const ACCENT_KEY = 'voidplayer.accent';
const CUSTOM_KEY = 'voidplayer.custom-accent';
function readCustom() { try { const stored = JSON.parse(localStorage.getItem(CUSTOM_KEY) ?? 'null'); return customAccent(typeof stored?.color === 'string' ? stored.color : '') ?? customAccent('#007aff')!; } catch { return customAccent('#007aff')!; } }
function readAccent() { try { const value = localStorage.getItem(ACCENT_KEY); return value === 'custom' ? 'custom' : ACCENTS.find(c => c.id === value)?.id ?? 'blue'; } catch { return 'blue'; } }
function readPreference(): ThemePreference {
  try {
    const value = localStorage.getItem(KEY);
    if (value === 'light' || value === 'dark') return value;
  } catch { /* Storage restrictions must not prevent changing this page's appearance. */ }
  return 'system';
}

/** Appearance is a UI preference, independent of review data and media presentation. */
export function installThemeControls() {
  const system = matchMedia('(prefers-color-scheme: dark)');
  const life = new AbortController();
  const buttons = [...document.querySelectorAll<HTMLButtonElement>('[data-theme-choice]')];
  let preference = readPreference();
  let accent = readAccent(); let custom = readCustom();
  const picker = document.getElementById('accent-picker') as HTMLInputElement;
  const hex = document.getElementById('accent-hex') as HTMLInputElement;
  const hint = document.getElementById('accent-input-hint')!;
  const caption = hint.textContent!;
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
    document.documentElement.dataset.theme = preference === 'system' ? (system.matches ? 'dark' : 'light') : preference;
    document.documentElement.dataset.accent = accent;
    document.documentElement.style.setProperty('--custom-accent-light', custom.light);
    document.documentElement.style.setProperty('--custom-accent-dark', custom.dark);
    const customButton = document.querySelector<HTMLElement>('[data-accent-choice=custom]')!;
    customButton.style.setProperty('--swatch-light', custom.light); customButton.style.setProperty('--swatch-dark', custom.dark);
    document.getElementById('accent-current')!.textContent = accent === 'custom' ? `自定义 · ${custom.color.toUpperCase()}` : ACCENTS.find(c => c.id === accent)!.name;
    for (const button of accents) { const selected = button.dataset.accentChoice === accent; button.setAttribute('aria-checked', String(selected)); button.tabIndex = selected ? 0 : -1; }
    for (const button of buttons) button.setAttribute('aria-checked', String(button.dataset.themeChoice === preference));
  }
  for (const button of buttons) button.addEventListener('click', () => {
    preference = button.dataset.themeChoice as ThemePreference;
    try { if (preference === 'system') localStorage.removeItem(KEY); else localStorage.setItem(KEY, preference); } catch { /* Keep the choice for this page. */ }
    apply();
  }, { signal: life.signal });
  for (const button of accents) button.addEventListener('click', () => {
    accent = button.dataset.accentChoice === 'custom' ? 'custom' : ACCENTS.find(c => c.id === button.dataset.accentChoice)!.id;
    saveAccent(); syncInputs();
    apply();
  }, { signal: life.signal });
  for (const group of [buttons, accents]) for (const button of group) button.addEventListener('keydown', event => {
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
    else { hex.setAttribute('aria-invalid', 'true'); hint.textContent = '请输入有效的 HEX 颜色，例如 #3478F6。'; }
  };
  hex.addEventListener('change', commitHex, { signal: life.signal });
  hex.addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); commitHex(); }
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); syncInputs(); }
  }, { signal: life.signal });
  syncInputs();
  system.addEventListener('change', apply, { signal: life.signal });
  window.addEventListener('storage', event => {
    if (event.key === KEY || event.key === ACCENT_KEY || event.key === CUSTOM_KEY || event.key === null) { preference = readPreference(); accent = readAccent(); custom = readCustom(); syncInputs(); apply(); }
  }, { signal: life.signal });
  apply();
  return () => life.abort();
}
