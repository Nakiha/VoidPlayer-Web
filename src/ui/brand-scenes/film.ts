import { exposeMoon, exposeOrbit } from './orbit.ts';
import { ease, mix } from './timing.ts';

export function createFilm(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const orbit = exposeOrbit(), moon = exposeMoon(), stock = Math.min(w * .94, h * 1.56), pitch = stock * .585;
  const frameW = stock * .822, frameH = pitch * .934;
  const lamp = ctx.createRadialGradient(w * .47, h * .50, 0, w * .47, h * .50, Math.max(w, h) * .82);
  lamp.addColorStop(0, '#ffe0a2'); lamp.addColorStop(.44, '#a76b44'); lamp.addColorStop(.73, '#342421'); lamp.addColorStop(1, '#140f14');
  const base = ctx.createLinearGradient(-stock / 2, 0, stock / 2, 0);
  base.addColorStop(0, '#815234'); base.addColorStop(.009, '#311e18'); base.addColorStop(.07, '#402725');
  base.addColorStop(.11, '#15161b'); base.addColorStop(.90, '#16161b'); base.addColorStop(.97, '#3c2220'); base.addColorStop(1, '#91573b');

  function exposure(y: number, index: number, t: number) {
    const number = (index % 36 + 36) % 36;
    ctx.save();
    ctx.translate(0, y);
    // Four perforations per frame on each side of the 35 mm strip.
    ctx.beginPath(); ctx.rect(-stock / 2, -pitch / 2, stock, pitch + .65);
    for (const side of [-1, 1]) for (let n = 0; n < 4; n++) {
      ctx.roundRect(side * stock * .454 - stock * .022, pitch * ((n + .5) / 4 - .5) - stock * .016,
        stock * .044, stock * .032, stock * .005);
    }
    ctx.fillStyle = base; ctx.fill('evenodd');
    ctx.fillStyle = '#dba267'; ctx.font = Math.max(8, stock * .014) + 'px monospace';
    ctx.save(); ctx.translate(stock * -.486, -pitch * .22); ctx.rotate(Math.PI / 2);
    ctx.fillText('VP  35', 0, 0); ctx.fillText(String(number + 1) + '  ▸', pitch * .54, 0); ctx.restore();
    ctx.beginPath(); ctx.roundRect(-frameW / 2, -frameH / 2, frameW, frameH, stock * .009); ctx.clip();

    const zoom = [1.12, 1.39, 1.22][number % 3] + .076 * Math.sin(t * .37);
    const imageW = Math.max(frameW, frameH * orbit.width / orbit.height) * zoom, imageH = imageW * orbit.height / orbit.width;
    const pan = .5 + .32 * Math.sin(t * .25 + number * .37);
    ctx.drawImage(orbit, -frameW / 2 - (imageW - frameW) * pan, -frameH / 2 - (imageH - frameH) * .45, imageW, imageH);
    const phase = t * .235 + number / 24, diameter = frameW * (.045 + .005 * Math.cos(phase));
    ctx.drawImage(moon, frameW * (.02 + .37 * Math.cos(phase + .55)), frameH * (-.14 + .16 * Math.sin(phase - .65)), diameter, diameter);
    const falloff = ctx.createLinearGradient(0, -frameH / 2, 0, frameH / 2);
    falloff.addColorStop(0, '#150e1918'); falloff.addColorStop(.50, '#1a101100'); falloff.addColorStop(1, '#100a16a0');
    ctx.fillStyle = falloff; ctx.fillRect(-frameW / 2, -frameH / 2, frameW, frameH);
    ctx.restore();
  }

  function transport(t: number) {
    const travel = 3.8 * (1 - ease(.12, 2.25, t)), fraction = travel % 1;
    const running = Math.max(0, t - 6), lap = Math.floor(running / 9);
    return (Math.floor(travel) + mix(fraction, ease(.14, .91, fraction), .62) - lap - ease(0, 1.25, running % 9)) * pitch;
  }
  return (t: number) => {
    const lock = ease(.12, 2.25, t), tilt = mix(-.20, -.068, lock);
    const frame = Math.floor(t * 24), weaveX = .55 * Math.sin(frame * 1.71), weaveY = .52 * Math.cos(frame * 2.17);
    const offset = transport(t), previous = transport(t - 1 / 48);
    const gateY = h * .495, reach = Math.hypot(w, h) * .60;
    ctx.fillStyle = lamp; ctx.fillRect(0, 0, w, h);
    ctx.save();
    ctx.translate(w * .50 + weaveX, gateY + weaveY);
    ctx.rotate(tilt);
    const first = Math.floor((-reach - offset) / pitch), last = Math.ceil((reach - offset) / pitch);
    for (let i = first; i <= last; i++) exposure(i * pitch + offset, i, frame / 24);
    if (Math.abs(previous - offset) > 2) {
      // Integrate two earlier positions over the shutter interval, including the stock edges.
      ctx.globalAlpha = .17;
      for (let i = first - 1; i <= last; i++) exposure(i * pitch + previous, i, frame / 24);
      ctx.globalAlpha = .26;
      for (let i = first - 1; i <= last; i++) exposure(i * pitch + (previous + offset) / 2, i, frame / 24);
      ctx.globalAlpha = 1;
    }
    // The fixed gate illuminates one frame; neighbouring exposures remain visible in the magazine.
    const shutter = ctx.createLinearGradient(0, -pitch * 1.10, 0, pitch * 1.10);
    shutter.addColorStop(0, '#100b11f5'); shutter.addColorStop(.22, '#170e12e8'); shutter.addColorStop(.29, '#180e1433');
    shutter.addColorStop(.35, '#08080b00'); shutter.addColorStop(.65, '#08080b00'); shutter.addColorStop(.71, '#180e1433');
    shutter.addColorStop(.78, '#170e12ea'); shutter.addColorStop(1, '#100a10f7');
    ctx.fillStyle = shutter; ctx.fillRect(-reach * 2, -reach * 2, reach * 4, reach * 4);
    ctx.restore();

    const vignette = ctx.createRadialGradient(w * .48, gateY, stock * .21, w * .48, gateY, Math.max(w, h) * .73);
    vignette.addColorStop(0, '#110c1300'); vignette.addColorStop(.72, '#190c1630'); vignette.addColorStop(1, '#100b13c4');
    ctx.fillStyle = vignette; ctx.fillRect(0, 0, w, h);
    const leak = Math.sin(Math.PI * ease(.48, 2.5, t));
    if (leak > .001) {
      const x = mix(-w * .36, w * .95, ease(.48, 2.5, t)), radius = Math.min(w, h) * .67;
      const glow = ctx.createRadialGradient(x, h * .51, 0, x, h * .51, radius);
      glow.addColorStop(0, '#ffe4a2a8'); glow.addColorStop(.18, '#ffae5c85'); glow.addColorStop(.53, '#f0452d48'); glow.addColorStop(1, '#de300000');
      ctx.save(); ctx.globalCompositeOperation = 'screen'; ctx.globalAlpha = leak * .7;
      ctx.fillStyle = glow; ctx.fillRect(0, 0, w, h); ctx.restore();
    }
    const slip = offset / pitch - Math.round(offset / pitch), creditY = pitch * (.27 + slip);
    return { x: w * .5 + weaveX - creditY * Math.sin(tilt), y: gateY + weaveY + creditY * Math.cos(tilt),
      angle: tilt * 180 / Math.PI, opacity: 1 - ease(.10, .44, Math.abs(slip)) };
  };
}
