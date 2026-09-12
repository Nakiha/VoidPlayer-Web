import { chooseIdentity, currentActor, identityHealth } from '../identity.ts';
import { icon } from './icons.ts';

type User = { id: string; name: string };
let pending: Promise<void> | undefined;
/** Player and admin share one explicit identity choice; read requests never create identities. */
export function chooseInitialIdentity(signal: AbortSignal): Promise<void> {
  return pending ??= choose(signal).finally(() => { pending = undefined; });
}
async function choose(signal: AbortSignal) {
  const health = await identityHealth();
  if (!health.capabilities?.admin || currentActor() || signal.aborted) return;
  let busy = false, closing = false, expanded = false, active = -1;
  let users: User[] = [], filtered: User[] = [], listState: 'loading' | 'ready' | 'error' = 'loading';
  let completeWelcome!: () => void;
  const done = new Promise<void>(resolve => { completeWelcome = resolve; });
  const controller = new AbortController();
  const welcome = document.createElement('dialog');
  welcome.id = 'identity-welcome'; welcome.className = 'identity-welcome';
  welcome.setAttribute('aria-labelledby', 'identity-welcome-title');
  welcome.innerHTML = `<p id="identity-welcome-title">怎么称呼你？</p>
    <form><div class="welcome-picker"><div class="welcome-field">
      <input maxlength="128" autocomplete="off" placeholder="名字（选填）" aria-label="名字（选填）" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="welcome-users" aria-describedby="welcome-kind" spellcheck="false">
      <span id="welcome-kind" class="welcome-kind" role="status"></span>
      <button type="button" class="welcome-toggle" aria-label="选择已有用户" aria-expanded="false" aria-controls="welcome-users">${icon('down')}</button>
    </div><div class="welcome-dropdown" inert><div id="welcome-users" class="welcome-user-list" role="listbox" aria-label="已有用户"></div><p class="welcome-empty" role="status"></p></div></div>
    <p role="alert"></p><button type="submit" class="primary welcome-enter" autofocus><span>以访客身份继续</span></button></form>`;
  document.body.append(welcome);
  const input = welcome.querySelector('input')!;
  const enterButton = welcome.querySelector<HTMLButtonElement>('.welcome-enter')!;
  const label = enterButton.querySelector('span')!;
  const kind = welcome.querySelector<HTMLElement>('.welcome-kind')!;
  const toggle = welcome.querySelector<HTMLButtonElement>('.welcome-toggle')!;
  const picker = welcome.querySelector<HTMLElement>('.welcome-picker')!;
  const dropdown = welcome.querySelector<HTMLElement>('.welcome-dropdown')!;
  const list = welcome.querySelector<HTMLElement>('.welcome-user-list')!;
  const empty = welcome.querySelector<HTMLElement>('.welcome-empty')!;
  const alert = welcome.querySelector<HTMLElement>('[role=alert]')!;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const name = () => input.value.normalize('NFC').trim();
  const matched = () => users.find(user => user.name === name());
  function changeText(element: HTMLElement, text: string) {
    if (element.textContent === text) return;
    element.textContent = text;
    element.getAnimations().forEach(animation => animation.cancel());
    if (!reducedMotion.matches) element.animate([{ opacity: .3, transform: 'translateY(3px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 160, easing: 'ease-out' });
  }
  function sync() {
    const value = name(), existing = matched();
    changeText(kind, !value ? '' : existing ? '已有用户' : listState === 'ready' ? '新用户' : '待确认');
    kind.dataset.kind = !value ? 'guest' : existing ? 'existing' : listState === 'ready' ? 'new' : 'pending';
    kind.title = kind.dataset.kind === 'pending' ? '用户列表尚未确认，继续时会按名字匹配或创建用户' : '';
    changeText(label, busy ? '正在进入…' : value ? `以「${value}」的身份继续` : '以访客身份继续');
    enterButton.title = label.textContent!;
    // Guest is a state of the same primary action.
    enterButton.toggleAttribute('data-guest', !value);
    welcome.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input,button').forEach(el => { el.disabled = busy || closing; });
    toggle.hidden = listState === 'ready' && !users.length;
  }
  function positionDropdown() {
    if (!expanded) return;
    const rect = picker.getBoundingClientRect(), viewport = window.visualViewport;
    const top = viewport?.offsetTop ?? 0, bottom = top + (viewport?.height ?? innerHeight);
    const below = bottom - rect.bottom - 16, above = rect.top - top - 16;
    const up = below < 160 && above > below;
    dropdown.classList.toggle('opens-up', up);
    dropdown.style.maxHeight = `${Math.max(44, Math.min(224, up ? above : below))}px`;
  }
  function setExpanded(value: boolean) {
    expanded = value && !busy && !closing && !toggle.hidden;
    dropdown.inert = !expanded;
    dropdown.classList.toggle('is-open', expanded);
    input.setAttribute('aria-expanded', String(expanded));
    toggle.setAttribute('aria-expanded', String(expanded));
    if (!expanded) { active = -1; input.removeAttribute('aria-activedescendant'); }
    positionDropdown();
  }
  function setActive(index: number) {
    active = index;
    [...list.children].forEach((row, i) => row.classList.toggle('is-active', i === active));
    const row = list.children[active] as HTMLElement | undefined;
    if (row) { input.setAttribute('aria-activedescendant', row.id); row.scrollIntoView({ block: 'nearest' }); }
    else input.removeAttribute('aria-activedescendant');
  }
  function select(user: User) {
    if (busy || closing) return;
    input.value = user.name; alert.textContent = ''; sync(); renderList(); setExpanded(false); input.focus();
  }
  function renderList(showAll = false) {
    filtered = showAll ? users : users.filter(user => user.name.toLocaleLowerCase().includes(name().toLocaleLowerCase()));
    list.replaceChildren(...filtered.map((user, index) => {
      const row = document.createElement('div'); row.id = `welcome-user-${index}`; row.className = 'welcome-user';
      row.setAttribute('role', 'option'); row.setAttribute('aria-selected', String(user.id === matched()?.id));
      row.textContent = user.name;
      row.addEventListener('pointerdown', event => event.preventDefault());
      row.addEventListener('click', () => select(user));
      return row;
    }));
    empty.textContent = listState === 'loading' ? '正在读取用户…' : listState === 'error' ? '暂时无法读取用户，可直接输入名字继续。' : filtered.length ? '' : '没有匹配的用户';
    empty.hidden = !empty.textContent;
    setActive(-1);
  }
  input.addEventListener('input', () => { alert.textContent = ''; sync(); renderList(); });
  // Safari can blur the input with a null relatedTarget before a pointer click.
  // Keep focus in the picker so that blur cannot close and then reopen the list.
  toggle.addEventListener('pointerdown', event => { if (event.button === 0) event.preventDefault(); });
  toggle.addEventListener('click', () => { if (!expanded) renderList(true); setExpanded(!expanded); input.focus(); });
  input.addEventListener('keydown', event => {
    if (event.isComposing) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); setExpanded(true);
      if (expanded && filtered.length) setActive(active < 0 ? (event.key === 'ArrowDown' ? 0 : filtered.length - 1) : (active + (event.key === 'ArrowDown' ? 1 : -1) + filtered.length) % filtered.length);
    } else if (event.key === 'Enter' && expanded && active >= 0) {
      event.preventDefault(); select(filtered[active]);
    } else if (event.key === 'Escape' && expanded) {
      event.preventDefault(); event.stopPropagation(); setExpanded(false);
    } else if (event.key === 'Tab') setExpanded(false);
  });
  welcome.addEventListener('pointerdown', event => { if (!picker.contains(event.target as Node)) setExpanded(false); });
  welcome.addEventListener('focusout', event => { if (!picker.contains(event.relatedTarget as Node | null)) setExpanded(false); });
  async function finish() {
    if (closing) return;
    closing = true; setExpanded(false); sync();
    if (!signal.aborted && !reducedMotion.matches) {
      await welcome.animate([{ opacity: 1, transform: 'translateY(0)' }, { opacity: 0, transform: 'translateY(6px)' }], { duration: 140, easing: 'ease-in', fill: 'forwards' }).finished.catch(() => {});
    }
    welcome.close(); completeWelcome();
  }
  async function enter() {
    if (busy || closing) return;
    const value = name(), existing = matched();
    const choice = !value ? { guest: true as const } : existing ? { id: existing.id } : { name: value };
    busy = true; alert.textContent = ''; setExpanded(false); sync();
    try { await chooseIdentity(choice); void finish(); }
    catch (error) { alert.textContent = (error as Error).message; }
    finally { busy = false; sync(); }
  }
  welcome.querySelector('form')!.onsubmit = event => { event.preventDefault(); void enter(); };
  welcome.addEventListener('cancel', event => { event.preventDefault(); setExpanded(false); });
  const selected = () => { if (currentActor()) void finish(); };
  const abort = () => { void finish(); };
  const refresh = () => { void identityHealth().catch(() => {}); };
  window.addEventListener('voidplayer-identity-change', selected);
  window.addEventListener('storage', refresh);
  window.addEventListener('resize', positionDropdown);
  window.visualViewport?.addEventListener('resize', positionDropdown);
  window.visualViewport?.addEventListener('scroll', positionDropdown);
  signal.addEventListener('abort', abort, { once: true });
  sync(); renderList(); welcome.showModal();
  // Listing never delays guest entry or steals focus after the user starts typing.
  void (async () => {
    try {
      const response = await fetch('/api/users', { cache: 'no-store', signal: AbortSignal.any([signal, controller.signal, AbortSignal.timeout(4000)]) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? '无法读取用户列表。');
      users = result.users; listState = 'ready';
    } catch { listState = 'error'; }
    if (closing) return;
    sync(); renderList();
    if (toggle.hidden) setExpanded(false);
  })();
  if (signal.aborted) abort();
  await done;
  controller.abort();
  signal.removeEventListener('abort', abort);
  window.removeEventListener('voidplayer-identity-change', selected);
  window.removeEventListener('storage', refresh);
  window.removeEventListener('resize', positionDropdown);
  window.visualViewport?.removeEventListener('resize', positionDropdown);
  window.visualViewport?.removeEventListener('scroll', positionDropdown);
  welcome.remove();
}
