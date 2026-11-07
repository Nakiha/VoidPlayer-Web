// Moving silver grain is applied after the lettering so the title receives the
// same exposure as the plate. Only the small noise tile is generated pixelwise.
export function createEmulsion(w: number, h: number) {
  const canvas = document.createElement('canvas'), tile = document.createElement('canvas');
  canvas.className = 'brand-cinema-emulsion';
  const ratio = Math.min(1, Math.sqrt(800_000 / (w * h)));
  canvas.width = Math.max(1, Math.round(w * ratio)); canvas.height = Math.max(1, Math.round(h * ratio));
  tile.width = tile.height = 157;
  const ctx = canvas.getContext('2d'), stock = tile.getContext('2d');
  if (!ctx || !stock) throw new Error('Film emulsion unavailable');
  const noise = stock.createImageData(tile.width, tile.height);
  let seed = 179261;
  for (let i = 0; i < noise.data.length; i += 4) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const grey = ((seed >>> 24) + ((seed >>> 12) & 255)) / 2;
    noise.data[i] = grey; noise.data[i + 1] = grey; noise.data[i + 2] = grey; noise.data[i + 3] = 255;
  }
  stock.putImageData(noise, 0, 0);
  const pattern = ctx.createPattern(tile, 'repeat');
  if (!pattern) throw new Error('Film grain unavailable');
  let last = -1;
  const develop = (t: number) => {
    const frame = Math.floor(t * 24);
    if (frame === last) return;
    last = frame;
    const dx = frame * 43 % tile.width, dy = frame * 61 % tile.height;
    ctx.setTransform(1, 0, 0, 1, -dx, -dy);
    ctx.fillStyle = pattern;
    ctx.fillRect(dx, dy, canvas.width, canvas.height);
    if (frame % 37 === 6 || frame % 37 === 7) {
      const x = canvas.width * (.16 + (frame % 11) / 20), y = canvas.height * .24;
      ctx.strokeStyle = '#382d2c'; ctx.lineWidth = 1.25;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.quadraticCurveTo(x + 2, y + 4, x - 1, y + 9); ctx.stroke();
    }
  };
  return { canvas, develop };
}
