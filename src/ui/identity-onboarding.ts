import { chooseIdentity, currentActor, identityHealth } from '../identity.ts';
let pending: Promise<void> | undefined;
/** Player and admin share one explicit identity choice; read requests never create identities. */
export function chooseInitialIdentity(signal: AbortSignal): Promise<void> {
  return pending ??= choose(signal).finally(() => { pending = undefined; });
}
async function choose(signal: AbortSignal) {
  const health = await identityHealth();
  if (!health.capabilities?.admin || currentActor() || signal.aborted) return;
  let busy = false, completeWelcome!: () => void;
  const done = new Promise<void>(resolve => { completeWelcome = resolve; });
  const welcome = document.createElement('dialog'); welcome.id = 'identity-welcome'; welcome.className = 'identity-welcome';
  welcome.setAttribute('aria-labelledby', 'identity-welcome-title');
  welcome.innerHTML = `<h2 id="identity-welcome-title">欢迎使用 VoidPlayer</h2><p>选择已有用户或填写用户名，便于记录标注归属。稍后可以在设置的「用户」页面修改。</p><form><label>已有用户<select aria-label="选择已有用户"><option value="">请选择</option></select></label><label>用户名<input maxlength="128" autocomplete="nickname" placeholder="填写用户名"></label><p role="alert"></p><div class="identity-welcome-actions"><button type="button" data-guest>以访客继续</button><button type="submit" class="primary">进入工作区</button></div></form>`;
  document.body.append(welcome);

  const welcomeInput = welcome.querySelector('input')!, welcomeSelect = welcome.querySelector('select')!;
  welcomeSelect.onchange = () => { if (welcomeSelect.value) welcomeInput.value = ''; };
  welcomeInput.oninput = () => { if (welcomeInput.value) welcomeSelect.value = ''; };
  async function enter(guest = false) {
    if (busy) return;
    const choice = guest ? {guest:true as const} : welcomeSelect.value ? {id:welcomeSelect.value} : {name:welcomeInput.value};
    busy = true; welcome.querySelectorAll('button,input,select').forEach(el => el.toggleAttribute('disabled', true));
    try { await chooseIdentity(choice); welcome.close(); completeWelcome(); }
    catch(error) { welcome.querySelector('[role=alert]')!.textContent = (error as Error).message; }
    finally { busy = false; welcome.querySelectorAll('button,input,select').forEach(el => el.removeAttribute('disabled')); }
  }
  welcome.querySelector('form')!.onsubmit = event => { event.preventDefault(); void enter(); };
  welcome.querySelector<HTMLButtonElement>('[data-guest]')!.onclick = () => void enter(true);
  welcome.addEventListener('cancel', event => event.preventDefault());

  const selected = () => { if (currentActor()) { welcome.close(); completeWelcome(); } };
  const abort = () => { welcome.close(); completeWelcome(); };
  window.addEventListener('voidplayer-identity-change', selected);
  const refresh = () => { void identityHealth().catch(() => {}); };
  window.addEventListener('storage', refresh);
  signal.addEventListener('abort', abort, {once:true});
  welcome.showModal();
  try {
    const response = await fetch('/api/users', {cache:'no-store',signal:AbortSignal.any([signal,AbortSignal.timeout(4000)])});
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? '无法读取用户列表。');
    welcomeSelect.replaceChildren(new Option('请选择', ''), ...result.users.map((user: {name:string;id:string}) => new Option(user.name,user.id)));
  } catch(error) { if (!signal.aborted) welcome.querySelector('[role=alert]')!.textContent = (error as Error).message; }
  await done;
  signal.removeEventListener('abort',abort);
  window.removeEventListener('voidplayer-identity-change',selected);
  window.removeEventListener('storage',refresh);
  welcome.remove();
}
