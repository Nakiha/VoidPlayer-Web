import { chooseIdentity, currentActor, identityHealth } from '../identity.ts';
import type { Actor } from '../identity.ts';

export function installIdentitySettings(setActor: (actor: Actor | null) => void) {
  const life = new AbortController();
  const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(`identity-${id}`) as T;
  const input = $<HTMLInputElement>('name'), select = $<HTMLSelectElement>('users');
  let busy = false;
  function render() {
    const actor = currentActor(); setActor(actor);
    $('current').textContent = actor?.name ?? '正在连接服务…';
    $('id').textContent = actor ? `ID · ${actor.id.slice(0, 8)}` : '';
    $('id').title = actor?.id ?? '';
    input.value = actor?.name ?? '';
    input.disabled = select.disabled = $<HTMLButtonElement>('save').disabled = busy || !actor;
    select.value = actor?.id ?? '';
  }
  async function users() {
    const response = await fetch('/api/users', { cache: 'no-store', signal: AbortSignal.any([life.signal, AbortSignal.timeout(4000)]) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? '无法读取用户列表。');
    const options = (result.users as Actor[]).map(user => new Option(user.name, user.id));
    select.replaceChildren(...options); select.value = currentActor()?.id ?? '';
  }
  async function refresh() {
    try { await identityHealth(); await users(); }
    catch (error) { if (!life.signal.aborted) $('message').textContent = (error as Error).message; }
  }
  async function choose(name: string, id?: string) {
    if (busy) return;
    busy = true; const previous = currentActor(); render(); $('message').textContent = '正在保存…';
    try {
      const actor = await chooseIdentity(id ? { id } : { name });
      $('message').textContent = previous?.id === actor.id ? '用户名已保存。' : `已切换到 ${actor.name}。`;
      await users();
    } catch (error) { $('message').textContent = (error as Error).message; }
    finally { busy = false; render(); }
  }
  $('form').addEventListener('submit', event => { event.preventDefault(); void choose(input.value); }, { signal: life.signal });
  select.addEventListener('change', () => { const option = select.selectedOptions[0]; if (option) void choose(option.text, option.value); }, { signal: life.signal });
  window.addEventListener('voidplayer-identity-change', render, { signal: life.signal });
  window.addEventListener('storage', event => { if (event.key === 'voidplayer.identity') void refresh(); }, { signal: life.signal });
  document.getElementById('settings')!.addEventListener('settings-pane-change', event => {
    if ((event as CustomEvent).detail === 'identity') void refresh();
  }, { signal: life.signal });
  render(); void refresh();
  return { dispose() { life.abort(); } };
}
