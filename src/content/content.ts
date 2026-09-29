import { accessibleLabel, createDOMCapture } from './dom-snapshot';
import type { PageMetadata } from '../shared/page';
import { normalizeWebPolicy, validatePageUrl } from '../shared/web-policy';
import type { Snapshot, ElementRef, BrowserAction } from '../shared/types';
import { declaresEffect } from '../shared/policy';
import { errorText, isLocale, LocalizedError, msg, setLocale, type Text } from '../i18n';

declare global { interface Window { __bwaiInstalled?: boolean } }
if (!window.__bwaiInstalled) {
  window.__bwaiInstalled = true;
  let snapshotId = '', snapshotUrl = '', snapshotPolicy = '';
  let metadata: PageMetadata;
  const captureDOM = createDOMCapture();
  let activePolicy = normalizeWebPolicy();
  let refs = new Map<string, { node: HTMLElement; ref: ElementRef; fingerprint: string }>();
  type Field = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
  const isField = (node: Element): node is Field => node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement || node instanceof HTMLSelectElement;
  const formOf = (node: HTMLElement) => isField(node) || node instanceof HTMLButtonElement ? node.form : node.closest('form');
  // Native getters avoid controls named "action", "method" or "elements" shadowing form properties.
  const formValue = (form: HTMLFormElement, key: 'action' | 'method' | 'elements') => Object.getOwnPropertyDescriptor(HTMLFormElement.prototype, key)!.get!.call(form);
  const fields = (form: HTMLFormElement) => [...formValue(form, 'elements') as HTMLFormControlsCollection].filter(isField);
  const visible = (node: HTMLElement) => !!(node.offsetWidth || node.offsetHeight || node.getClientRects().length)
    && (!node.checkVisibility || node.checkVisibility({ opacityProperty: true, visibilityProperty: true }));
  const label = (node: HTMLElement) => (accessibleLabel(node) || node.getAttribute('placeholder') || node.getAttribute('name') || node.innerText || node.getAttribute('title') || node.localName).trim();
  const shownValue = (node: Field): Text => node instanceof HTMLInputElement && ['checkbox', 'radio'].includes(node.type)
    ? msg(node.checked ? 'page.checked' : 'page.unchecked')
    : node instanceof HTMLSelectElement ? [...node.selectedOptions].map(option => option.label).join(', ') : node.value.slice(0, 2000);
  function formPreview(node: HTMLElement, action: BrowserAction, current: ElementRef) {
    const form = formOf(node);
    const visibleFields = form ? fields(form).filter(visible) : [];
    let fieldsTruncated = visibleFields.length > 20;
    const preview = visibleFields.slice(0, 20).map(field => {
      const text = label(field);
      if (text.length > 180 || field.value.length > 2000) fieldsTruncated = true;
      return { node: field, label: text.slice(0, 180), value: shownValue(field) };
    });
    const proposedValue = 'value' in action ? action.value
      : action.name === 'check' ? msg(action.checked ? 'page.checked' : 'page.unchecked') : undefined;
    const entries = proposedValue === undefined ? preview : preview.filter(field => field.node !== node);
    const result = entries.map(({ label, value }) => ({ label, value }));
    if (proposedValue !== undefined) result.push({ label: current.text, value: proposedValue });
    return { fields: result, fieldsTruncated };
  }
  function describe(node: HTMLElement, id: string): ElementRef | undefined {
    if (!visible(node)) return;
    const fullLabel = label(node), text = fullLabel.slice(0, 180);
    const fullValue = isField(node) ? node.value : node.isContentEditable ? node.innerText : undefined;
    const form = formOf(node);
    const state = { textChars: fullLabel.length, ...(fullValue === undefined ? {} : { valueChars: fullValue.length }), ...(node instanceof HTMLSelectElement ? { optionCount: node.options.length } : {}), disabled: 'disabled' in node ? !!node.disabled : node.getAttribute('aria-disabled') === 'true',
      tag: node.localName, ...(node instanceof HTMLButtonElement || node instanceof HTMLInputElement ? { inputType: node.type } : {}),
      ...(form ? { form: { action: String(formValue(form, 'action')), method: String(formValue(form, 'method')) } } : {}),
      ...(node.hasAttribute('aria-expanded') ? { expanded: node.getAttribute('aria-expanded') === 'true' } : {}),
      ...(node.getAttribute('role') ? { role: node.getAttribute('role')! } : {}) };
    if (node instanceof HTMLInputElement && ['checkbox', 'radio'].includes(node.type)) return { id, kind: node.type as 'checkbox' | 'radio', text, checked: node.checked, ...state };
    if (node instanceof HTMLSelectElement) return { id, kind: 'select', text, value: node.value,
      options: [...node.options].slice(0, 60).map(option => ({ label: option.label, value: option.value, disabled: option.disabled })), ...state };
    if (node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement && !['hidden', 'file', 'submit', 'button', 'image', 'reset'].includes(node.type)) {
      return { id, kind: 'input', text, inputType: node.type, value: node.value.slice(0, 2000), readOnly: node.readOnly, ...state };
    }
    if (node.isContentEditable) return { id, kind: 'input', text, inputType: 'contenteditable', value: node.innerText.slice(0, 2000), ...state };
    if (node instanceof HTMLInputElement && ['hidden', 'file'].includes(node.type)) return;
    if (node instanceof HTMLAnchorElement) {
      try { return { id, kind: 'link', text, href: validatePageUrl(node.href, activePolicy), ...state }; } catch { return; }
    }
    return { id, kind: 'button', text, ...state };
  }
  // Guard identity and form state, not the meaning of a button or URL.
  const fingerprint = (node: HTMLElement, ref: ElementRef) => {
    const form = formOf(node);
    return JSON.stringify([node.tagName, node.getAttribute('type'), node.getAttribute('name'), node.getAttribute('formaction'), ref, label(node), isField(node) ? node.value : node.isContentEditable ? node.innerText : null,
      node instanceof HTMLSelectElement ? [...node.options].map(option => [option.label, option.value, option.disabled]) : null,
      form && [formValue(form, 'action'), formValue(form, 'method'), fields(form).map(field => [field.name, field.value, field instanceof HTMLInputElement ? field.checked : null])]]);
  };
  const settle = (maxMs: number, quietMs: number) => new Promise<void>(resolve => {
    let quiet: ReturnType<typeof setTimeout>;
    const done = () => { observer.disconnect(); clearTimeout(quiet); clearTimeout(cap); resolve(); };
    const observer = new MutationObserver(() => { clearTimeout(quiet); quiet = setTimeout(done, quietMs); });
    observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    const cap = setTimeout(done, maxMs); quiet = setTimeout(done, quietMs);
  });
  function snapshot(elementOffset = 0): Snapshot {
    validatePageUrl(location.href, activePolicy);
    const capture = captureDOM(activePolicy, describe, elementOffset);
    refs = new Map(); snapshotId = [...crypto.getRandomValues(new Uint8Array(16))].map(byte => byte.toString(16).padStart(2, '0')).join(''); snapshotUrl = location.href;
    snapshotPolicy = JSON.stringify(activePolicy);
    for (const { node, ref } of capture.controls) refs.set(ref.id, { node, ref, fingerprint: fingerprint(node, ref) });
    metadata = capture.metadata;
    const height = document.documentElement.scrollHeight;
    return { url: location.href, title: document.title, text: '', snapshotId, elementCount: capture.elementCount, elementOffset, ...(elementOffset + capture.controls.length < capture.elementCount ? { nextElementOffset: elementOffset + capture.controls.length } : {}), elements: [...refs.values()].map(value => value.ref),
      scroll: { top: Math.round(scrollY), height, atBottom: scrollY + innerHeight >= height - 4 } };
  }
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id || message.type !== 'pageTool') return;
    activePolicy = normalizeWebPolicy(message.policy);
    if (isLocale(message.locale)) setLocale(message.locale);
    const action = message.action as BrowserAction;
    void (async () => {
      if (action.name === 'read') return { snapshot: snapshot(action.elementOffset) };
      if (action.name === 'scroll') { window.scrollBy({ top: (action.direction === 'down' ? 1 : -1) * innerHeight * 0.8, behavior: 'instant' }); await settle(600, 150); return { refresh: true }; }
      if (!('elementId' in action)) throw new LocalizedError('page.unsupportedTool');
      if (snapshotUrl !== location.href || snapshotId !== action.snapshotId || snapshotPolicy !== JSON.stringify(activePolicy)) throw new LocalizedError('page.snapshotStale');
      const entry = refs.get(action.elementId);
      if (!entry || !entry.node.isConnected) throw new LocalizedError('page.elementGone');
      const current = describe(entry.node, entry.ref.id);
      if (!current || fingerprint(entry.node, current) !== entry.fingerprint) throw new LocalizedError('page.snapshotStale');
      const node = entry.node;
      if (action.name === 'read_element') {
        const offset = action.offset ?? 0;
        if (action.part === 'options') {
          if (!(node instanceof HTMLSelectElement)) throw new LocalizedError('page.optionUnavailable');
          const end = Math.min(offset + 60, node.options.length);
          return { element: { elementId: action.elementId, snapshotId, part: action.part, offset, total: node.options.length,
            options: [...node.options].slice(offset, end).map(option => ({ label: option.label, value: option.value, disabled: option.disabled })), ...(end < node.options.length ? { nextOffset: end } : {}) } };
        }
        const value = action.part === 'label' ? label(node) : isField(node) ? node.value : node.isContentEditable ? node.innerText : '';
        const end = offset + 12000;
        return { element: { elementId: action.elementId, snapshotId, part: action.part, offset, total: value.length, content: value.slice(offset, end), ...(end < value.length ? { nextOffset: end } : {}) } };
      }
      if (current.disabled) throw new LocalizedError('page.buttonDisabled');
      let apply: () => void;
      if (action.name === 'fill' || action.name === 'select') {
        if (action.name === 'select' && (!(node instanceof HTMLSelectElement) || ![...node.options].some(option => option.value === action.value && !option.disabled))) throw new LocalizedError('page.optionUnavailable');
        if (action.name === 'fill' && (current.kind !== 'input' || current.readOnly)) throw new LocalizedError('page.notFillable');
        apply = () => {
          if (node.isContentEditable) node.textContent = action.value;
          else if (isField(node)) Object.getOwnPropertyDescriptor(Object.getPrototypeOf(node), 'value')!.set!.call(node, action.value);
          node.dispatchEvent(new Event('input', { bubbles: true })); node.dispatchEvent(new Event('change', { bubbles: true }));
        };
      } else if (action.name === 'check') {
        if (!(node instanceof HTMLInputElement) || !['checkbox', 'radio'].includes(node.type)) throw new LocalizedError('page.notCheckable');
        if (node.type === 'radio' && !action.checked) throw new LocalizedError('page.cannotUncheckRadio');
        apply = () => { if (node.checked !== action.checked) node.click(); };
      } else if (action.name === 'click' || action.name === 'follow') {
        if (action.name === 'follow' && !current.href) throw new LocalizedError('page.notReadableLink');
        apply = () => node.click();
      } else throw new LocalizedError('page.unsupportedTool');
      // The executor enforces the model's declared effect, with no keyword or
      // form-shape classifier and no automatic submission cancellation/rollback.
      if (declaresEffect(action) && message.approved !== true) {
        return { confirmation: {
          description: msg('page.clickNeedsApproval', { label: current.text }),
          url: current.href ?? location.href,
          elementText: current.text,
          ...formPreview(node, action, current),
          ...(action.reason ? { reason: action.reason } : {}),
        } };
      }
      if (action.name === 'follow') return { navigate: current.href };
      setTimeout(apply, 0);
      return { settle: true };
    })().then(result => respond({ ...result, ...('snapshot' in result ? { metadata } : {}) }), error => respond({ error: errorText(error, 'page.actionFailed') }));
    return true;
  });
}
