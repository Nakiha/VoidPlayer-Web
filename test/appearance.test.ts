import assert from 'node:assert/strict';
import { test } from 'node:test';
import { customAccent, normalizeAccent } from '../src/ui/appearance.ts';

test('custom accent input accepts hex and leaves invalid values unapplied', () => {
  assert.equal(normalizeAccent(' #aBc '), '#aabbcc');
  for (const value of ['', '#12', '#abcd', 'red', '#ffgg00', 'url(x)']) assert.equal(customAccent(value), null);
});

test('extreme custom colors remain readable on both selected panel surfaces', () => {
  const rgb = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
  const luminance = (rgb: number[]) => rgb.map(v => { const c = v / 255; return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; }).reduce((a, v, i) => a + v * [.2126, .7152, .0722][i], 0);
  for (const color of ['#000000', '#ffffff', '#ffff00', '#0000ff', '#ff0000', '#00ff00', '#808080']) {
    const accent = customAccent(color)!;
    assert.equal(accent.color, color);
    for (const [variant, surface] of [[accent.light, '#f0f1f3'], [accent.dark, '#27292e']]) {
      const foreground = rgb(variant), panel = rgb(surface);
      const selected = panel.map((c, i) => c * .85 + foreground[i] * .15);
      const a = luminance(foreground), b = luminance(selected);
      assert.ok((Math.max(a,b) + .05) / (Math.min(a,b) + .05) >= 4.5, `${color} on ${surface}`);
    }
  }
});
