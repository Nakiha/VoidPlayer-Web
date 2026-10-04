// Apply before first paint; keep validation aligned with ui/theme.ts.
let accent;
try { accent = localStorage.getItem('voidplayer.accent'); } catch {}
document.documentElement.dataset.accent = ['blue', 'indigo', 'purple', 'rose', 'red', 'orange', 'amber', 'lime', 'green', 'mint', 'teal', 'sky'].includes(accent) ? accent : 'blue';
try {
  const custom = JSON.parse(localStorage.getItem('voidplayer.custom-accent') || 'null');
  if (accent === 'custom' && custom && [custom.color, custom.light, custom.dark].every(c => typeof c === 'string' && /^#[\da-f]{6}$/i.test(c))) {
    document.documentElement.style.setProperty('--custom-accent-light', custom.light);
    document.documentElement.style.setProperty('--custom-accent-dark', custom.dark);
    document.documentElement.dataset.accent = 'custom';
  }
} catch {}
let preference;
try { preference = localStorage.getItem('voidplayer.theme'); } catch {}
document.documentElement.dataset.theme = preference === 'light' || preference === 'dark'
  ? preference : (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');

try {
  const base = JSON.parse(localStorage.getItem('voidplayer.custom-theme') || 'null');
  const tokens = ['surface', 'panel', 'table', 'group', 'hover', 'input', 'preview', 'viewport', 'text', 'secondary', 'subtle', 'accent'];
  if (preference === 'custom' && base && typeof base.dark === 'boolean' && /^#[\da-f]{6}$/i.test(base.color) && tokens.every(token => typeof base.colors?.[token] === 'string' && /^#[\da-f]{6}$/i.test(base.colors[token]))) {
    document.documentElement.dataset.theme = base.dark ? 'dark' : 'light';
    document.documentElement.dataset.customTheme = '';
    for (const token of tokens) document.documentElement.style.setProperty(`--custom-theme-${token}`, base.colors[token]);
  }
} catch {}
