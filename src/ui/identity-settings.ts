import { chooseInitialIdentity } from './identity-onboarding.ts';
import { installChoiceMenu } from './choice-menu.ts';
import { chooseIdentity, currentActor, identityHealth } from '../identity.ts';
import type { Actor } from '../identity.ts';

export function installIdentitySettings(setActor: (actor: Actor | null) => void) {
  const life = new AbortController();
  const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(`identity-${id}`) as T;
  const input = $<HTMLInputElement>('name');
  let userOptions: Actor[] = [];
  const menu = installChoiceMenu('identity-users', [], id => void choose('', id));
  let busy = false;
  function syncMenu() {
    const actor = currentActor();
    menu.sync(actor?.id ?? '', actor?.name ?? '暂无可用用户', !busy && userOptions.length > 0);
  }
  function render() {
    const actor = currentActor(); setActor(actor);
    $('current').textContent = actor?.name ?? '尚未选择用户';
    $('id').textContent = actor ? `ID · ${actor.id.slice(0, 8)}` : '';
    $('id').dataset.tooltip = actor?.id ?? '';
    input.value = actor?.kind === 'guest' ? '' : actor?.name ?? '';
    input.disabled = $<HTMLButtonElement>('save').disabled = busy;
    syncMenu();
  }
  async function users() {
    const response = await fetch('/api/users', { cache: 'no-store', signal: AbortSignal.any([life.signal, AbortSignal.timeout(4000)]) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? '无法读取用户列表。');
    userOptions = result.users as Actor[];
    menu.setOptions(userOptions.map(user => ({ value: user.id, label: user.name })));
    syncMenu();
  }
  async function refresh() {
    try { const health = await identityHealth();
      if (!health.capabilities?.admin) return;
      await users().catch(error => { $('message').textContent = (error as Error).message; });
      await chooseInitialIdentity(life.signal);
    }
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
  window.addEventListener('voidplayer-identity-change', render, { signal: life.signal });
  window.addEventListener('storage', event => { if (event.key === 'voidplayer.identity') void refresh(); }, { signal: life.signal });
  document.getElementById('settings')!.addEventListener('settings-pane-change', event => {
    if ((event as CustomEvent).detail === 'identity') void refresh();
  }, { signal: life.signal });
  $('guest').onclick = () => void chooseGuest();
  async function chooseGuest() {
    if (busy) return; busy = true;
    try { await chooseIdentity({guest:true}); $('message').textContent = '已切换为访客。'; }
    catch(error) { $('message').textContent = (error as Error).message; }
    finally { busy = false; render(); }
  }
  render(); const ready = refresh();
  return { ready, dispose() { life.abort(); menu.dispose(); } };
}
