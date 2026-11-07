// One exposure of a ringed planet. The sphere and the inclined ring plane are
// intersected separately so that front/back occlusion and cast shadows agree.
export function exposeOrbit() {
  const plate = document.createElement('canvas');
  plate.width = 860; plate.height = 500;
  const ctx = plate.getContext('2d');
  if (!ctx) throw new Error('Film exposure unavailable');
  const pixels = ctx.createImageData(plate.width, plate.height), rgb = pixels.data;
  const rings = new Float32Array(2048);
  for (let i = 0; i < rings.length; i++) {
    const r = 1.23 + i / (rings.length - 1) * 1.19;
    const band = .58 + .15 * Math.sin(47 * r) + .12 * Math.sin(141 * r + Math.sin(37 * r)) + .12 * Math.cos(391 * r);
    const gap = 1 - .98 * Math.exp(-((r - 1.98) ** 2) / .0012);
    rings[i] = band * gap * Math.min(1, i / 90, (rings.length - 1 - i) / 45);
  }
  function density(r: number) {
    const i = Math.round((r - 1.23) * (rings.length - 1) / 1.19);
    return i >= 0 && i < rings.length ? rings[i] : 0;
  }
  // The key grazes the upper left limb. Coordinates are in planet radii, +z towards the camera.
  const lx = -.81, ly = .43, lz = -.40, tilt = .29, dz = Math.sqrt(1 - tilt * tilt);
  const twist = -.29, cos = Math.cos(twist), sin = Math.sin(twist);
  const radius = 121, cx = 515, cy = 223;
  let seed = 98173;
  for (let y = 0; y < plate.height; y++) {
    for (let x = 0; x < plate.width; x++) {
      const sx = (x - cx) / radius, sy = (cy - y) / radius;
      const px = sx * cos + sy * sin, py = sy * cos - sx * sin, rr = px * px + py * py;
      const sky = Math.exp(-((sx + 1.8) ** 2 * .45 + (sy - .64) ** 2 * 1.8));
      let red = 11 + 17 * sky, green = 14 + 10 * sky, blue = 21 + 7 * sky;
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      if (seed > 4294200000) { const star = 20 + (seed % 92); red += star; green += star; blue += star; }
      const z = rr <= 1 ? Math.sqrt(1 - rr) : -Infinity;
      if (rr <= 1) {
        const latitude = py + z * .18;
        const turbulence = Math.sin(px * 8 + latitude * 9) * .028 + Math.sin(px * 21 - latitude * 14) * .009;
        const cloud = .80 + .13 * Math.sin(22 * (latitude + turbulence)) + .052 * Math.sin(97 * (latitude + turbulence));
        const sun = Math.max(0, px * lx + py * ly + z * lz);
        // Cast the ray towards the sun through the ring plane before shading the clouds.
        const toRing = -(py * dz + z * tilt) / (ly * dz + lz * tilt);
        const shadow = toRing > 0 ? density(Math.hypot(px + lx * toRing, (py + ly * toRing) / tilt)) : 0;
        const diffuse = Math.sqrt(sun) * cloud * (1 - shadow * .91);
        const rim = Math.pow(1 - z, 3) * Math.max(0, (px * lx + py * ly) * 1.2);
        red = 20 + 190 * diffuse + 84 * rim; green = 20 + 150 * diffuse + 54 * rim; blue = 27 + 100 * diffuse + 37 * rim;
      } else {
        const halo = Math.exp(-Math.abs(Math.sqrt(rr) - 1) * 38) * Math.max(0, px * lx + py * ly);
        red += 76 * halo; green += 36 * halo; blue += 17 * halo;
      }
      const ringZ = -py * dz / tilt, r = Math.hypot(px, py / tilt);
      if (ringZ > z && r >= 1.23 && r < 2.42) {
        const d = density(r), toward = -(px * lx + py * ly + ringZ * lz);
        const miss = rr + ringZ * ringZ - toward * toward;
        const shadow = toward > 0 ? Math.max(0, Math.min(1, (1.09 - miss) * 7)) : 0;
        const lit = (1 - shadow * .86) * (.90 + .10 * Math.cos(r * 52));
        const alpha = Math.min(.96, d * 1.22);
        red += (249 * lit - red) * alpha; green += (214 * lit - green) * alpha; blue += (161 * lit - blue) * alpha;
      }
      const p = (y * plate.width + x) * 4;
      rgb[p] = red; rgb[p + 1] = green; rgb[p + 2] = blue; rgb[p + 3] = 255;
    }
  }
  // Develop halation from the bright part of the actual exposure at quarter resolution.
  const stride = Math.ceil(plate.width / 4), rows = Math.ceil(plate.height / 4);
  const glow = new Float32Array(stride * rows), horizontal = new Float32Array(glow.length);
  for (let y = 0; y < plate.height; y++) for (let x = 0; x < plate.width; x++) {
    const p = (y * plate.width + x) * 4;
    glow[(y >> 2) * stride + (x >> 2)] += Math.max(0, rgb[p] * .4 + rgb[p + 1] * .6 - 109) / 16;
  }
  const kernel = [.036, .111, .216, .274, .216, .111, .036];
  for (let y = 3; y < rows - 3; y++) for (let x = 3; x < stride - 3; x++) {
    for (let k = 0; k < kernel.length; k++) horizontal[y * stride + x] += glow[y * stride + x + k - 3] * kernel[k];
  }
  for (let y = 3; y < rows - 3; y++) for (let x = 3; x < stride - 3; x++) {
    let energy = 0;
    for (let k = 0; k < kernel.length; k++) energy += horizontal[(y + k - 3) * stride + x] * kernel[k];
    glow[y * stride + x] = energy;
  }
  for (let y = 0; y < plate.height; y++) for (let x = 0; x < plate.width; x++) {
    const p = (y * plate.width + x) * 4, energy = glow[(y >> 2) * stride + (x >> 2)];
    rgb[p] += energy * .65; rgb[p + 1] += energy * .24; rgb[p + 2] += energy * .08;
  }
  ctx.putImageData(pixels, 0, 0);
  return plate;
}

// A nearer moon moves independently through the photographed field.
export function exposeMoon() {
  const moon = document.createElement('canvas');
  moon.width = moon.height = 72;
  const ctx = moon.getContext('2d');
  if (!ctx) throw new Error('Lunar exposure unavailable');
  const image = ctx.createImageData(72, 72);
  for (let y = 0; y < 72; y++) for (let x = 0; x < 72; x++) {
    const nx = (x - 35.5) / 34, ny = (35.5 - y) / 34, r2 = nx * nx + ny * ny;
    if (r2 >= 1) continue;
    const relief = .88 + .12 * Math.sin(nx * 33 + Math.sin(ny * 24)) * Math.cos(ny * 37);
    const lit = Math.sqrt(Math.max(0, -.81 * nx + .43 * ny - .40 * Math.sqrt(1 - r2))) * relief;
    const p = (y * 72 + x) * 4;
    image.data[p] = 17 + 190 * lit; image.data[p + 1] = 17 + 152 * lit; image.data[p + 2] = 24 + 112 * lit;
    image.data[p + 3] = Math.min(255, (1 - r2) * 5100);
  }
  ctx.putImageData(image, 0, 0);
  return moon;
}
