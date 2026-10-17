// Export browser-rendered icons from the canonical vector mark.
// Usage: npm run icons:generate (requires Playwright Chromium).
import { readFile, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const publicDir = new URL('../../../public/', import.meta.url);
const svg = await readFile(new URL('favicon.svg', publicDir), 'utf8');
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const images = await page.evaluate(async svg => {
    const image = new Image();
    image.src = `data:image/svg+xml,${encodeURIComponent(svg)}`;
    await image.decode();
    return [16, 32, 48, 180, 192, 512].map(size => {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = size;
      const ctx = canvas.getContext('2d');
      // Home-screen icons have an opaque backing for platform-applied masks.
      if (size >= 180) { ctx.fillStyle = '#f8fafc'; ctx.fillRect(0, 0, size, size); }
      const inset = size >= 180 ? size / 8 : 0;
      ctx.drawImage(image, inset, inset, size - inset * 2, size - inset * 2);
      return { size, png: canvas.toDataURL('image/png').split(',')[1] };
    });
  }, svg);
  const favicon = images.filter(image => image.size <= 48).map(image => ({ ...image, bytes: Buffer.from(image.png, 'base64') }));
  // ICO directory with embedded PNG entries: keeps alpha at each native size.
  const directory = Buffer.alloc(6 + favicon.length * 16);
  directory.writeUInt16LE(1, 2); directory.writeUInt16LE(favicon.length, 4);
  let offset = directory.length;
  for (const [index, { size, bytes }] of favicon.entries()) {
    const at = 6 + index * 16;
    directory[at] = directory[at + 1] = size;
    directory.writeUInt16LE(1, at + 4); directory.writeUInt16LE(32, at + 6);
    directory.writeUInt32LE(bytes.length, at + 8); directory.writeUInt32LE(offset, at + 12);
    offset += bytes.length;
  }
  await writeFile(new URL('favicon.ico', publicDir), Buffer.concat([directory, ...favicon.map(image => image.bytes)]));
  for (const { size, png } of images) {
    const filename = size === 180 ? 'apple-touch-icon.png' : `icon-${size}.png`;
    await writeFile(new URL(filename, publicDir), Buffer.from(png, 'base64'));
  }
  console.log('Generated ICO (16/32/48), PNG (16/32/48/192/512) and Apple touch icon (180).');
} finally { await browser.close(); }
