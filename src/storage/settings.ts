import type { ModelConfig, ModelSettings } from '../shared/types';
import { endpoint, initialSettings } from '../shared/settings';
import { isSearchEngine } from '../shared/search-engines';
import { normalizeWebPolicy, validateWebPolicy, type WebPolicy } from '../shared/web-policy';
import { normalizeTokenLimit, validateTokenLimit } from '../shared/budget';
import { LocalizedError } from '../i18n';

/** Keep chrome.storage.local (which may hold the API key) out of content scripts. Call once from the service worker. */
export async function restrictStorageAccess() {
  await chrome.storage.local.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' });
}
export async function loadConfig(): Promise<ModelConfig> {
  const local = await chrome.storage.local.get(['settings', 'apiKey']);
  const session = await chrome.storage.session.get('apiKey');
  const { executionLimits: _legacy, ...stored } = (local.settings ?? {}) as ModelSettings & { executionLimits?: unknown };
  const settings = { ...initialSettings, ...stored };
  return { ...settings, tokenLimit: normalizeTokenLimit(settings.tokenLimit), webPolicy: normalizeWebPolicy(settings.webPolicy), search: isSearchEngine(settings.search) ? settings.search : 'browser', apiKey: (session.apiKey ?? local.apiKey ?? '') as string };
}
export async function loadWebPolicy(): Promise<WebPolicy> {
  const local = await chrome.storage.local.get('settings');
  return normalizeWebPolicy((local.settings as ModelSettings | undefined)?.webPolicy);
}
/** Whether tabs the agent opened are closed when its task finishes or the conversation is deleted. Off by default. */
export async function closesAgentTabs(): Promise<boolean> {
  const local = await chrome.storage.local.get('settings');
  return (local.settings as ModelSettings | undefined)?.closeAgentTabs === true;
}
export async function storeConfig(config: ModelConfig) {
  endpoint(config.baseUrl);
  if (!isSearchEngine(config.search)) throw new LocalizedError('search.invalidEngine');
  const { apiKey, ...settings } = config;
  await chrome.storage.local.set({ settings: { ...settings, tokenLimit: validateTokenLimit(config.tokenLimit), webPolicy: validateWebPolicy(config.webPolicy ?? {}) } });
  if (config.remember) { await chrome.storage.local.set({ apiKey }); await chrome.storage.session.remove('apiKey'); }
  else { await chrome.storage.session.set({ apiKey }); await chrome.storage.local.remove('apiKey'); }
}
