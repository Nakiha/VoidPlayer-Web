export type Vec = [number, number, number];
export const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const step = (p: Vec, d: Vec, t: number): Vec => [p[0] + d[0] * t, p[1] + d[1] * t, p[2] + d[2] * t];
export const unit = (v: Vec): Vec => { const length = Math.hypot(...v); return [v[0] / length, v[1] / length, v[2] / length]; };
export const reflect = (ray: Vec, n: Vec) => step(ray, n, -2 * dot(ray, n));
export function transmit(ray: Vec, normal: Vec, eta: number): Vec | undefined {
  const cos = -dot(ray, normal), discriminant = 1 - eta * eta * (1 - cos * cos);
  if (discriminant < 0) return;
  return step([ray[0] * eta, ray[1] * eta, ray[2] * eta], normal, eta * cos - Math.sqrt(discriminant));
}
export const inward = (n: Vec): Vec => [-n[0], -n[1], -n[2]];

type Plane = { n: Vec; d: number };
const side = unit([1.25, .72, 0]), sideD = side[1] * .77;
const planes: Plane[] = [{ n: side, d: sideD }, { n: [-side[0], side[1], 0], d: sideD },
  { n: [0, -1, 0], d: .48 }, { n: [0, 0, 1], d: .39 }, { n: [0, 0, -1], d: .39 }];
// Polish a narrow bevel at each of the nine physical edges.
for (let i = 0; i < 3; i++) for (let j = i + 1; j < 5; j++) {
  const a = planes[i], b = planes[j], n = step(a.n, b.n, 1), length = Math.hypot(...n);
  planes.push({ n: unit(n), d: (a.d + b.d - .017) / length });
}

export function enter(p: Vec, dir: Vec) {
  let near = -Infinity, far = Infinity, face = planes[0];
  for (const plane of planes) {
    const rate = dot(dir, plane.n), dist = plane.d - dot(p, plane.n);
    if (Math.abs(rate) < 1e-8) { if (dist < 0) return; continue; }
    const t = dist / rate;
    if (rate < 0 && t > near) { near = t; face = plane; }
    if (rate > 0) far = Math.min(far, t);
    if (far < near) return;
  }
  if (near >= 0 && Number.isFinite(near)) return { point: step(p, dir, near), n: face.n };
}

export function leave(p: Vec, dir: Vec) {
  let nearest = Infinity, face = planes[0];
  for (const plane of planes) {
    const rate = dot(dir, plane.n);
    if (rate <= .00001) continue;
    const t = (plane.d - dot(p, plane.n)) / rate;
    if (t > .00001 && t < nearest) { nearest = t; face = plane; }
  }
  if (Number.isFinite(nearest)) return { point: step(p, dir, nearest), n: face.n, distance: nearest };
}

const yaw = -.43, pitch = .22, cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
export function view([x, y, z]: Vec): Vec {
  const depth = -sy * x + cy * z;
  return [cy * x + sy * z, cp * y - sp * depth, sp * y + cp * depth];
}
export function local([x, y, z]: Vec): Vec {
  const depth = -sp * y + cp * z;
  return [cy * x - sy * depth, cp * y + sp * z, sy * x + cy * depth];
}

// The camera and the projector intersect the same solid. Near the critical angle
// a wavelength can reflect internally before finding its exit face.
export function lightPath(origin: Vec, ray: Vec, index: number) {
  const hit = enter(origin, ray);
  if (!hit) return;
  const inside = transmit(ray, hit.n, 1 / index);
  if (!inside) return;
  const points: Vec[] = [hit.point];
  let dir = inside;
  for (let i = 0; i < 4; i++) {
    const end = leave(points[points.length - 1], dir);
    if (!end) return;
    points.push(end.point);
    const outgoing = transmit(dir, inward(end.n), index);
    if (outgoing) return { points, outgoing };
    dir = reflect(dir, end.n);
  }
}
