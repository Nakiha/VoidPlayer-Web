/** UI accents only; annotation ink and stable mark identities retain their own colors. */
export const ACCENTS = [
  { id: 'blue', name: '蓝色', light: '#007aff', dark: '#6aaeff' },
  { id: 'indigo', name: '靛蓝', light: '#5552b8', dark: '#aaa7ff' },
  { id: 'purple', name: '紫色', light: '#8050c8', dark: '#bd9aff' },
  { id: 'rose', name: '玫红', light: '#bf3b72', dark: '#f18bb4' },
  { id: 'red', name: '红色', light: '#c43d3d', dark: '#ff9690' },
  { id: 'orange', name: '橙色', light: '#b75b0a', dark: '#ffb269' },
  { id: 'amber', name: '琥珀', light: '#936b00', dark: '#e9c567' },
  { id: 'lime', name: '草绿', light: '#608021', dark: '#b1d478' },
  { id: 'green', name: '绿色', light: '#25834f', dark: '#70cc99' },
  { id: 'mint', name: '薄荷', light: '#168169', dark: '#78d5b8' },
  { id: 'teal', name: '青色', light: '#087f8c', dark: '#63cbd5' },
  { id: 'sky', name: '天蓝', light: '#087fa9', dark: '#7acded' },
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
