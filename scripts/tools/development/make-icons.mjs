// Derive regular and full-bleed square web icons from the editable Icon Composer document.
import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  // Fit the foreground and tab icon to the artwork without a white backing or shadow.
  const { foreground, faviconSvg, maskSvg, crop, squareLayers } = await page.evaluate(artwork => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.innerHTML = '<title>VoidPlayer</title>\n' + artwork + '\n';
    document.body.appendChild(svg);
    const { x, y, width, height } = svg.getBBox();
    const side = Math.ceil(Math.max(width, height));
    const crop = { x: x + (width - side) / 2, y: y + (height - side) / 2, side };
    // Maskable artwork fills a square. Extend only outer tile edges; keep the play key and internal seams in place.
    const squareLayers = [...svg.querySelectorAll(':scope > g')].filter(group => group.id !== 'Play').map(group => {
      const bounds = group.getBBox(), square = group.cloneNode(true);
      const edge = (value, outside, extended) => Number((Math.abs(value - outside) < .01 ? extended : value).toFixed(2));
      const left = edge(bounds.x, x, crop.x), right = edge(bounds.x + bounds.width, x + width, crop.x + side);
      const top = edge(bounds.y, y, crop.y), bottom = edge(bounds.y + bounds.height, y + height, crop.y + side);
      square.querySelector('path').setAttribute('d', `M${left} ${top}H${right}V${bottom}H${left}Z`);
      return { name: group.id, svg: `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">${square.innerHTML}</svg>` };
    });
    svg.setAttribute('viewBox', [crop.x, crop.y, side, side].join(' '));
    svg.setAttribute('width', side);
    svg.setAttribute('height', side);
    svg.remove();
    // Clip the Composer rendition to the colored tile silhouette, excluding its white backing.
    const mask = svg.cloneNode(true);
    mask.querySelector('#Play')?.remove();
    for (const path of mask.querySelectorAll('path')) path.setAttribute('fill', '#fff');
    mask.setAttribute('viewBox', '0 0 1024 1024'); mask.setAttribute('width', '1024'); mask.setAttribute('height', '1024');
    const maskSvg = new XMLSerializer().serializeToString(mask);
    const foreground = new XMLSerializer().serializeToString(svg) + '\n';
    svg.setAttribute('width', '32');
    svg.setAttribute('height', '32');
    return { foreground, faviconSvg: new XMLSerializer().serializeToString(svg) + '\n', maskSvg, crop, squareLayers };
  }, layers);
  await writeFile(new URL('icon-foreground.svg', publicDir), foreground);
  await writeFile(new URL('favicon.svg', publicDir), faviconSvg);
  const squareSource = path.join(temp, 'Square.icon'), squareMaster = path.join(temp, 'square.png');
  await cp(source, squareSource, { recursive: true });
  for (const layer of squareLayers) {
    const original = project.groups.flatMap(group => group.layers).find(item => item.name === layer.name);
    if (!original) throw Error('Missing icon tile: ' + layer.name);
    await writeFile(path.join(squareSource, 'Assets', original['image-name']), layer.svg);
  }
  execFileSync(composer, [squareSource, '--export-image', '--output-file', squareMaster, '--platform', 'macOS',
    '--rendition', 'Default', '--width', '1024', '--height', '1024', '--scale', '1']);

  const { images, maskable } = await page.evaluate(async ({ png, squarePng, faviconSvg, maskSvg, crop, backing }) => {
    const image = new Image();
    image.src = 'data:image/png;base64,' + png;
    await image.decode();
    const square = new Image(); square.src = 'data:image/png;base64,' + squarePng;
    await square.decode();
    const favicon = new Image();
    favicon.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(faviconSvg);
    await favicon.decode();
    const mask = new Image();
    mask.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(maskSvg);
    await mask.decode();
    const artwork = document.createElement('canvas'); artwork.width = artwork.height = 1024;
    const artworkContext = artwork.getContext('2d');
    artworkContext.drawImage(image, 0, 0);
    artworkContext.globalCompositeOperation = 'destination-in';
    artworkContext.drawImage(mask, 0, 0);
    function render(image, size, opaque = false, cropped = false) {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      if (opaque) { ctx.fillStyle = backing; ctx.fillRect(0, 0, size, size); }
      if (cropped) ctx.drawImage(image, crop.x, crop.y, crop.side, crop.side, 0, 0, size, size);
      else ctx.drawImage(image, 0, 0, size, size);
      return canvas.toDataURL('image/png').split(',')[1];
    }
    return { images: [16, 32, 48, 180, 192, 512].map(size => ({ size, png: render(size <= 48 ? favicon : artwork, size, size === 180, size > 48) })),
      maskable: render(square, 512, true, true) };
  }, { png: (await readFile(master)).toString('base64'), squarePng: (await readFile(squareMaster)).toString('base64'),
    faviconSvg, maskSvg, crop, backing });
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
