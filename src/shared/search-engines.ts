import { LocalizedError, t } from '../i18n';

export const SEARCH_ENGINES = [
  { id: 'browser', label: 'Browser default' },
  { id: 'google', label: 'Google', url: 'https://www.google.com/search', parameter: 'q' },
  { id: 'bing', label: 'Bing', url: 'https://www.bing.com/search', parameter: 'q' },
  { id: 'baidu', label: 'Baidu', url: 'https://www.baidu.com/s', parameter: 'wd' },
  { id: 'duckduckgo', label: 'DuckDuckGo', url: 'https://duckduckgo.com/', parameter: 'q' },
  { id: 'brave', label: 'Brave Search', url: 'https://search.brave.com/search', parameter: 'q' },
  { id: 'startpage', label: 'Startpage', url: 'https://www.startpage.com/sp/search', parameter: 'query' },
  { id: 'yahoo', label: 'Yahoo', url: 'https://search.yahoo.com/search', parameter: 'p' },
  { id: 'yandex', label: 'Yandex', url: 'https://yandex.com/search/', parameter: 'text' },
] as const;
export type SearchEngine = typeof SEARCH_ENGINES[number]['id'];
export const isSearchEngine = (value: unknown): value is SearchEngine => SEARCH_ENGINES.some(engine => engine.id === value);
/** Brand names stay as-is; only the generic and localized names are translated. */
export function searchEngineLabel(engine: typeof SEARCH_ENGINES[number]): string {
  return engine.id === 'browser' ? t('search.browser') : engine.id === 'baidu' ? t('search.baidu') : engine.label;
}

export function searchUrl(query: string, engine: SearchEngine): string {
  if (engine === 'browser') throw new LocalizedError('search.browserNeedsApi');
  const provider = SEARCH_ENGINES.find(p => p.id === engine);
  if (!provider || !('url' in provider)) throw new LocalizedError('search.invalidEngine');
  return `${provider.url}?${provider.parameter}=${encodeURIComponent(query)}`;
}
