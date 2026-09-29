import { useEffect, useState } from 'react';
import { getLocale, watchLocale } from '../i18n';

/** Re-render an extension page when the language setting changes. Call `initLocale()` before the first render. */
export function useLocale(title: () => string) {
  const [locale, setLocale] = useState(getLocale());
  useEffect(() => watchLocale(setLocale), []);
  useEffect(() => { document.documentElement.lang = locale; document.title = title(); }, [locale]);
  return locale;
}
