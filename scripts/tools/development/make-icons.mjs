// Render the editable Apple Icon Composer document once, then derive the web sizes.
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const publicDir = new URL('../../../public/', import.meta.url);
const designDir = new URL('../../../design/', import.meta.url);
const source = fileURLToPath(new URL('VoidPlayer.icon/', designDir));
const backing = '#ffffff';
const developer = execFileSync('xcode-select', ['-p'], { encoding: 'utf8' }).trim();
const composer = path.resolve(developer, '../Applications/Icon Composer.app/Contents/Executables/ictool');
const temp = await mkdtemp(path.join(tmpdir(), 'voidplayer-icon-'));
let browser;
try {
  const master = path.join(temp, 'icon.png');
  execFileSync(composer, [source, '--export-image', '--output-file', master, '--platform', 'macOS',
    '--rendition', 'Default', '--width', '1024', '--height', '1024', '--scale', '1']);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  async function vectorLayers(document, layers) {
    const files = await Promise.all(layers.map(layer => readFile(path.join(document, 'Assets', layer['image-name']), 'utf8')));
    return page.evaluate(({ files, layers }) => files.map((file, index) => {
      const root = new DOMParser().parseFromString(file, 'image/svg+xml').documentElement;
      if (root.localName !== 'svg' || root.getAttribute('viewBox') !== '0 0 1024 1024') throw Error('Invalid icon layer: ' + layers[index].name);
      // Each imported SVG has its own gradient IDs. Keep those references local when composing one SVG.
      for (const node of root.querySelectorAll('[id]')) {
        const id = node.id;
        node.id = `layer-${index}-${id}`;
        for (const element of root.querySelectorAll('*')) {
          for (const attribute of element.attributes) {
            attribute.value = attribute.value.replaceAll(`url(#${id})`, `url(#${node.id})`);
          }
        }
      }
      return `  <g id="${layers[index].name}">${root.innerHTML.trim()}</g>`;
    }).join('\n'), { files, layers });
  }
  const project = JSON.parse(await readFile(path.join(source, 'icon.json'), 'utf8'));
  const layers = await vectorLayers(source, [...project.groups].reverse().flatMap(group => [...group.layers].reverse()));
  const vector = (size, artwork, background) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 1024 1024">
  <title>VoidPlayer</title>
  <rect width="1024" height="1024" rx="224" fill="${background}"/>
${artwork}
</svg>\n`;
  const faviconArt = `  <defs><filter id="shadow" x="-20%" y="-20%" width="140%" height="150%">
    <feDropShadow dx="0" dy="12" stdDeviation="10" flood-opacity="0.12"/>
  </filter></defs>
  <g filter="url(#shadow)">
${layers}
  </g>`;
  await writeFile(new URL('favicon.svg', publicDir), vector(32, faviconArt, backing));

  // Give the standalone mark a close, square viewBox so it fits an in-app icon slot.
  const foreground = await page.evaluate(artwork => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.innerHTML = '<title>VoidPlayer</title>\n' + artwork + '\n';
    document.body.appendChild(svg);
    const { x, y, width, height } = svg.getBBox();
    const side = Math.ceil(Math.max(width, height));
    svg.setAttribute('viewBox', [x + (width - side) / 2, y + (height - side) / 2, side, side].join(' '));
    svg.setAttribute('width', side);
    svg.setAttribute('height', side);
    svg.remove();
    return new XMLSerializer().serializeToString(svg) + '\n';
  }, layers);
  await writeFile(new URL('icon-foreground.svg', publicDir), foreground);

  // Keep the original two-frame motion study reproducible apart from the shipping icon.
  const studies = new URL('studies/', designDir);
  const frames = fileURLToPath(new URL('Frames.icon/', studies));
  const frameProject = JSON.parse(await readFile(path.join(frames, 'icon.json'), 'utf8'));
  const frameLayers = await vectorLayers(frames, frameProject.groups.flatMap(group => group.layers));
  const motionCss = await readFile(new URL('VoidPlayer-motion.css', studies), 'utf8');
  const motion = `  <style>\n${motionCss}  </style>\n${frameLayers}`;
  await writeFile(new URL('VoidPlayer-motion.svg', studies), vector(256, motion, '#e5ebf3'));

  const { images, maskable } = await page.evaluate(async ({ png, backing }) => {
    const image = new Image();
    image.src = 'data:image/png;base64,' + png;
    await image.decode();
    function render(size, opaque = false) {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      if (opaque) { ctx.fillStyle = backing; ctx.fillRect(0, 0, size, size); }
      ctx.drawImage(image, 0, 0, size, size);
      return canvas.toDataURL('image/png').split(',')[1];
    }
    return { images: [16, 32, 48, 180, 192, 512].map(size => ({ size, png: render(size, size === 180) })),
      maskable: render(512, true) };
  }, { png: (await readFile(master)).toString('base64'), backing });
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
    if (size <= 48) continue; // Those sizes are already embedded in favicon.ico.
    const filename = size === 180 ? 'apple-touch-icon.png' : `icon-${size}.png`;
    await writeFile(new URL(filename, publicDir), Buffer.from(png, 'base64'));
  }
  await writeFile(new URL('icon-maskable-512.png', publicDir), Buffer.from(maskable, 'base64'));
} finally {
  await browser?.close();
  await rm(temp, { recursive: true, force: true });
}
