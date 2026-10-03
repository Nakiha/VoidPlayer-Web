import { t, onLanguageChange, msg } from '../i18n.ts';
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
  // Whether WE placed the guest default text in the box (never typed by the
  // user). Compared by placement, not by translated label, so a peer tab
  // switching languages cannot turn the default into a "new name".
  let defaultedGuest = false;
  const guestDefault = () => t(msg("savedWorkspaces.guest", "访客"));
  const unchangedGuest = () => (!currentActor() || currentActor()?.kind === 'guest') && defaultedGuest && !match();
  const menu = installChoiceMenu('identity-users', [], id => {
    rename = id === 'rename';
    input.value = rename ? currentActor()?.name ?? '' : users.find(user => user.id === id)?.name ?? '';
    $('message').textContent = ''; render(); input.focus();
  }, undefined, undefined, () => input.closest('.identity-combo')!.getBoundingClientRect());
  function render(updateActor = true) {
    const actor = currentActor(); if (updateActor) setActor(actor);
    $('current').textContent = actor?.name ?? t(msg("savedWorkspaces.guest", "访客"));
    $('id').textContent = actor ? `ID · ${actor.id}` : '';
    $('id').dataset.tooltip = actor?.id ?? '';
    const existing = match(), name = value();
    $('kind').textContent = rename ? t(msg("identitySettings.renameYourself", "修改当前名字")) : !name || unchangedGuest() ? '' : existing ? t(msg("identitySettings.existingUser", "已有用户")) : loaded ? t(msg("identitySettings.newUser", "新用户")) : t(msg("identitySettings.unconfirmed", "待确认"));
    const label = busy ? t(msg("identitySettings.saving", "保存中…")) : rename ? t(msg("identitySettings.save", "保存")) : !name || unchangedGuest() ? t(msg("identitySettings.confirm", "确认")) : existing ? t(msg("identitySettings.switch", "切换")) : t(msg("identitySettings.create", "创建"));
    const button = $<HTMLButtonElement>('save');
    if (button.textContent !== label) {
      button.textContent = label;
      if (!matchMedia('(prefers-reduced-motion: reduce)').matches) button.animate([{ opacity: .5 }, { opacity: 1 }], { duration: 160 });
    }
    button.title = rename ? t(msg("identitySettings.renameTo", "改名为「{p0}」"), { p0: name }) : name ? t(msg("identitySettings.continueAs", "以「{p0}」的身份继续"), { p0: name }) : t(msg("settingsShell.enterANameOrChooseAnExisting", "输入名字或选择已有用户"));
    button.setAttribute('aria-label', button.title);
    button.disabled = busy || !name || unchangedGuest();
    input.disabled = busy;
    menu.sync(existing?.id ?? 'guest', '', !busy);
  }
  async function refreshUsers() {
    const response = await fetch('/api/users', { cache: 'no-store', signal: AbortSignal.any([life.signal, AbortSignal.timeout(4000)]) });
    const result = await response.json(); if (!response.ok) throw new Error(result.error ?? t(msg("identitySettings.unableToReadUserList", "无法读取用户列表。")));
    users = result.users; loaded = true;
    menu.setOptions(() => [...users.map(user => ({ value: user.id, label: user.name })), ...(currentActor()?.kind !== 'guest' && currentActor() ? [{ value: 'rename', label: t(msg("identitySettings.renameCurrentUser", "修改当前用户名…")) }] : [])]);
    render();
  }
  async function refresh() {
    try { const health = await identityHealth(); if (!health.capabilities?.admin) return; await chooseInitialIdentity(life.signal); await refreshUsers(); }
    catch (error) { if (!life.signal.aborted) $('message').textContent = (error as Error).message; }
  }
  input.addEventListener('focus', () => { if (unchangedGuest()) input.select(); }, { signal: life.signal });
  input.addEventListener('input', () => { defaultedGuest = false; $('message').textContent = ''; render(); }, { signal: life.signal });
  $('form').addEventListener('submit', event => {
    event.preventDefault(); if (busy || !value() || unchangedGuest()) return;
    const name = value(), existing = match();
    const choice = rename ? { name, mode: 'rename' as const } : existing ? { id: existing.id } : { name, mode: 'create' as const };
    busy = true; render();
    void chooseIdentity(choice).then(async actor => {
      rename = false; input.value = actor.name; $('message').textContent = ''; await refreshUsers();
    }).catch(error => { $('message').textContent = error.message; }).finally(() => { busy = false; render(); });
  }, { signal: life.signal });
  window.addEventListener('voidplayer-identity-change', () => { rename = false; input.value = currentActor()?.name ?? guestDefault(); defaultedGuest = !currentActor() || currentActor()?.kind === 'guest'; render(); }, { signal: life.signal });
  window.addEventListener('storage', event => { if (event.key === 'voidplayer.identity') void refresh(); }, { signal: life.signal });
  document.getElementById('settings')!.addEventListener('settings-pane-change', event => { if ((event as CustomEvent).detail === 'identity') void refresh(); }, { signal: life.signal });
  onLanguageChange(() => render(false), life.signal);
  input.value = currentActor()?.name ?? guestDefault(); defaultedGuest = !currentActor() || currentActor()?.kind === 'guest'; render();
  return { ready: refresh(), dispose() { life.abort(); menu.dispose(); } };
}
