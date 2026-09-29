import { zhCN } from './locales/zh-CN';
import { en } from './locales/en';

export type MessageKey = keyof typeof zhCN;
export type Catalog = Record<MessageKey, string>;
export const LOCALES = [
  { id: 'zh-CN', label: '简体中文' },
  { id: 'en', label: 'English' },
] as const;
export type Locale = typeof LOCALES[number]['id'];
export type LanguageSetting = 'auto' | Locale;
/** Text stored as a catalog key, rendered in whichever locale is active when displayed. */
export interface LocalText { key: MessageKey; params?: Params }
export type Params = Record<string, string | number | LocalText>;
/** Plain strings are model-authored or page-derived text and are shown as-is. */
export type Text = string | LocalText;
const catalogs: Record<Locale, Catalog> = { 'zh-CN': zhCN, en };
const storageKey = 'language';

export const isLocale = (value: unknown): value is Locale => LOCALES.some(locale => locale.id === value);
export function detectLocale(language = globalThis.navigator?.language ?? ''): Locale { return /^zh\b/i.test(language) ? 'zh-CN' : 'en'; }
export function resolveLocale(setting?: unknown): Locale { return isLocale(setting) ? setting : detectLocale(); }

let current: Locale = detectLocale();
export function getLocale(): Locale { return current; }
export function setLocale(locale: Locale) { current = locale; }
export function translate(locale: Locale, key: MessageKey, params?: Params): string {
  const template = catalogs[locale]?.[key] ?? en[key] ?? key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : isLocalText(value) ? translate(locale, value.key, value.params) : String(value);
  });
}
export function t(key: MessageKey, params?: Params): string { return translate(current, key, params); }

export const msg = (key: MessageKey, params?: Params): LocalText => params ? { key, params } : { key };
export function isLocalText(value: unknown): value is LocalText {
  return !!value && typeof value === 'object' && typeof (value as LocalText).key === 'string' && (value as LocalText).key in zhCN;
}
export function display(text: Text | undefined): string { return text === undefined ? '' : typeof text === 'string' ? text : t(text.key, text.params); }
/** Message fields for persisting text: the rendered content plus the key for re-rendering. */
export const asContent = (text: Text) => ({ content: display(text), ...(typeof text === 'string' ? {} : { localText: text }) });

export class LocalizedError extends Error {
  readonly text: LocalText;
  constructor(key: MessageKey, params?: Params) { super(t(key, params)); this.text = msg(key, params); }
  static of(text: LocalText) { return new LocalizedError(text.key, text.params); }
}
/** Keep an error's catalog key when it has one, so it can be re-rendered and shown to the model canonically. */
export function errorText(error: unknown, fallback: MessageKey): Text {
  if (error instanceof LocalizedError) return error.text;
  return error instanceof Error ? error.message : msg(fallback);
}

export async function loadLanguage(): Promise<LanguageSetting> {
  const value = (await chrome.storage.local.get(storageKey))[storageKey];
  return isLocale(value) ? value : 'auto';
}
export async function storeLanguage(language: LanguageSetting) {
  if (language === 'auto') await chrome.storage.local.remove(storageKey);
  else await chrome.storage.local.set({ [storageKey]: language });
  setLocale(resolveLocale(language));
}
export async function initLocale() { setLocale(resolveLocale(await loadLanguage())); }
/** Keep the active locale in sync with the setting; returns an unsubscribe function. */
export function watchLocale(onChange?: (locale: Locale) => void) {
  const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area !== 'local' || !(storageKey in changes)) return;
    setLocale(resolveLocale(changes[storageKey].newValue)); onChange?.(current);
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
