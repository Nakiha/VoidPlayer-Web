export type Locale = 'zh-CN' | 'en';
export type LanguagePreference = Locale | 'system';
export type Catalog = Partial<Record<string, (values?: Record<string, string | number>) => string>>;
export function parseLanguagePreference(value: string | null): LanguagePreference {
  return value === 'zh-CN' || value === 'en' ? value : 'system';
}
export function resolveLocale(choice: LanguagePreference, languages: readonly string[]): Locale {
  if (choice !== 'system') return choice;
  for (const language of languages) {
    if (/^zh(?:-|$)/i.test(language)) return 'zh-CN';
    if (/^en(?:-|$)/i.test(language)) return 'en';
  }
  return 'en';
}
/** Pure, injectable locale lifecycle. Only successful latest loads commit or notify. */
export function createLocaleController(defaultCatalog: Catalog, load: (locale: Locale) => Promise<Catalog>, commit: (locale: Locale, preference: LanguagePreference, persist: boolean) => void) {
  let locale: Locale = 'zh-CN', preference: LanguagePreference = 'system', catalog = defaultCatalog;
  let request = 0, revision = 0;
  const listeners = new Set<() => void>();
  const staticMessages = new Map<string,string>();
  const pending = new Map<Locale, Promise<Catalog>>();
  const catalogs = new Map<Locale, Catalog>([['zh-CN', defaultCatalog]]);
  return {
    getLocale: () => locale, getPreference: () => preference, getRevision: () => revision,
    message(id: string, values?: Record<string, string | number>) {
      const format = catalog[id] ?? defaultCatalog[id];
      if (!format) throw new Error(`Unknown message ID: ${id}`);
      if(values)return format(values);
      let text=staticMessages.get(id);if(text===undefined){text=format();staticMessages.set(id,text);}return text;
    },
    async set(choice: LanguagePreference, languages: readonly string[], persist = true) {
      const ticket = ++request, next = resolveLocale(choice,languages);
      let loaded = catalogs.get(next);
      if (!loaded) {
        let promise = pending.get(next);
        if (!promise) {
          promise = load(next).then(value => { catalogs.set(next,value);return value; }).finally(() => pending.delete(next));
          pending.set(next,promise);
        }
        try { loaded = await promise; } catch (error) { if(ticket !== request)return;throw error; }
      }
      if (ticket !== request) return;
      const changed = next !== locale || loaded !== catalog;
      const preferenceChanged = choice !== preference;
      locale = next; preference = choice; catalog = loaded;
      commit(locale,preference,persist);
      if (changed) { staticMessages.clear(); revision++; }
      if (changed || preferenceChanged) for(const listener of listeners)listener();
    },
    subscribe(listener: () => void, signal?: AbortSignal) {
      if(signal?.aborted)return () => {};
      listeners.add(listener);
      const remove = () => {listeners.delete(listener);signal?.removeEventListener('abort',remove);};
      signal?.addEventListener('abort',remove,{once:true});return remove;
    },
    // Explicit QA locale: compiled pseudo catalog, never persisted or a user preference.
    preview(value: Catalog) { request++;catalog=value;staticMessages.clear();revision++;for(const listener of listeners)listener(); },
  };
}
