import { t, msg } from '../i18n.ts';
/** UI accents only; annotation ink and stable mark identities retain their own colors. */
export const ACCENTS = [
  { id: 'blue', get name() { return t(msg("appearance.blue", "蓝色")); }, light: '#007aff', dark: '#6aaeff' },
  { id: 'indigo', get name() { return t(msg("appearance.indigo", "靛蓝")); }, light: '#5552b8', dark: '#aaa7ff' },
  { id: 'purple', get name() { return t(msg("appearance.purple", "紫色")); }, light: '#8050c8', dark: '#bd9aff' },
  { id: 'rose', get name() { return t(msg("appearance.rose", "玫红")); }, light: '#bf3b72', dark: '#f18bb4' },
  { id: 'red', get name() { return t(msg("appearance.red", "红色")); }, light: '#c43d3d', dark: '#ff9690' },
  { id: 'orange', get name() { return t(msg("appearance.orange", "橙色")); }, light: '#b75b0a', dark: '#ffb269' },
  { id: 'amber', get name() { return t(msg("appearance.amber", "琥珀")); }, light: '#936b00', dark: '#e9c567' },
  { id: 'lime', get name() { return t(msg("appearance.lime", "草绿")); }, light: '#608021', dark: '#b1d478' },
  { id: 'green', get name() { return t(msg("appearance.green", "绿色")); }, light: '#25834f', dark: '#70cc99' },
  { id: 'mint', get name() { return t(msg("appearance.mint", "薄荷")); }, light: '#168169', dark: '#78d5b8' },
  { id: 'teal', get name() { return t(msg("appearance.teal", "青色")); }, light: '#087f8c', dark: '#63cbd5' },
  { id: 'sky', get name() { return t(msg("appearance.sky", "天蓝")); }, light: '#087fa9', dark: '#7acded' },
] as const;

/** Common reading palettes: muted light seeds followed by deeper, tinted seeds. */
export const BASE_COLORS = [
  { color: '#eee7de', get name() { return t(msg('appearance.baseIvory', '米白')); } },
  { color: '#e9edf2', get name() { return t(msg('appearance.baseMist', '雾灰')); } },
  { color: '#e4edf4', get name() { return t(msg('appearance.baseIce', '冰蓝')); } },
  { color: '#e4ece4', get name() { return t(msg('appearance.baseSage', '浅鼠尾草')); } },
  { color: '#ece7f1', get name() { return t(msg('appearance.baseLavender', '浅薰衣草')); } },
  { color: '#f3e6e6', get name() { return t(msg('appearance.baseBlush', '浅玫瑰')); } },
  { color: '#25272b', get name() { return t(msg('appearance.baseGraphite', '石墨')); } },
  { color: '#18304a', get name() { return t(msg('appearance.baseNavy', '深海蓝')); } },
  { color: '#24382e', get name() { return t(msg('appearance.baseForest', '森林绿')); } },
  { color: '#352b41', get name() { return t(msg('appearance.basePlum', '暗紫')); } },
  { color: '#3d3028', get name() { return t(msg('appearance.baseMocha', '摩卡')); } },
  { color: '#28353a', get name() { return t(msg('appearance.baseSlate', '青灰')); } },
] as const;

export function normalizeAccent(value: string): string | null {
  const hex = value.trim().replace(/^#/, '');
  if (/^[\da-f]{3}$/i.test(hex)) return '#' + [...hex.toLowerCase()].map(c => c + c).join('');
  return /^[\da-f]{6}$/i.test(hex) ? '#' + hex.toLowerCase() : null;
}

/** Cache both display variants so the inline bootstrap can apply them before paint. */
export function customAccent(value: string) {
  const color = normalizeAccent(value);
  if (!color) return null;
  const rgb = [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16));
  const luminance = (channels: number[]) => channels.reduce((sum, n, i) => {
    const c = n / 255;
    return sum + (c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4) * [.2126, .7152, .0722][i];
  }, 0);
  const variant = (dark: boolean) => {
    let channels = rgb;
    // Leave room for accent text over the tinted selection background too.
    for (let step = 0; step <= 100; step++) {
      channels = rgb.map(c => Math.round(c + ((dark ? 255 : 0) - c) * step / 100));
      if (dark ? luminance(channels) >= .4 : luminance(channels) <= .1) break;
    }
    return '#' + channels.map(c => c.toString(16).padStart(2, '0')).join('');
  };
  return { color, light: variant(false), dark: variant(true) };
}

const channels = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
const asHex = (rgb: number[]) => '#' + rgb.map(c => Math.round(c).toString(16).padStart(2, '0')).join('');
const mix = (a: string, b: string, amount: number) => asHex(channels(a).map((c, i) => c + (channels(b)[i] - c) * amount));
const luminance = (hex: string) => channels(hex).reduce((sum, n, i) => {
  const c = n / 255;
  return sum + (c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4) * [.2126, .7152, .0722][i];
}, 0);
const contrast = (a: string, b: string) => (Math.max(luminance(a), luminance(b)) + .05) / (Math.min(luminance(a), luminance(b)) + .05);

/** Generate reading surfaces from a seed, leaving room for distinct tonal layers. */
export function customTheme(value: string) {
  const color = normalizeAccent(value);
  if (!color) return null;
  const dark = luminance(color) < .35, endpoint = dark ? '#000000' : '#ffffff';
  let surface = color;
  for (let step = 0; step <= 100; step++) {
    surface = mix(color, endpoint, step / 100);
    if (dark ? luminance(surface) <= .07 : luminance(surface) >= .55) break;
  }
  const layer = (amount: number) => mix(surface, dark ? '#ffffff' : '#000000', amount);
  const colors = {
    surface, panel: layer(.025), table: layer(.01), group: layer(.065), hover: layer(.10),
    input: mix(surface, dark ? '#000000' : '#ffffff', .08), preview: layer(.04), viewport: mix(surface, '#000000', dark ? .08 : .04),
    text: dark ? '#f2f3f5' : '#16191e', secondary: '', subtle: '', accent: '',
  };
  const backgrounds = [colors.surface, colors.panel, colors.table, colors.group, colors.hover, colors.input, colors.preview, colors.viewport];
  const readable = (seed: string, selected = false) => {
    const end = dark ? '#ffffff' : '#000000';
    for (let step = 0; step <= 100; step++) {
      const fg = mix(seed, end, step / 100);
      if (backgrounds.every(bg => contrast(fg, bg) >= 4.5) && (!selected || contrast(fg, mix(colors.panel, fg, .15)) >= 4.5)) return fg;
    }
    return end;
  };
  colors.secondary = readable(mix(surface, colors.text, .66));
  colors.subtle = readable(mix(surface, colors.text, .55));
  return { color, dark, colors, accent: (seed: string) => readable(seed, true) };
}
