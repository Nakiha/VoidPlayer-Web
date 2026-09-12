import { chooseInitialIdentity } from './identity-onboarding.ts';
import { installChoiceMenu } from './choice-menu.ts';
import { chooseIdentity, currentActor, identityHealth } from '../identity.ts';
import type { Actor } from '../identity.ts';

export function installIdentitySettings(setActor: (actor: Actor | null) => void) {
  const life = new AbortController();
  const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(`identity-${id}`) as T;
  const input = $<HTMLInputElement>('name');
  let users: Actor[] = [], busy = false, rename = false, loaded = false;
  const value = () => input.value.normalize('NFC').trim();
  const match = () => users.find(user => user.name === value());
  const unchangedGuest = () => (!currentActor() || currentActor()?.kind === 'guest') && value() === '访客' && !match();
  const menu = installChoiceMenu('identity-users', [], id => {
    rename = id === 'rename';
    input.value = rename ? currentActor()?.name ?? '' : users.find(user => user.id === id)?.name ?? '';
    $('message').textContent = ''; render(); input.focus();
  }, undefined, undefined, () => input.closest('.identity-combo')!.getBoundingClientRect());
  function render() {
    const actor = currentActor(); setActor(actor);
    $('current').textContent = actor?.name ?? '访客';
    $('id').textContent = actor ? `ID · ${actor.id}` : '';
    $('id').dataset.tooltip = actor?.id ?? '';
    const existing = match(), name = value();
    $('kind').textContent = rename ? '修改当前名字' : !name || unchangedGuest() ? '' : existing ? '已有用户' : loaded ? '新用户' : '待确认';
    const label = busy ? '保存中…' : rename ? '保存' : !name || unchangedGuest() ? '确认' : existing ? '切换' : '创建';
    const button = $<HTMLButtonElement>('save');
    if (button.textContent !== label) {
      button.textContent = label;
      if (!matchMedia('(prefers-reduced-motion: reduce)').matches) button.animate([{ opacity: .5 }, { opacity: 1 }], { duration: 160 });
    }
    button.title = rename ? `改名为「${name}」` : name ? `以「${name}」的身份继续` : '输入名字或选择已有用户';
    button.setAttribute('aria-label', button.title);
    button.disabled = busy || !name || unchangedGuest();
    input.disabled = busy;
    menu.sync(existing?.id ?? 'guest', '', !busy);
  }
  async function refreshUsers() {
    const response = await fetch('/api/users', { cache: 'no-store', signal: AbortSignal.any([life.signal, AbortSignal.timeout(4000)]) });
    const result = await response.json(); if (!response.ok) throw new Error(result.error ?? '无法读取用户列表。');
    users = result.users; loaded = true;
    menu.setOptions([...users.map(user => ({ value: user.id, label: user.name })), ...(currentActor()?.kind !== 'guest' && currentActor() ? [{ value: 'rename', label: '修改当前用户名…' }] : [])]);
    render();
  }
  async function refresh() {
    try { const health = await identityHealth(); if (!health.capabilities?.admin) return; await chooseInitialIdentity(life.signal); await refreshUsers(); }
    catch (error) { if (!life.signal.aborted) $('message').textContent = (error as Error).message; }
  }
  input.addEventListener('focus', () => { if (unchangedGuest()) input.select(); }, { signal: life.signal });
  input.addEventListener('input', () => { $('message').textContent = ''; render(); }, { signal: life.signal });
  $('form').addEventListener('submit', event => {
    event.preventDefault(); if (busy || !value() || unchangedGuest()) return;
    const name = value(), existing = match();
    const choice = rename ? { name, mode: 'rename' as const } : existing ? { id: existing.id } : { name, mode: 'create' as const };
    busy = true; render();
    void chooseIdentity(choice).then(async actor => {
      rename = false; input.value = actor.name; $('message').textContent = ''; await refreshUsers();
    }).catch(error => { $('message').textContent = error.message; }).finally(() => { busy = false; render(); });
  }, { signal: life.signal });
  window.addEventListener('voidplayer-identity-change', () => { rename = false; input.value = currentActor()?.name ?? '访客'; render(); }, { signal: life.signal });
  window.addEventListener('storage', event => { if (event.key === 'voidplayer.identity') void refresh(); }, { signal: life.signal });
  document.getElementById('settings')!.addEventListener('settings-pane-change', event => { if ((event as CustomEvent).detail === 'identity') void refresh(); }, { signal: life.signal });
  input.value = currentActor()?.name ?? '访客'; render();
  return { ready: refresh(), dispose() { life.abort(); menu.dispose(); } };
}
