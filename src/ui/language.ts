import type { ToastStack } from './toast.ts';
import { getLanguagePreference, onLanguageChange, setLanguage, t, msg } from '../i18n.ts';
import type { LanguagePreference } from '../i18n.ts';
import { installChoiceMenu } from './choice-menu.ts';

export function installLanguageControls(signal: AbortSignal, toasts?: ToastStack) {
  const status = document.getElementById('language-status');
  const options = () => [
    { value: 'system', label: t(msg("language.system", "跟随浏览器")) },
    { value: 'zh-CN', label: '简体中文' },
    { value: 'en', label: 'English' },
  ];
  let request = 0;
  const menu = installChoiceMenu('language-choice', options, value => {
    const ticket = ++request;
    void setLanguage(value as LanguagePreference).then(() => { if (ticket === request) sync(); }).catch(() => {
      if (ticket !== request) return;
      sync();
      const message = () => t(msg("language.loadFailed", "语言包未能加载，请重试"));
      if (toasts) toasts.show(message, { kind: 'error', durationMs: 5000 });
      else if (status) status.textContent = message();
    });
  });
  const sync = () => {
    const value = getLanguagePreference();
    menu.sync(value, options().find(option => option.value === value)!.label, true);
    if (status) status.textContent = '';
  };
  onLanguageChange(sync, signal);
  signal.addEventListener('abort', () => menu.dispose(), { once: true });
  sync();
}
