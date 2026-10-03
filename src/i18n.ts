import zhCN from './i18n/generated/zh-CN.js';
import type { Sources, MessageParameters } from './i18n/generated/types.ts';
import { createLocaleController, parseLanguagePreference, resolveLocale } from './i18n/locale.ts';
import type { Locale, LanguagePreference } from './i18n/locale.ts';
export { parseLanguagePreference, resolveLocale };
export type { Locale, LanguagePreference };
export type MessageKey = keyof Sources;
export type Descriptor<K extends MessageKey = MessageKey> = { id: K; source: Sources[K] };
/** Default source stays beside the owning UI. Values remain text, never HTML. */
export function msg<K extends MessageKey>(id: K, source: Sources[K]): Descriptor<K> { return id as unknown as Descriptor<K>; }
type Args<K extends MessageKey> = keyof MessageParameters[K] extends never ? [] : [MessageParameters[K]];
export const LANGUAGE_KEY = 'voidplayer.language';
let englishAttempt = 0;
const englishCatalogURL = '__EN_CATALOG_URL__'; // Vite emits the compiled module, including its runtime dependencies.
const controller = createLocaleController(zhCN, async () => {
  const attempt=englishAttempt++;
  if(!attempt)return (await import('./i18n/generated/en.js')).default;
  // WebKit retains a failed module-map entry even after connectivity returns.
  // Use a new URL only on retry; successful catalogs remain cached by the controller.
  return (await import(/* @vite-ignore */ `${englishCatalogURL}?retry=${attempt}`)).default;
}, (locale,preference,persist) => {
  if(typeof document !== 'undefined')document.documentElement.lang=locale;
  if(persist)try { if(preference==='system')localStorage.removeItem(LANGUAGE_KEY);else localStorage.setItem(LANGUAGE_KEY,preference); }catch { /* Switching works in restricted storage contexts. */ }
});
export const getLocale=controller.getLocale;
export const getLanguagePreference=controller.getPreference;
export const getLocaleRevision=controller.getRevision;
export const onLanguageChange=controller.subscribe;
export function t<K extends MessageKey>(descriptor: Descriptor<K>, ...args: Args<K>): string {
  return controller.message(descriptor as unknown as string,args[0] as Record<string,string|number> | undefined);
}
export function th<K extends MessageKey>(descriptor: Descriptor<K>, ...args: Args<K>): string {
  return t(descriptor,...args).replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll("'",'&#39;').replaceAll('<','&lt;').replaceAll('>','&gt;');
}
export async function setLanguage(choice: LanguagePreference, options: {persist?:boolean;languages?:readonly string[]}={}) {
  await controller.set(choice,options.languages ?? (typeof navigator==='undefined'?[]:navigator.languages),options.persist!==false);
}
function readPreference() {try {return parseLanguagePreference(localStorage.getItem(LANGUAGE_KEY));}catch{return 'system' as const;}}
export async function initializeLanguage() {
  try { await setLanguage(readPreference(),{persist:false}); }
  catch { await setLanguage('zh-CN',{persist:false}); }
  if((import.meta.env?.DEV || import.meta.env?.VITE_I18N_PSEUDO === '1') && new URL(location.href).searchParams.has('pseudo-locale')) await previewPseudoLocale();
  const life=new AbortController();
  window.addEventListener('storage',event=>{if(event.key===LANGUAGE_KEY||event.key===null)void setLanguage(readPreference(),{persist:false}).catch(()=>{});},{signal:life.signal});
  window.addEventListener('languagechange',()=>{if(getLanguagePreference()==='system')void setLanguage('system',{persist:false}).catch(()=>{});},{signal:life.signal});
  return ()=>life.abort();
}
const dateFormats=new Map<Locale,Intl.DateTimeFormat>();
export function formatDate(value:string|number|Date) {
  let format=dateFormats.get(getLocale());if(!format){format=new Intl.DateTimeFormat(getLocale(),{dateStyle:'short',timeStyle:'medium'});dateFormats.set(getLocale(),format);}
  const date=new Date(value);return Number.isNaN(date.getTime())?'—':format.format(date);
}
const numberFormats=new Map<string,Intl.NumberFormat>();
export function formatNumber(value:number,options:Intl.NumberFormatOptions={}) {
  const key=getLocale()+JSON.stringify(options);let format=numberFormats.get(key);if(!format){format=new Intl.NumberFormat(getLocale(),options);numberFormats.set(key,format);}return format.format(value);
}
export async function previewPseudoLocale() {controller.preview((await import('./i18n/generated/pseudo.js')).default);}
