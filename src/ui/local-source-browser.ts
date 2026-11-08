import { onLanguageChange, t, msg } from '../i18n.ts';
import type { LibraryBrowserElements } from './library-browser.ts';
import type { LibraryEntry, LibraryPage } from '../services/library.ts';

/** Local source filtering has no directory navigation, service probes or polling. */
export function installLocalSourceBrowser(elements: LibraryBrowserElements, change: (page: LibraryPage | null) => void, signal: AbortSignal) {
  let search = '';
  const input = document.createElement('input');
  input.id = 'local-source-search'; input.type = 'search'; input.className = 'library-location';
  const navigation = document.createElement('div'); navigation.className = 'library-navigation'; navigation.append(input);
  elements.tools.replaceChildren(navigation);
  if (elements.trailing) elements.tools.append(elements.trailing);
  const localize = () => {
    const label = t(msg('sites.searchLocal', '搜索本地片源'));
    input.placeholder = label; input.setAttribute('aria-label', label);
  };
  const publish = () => { input.value = search; change(null); };
  input.addEventListener('input', () => { search = input.value.trim(); change(null); }, { signal });
  onLanguageChange(localize, signal); localize();
  return {
    snapshot: () => ({ root: '', directory: '', search, all: false }),
    async restore(state: { root: string; directory: string; search: string; all: boolean; recent?: boolean; query?: string }) { search = state.search; publish(); },
    async reveal(_entry: LibraryEntry) { return false; },
    navigate(_root: string, _directory: string) {},
    page: (): LibraryPage | null => null, filter: () => search, isRoot: () => true,
    async load() { publish(); },
    clearSearch() { search = ''; publish(); },
  };
}
