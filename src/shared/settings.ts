import type { ModelSettings } from './types';
import { addressKind, normalizeWebPolicy } from './web-policy';
import { LocalizedError } from '../i18n';
export const initialSettings: ModelSettings = { baseUrl: 'https://api.openai.com/v1', model: '', remember: false, search: 'browser', webPolicy: normalizeWebPolicy(), closeAgentTabs: false, debug: true };
export function endpoint(baseUrl: string) {
  const url = new URL(baseUrl);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new LocalizedError('settings.invalidApiUrl');
  // Plain HTTP is fine for models on this machine or the local network; anything public needs HTTPS.
  if (url.protocol === 'http:' && addressKind(url.hostname) === 'public') throw new LocalizedError('settings.httpsRequired');
  return baseUrl.replace(/\/+$/, '') + '/chat/completions';
}
