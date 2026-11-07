import { createGlass, PLATE_SIZE } from './glass.ts';
import { lightPath, step, unit, view, type Vec } from './optics.ts';
import { ease, mix } from './timing.ts';

type Point = [number, number];
const spectrum = Array.from({ length: 27 }, (_, i) => {
  const nm = mix(415, 685, i / 26), line = (center: number, width: number) => Math.exp(-(((nm - center) / width) ** 2));
  const rgb = [line(615, 48) + .16 * line(427, 24), line(540, 42), line(450, 37)];
  return { rgb: rgb.map(n => Math.round(n * 255)).join(','), index: 1.54 + .020 / (nm * .001) ** 2 };
});

export function createPrism(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const unitSize = Math.min(w * .395, h * .415);
  const glass = createGlass(Math.max(160, Math.min(472, Math.round(unitSize * 1.66))));
  let glassReadyAt: number | undefined;
  // A rough tabletop spreads the reflected image over a much larger area than the polished glass.
  const reflection = document.createElement('canvas');
  reflection.width = 54; reflection.height = 28;
  const reflected = reflection.getContext('2d');
  const room = ctx.createRadialGradient(w * .43, h * .42, 0, w * .43, h * .42, Math.max(w, h) * .77);
  room.addColorStop(0, '#172331'); room.addColorStop(.58, '#0d131f'); room.addColorStop(1, '#060810');
  function glow(p: Point, rx: number, ry: number, color: string, strength: number) {
    ctx.save(); ctx.translate(...p); ctx.scale(rx, ry);
    const halo = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
    halo.addColorStop(0, 'rgba(' + color + ',' + strength + ')'); halo.addColorStop(.23, 'rgba(' + color + ',' + strength * .45 + ')');
    halo.addColorStop(1, 'rgba(' + color + ',0)'); ctx.fillStyle = halo; ctx.fillRect(-1, -1, 2, 2); ctx.restore();
  }
  return (t: number) => {
    const build = ease(.12, 1.48, t);
    const cx = w * (.43 + .033 * Math.sin(t * .30)), cy = h * (.42 + .013 * Math.sin(t * .39));
    const scale = unitSize * mix(.91, 1, build), roll = -.072 + .060 * Math.sin(t * .53);
    const object = glass(t);
    if (object && glassReadyAt === undefined) glassReadyAt = t;
    const reveal = glassReadyAt === undefined ? 0 : ease(glassReadyAt, glassReadyAt + .46, t);
    const light = ease(.50, 2.2, t) * reveal;
    function project(p: Vec): Point {
      const [x, y] = view(p);
      return [cx + scale * (x * Math.cos(roll) + y * Math.sin(roll)), cy + scale * (x * Math.sin(roll) - y * Math.cos(roll))];
    }
    ctx.fillStyle = room; ctx.fillRect(0, 0, w, h);
    const floor = project([0, -.56, .12]);
    glow(floor, scale * 1.40, scale * .22, '62,80,100', .35);
    glow([cx + scale * .08, floor[1] - 3], scale * .78, scale * .085, '1,4,11', .93);
    if (object && reflected) {
      reflected.clearRect(0, 0, reflection.width, reflection.height);
      reflected.drawImage(object, 0, 0, reflection.width, reflection.height);
      ctx.save(); ctx.globalAlpha = .07 * reveal; ctx.translate(cx, floor[1]); ctx.scale(1, -.23);
      ctx.translate(0, cy - floor[1]); ctx.rotate(roll);
      const side = PLATE_SIZE * scale;
      ctx.drawImage(reflection, -side / 2, -side / 2, side, side); ctx.restore();
    }
    const dir = unit([1, .18 + .064 * Math.sin(t * .68 - .4), -.014]);
    const origin = step([-.36, .16 + .053 * Math.sin(t * .82), .11], dir, -4);
    const neutral = lightPath(origin, dir, 1.615);
    // The projector always intersects the left face within this range of incidence.
    const entry = project(neutral?.points[0] ?? [-.36, .16, .11]);
    const exit = project(neutral?.points.at(-1) ?? [.44, .02, .11]);
    const source = project(origin);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const beam = ctx.createLinearGradient(source[0], source[1], entry[0], entry[1]);
    beam.addColorStop(0, '#c1d9ff00'); beam.addColorStop(1, '#ffe8ca');
    ctx.strokeStyle = beam;
    for (const [width, strength] of [[.088, .022], [.056, .032], [.030, .057], [.014, .16], [.005, .67]]) {
      ctx.globalAlpha = strength * build * reveal; ctx.lineWidth = Math.max(1, scale * width);
      ctx.beginPath(); ctx.moveTo(...source); ctx.lineTo(...entry); ctx.stroke();
    }

    const interiors: { points: Point[]; rgb: string }[] = [];
    for (const band of spectrum) {
      const path = lightPath(origin, dir, band.index);
      if (!path) continue;
      const points = path.points.map(project), end = path.points[path.points.length - 1];
      const travel = path.outgoing[1] < -.02 ? (-.56 - end[1]) / path.outgoing[1] : 4;
      const spot = project(step(end, path.outgoing, Math.max(.2, Math.min(5, travel))));
      const last = points[points.length - 1];
      const shaft = ctx.createLinearGradient(...last, ...spot);
      shaft.addColorStop(0, 'rgba(' + band.rgb + ',.12)'); shaft.addColorStop(.35, 'rgba(' + band.rgb + ',.065)');
      shaft.addColorStop(1, 'rgba(' + band.rgb + ',.09)');
      ctx.globalAlpha = light; ctx.strokeStyle = shaft;
      ctx.lineWidth = scale * .024;
      ctx.beginPath(); ctx.moveTo(...last); ctx.lineTo(...spot); ctx.stroke();
      glow(spot, scale * .30, scale * .048, band.rgb, light * .17);
      glow(spot, scale * .085, scale * .009, band.rgb, light * .44);
      interiors.push({ points, rgb: band.rgb });
    }
    ctx.restore();
    if (object) {
      ctx.save(); ctx.globalAlpha = reveal; ctx.translate(cx, cy); ctx.rotate(roll);
      const side = PLATE_SIZE * scale;
      ctx.drawImage(object, -side / 2, -side / 2, side, side); ctx.restore();
    }

    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    for (const { points, rgb } of interiors) {
      ctx.strokeStyle = 'rgba(' + rgb + ',' + light * .055 + ')'; ctx.lineWidth = scale * .012;
      ctx.beginPath(); ctx.moveTo(...points[0]);
      for (const p of points.slice(1)) ctx.lineTo(...p);
      ctx.stroke();
    }
    for (const p of [entry, exit]) {
      glow(p, scale * .082, scale * .080, '173,202,228', light * .38);
      glow(p, scale * .021, scale * .012, '255,236,200', light * .84);
    }
    ctx.restore();
    return { entry, exit };
  };
}
