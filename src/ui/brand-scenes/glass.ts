import { dot, enter, inward, leave, local, reflect, step, transmit, view, type Vec } from './optics.ts';

const EW = 512, EH = 128, STRIDE = 7;
export const PLATE_SIZE = 1.98;
const indices = [1.590, 1.609, 1.637];
const absorption = [.14, .080, .061];
const fresnel = (cos: number, index: number) => {
  const r = ((1 - index) / (1 + index)) ** 2;
  return r + (1 - r) * (1 - Math.min(1, Math.abs(cos))) ** 5;
};

// A small linear-light studio environment. Long diffusers and dark flags stay
// in world space while the light rig moves across the polished facets.
function studio() {
  const map = new Float32Array(EW * EH * 3);
  for (let y = 0; y < EH; y++) for (let x = 0; x < EW; x++) {
    const u = x / EW, v = y / EH;
    const softbox = (center: number, width: number, top: number, bottom: number, slant: number) => {
      const offset = u - center - slant * (v - .5);
      const edge = Math.abs(offset - Math.round(offset)) - width;
      const s = Math.max(0, Math.min(1, .5 - edge / .032));
      return s * s * (3 - 2 * s) * Math.max(0, Math.min(1, (v - top) * 12, (bottom - v) * 12));
    };
    const key = softbox(.82, .048, .13, .61, .34) * 3.8 + softbox(.965, .013, .22, .72, -.12) * 2.8;
    const cool = softbox(.32, .082, .28, .67, -.28) * 1.8 + softbox(.64, .009, .16, .85, .32) * 3.5;
    const warm = softbox(.12, .027, .32, .64, -.16) * 2.4;
    const horizon = .09 * Math.exp(-((v - .59) ** 2) / .0015), p = (y * EW + x) * 3;
    const sky = .026 + .23 * Math.exp(-((v - .32) ** 2) / .14) * (.50 + .50 * Math.cos((u - .20) * Math.PI * 2)) ** 2;
    map[p] = sky * .80 + key + .60 * cool + warm + horizon;
    map[p + 1] = sky + .96 * key + .82 * cool + .72 * warm + horizon;
    map[p + 2] = sky * 1.23 + .88 * key + cool + .48 * warm + horizon * 1.4;
  }
  return map;
}

function environment(p: Vec, ray: Vec) {
  // Finite lamp distance matters: rays leaving different places on the same
  // face see different parts of a softbox, even with an orthographic camera.
  const along = dot(p, ray), radius = 1.82;
  const hit = view(step(p, ray, -along + Math.sqrt(along * along + radius * radius - dot(p, p))));
  const u = Math.floor((.5 + Math.atan2(hit[0], hit[2]) / (2 * Math.PI)) * EW * 16) & (EW * 16 - 1);
  const v = Math.min((EH - 1) * 16 - 1, Math.floor(Math.acos(Math.max(-1, Math.min(1, hit[1] / radius))) * EH * 16 / Math.PI));
  return (v << 16) | u;
}

export function createGlass(size: number) {
  const canvas = document.createElement('canvas'), sensor = document.createElement('canvas');
  canvas.width = canvas.height = sensor.width = sensor.height = size;
  const ctx = canvas.getContext('2d'), raw = sensor.getContext('2d');
  if (!ctx || !raw) throw new Error('Optical plate unavailable');
  const plate = raw.createImageData(size, size), pixels = plate.data, map = studio();
  const addresses = new Uint32Array(size * size * STRIDE), weights = new Uint8Array(addresses.length);
  const covered = new Uint32Array(size * size), incident = local([0, 0, -1]);
  const tone = new Uint8ClampedArray(2048);
  for (let i = 0; i < tone.length; i++) tone[i] = 255 * (1 - Math.exp(-i / 390)) ** .61;
  let row = 0, count = 0, lastLight = -1000;
  function traceRow(y: number) {
    for (let x = 0; x < size; x++) {
      const origin = local([((x + .5) / size - .5) * PLATE_SIZE, (.5 - (y + .5) / size) * PLATE_SIZE, 2]);
      const hit = enter(origin, incident);
      if (!hit) continue;
      const pixel = y * size + x, base = pixel * STRIDE;
      covered[count++] = pixel; pixels[pixel * 4 + 3] = 255;
      const front = fresnel(dot(incident, hit.n), indices[1]);
      addresses[base] = environment(hit.point, reflect(incident, hit.n)); weights[base] = Math.round(255 * front);
      for (let ch = 0; ch < 3; ch++) {
        const index = indices[ch];
        let dir = transmit(incident, hit.n, 1 / index), p = hit.point, weight = 1 - front, stored = 0;
        for (let bounce = 0; dir && bounce < 5 && stored < 2 && weight > .008; bounce++) {
          const next = leave(p, dir);
          if (!next) break;
          weight *= Math.exp(-next.distance * absorption[ch]);
          const outgoing = transmit(dir, inward(next.n), index);
          if (outgoing) {
            const reflected = fresnel(dot(dir, next.n), index), slot = base + 1 + ch * 2 + stored++;
            addresses[slot] = environment(next.point, outgoing); weights[slot] = Math.round(255 * weight * (1 - reflected));
            weight *= reflected;
          }
          p = next.point; dir = reflect(dir, next.n);
        }
      }
    }
  }

  function sample(uv: number, shift: number, ch: number) {
    const u = ((uv & 65535) + shift) & (EW * 16 - 1), v = uv >>> 16;
    const fx = (u & 15) / 16, fy = (v & 15) / 16, row = (v >> 4) * EW;
    const a = (row + (u >> 4)) * 3 + ch, b = (row + (((u >> 4) + 1) & (EW - 1))) * 3 + ch;
    const upper = map[a] + fx * (map[b] - map[a]), lower = map[a + EW * 3] + fx * (map[b + EW * 3] - map[a + EW * 3]);
    return upper + fy * (lower - upper);
  }
  const radiance = [0, 0, 0];
  return (t: number) => {
    // Compute the paths once over the first few frames. Subsequent frames only
    // sample the lighting for the covered pixels; empty screen area costs nothing.
    if (row < size) {
      const until = performance.now() + 5;
      do { traceRow(row++); } while (row < size && performance.now() < until);
      if (row < size) return;
    }
    const tick = Math.floor(t * 24);
    if (tick !== lastLight) {
      const shift = Math.round(16 * (18 * Math.sin(tick / 24 * .62 - .55) + tick / 12));
      for (let i = 0; i < count; i++) {
        const pixel = covered[i], base = pixel * STRIDE, primary = addresses[base];
        for (let ch = 0; ch < 3; ch++) {
          let energy = weights[base] * sample(primary, shift, ch);
          for (let k = 0; k < 2; k++) {
            const slot = base + 1 + ch * 2 + k;
            if (weights[slot]) energy += weights[slot] * sample(addresses[slot], shift, ch);
          }
          radiance[ch] = energy;
        }
        const luminance = .26 * radiance[0] + .57 * radiance[1] + .17 * radiance[2];
        for (let ch = 0; ch < 3; ch++) {
          pixels[pixel * 4 + ch] = tone[Math.min(2047, Math.round((radiance[ch] * .88 + luminance * .12) * 1.55))];
        }
      }
      raw.putImageData(plate, 0, 0);
      // Integrate a small optical footprint so bright bevels don't alias as the glass rocks.
      ctx.clearRect(0, 0, size, size);
      ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = .25;
      for (const x of [-.58, .58]) for (const y of [-.58, .58]) ctx.drawImage(sensor, x, y);
      lastLight = tick;
    }
    return canvas;
  };
}
