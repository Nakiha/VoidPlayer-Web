import { DEFAULT_ANNOTATION_COLOR } from '../annotation.ts';
import { installMenu } from './menu.ts';

const common = [
  [DEFAULT_ANNOTATION_COLOR, '红色'], ['#ff9500', '橙色'], ['#ffcc00', '黄色'],
  ['#34c759', '绿色'], ['#5ac8fa', '青色'], ['#007aff', '蓝色'],
  ['#e93eff', '品红色'], ['#af52de', '紫色'], ['#a2845e', '棕色'],
  ['#ffffff', '白色'], ['#8e8e93', '灰色'], ['#000000', '黑色'],
];
const hex = (value: number) => Math.round(value).toString(16).padStart(2, '0');
function tone(hue: number, lightness: number) {
  const a = .7 * Math.min(lightness, 1 - lightness);
  const channel = (n: number) => { const k = (n + hue / 30) % 12; return hex(255 * (lightness - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))); };
  return `#${channel(0)}${channel(8)}${channel(4)}`;
}
// A fixed grayscale row plus nine rows of hues, dark to light. No history or preferences.
const spectrum = [
  ...[255, 235, 215, 195, 175, 155, 135, 115, 95, 65, 35, 0].map(v => `#${hex(v).repeat(3)}`),
  ...[.14, .23, .32, .41, .5, .62, .73, .84, .93].flatMap(l => [195, 220, 255, 285, 320, 5, 25, 40, 55, 75, 100, 135].map(h => tone(h, l))),
].map(color => [color, '颜色']);
const valid = (value: unknown): value is string => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);

/** Stateless fixed palette. Choosing a color uses the editor's normal style path. */
export function installColorMenu(id: string, choose: (value: string) => void) {
  const button = document.getElementById(id) as HTMLButtonElement;
  const swatch = document.createElement('span'); swatch.className = 'color-swatch'; swatch.setAttribute('aria-hidden', 'true'); button.replaceChildren(swatch);
  const menu = document.createElement('div'); menu.id = `${id}-menu`; menu.className = 'color-menu'; document.body.append(menu);
  let value = DEFAULT_ANNOTATION_COLOR;
  // Remove the previous implementation's preference; never read or record color history.
  try { localStorage.removeItem('voidplayer.annotation.recent-colors'); } catch { /* Storage is optional. */ }
  function section(title: string, colors: string[][]) {
    const group = document.createElement('section'); group.setAttribute('role', 'group'); group.setAttribute('aria-label', title);
    const grid = document.createElement('div'); grid.className = 'palette-grid';
    for (const [color, name] of colors) {
      const item = document.createElement('button'); item.type = 'button'; item.dataset.color = color;
      item.setAttribute('role', 'menuitemradio'); item.setAttribute('aria-label', `${name} ${color}`);
      item.setAttribute('aria-checked', String(color === value));
      const ink = document.createElement('span'); ink.className = 'color-swatch'; ink.style.backgroundColor = color; ink.setAttribute('aria-hidden', 'true'); item.append(ink);
      item.onclick = () => choose(color);
      grid.append(item);
    }
    group.append(grid); return group;
  }
  menu.append(section('常用色', common), section('色盘', spectrum));
  function render() {
    swatch.style.backgroundColor = value;
    for (const item of menu.querySelectorAll<HTMLButtonElement>('[data-color]')) item.setAttribute('aria-checked', String(item.dataset.color === value));
  }
  const controller = installMenu(button, menu, {
    columns: 12,
    selected: () => menu.querySelector<HTMLButtonElement>('[aria-checked=true]') ?? undefined,
    bounds: () => button.closest('.annotation-toolbar')?.parentElement?.getBoundingClientRect(),
  });
  return {
    sync(next: string, _text: string, enabled: boolean) {
      if (valid(next)) value = next.toLowerCase();
      button.disabled = !enabled; if (!enabled) controller.close(); render();
    },
    dispose() { controller.dispose(); menu.remove(); },
  };
}
