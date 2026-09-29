import 'fake-indexeddb/auto';
import { afterEach, vi } from 'vitest';
import { setLocale } from '../../src/i18n';
// Existing assertions use the Chinese catalog; i18n.test.ts covers other locales.
setLocale('zh-CN');
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); setLocale('zh-CN'); });
