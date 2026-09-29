import { useEffect, useState } from 'react';
import { endpoint, initialSettings } from '../../shared/settings';
import { loadConfig, storeConfig } from '../../storage/settings';
import { probeVision, testConnection } from '../../agent/model';
import { visionProbe } from '../vision-probe';
import { SEARCH_ENGINES, searchEngineLabel, type SearchEngine } from '../../shared/search-engines';
import type { ModelConfig } from '../../shared/types';
import { normalizeWebPolicy, PAGE_SCHEMES, validateWebPolicy, type WebPolicy } from '../../shared/web-policy';
import { TOKEN_LIMIT, normalizeTokenLimit } from '../../shared/budget';
import '../styles/settings-page.css';
import { loadLanguage, LOCALES, LocalizedError, storeLanguage, t, type LanguageSetting, type MessageKey } from '../../i18n';
import { readDebug, clearDebug } from '../../storage/debug';
import { downloadBlob } from '../helpers';

type PolicyToggle = 'allowLocalAddresses' | 'allowPrivateAddresses' | 'allowEmbeddedCredentials' | 'blockDownloadPaths';
const POLICY_TOGGLES: [PolicyToggle, MessageKey][] = [
  ['allowLocalAddresses', 'settings.allowLocal'],
  ['allowPrivateAddresses', 'settings.allowPrivate'],
  ['allowEmbeddedCredentials', 'settings.allowCredentials'],
  ['blockDownloadPaths', 'settings.blockDownloads'],
];
const errorMessage = (e: unknown, fallback: MessageKey) => e instanceof Error ? e.message : t(fallback);
const splitList = (value: string) => value.split(/[,，\s]+/).map(item => item.trim()).filter(Boolean);
const withTokenLimit = (config: ModelConfig, text: string): ModelConfig => config.tokenLimit === undefined ? config : {
  ...config, tokenLimit: Math.max(TOKEN_LIMIT.min, Math.min(TOKEN_LIMIT.max, Math.round(Number(text) * 1000) || TOKEN_LIMIT.min)),
};
/** The form in a canonical shape, so equal settings compare equal whatever their key order or defaults. */
function formState(config: ModelConfig, parameterText: string, extensionText: string) {
  const policy = normalizeWebPolicy(config.webPolicy);
  return JSON.stringify([config.baseUrl, config.model, config.apiKey, config.remember, config.search, config.closeAgentTabs === true, config.visionInput === true, config.debug !== false,
    normalizeTokenLimit(config.tokenLimit), { ...policy, allowedSchemes: [...policy.allowedSchemes].sort() }, splitList(parameterText), splitList(extensionText)]);
}

interface Props {
  /** Shown inside the side panel: a back button replaces the page header. */
  embedded?: { visible: boolean; onClose: () => void };
}
/**
 * The settings form, as its own page and inside the side panel. The side panel keeps it mounted while
 * it is hidden, so unsaved changes survive going back; it reloads when shown again without changes.
 */
export function SettingsForm({ embedded }: Props) {
  const [language, setLanguage] = useState<LanguageSetting>('auto');
  const [config, setConfig] = useState<ModelConfig>({ ...initialSettings, apiKey: '' });
  const [loaded, setLoaded] = useState(false); const [busy, setBusy] = useState(false); const [notice, setNotice] = useState<{ text: string; error?: boolean }>();
  const [tokenText, setTokenText] = useState('500');
  const [parameterText, setParameterText] = useState(''); const [extensionText, setExtensionText] = useState('');
  // The form as last loaded or saved, to tell whether there are unsaved changes.
  const [saved, setSaved] = useState<{ config: ModelConfig; parameterText: string; extensionText: string }>();
  const dirty = !!saved && formState(withTokenLimit(config, tokenText), parameterText, extensionText) !== formState(saved.config, saved.parameterText, saved.extensionText);
  const modelChanged = !!saved && (['baseUrl', 'model', 'apiKey'] as const).some(key => config[key] !== saved.config[key]);
  // Testing the connection is the main action until a model is configured, and whenever its settings change.
  const testFirst = !saved?.config.model || !saved.config.apiKey || modelChanged;
  const policy = normalizeWebPolicy(config.webPolicy);
  const update = (patch: Partial<ModelConfig>) => setConfig(current => ({ ...current, ...patch }));
  const updatePolicy = (patch: Partial<WebPolicy>) => setConfig(current => ({ ...current, webPolicy: { ...normalizeWebPolicy(current.webPolicy), ...patch } }));
  const fail = (e: unknown, fallback: MessageKey) => setNotice({ text: errorMessage(e, fallback), error: true });
  useEffect(() => { void loadLanguage().then(setLanguage); }, []);
  function load() {
    void loadConfig().then(value => {
      setConfig(value); setTokenText(String((value.tokenLimit ?? 500_000) / 1000));
      const next = normalizeWebPolicy(value.webPolicy);
      setParameterText(next.blockedQueryParameters.join(', ')); setExtensionText(next.blockedFileExtensions.join(', '));
      setSaved({ config: value, parameterText: next.blockedQueryParameters.join(', '), extensionText: next.blockedFileExtensions.join(', ') });
      setLoaded(true);
    }, e => fail(e, 'settings.loadFailed'));
  }
  useEffect(load, []);
  // Settings may have changed elsewhere while the form was hidden; keep unsaved edits, though.
  const visible = embedded?.visible;
  useEffect(() => { if (visible && saved && !dirty) { load(); void loadLanguage().then(setLanguage); } }, [visible]);
  /** Language applies immediately, independent of saving the other settings. */
  function changeLanguage(next: LanguageSetting) {
    setLanguage(next);
    void storeLanguage(next).catch(e => fail(e, 'settings.saveFailed'));
  }
  async function save(test: boolean) {
    if (busy || !loaded) return;
    setBusy(true); setNotice(undefined);
    try {
      const api = endpoint(config.baseUrl);
      const granted = await chrome.permissions.request({ origins: [new URL(api).origin + '/*'] });
      if (!granted) throw new LocalizedError('settings.apiPermissionDenied');
      const next = { ...withTokenLimit(config, tokenText), webPolicy: validateWebPolicy({ ...policy, blockedQueryParameters: splitList(parameterText), blockedFileExtensions: splitList(extensionText) }) };
      await storeConfig(next); setConfig(next); setTokenText(String((next.tokenLimit ?? 500_000) / 1000)); setSaved({ config: next, parameterText, extensionText });
      if (test) {
        await testConnection(next, AbortSignal.timeout(90_000));
        // The test also decides whether the model reads images; the checkbox can still be changed afterwards.
        const tested = { ...next, visionInput: await probeVision(next, AbortSignal.timeout(90_000), visionProbe()) };
        await storeConfig(tested); setConfig(tested); setSaved({ config: tested, parameterText, extensionText });
        setNotice({ text: t(tested.visionInput ? 'settings.connectedVision' : 'settings.connectedNoVision') });
      }
      else setNotice({ text: t('settings.saved') });
    } catch (e) { fail(e, 'settings.saveFailed'); }
    finally { setBusy(false); }
  }
  async function debugLogs(clear = false) {
    setBusy(true); setNotice(undefined);
    try {
      if (clear) { await clearDebug(); setNotice({ text: t('settings.debugCleared') }); return; }
      const entries = await readDebug();
      const content = JSON.stringify({ format: 'bwai-debug-v1', exportedAt: new Date().toISOString(), version: chrome.runtime.getManifest().version, entries }, null, 2);
      downloadBlob(new Blob([content], { type: 'application/json' }), `bwai-debug-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    } catch (error) { fail(error, 'settings.debugFailed'); }
    finally { setBusy(false); }
  }
  return <div className={embedded ? 'settings-page embedded' : 'app settings-page'} hidden={embedded && !embedded.visible} data-testid="settings">
    {embedded ? <div className="settings-header">
      <button className="quiet" onClick={embedded.onClose}>← {t('common.back')}</button><h1>{t('settings.title')}</h1>
    </div> : <header><a className="brand" href="task.html"><span className="mark">b</span><span>BWAI<small>Browse With AI</small></span></a><h1>{t('settings.title')}</h1></header>}
    <form onSubmit={event => { event.preventDefault(); void save(false); }}>
      <fieldset disabled={!loaded || busy}>
        <section className="card"><h2>{t('settings.model')}</h2>
          <label>{t('settings.apiBaseUrl')}<input value={config.baseUrl} placeholder={t('settings.apiBaseUrlPlaceholder')} onChange={e => update({ baseUrl: e.target.value })}/></label>
          <label>{t('settings.modelName')}<input value={config.model} onChange={e => update({ model: e.target.value })}/></label>
          <label>{t('settings.apiKey')}<input type="password" autoComplete="off" value={config.apiKey} onChange={e => update({ apiKey: e.target.value })}/></label>
          <label className="check"><input type="checkbox" checked={config.remember} onChange={e => update({ remember: e.target.checked })}/>{t('settings.remember')}</label>
          <label className="check"><input type="checkbox" checked={config.visionInput === true} onChange={e => update({ visionInput: e.target.checked })}/>{t('settings.visionInput')}</label>
          <p className="hint">{t('settings.visionInputHint')}</p>
        </section>
        <section className="card"><h2>{t('settings.interface')}</h2>
          <label htmlFor="language">{t('settings.language')}</label>
          <select id="language" value={language} onChange={e => changeLanguage(e.target.value as LanguageSetting)}>
            <option value="auto">{t('settings.languageAuto')}</option>
            {LOCALES.map(locale => <option key={locale.id} value={locale.id} lang={locale.id}>{locale.label}</option>)}
          </select>
          <p className="hint">{t('settings.languageInstant')}</p>
        </section>
        <section className="card"><h2>{t('settings.search')}</h2>
          <label htmlFor="search-engine">{t('settings.searchEngine')}</label>
          <select id="search-engine" value={config.search} onChange={e => update({ search: e.target.value as SearchEngine })}>
            {SEARCH_ENGINES.map(engine => <option key={engine.id} value={engine.id}>{searchEngineLabel(engine)}</option>)}
          </select>
        </section>
        <section className="card"><h2>{t('settings.tabs')}</h2>
          <label className="check"><input type="checkbox" checked={config.closeAgentTabs === true} onChange={e => update({ closeAgentTabs: e.target.checked })}/>{t('settings.closeAgentTabs')}</label>
          <p className="hint">{t('settings.closeAgentTabsHint')}</p>
        </section>
        <section className="card"><h2>{t('settings.execution')}</h2>
          <label className="check"><input type="checkbox" checked={config.tokenLimit !== undefined}
            onChange={event => update({ tokenLimit: event.target.checked ? Math.max(TOKEN_LIMIT.min, Math.min(TOKEN_LIMIT.max, Number(tokenText) * 1000 || 500_000)) : undefined })}/>{t('settings.limitTokens')}</label>
          {config.tokenLimit !== undefined && <label>{t('settings.tokenLimit')}
            <input type="number" min={TOKEN_LIMIT.min / 1000} max={TOKEN_LIMIT.max / 1000} step={1} value={tokenText}
              onChange={event => setTokenText(event.target.value)} onBlur={() => {
                const next = withTokenLimit(config, tokenText); setConfig(next); setTokenText(String(next.tokenLimit! / 1000));
              }}/>
          </label>}
          <p className="hint">{t('settings.executionHint')}</p>
        </section>
        <section className="card"><h2>{t('settings.debug')}</h2>
          <label className="check"><input type="checkbox" checked={config.debug !== false} onChange={e => update({ debug: e.target.checked })}/>{t('settings.debugEnabled')}</label>
          <p className="hint">{t('settings.debugHint')}</p>
          <div className="buttons">
            <button type="button" className="secondary" onClick={() => void debugLogs()}>{t('settings.debugExport')}</button>
            <button type="button" className="quiet" onClick={() => void debugLogs(true)}>{t('settings.debugClear')}</button>
          </div>
        </section>
        <section className="card"><h2>{t('settings.webAccess')}</h2>
          <fieldset className="scheme-options"><legend>{t('settings.allowedSchemes')}</legend>
            {PAGE_SCHEMES.map(scheme => <label className="check" key={scheme}>
              <input type="checkbox" checked={policy.allowedSchemes.includes(scheme)}
                onChange={e => updatePolicy({ allowedSchemes: e.target.checked ? [...policy.allowedSchemes, scheme] : policy.allowedSchemes.filter(value => value !== scheme) })}/>
              {scheme === 'file' ? 'file' : scheme.toUpperCase()}
            </label>)}
          </fieldset>
          {POLICY_TOGGLES.map(([key, label]) => <label className="check" key={key}>
            <input type="checkbox" checked={policy[key]} onChange={e => updatePolicy({ [key]: e.target.checked })}/>{t(label)}
          </label>)}
          <label>{t('settings.blockedParams')}<textarea rows={3} value={parameterText} onChange={e => setParameterText(e.target.value)}/></label>
          <label>{t('settings.blockedExtensions')}<input value={extensionText} onChange={e => setExtensionText(e.target.value)}/></label>
        </section>
        <div className="save-bar">
          {notice && <div className={`notice save-feedback${notice.error ? ' error' : ''}`} role={notice.error ? 'alert' : 'status'}>{notice.text}<button type="button" className="quiet" onClick={() => setNotice(undefined)}>{t('common.close')}</button></div>}
          <span className={`save-state ${dirty ? 'dirty' : ''}`}>{t(dirty ? 'settings.unsaved' : 'settings.allSaved')}</span>
          <div className="buttons">
            <button type="submit" className={testFirst ? 'secondary' : undefined}>{t('settings.save')}</button>
            <button type="button" className={testFirst ? undefined : 'secondary'} onClick={() => void save(true)}>{t('settings.saveAndTest')}</button>
          </div>
        </div>
      </fieldset>
    </form>
  </div>;
}
