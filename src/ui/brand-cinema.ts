import { msg, t } from '../i18n.ts';
import type { BrandCinemaStyle } from './brand-effects.ts';
import './brand-cinema.css';

const PORTAL_DURATION = 8.1;
const clamp = (v: number) => Math.max(0, Math.min(1, v));
const smooth = (v: number) => { v = clamp(v); return v * v * (3 - 2 * v); };
const out = (v: number) => 1 - (1 - clamp(v)) ** 3;
const mix = (a: number, b: number, v: number) => a + (b - a) * v;
// A damped landing: the first overshoot has weight, subsequent motion settles.
const spring = (v: number) => v <= 0 ? 0 : v >= 1 ? 1 : 1 - Math.exp(-7 * v) * Math.cos(10 * v);
type Pose = { x: number; y: number; scale: number; angle: number; stretch: number; opacity: number };
type Actor = { node: HTMLElement; width: number; height: number; home: Pose; hero: Pose; pose: Pose };
const pose = (x: number, y: number, scale = 1): Pose => ({ x, y, scale, angle: 0, stretch: 1, opacity: 1 });
function between(a: Pose, b: Pose, u: number): Pose {
  return { x: mix(a.x, b.x, u), y: mix(a.y, b.y, u), scale: mix(a.scale, b.scale, u),
    angle: mix(a.angle, b.angle, u), stretch: mix(a.stretch, b.stretch, u), opacity: mix(a.opacity, b.opacity, u) };
}
function curve(a: number, b: number, c: number, d: number, u: number) {
  return (1 - u) ** 3 * a + 3 * (1 - u) ** 2 * u * b + 3 * (1 - u) * u ** 2 * c + u ** 3 * d;
}

/** Independent letter actors on a decorative stage; no media resources are read. */
export function playBrandCinema(button: HTMLButtonElement, style: BrandCinemaStyle, done: () => void) {
  const overlay = document.createElement('div');
  overlay.className = 'brand-cinema brand-cinema--' + style;
  overlay.setAttribute('aria-hidden', 'true');
  overlay.dataset.phase = 'escape';
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Brand canvas unavailable');
  const ctx: CanvasRenderingContext2D = context;
  const font = getComputedStyle(button), bounds = button.getBoundingClientRect();
  const sourceColor = font.color;
  const f = parseFloat(font.fontSize), w = innerWidth, h = innerHeight;
  const dpr = Math.min(devicePixelRatio || 1, 1.5, Math.sqrt(1_800_000 / (w * h)));
  canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); ctx.scale(dpr, dpr);
  const measure = document.createElement('span');
  measure.className = 'brand-cinema-measure';
  measure.style.font = font.font; measure.style.letterSpacing = font.letterSpacing;
  const nodes = [...(button.textContent?.trim() || 'VoidPlayer')].map(char => {
    const node = document.createElement('span'); node.textContent = char; measure.append(node); return node;
  });
  const caption = document.createElement('span'); caption.className = 'brand-cinema-caption';
  caption.textContent = t(msg('brandCinema.detour', '出去转一圈。'));
  const tagline = document.createElement('span'); tagline.className = 'brand-cinema-tagline';
  tagline.textContent = t(msg('brandCinema.everyFrame', '每一帧，都值得看见。'));
  overlay.append(canvas, measure, caption, tagline); document.body.append(overlay);
  const measured = measure.getBoundingClientRect(), totalWidth = measured.width;
  const originX = bounds.left + (bounds.width - totalWidth) / 2, originY = bounds.top + bounds.height / 2;
  const heroScale = Math.min(w * .78 / totalWidth, 106 / f, h * .16 / f);
  const heroX = (w - totalWidth * heroScale) / 2, heroY = h * .52;
  const glyphBounds = nodes.map(node => node.getBoundingClientRect());
  const letters: Actor[] = nodes.map((node, index) => {
    const rect = glyphBounds[index], offset = rect.left - measured.left + rect.width / 2;
    const home = pose(originX + offset, originY), hero = pose(heroX + offset * heroScale, heroY, heroScale);
    node.className = 'brand-cinema-letter'; node.style.font = font.font; node.style.letterSpacing = font.letterSpacing;
    const actor = { node, width: rect.width, height: rect.height, home, hero, pose: { ...home } };
    overlay.append(node); return actor;
  });
  measure.remove();
  // Splitting the i keeps the existing typeface and gives the story a tiny instigator.
  const i = letters[2], o = letters[1];
  i.node.textContent = 'ı';
  const dotNode = document.createElement('span'); dotNode.className = 'brand-cinema-dot'; overlay.append(dotNode);
  const dotSize = f * .15;
  dotNode.style.width = dotNode.style.height = dotSize + 'px';
  const dotHome = pose(i.home.x, i.home.y - f * .31), dotHero = pose(i.hero.x, i.hero.y - f * .31 * heroScale, heroScale);
  const dot: Actor = { node: dotNode, width: dotSize, height: dotSize, home: dotHome, hero: dotHero, pose: { ...dotHome } };
  const actors = [...letters, dot];
  const originalOpacity = button.style.opacity; button.style.opacity = '0';
  const start = performance.now();
  let raf = 0, finished = false, returningAt: number | undefined;
  let returnTimer: number | undefined;
  let returningPoses: Pose[] = [];
  const paintActor = (actor: Actor) => {
    const p = actor.pose;
    actor.node.style.transform = 'translate(' + (p.x - actor.width / 2) + 'px,' + (p.y - actor.height / 2) +
      'px) rotate(' + p.angle + 'deg) scale(' + p.scale * p.stretch + ',' + p.scale / p.stretch + ')';
    actor.node.style.opacity = String(clamp(p.opacity));
  };
  const cleanup = () => {
    if (finished) return;
    finished = true; cancelAnimationFrame(raf); clearTimeout(returnTimer);
    overlay.remove(); button.style.opacity = originalOpacity; canvas.width = canvas.height = 1; done();
  };
  const cancel = (immediate = false) => {
    if (finished) return;
    if (immediate) { cleanup(); return; }
    if (returningAt !== undefined) return;
    returningAt = performance.now();
    // Preserve every letter's current pose, including partly swallowed letters.
    returningPoses = actors.map(actor => ({ ...actor.pose }));
    overlay.dataset.phase = 'return';
    returnTimer = window.setTimeout(cleanup, 210);
  };
  const delays = [ .54, .44, .36, .28, 0, .08, .15, .22, .32, .43 ];
  const runMeeting = (index: number) => pose(w * .67 + (letters[index].hero.x - w * .5) * .68, h * (.72 + (index % 3) * .007), heroScale * .56);

  function runaway(p: number) {
    letters.forEach((actor, index) => {
      const lag = delays[index], launch = 1.04 + lag, meeting = runMeeting(index);
      let next = { ...actor.home };
      if (p < launch) {
        const crouch = Math.sin(clamp((p - launch + .24) / .24) * Math.PI);
        next.y += crouch * f * .1; next.stretch = 1 + crouch * .19;
        // P recoils when the dot bumps it; the followers hesitate independently.
        next.angle = (index === 4 ? -11 : 5) * crouch;
      } else if (p < 3.04 + lag) {
        const u = clamp((p - launch) / 2), q = smooth(u);
        next = between(actor.home, meeting, q);
        next.x = curve(actor.home.x, w * .24, w * .55, meeting.x, q);
        next.y = curve(actor.home.y, h * .05, h * .83, meeting.y, q);
        const hop = Math.sin(u * Math.PI * (index % 2 ? 5 : 6));
        next.y -= Math.abs(hop) * f * next.scale * .35 * Math.sin(u * Math.PI);
        next.angle = Math.sin(u * Math.PI) * (12 + hop * 7);
        next.stretch = 1 + hop * .1 * Math.sin(u * Math.PI);
      } else if (p < 4.64 + lag) {
        const u = clamp((p - 3.04 - lag) / 1.6), q = smooth(u);
        next = between(meeting, actor.hero, q);
        next.x = curve(meeting.x, meeting.x + w * .10, actor.hero.x + w * .07, actor.hero.x, q);
        next.y = mix(meeting.y, actor.hero.y, q) - Math.sin(q * Math.PI) * h * (.17 + (index % 3) * .025);
        next.angle = -Math.sin(q * Math.PI) * (16 + (index % 3) * 6);
        next.stretch = 1 - Math.sin(q * Math.PI) * .12;
      } else {
        const elapsed = p - 4.64 - lag, recoil = Math.sin(elapsed * 16) * Math.exp(-elapsed * 6);
        next = { ...actor.hero, y: actor.hero.y + recoil * f * heroScale * .09, stretch: 1 + recoil * .08, angle: recoil * 3 };
      }
      actor.pose = next;
    });
    if (p < .85) {
      const u = smooth(p / .85);
      dot.pose = between(dotHome, pose(letters[4].home.x, letters[4].home.y - f * .2), u);
      dot.pose.y -= Math.sin(u * Math.PI) * f * 1.6;
      dot.pose.stretch = 1 - Math.sin(u * Math.PI) * .16;
    } else if (p < 3.08) {
      const u = smooth((p - .85) / 2.23);
      const target = pose(w * .76, h * .65, heroScale * .52);
      dot.pose = between(pose(letters[4].home.x, letters[4].home.y - f * .2), target, u);
      dot.pose.y -= Math.abs(Math.sin(u * Math.PI * 4)) * h * .085 * Math.sin(u * Math.PI);
    } else if (p < 5.23) {
      const u = smooth((p - 3.08) / 2.15);
      dot.pose = between(pose(w * .76, h * .65, heroScale * .52), dotHero, u);
      dot.pose.y -= Math.sin(u * Math.PI) * h * .38;
    } else {
      const e = p - 5.23, bounce = Math.sin(e * 17) * Math.exp(-e * 6);
      dot.pose = { ...dotHero, y: dotHero.y - bounce * f * heroScale * .12, stretch: 1 + bounce * .1 };
    }
  }

  // After the entrance, letters share a small physical stage. A delayed follower
  // really catches its neighbour; impacts and an elastic link transfer momentum.
  // Fixed steps keep contacts stable across different display refresh rates.
  const bodies = letters.map(actor => ({ x: actor.hero.x, y: actor.hero.y, vx: 0, vy: 0,
    angle: 0, spin: 0, squash: 0, scale: heroScale, jump: -1 }));
  let simulated = 0, previousFrame = start, accumulator = 0;
  const STEP = 1 / 120, LAP = 19;
  function playground(dt: number) {
    simulated += dt;
    const lap = Math.floor(simulated / LAP), time = simulated % LAP;
    const direction = lap % 2 ? -1 : 1;
    const runningScale = heroScale * .64;
    const regroup = smooth((time - 14.2) / 2.3);
    const releasing = 1 - smooth(time / 1.5);
    const lineup = Math.max(regroup, releasing);
    const brake = smooth((time - 4.5) / .6) * (1 - smooth((time - 6.7) / .6));
    const tug = smooth((time - 7.3) / .5) * (1 - smooth((time - 10.5) / .7));
    const travel = time < 5 ? smooth(time / 5) : time < 7 ? 1 : 1 - smooth((time - 7) / 7);
    const center = w * (.27 + .46 * (direction > 0 ? travel : 1 - travel));
    const ground = h * .77;
    overlay.dataset.phase = lineup > .95 ? 'hero' : tug > .1 ? 'tug' : brake > .1 ? 'collision' : 'chase';
    overlay.dataset.lap = String(lap);
    bodies.forEach((body, index) => {
      const actor = letters[index];
      body.scale = mix(runningScale, heroScale, lineup);
      const spacing = mix(.64, .34, brake);
      // The P leads. Others react late, with different acceleration and stride.
      const lag = delays[index] * .48;
      const delayedTravel = time < 5 ? smooth(Math.max(0, time - lag) / 5) : travel;
      const delayedCenter = time < 5 ? w * (.27 + .46 * (direction > 0 ? delayedTravel : 1 - delayedTravel)) : center;
      let targetX = delayedCenter + (actor.hero.x - w * .5) * spacing;
      if (index === 2 || index === 3) targetX += (index === 2 ? -1 : 1) * w * .075 * tug;
      targetX = mix(targetX, actor.hero.x, lineup);
      const floor = mix(ground - f * body.scale * .37, actor.hero.y, lineup);
      const acceleration = (targetX - body.x) * (index === 4 ? 20 : 13 + index % 3) - body.vx * (brake > .7 ? 8 : 4.6);
      body.vx += acceleration * dt;
      body.vy += h * 1.5 * dt;
      // A wave of hops travels through the queue, with a larger leap after tugging.
      const beat = Math.floor((time - index * .095) / .75);
      if (beat !== body.jump && lineup < .1 && brake < .3 && tug < .1 && body.y >= floor - 1) {
        body.jump = beat;
        body.vy = -h * (time > 11 && time < 13 ? .65 : .17 + (index % 3) * .022);
      }
      body.x += body.vx * dt; body.y += body.vy * dt;
      if (body.y > floor) {
        body.squash += Math.min(.25, Math.max(0, body.vy) / h * .16);
        body.y = floor; body.vy = 0;
      }
      // Keep the cast on stage even during overshoot on a narrow viewport.
      const margin = actor.width * body.scale * .6 + 10;
      if (body.x < margin || body.x > w - margin) { body.x = Math.max(margin, Math.min(w - margin, body.x)); body.vx *= -.4; }
      body.squash *= Math.exp(-12 * dt);
      const lean = Math.max(-23, Math.min(23, -body.vx / w * 45 + acceleration / w * 3));
      body.spin += ((lean - body.angle) * 70 - body.spin * 11) * dt;
      body.angle += body.spin * dt;
    });
    // Contact only when two glyphs share a height; airborne letters can leap over.
    for (let a = 0; a < bodies.length; a++) for (let b = a + 1; b < bodies.length; b++) {
      const left = bodies[a], right = bodies[b];
      const separation = (letters[a].width * left.scale + letters[b].width * right.scale) * .43;
      const dx = right.x - left.x, overlap = separation - Math.abs(dx);
      if (overlap <= 0 || Math.abs(left.y - right.y) > f * runningScale * .45 || lineup > .65) continue;
      const sign = dx >= 0 ? 1 : -1;
      left.x -= sign * overlap * .5; right.x += sign * overlap * .5;
      const closing = (left.vx - right.vx) * sign;
      if (closing > 0) {
        const impulse = closing * .64;
        left.vx -= sign * impulse; right.vx += sign * impulse;
        left.spin -= sign * Math.min(85, impulse * .5); right.spin += sign * Math.min(85, impulse * .5);
        left.squash = right.squash = Math.min(.23, closing / w * .4);
      }
    }
    if (tug > 0) {
      const a = bodies[2], b = bodies[3];
      const rest = (letters[2].width + letters[3].width) * runningScale * .55;
      const tension = Math.max(0, b.x - a.x - rest) * 24 * tug;
      a.vx += tension * dt; b.vx -= tension * dt;
      a.spin += tension * dt * .15; b.spin -= tension * dt * .15;
    }
    bodies.forEach((body, index) => {
      const stride = Math.sin(simulated * (14 + index % 3) - index * .7);
      letters[index].pose = { ...pose(body.x, body.y, body.scale), angle: body.angle,
        stretch: Math.max(.78, Math.min(1.25, 1 + body.squash + stride * .025 * (1 - lineup))) };
    });
    // The mischievous dot circles the leader, then lands back on its i for a breather.
    const leader = bodies[4], own = bodies[2];
    const orbit = simulated * 3.1;
    dot.pose = between(pose(leader.x + Math.cos(orbit) * f * runningScale * .7,
      leader.y - f * runningScale * (1 + .35 * Math.sin(orbit)), runningScale),
    pose(own.x, own.y - f * heroScale * .31, heroScale), lineup);
  }

  function portalGeometry(p: number) {
    const opening = smooth((p - .45) / 1.75), sealing = smooth((p - 4.85) / 1.35);
    const x = mix(mix(o.home.x, w * .5, opening), o.hero.x, sealing);
    const y = mix(mix(o.home.y, h * .46, opening), o.hero.y + f * heroScale * .075, sealing);
    const r = mix(mix(f * .19, Math.min(w, h) * .245, opening), f * heroScale * .20, sealing);
    return { x, y, r, opening, sealing };
  }
  function swallowed(actor: Actor, index: number, p: number) {
    const hole = portalGeometry(p), onset = .65 + (index === 0 ? .3 : index * .095);
    const u = clamp((p - onset) / 1.5);
    const tug = Math.sin(clamp((p - onset + .22) / .22) * Math.PI);
    if (p < onset) return { ...actor.home, angle: tug * (index < 2 ? 14 : -12), stretch: 1 - tug * .12 };
    const q = out(u), swirl = Math.sin(q * Math.PI * 3) * u * (1 - u);
    const next = between(actor.home, pose(hole.x, hole.y, .055), q);
    next.x += swirl * hole.r * .8; next.y += Math.sin(q * Math.PI * 2) * hole.r * .4;
    next.scale = mix(1 + hole.opening * heroScale * .4, .055, smooth((u - .45) / .55));
    next.angle = u * u * (index % 2 ? 240 : -200);
    next.stretch = 1 + Math.sin(u * Math.PI) * .3;
    next.opacity = 1 - smooth((u - .73) / .27);
    return next;
  }
  function portal(p: number) {
    const hole = portalGeometry(p);
    letters.forEach((actor, index) => {
      let next = swallowed(actor, index, p);
      if (index === 1) {
        next = { ...actor.home, opacity: 1 - smooth((p - .18) / .28) };
        if (p > 5.6) next = { ...actor.hero, opacity: smooth((p - 5.6) / .6) };
      } else {
        const exit = 3.35 + index * .07, u = clamp((p - exit) / 1.65);
        if (p >= exit) {
          // Each glyph emerges with its own inertia and lands at its own time.
          next = between(pose(w * .5, h * .46, .05), actor.hero, spring(u));
          next.y -= Math.sin(u * Math.PI) * h * (.16 + (index % 3) * .035);
          next.angle = Math.sin(u * Math.PI) * (index % 2 ? 27 : -24);
          next.stretch = 1 - Math.sin(u * Math.PI * 2) * .12;
          next.opacity = smooth(u / .12);
        }
      }
      actor.pose = next;
    });
    dot.pose = swallowed(dot, 2, p);
    if (p > 4.3) {
      const u = clamp((p - 4.3) / 1.4);
      dot.pose = between(pose(hole.x, hole.y, .08), dotHero, spring(u));
      dot.pose.y -= Math.sin(u * Math.PI) * h * .2;
      dot.pose.opacity = smooth(u / .15);
    }
  }

  function stage(p: number, reveal: number) {
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = style === 'runaway' ? '#111118' : '#080910'; ctx.fillRect(0, 0, w, h);
    const glow = ctx.createRadialGradient(w * .5, h * .5, 0, w * .5, h * .5, Math.max(w, h) * .65);
    glow.addColorStop(0, style === 'runaway' ? '#55425650' : '#4e3f8050'); glow.addColorStop(1, '#00000000');
    ctx.fillStyle = glow; ctx.fillRect(0, 0, w, h);
    canvas.style.opacity = String(reveal);
    if (style === 'runaway') {
      // A lit stage floor gives the bouncing type weight without a space backdrop.
      const floor = h * .77;
      ctx.strokeStyle = '#f0d7bd15'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(w * .05, floor); ctx.quadraticCurveTo(w * .5, floor - 22, w * .95, floor); ctx.stroke();
      for (const actor of actors) {
        const a = actor.pose, spread = actor.width * a.scale * .48;
        ctx.fillStyle = '#00000035'; ctx.beginPath();
        ctx.ellipse(a.x, floor, Math.max(2, spread), Math.max(1, spread * .09), 0, 0, Math.PI * 2); ctx.fill();
      }
      if (overlay.dataset.phase === 'tug') {
        const a = letters[2], b = letters[3];
        const x1 = a.pose.x + a.width * a.pose.scale * .4, x2 = b.pose.x - b.width * b.pose.scale * .4;
        const y = (a.pose.y + b.pose.y) / 2 + f * a.pose.scale * .12;
        ctx.strokeStyle = '#ffd991b0'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x1, y);
        ctx.quadraticCurveTo((x1 + x2) / 2, y + Math.sin(p * 19) * 5, x2, y); ctx.stroke();
      }
      // Faint paper-like motes follow the leader, rather than a uniform star field.
      for (let n = 0; n < 28; n++) {
        const q = ((n / 28 + p * .08) % 1), fade = Math.sin(q * Math.PI) * .22;
        ctx.fillStyle = 'rgba(246,213,162,' + fade + ')';
        ctx.beginPath(); ctx.arc(w * (.12 + q * .76), h * (.72 - Math.sin(q * 5 + n) * .035), 1 + n % 2, 0, Math.PI * 2); ctx.fill();
      }
    } else {
      const hole = portalGeometry(p), visibility = smooth((p - .18) / .35) * (1 - smooth((p - 5.65) / .55));
      ctx.save(); ctx.globalAlpha = visibility;
      ctx.translate(hole.x, hole.y);
      const halo = ctx.createRadialGradient(0, 0, hole.r * .65, 0, 0, hole.r * 1.8);
      halo.addColorStop(0, '#00000000'); halo.addColorStop(.35, '#927cff30'); halo.addColorStop(1, '#927cff00');
      ctx.fillStyle = halo; ctx.fillRect(-hole.r * 2, -hole.r * 2, hole.r * 4, hole.r * 4);
      ctx.fillStyle = '#020308'; ctx.beginPath(); ctx.arc(0, 0, hole.r, 0, Math.PI * 2); ctx.fill();
      for (let ribbon = 0; ribbon < 4; ribbon++) {
        ctx.beginPath();
        for (let n = 0; n <= 100; n++) {
          const angle = n / 100 * Math.PI * 2;
          const breath = Math.sin(angle * 3 + p * 2.3 + ribbon) * .023 + Math.sin(angle * 5 - p * 1.7) * .012;
          const r = hole.r * (1 + ribbon * .025 + breath);
          const x = Math.cos(angle) * r, y = Math.sin(angle) * r * (1 + Math.sin(p * 1.8) * .025);
          if (n === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.closePath(); ctx.strokeStyle = ribbon === 0 ? '#e2d6ff' : '#a58aff55';
        ctx.lineWidth = ribbon === 0 ? 2.2 : 1.2; ctx.shadowColor = '#9b80ff'; ctx.shadowBlur = ribbon === 0 ? 17 : 0; ctx.stroke();
      }
      ctx.shadowBlur = 0;
      for (let n = 0; n < 74; n++) {
        const depth = ((n / 74 + p * .16) % 1), angle = n * 2.399963 + p * .45;
        const r = hole.r * (1.08 + depth ** 2 * 1.2);
        ctx.beginPath(); ctx.arc(Math.cos(angle) * r, Math.sin(angle) * r, .5 + depth, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(205,189,255,' + Math.sin(depth * Math.PI) * .35 + ')'; ctx.fill();
      }
      ctx.restore();
    }
  }

  const draw = (now: number) => {
    if (finished) return;
    const elapsed = (now - start) / 1000;
    const p = style === 'portal' ? elapsed % PORTAL_DURATION : elapsed;
    const dt = Math.min(.05, (now - previousFrame) / 1000);
    previousFrame = now;
    if (returningAt !== undefined) {
      const u = clamp((now - returningAt) / 200), q = out(u);
      actors.forEach((actor, index) => {
        actor.pose = between(returningPoses[index], actor.home, q);
        actor.pose.y -= Math.sin(u * Math.PI) * Math.min(18, h * .025);
        actor.pose.opacity = mix(returningPoses[index].opacity, 1, out(u));
        paintActor(actor);
      });
      canvas.style.opacity = String((1 - q) * Number(canvas.dataset.opacity ?? '1'));
      caption.style.opacity = tagline.style.opacity = '0';
      if (u >= 1) { cleanup(); return; }
    } else {
      if (style === 'runaway') {
        if (p < 7) runaway(p);
        else {
          accumulator += dt;
          while (accumulator >= STEP) { playground(STEP); accumulator -= STEP; }
        }
      } else {
        portal(p);
        overlay.dataset.lap = String(Math.floor(elapsed / PORTAL_DURATION));
      }
      if (style === 'portal' && p > 7.05) {
        const u = smooth((p - 7.05) / 1.05);
        actors.forEach(actor => { actor.pose = between(actor.pose, actor.home, u); });
      }
      const reveal = smooth((p - .38) / 1.15) * (style === 'portal' ? 1 - smooth((p - 7.05) / .85) : 1);
      stage(p, reveal); canvas.dataset.opacity = String(reveal);
      letters.forEach(actor => { actor.node.style.color = 'color-mix(in srgb, ' + sourceColor + ' ' + (1 - reveal) * 100 + '%, #f3eeea)'; });
      actors.forEach(paintActor);
      caption.style.opacity = String(smooth((p - 1.7) / .6) * (1 - smooth((p - 3) / .5)));
      tagline.style.opacity = String(style === 'runaway' && p >= 7 ? smooth((simulated % LAP - 16.4) / .5) : smooth((p - 5.8) / .6) * (1 - smooth((p - 6.8) / .3)));
      if (style === 'portal' || p < 7) overlay.dataset.phase = p < 1.6 ? 'escape' : p < 5.6 ? 'journey' : p < 7.05 ? 'hero' : 'return';
    }
    raf = requestAnimationFrame(draw);
  };
  actors.forEach(paintActor); raf = requestAnimationFrame(draw);
  return cancel;
}
