const EFFECTS = ['glitch', 'scramble', 'scatter', 'flip'] as const;
const DURATION = 1200;
const SCRAMBLE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#%&';

export function installBrandEffects(button: HTMLButtonElement) {
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const events = new AbortController();
  let timer: number | undefined;
  let scrambleTimer: number | undefined;
  let overlay: HTMLElement | undefined;
  let previous = -1;

  const clear = () => {
    window.clearTimeout(timer);
    window.clearInterval(scrambleTimer);
    overlay?.remove();
    overlay = undefined;
    button.classList.remove('brand-effect-active');
  };

  const schedule = () => {
    window.clearTimeout(timer);
    if (reducedMotion.matches || document.hidden) return;
    timer = window.setTimeout(play, 3800 + Math.random() * 3200);
  };

  const play = () => {
    clear();
    if (reducedMotion.matches || document.hidden || !button.getClientRects().length) {
      schedule();
      return;
    }
    const bounds = button.getBoundingClientRect();
    const style = getComputedStyle(button);
    // Draw above the scrolling toolbar so the distortion may leave its bounds.
    const next = (previous + 1 + Math.floor(Math.random() * (EFFECTS.length - 1))) % EFFECTS.length;
    previous = next;
    const effect = EFFECTS[next];
    overlay = document.createElement('span');
    overlay.className = `brand-effect brand-effect--${effect}`;
    overlay.setAttribute('aria-hidden', 'true');
    overlay.dataset.text = button.textContent?.trim() || 'VoidPlayer';
    overlay.style.cssText = `left:${bounds.left}px;top:${bounds.top}px;width:${bounds.width}px;height:${bounds.height}px;font:${style.font};letter-spacing:${style.letterSpacing};color:${style.color}`;
    const letters: HTMLSpanElement[] = [];
    for (const [index, char] of [...overlay.dataset.text].entries()) {
      const letter = document.createElement('span');
      letter.className = 'brand-effect-letter';
      letter.style.setProperty('--i', String(index));
      letter.style.setProperty('--dx', `${(index % 2 ? 1 : -1) * (18 + Math.random() * 32)}px`);
      letter.style.setProperty('--dy', `${(index % 3 - 1) * (16 + Math.random() * 15)}px`);
      letter.style.setProperty('--rotation', `${(index % 2 ? 1 : -1) * (25 + Math.random() * 65)}deg`);
      letter.textContent = char;
      overlay.append(letter);
      letters.push(letter);
    }
    document.body.append(overlay);
    if (effect === 'scramble') {
      for (const letter of letters) letter.style.width = `${letter.getBoundingClientRect().width}px`;
      button.classList.add('brand-effect-active');
      let round = 0;
      const scramble = () => {
        letters.forEach((letter, index) => {
          letter.textContent = round >= 5 + index * 2 ? overlay!.dataset.text![index] :
            SCRAMBLE_CHARS[Math.floor(Math.random() * SCRAMBLE_CHARS.length)];
        });
        round++;
      };
      scramble();
      scrambleTimer = window.setInterval(scramble, 40);
    } else if (effect === 'scatter' || effect === 'flip') {
      button.classList.add('brand-effect-active');
    }
    timer = window.setTimeout(() => { clear(); schedule(); }, DURATION);
  };

  button.addEventListener('pointerenter', play, { signal: events.signal });
  button.addEventListener('focus', play, { signal: events.signal });
  document.addEventListener('visibilitychange', () => { clear(); schedule(); }, { signal: events.signal });
  window.addEventListener('resize', () => { clear(); schedule(); }, { signal: events.signal });
  reducedMotion.addEventListener('change', () => { clear(); schedule(); }, { signal: events.signal });
  schedule();
  return () => { events.abort(); clear(); };
}
