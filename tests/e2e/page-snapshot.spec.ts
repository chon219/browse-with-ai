import { test, expect } from '@playwright/test';
import type { BrowserResult } from '../../src/shared/types';
import { harness } from './support/harness';
import { seedRunningTask, tool } from './support/tasks';

test('snapshots follow the viewport, skip hidden menus and report the scroll position', async () => {
  const h = await harness();
  try {
    const task = await seedRunningTask(h.page);
    const opened = (await tool(h.page, task.id, { name: 'open', url: 'https://shop-fixture.example/' })).result!;
    const texts = (result: BrowserResult) => result.snapshot!.elements.map(e => e.text);
    expect(opened.snapshot!.elements).toHaveLength(100);
    expect(texts(opened).every(text => text.startsWith('分类'))).toBe(true);
    expect(opened.snapshot!.text).not.toContain('隐藏菜单');
    expect(opened.snapshot!.scroll).toMatchObject({ top: 0, atBottom: false });
    let current = opened;
    for (let i = 0; i < 6 && !texts(current).includes('商品0'); i++) current = (await tool(h.page, task.id, { name: 'scroll', tabId: opened.tabId!, direction: 'down' })).result!;
    // Scrolling brings the products and the sort button into the snapshot, and the viewport text follows.
    expect(texts(current)).toEqual(expect.arrayContaining(['价格从低到高', '商品0', '商品5']));
    expect(current.snapshot!.scroll!.top).toBeGreaterThan(0);
    // Elements just below the viewport are listed before it reaches them; the viewport text follows the scroll position.
    // viewText is only added when the page text may not include what is on screen.
    const onScreen = () => current.snapshot!.viewText ?? current.snapshot!.text;
    for (let i = 0; i < 4 && !onScreen().includes('商品'); i++) current = (await tool(h.page, task.id, { name: 'scroll', tabId: opened.tabId!, direction: 'down' })).result!;
    expect(onScreen()).toContain('商品');
    for (let i = 0; i < 10 && !current.snapshot!.scroll!.atBottom; i++) current = (await tool(h.page, task.id, { name: 'scroll', tabId: opened.tabId!, direction: 'down' })).result!;
    expect(current.snapshot!.scroll!.atBottom).toBe(true);
    expect(current.snapshot!.viewText ?? current.snapshot!.text).toContain('页面底部');
    expect(h.errors).toEqual([]);
  } finally { await h.context.close(); }
});

test('element details and control pages expose tails without accepting stale snapshots', async () => {
  const h = await harness();
  try {
    await h.context.route('https://pagination-fixture.example/**', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><title>Pagination</title>
      <label>Long value<textarea>${'v'.repeat(15000)}VALUE_TAIL</textarea></label>
      <label>Choices<select>${Array.from({ length: 130 }, (_, i) => `<option value="${i}">Option ${i}</option>`).join('')}</select></label>
      <button aria-label="${'L'.repeat(200)}LABEL_TAIL">Label</button>
      ${Array.from({ length: 150 }, (_, i) => `<button>Control ${i}</button>`).join('')}` }));
    const task = await seedRunningTask(h.page);
    const first = (await tool(h.page, task.id, { name: 'open', url: 'https://pagination-fixture.example/' })).result!;
    const snapshot = first.snapshot!;
    const value = snapshot.elements.find(ref => ref.kind === 'input')!;
    const select = snapshot.elements.find(ref => ref.kind === 'select')!;
    const label = snapshot.elements.find(ref => (ref.textChars ?? 0) > 200)!;
    expect(value.valueChars).toBeGreaterThan(15000); expect(value.value).toHaveLength(2000);
    expect(select.optionCount).toBe(130); expect(select.options).toHaveLength(60);
    const read = (elementId: string, part: 'label' | 'value' | 'options', offset: number) => tool(h.page, task.id, { name: 'read_element', tabId: first.tabId!, snapshotId: snapshot.snapshotId, elementId, part, offset });
    expect((await read(value.id, 'value', 12000)).result?.element?.content).toContain('VALUE_TAIL');
    expect((await read(label.id, 'label', 180)).result?.element?.content).toContain('LABEL_TAIL');
    const options = (await read(select.id, 'options', 60)).result!.element!;
    expect(options.options![0].value).toBe('60'); expect(options.nextOffset).toBe(120);
    expect((await read(select.id, 'options', 120)).result!.element!.options!.at(-1)!.value).toBe('129');
    const more = snapshot.elementPages!.find(page => page.frameId === 0)!;
    expect(more.nextOffset).toBe(100);
    const second = (await tool(h.page, task.id, { name: 'read', tabId: first.tabId!, frameId: 0, elementOffset: more.nextOffset })).result!;
    expect(second.snapshot!.elements.some(ref => ref.text === 'Control 149')).toBe(true);
    expect((await read(value.id, 'value', 0)).result?.error).toBeTruthy();
    const source = h.context.pages().find(page => page.url().startsWith('https://pagination-fixture.example/'))!;
    const fresh = (await tool(h.page, task.id, { name: 'read', tabId: first.tabId! })).result!;
    const control = fresh.snapshot!.elements.find(ref => ref.kind === 'select')!;
    await source.evaluate(() => { document.querySelector('select')!.options[129].label = 'Changed tail'; });
    const stale = await tool(h.page, task.id, { name: 'read_element', tabId: first.tabId!, snapshotId: fresh.snapshot!.snapshotId, elementId: control.id, part: 'options', offset: 120 });
    expect(stale.result?.error).toBeTruthy();
  } finally { await h.context.close(); }
});

test('Native DOM is the page source, preserves full evidence and operates granted frame and shadow references', async () => {
  const h = await harness();
  try {
    expect(await h.page.evaluate(() => chrome.runtime.getManifest().permissions)).not.toContain('debugger');
    await h.context.serviceWorkers()[0].evaluate(() => {
      globalThis.WebSocket = class { constructor() { throw new Error('WebSockets disabled in Native DOM integration test'); } } as unknown as typeof WebSocket;
    });
    await h.context.route('https://dom-fixture.example/**', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><title>Native DOM integration</title>
      <h1>Catalog</h1><ul><li><h2>Product Alpha</h2><p>Price 99</p><button onclick="this.textContent='ALPHA_SELECTED'">Details</button></li>
      <li><h2>Product Beta</h2><p>Price 199</p><button>Details</button></li></ul>
      <label id="icon-label">Accessible icon</label><button aria-labelledby="icon-label"><svg width="20" height="20"></svg></button>
      <label>API key<input name="api_key" value="DO_NOT_EXPOSE_API_KEY"></label>
      <textarea name="access_token">DO_NOT_EXPOSE_TOKEN</textarea>
      <div contenteditable="true"><span>DO_NOT_EXPOSE_EDITABLE</span></div>
      <section id="shadow"></section><script>const root=document.querySelector('#shadow').attachShadow({mode:'open'});root.innerHTML='<button>Shadow details</button>';root.querySelector('button').onclick=function(){this.textContent='SHADOW_SELECTED'};</script>
      <section id="closed"></section><script>const closed=document.querySelector('#closed').attachShadow({mode:'closed'});closed.innerHTML='<button>Closed details</button>';closed.querySelector('button').onclick=function(){this.textContent='CLOSED_SELECTED'};</script>
      <section id="slots"><span>SLOTTED_ONCE</span><span slot="unused">UNSLOTTED_HIDDEN</span></section><script>document.querySelector('#slots').attachShadow({mode:'open'}).innerHTML='<slot></slot>';</script>
      <iframe src="https://dom-child.example/"></iframe>
      <iframe src="https://dom-denied.example/?token=DENIED_QUERY"></iframe>
      <iframe style="visibility:hidden" src="https://dom-hidden.example/"></iframe>
      ${Array.from({ length: 300 }, (_, i) => `<p>Paragraph ${i} ${'Long page text '.repeat(12)}</p>`).join('')}
      ${Array.from({ length: 3100 }, (_, i) => `<a href="#item-${i}">Item ${i}</a>`).join('')}
      <footer><p>BOTTOM_EVIDENCE_42</p><button>After 3000</button></footer>` }));
    await h.context.route('https://dom-child.example/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><button onclick="this.textContent=\'FRAME_SELECTED\'">Frame details</button>' }));
    await h.context.route('https://dom-denied.example/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><p>DENIED_FRAME_EVIDENCE</p>' }));
    await h.context.route('https://dom-hidden.example/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><p>HIDDEN_FRAME_EVIDENCE</p>' }));
    const task = await seedRunningTask(h.page);
    let result = (await tool(h.page, task.id, { name: 'open', url: 'https://dom-fixture.example/' })).result!;
    expect(result.error).toBeUndefined();
    expect(result.snapshot?.source).toBe('dom');
    expect(result.snapshot?.sourceFile).toMatch(/^pages\/.+\.md$/);
    expect(result.snapshot!.textChars).toBeGreaterThan(28000);
    const readEvidence = (path: string) => h.page.evaluate(async ({ taskId, path }) => {
      let folder = await (await navigator.storage.getDirectory()).getDirectoryHandle('tasks');
      folder = await folder.getDirectoryHandle(taskId);
      const parts = path.split('/'); for (const part of parts.slice(0, -1)) folder = await folder.getDirectoryHandle(part);
      return (await (await folder.getFileHandle(parts.at(-1)!)).getFile()).text();
    }, { taskId: task.id, path });
    const evidence = await readEvidence(result.snapshot!.sourceFile!);
    expect(evidence).toContain('# Catalog');
    expect(evidence).not.toContain('heading level=');
    expect(evidence).not.toContain('listitem');
    expect(evidence).not.toMatch(/\[e\d+\]/);
    expect(evidence).toContain('BOTTOM_EVIDENCE_42');
    expect(evidence).toContain('After 3000');
    expect(result.snapshot!.elements.find(ref => ref.inputType === 'contenteditable')?.value).toBe('DO_NOT_EXPOSE_EDITABLE');
    expect(evidence.match(/SLOTTED_ONCE/g)).toHaveLength(1);
    expect(evidence).not.toContain('UNSLOTTED_HIDDEN');
    expect(evidence).not.toContain('DENIED_FRAME_EVIDENCE');
    expect(evidence).not.toContain('DENIED_QUERY');
    expect(evidence).not.toContain('HIDDEN_FRAME_EVIDENCE');
    expect(JSON.stringify(result)).toContain('DO_NOT_EXPOSE_API_KEY');
    expect(result.snapshot!.elements.some(ref => ref.text === 'Accessible icon')).toBe(true);
    for (const [label, expected] of [['Details', 'ALPHA_SELECTED'], ['Shadow details', 'SHADOW_SELECTED'], ['Closed details', 'CLOSED_SELECTED'], ['Frame details', 'FRAME_SELECTED']]) {
      const ref = result.snapshot!.elements.find(ref => ref.text === label)!;
      expect(ref, label).toBeTruthy();
      result = (await tool(h.page, task.id, { name: 'click', tabId: result.tabId!, snapshotId: result.snapshot!.snapshotId, elementId: ref.id, effect: 'read' })).result!;
      expect(result.error).toBeUndefined();
      expect(result.snapshot!.text).toContain(expected);
    }
    const source = h.context.pages().find(page => page.url() === 'https://dom-fixture.example/')!;
    await source.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
    result = (await tool(h.page, task.id, { name: 'read', tabId: result.tabId! })).result!;
    expect(result.snapshot!.viewText).toContain('BOTTOM_EVIDENCE_42');
    expect(result.snapshot!.elements.some(ref => ref.text === 'After 3000')).toBe(true);
    expect(h.errors).toEqual([]);
  } finally { await h.context.close(); }
});

test('semantic DOM preserves table rows, clickable card contents and nested frame references', async () => {
  const h = await harness();
  try {
    await h.context.route('https://tree-fixture.example/**', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><title>Semantic tree</title>
      <table><thead><tr><th>Product</th><th>Price</th></tr></thead><tbody><tr><td>Alpha</td><td>99</td></tr><tr><td>Beta</td><td>199</td></tr></tbody></table>
      <a href="#card"><h2>Long card</h2><p>${'Description '.repeat(30)}</p><p>CARD_PRICE_456</p></a>
      <div style="display:none">HIDDEN_TEXT</div><div style="opacity:0">TRANSPARENT_TEXT</div>
      <iframe style="width:600px;height:400px" src="https://tree-child.example/"></iframe>` }));
    await h.context.route('https://tree-child.example/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><iframe src="https://tree-nested.example/"></iframe>' }));
    await h.context.route('https://tree-nested.example/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><button onclick="this.textContent=\'NESTED_SELECTED\'">Nested details</button>' }));
    const task = await seedRunningTask(h.page);
    let result = (await tool(h.page, task.id, { name: 'open', url: 'https://tree-fixture.example/' })).result!;
    expect(result.snapshot?.text).toContain('table');
    expect(result.snapshot!.text).toMatch(/row\n\s+cell\n\s+text: Alpha\n\s+cell\n\s+text: 99/);
    expect(result.snapshot!.text).toContain('CARD_PRICE_456');
    expect(result.snapshot!.text).not.toContain('HIDDEN_TEXT');
    expect(result.snapshot!.text).not.toContain('TRANSPARENT_TEXT');
    const target = result.snapshot!.elements.find(ref => ref.text === 'Nested details')!;
    expect(target).toBeTruthy();
    result = (await tool(h.page, task.id, { name: 'click', tabId: result.tabId!, snapshotId: result.snapshot!.snapshotId, elementId: target.id, effect: 'read' })).result!;
    expect(result.snapshot!.text).toContain('NESTED_SELECTED');
    expect(h.errors).toEqual([]);
  } finally { await h.context.close(); }
});

test('login forms and CAPTCHA widgets remain observable without rule-based handoff', async () => {
  const h = await harness();
  try {
    await h.context.route('https://auth-fixture.example/**', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><title>Catalog with sign-in</title>
      <h1>Public catalog</h1><p>Item price: 99</p>
      <form action="/login" method="post"><label>Password<input type="password" value="PRIVATE_PASSWORD"></label><button>Sign in</button></form>
      <div class="g-recaptcha">Verify you are human</div>
      <button type="button" onclick="this.textContent='LOGIN_PANEL_OPENED'">Log in</button>
      <button type="button" onclick="this.textContent='PUBLIC_DETAILS'">View public details</button>` }));
    const task = await seedRunningTask(h.page);
    let result = (await tool(h.page, task.id, { name: 'open', url: 'https://auth-fixture.example/' })).result!;
    expect(result.blocked).toBeUndefined();
    expect(result.snapshot?.text).toContain('Item price: 99');
    expect(result.snapshot?.text).toContain('Verify you are human');
    expect(JSON.stringify(result)).toContain('PRIVATE_PASSWORD');
    for (const [label, expected] of [['View public details', 'PUBLIC_DETAILS'], ['Log in', 'LOGIN_PANEL_OPENED']]) {
      const ref = result.snapshot!.elements.find(element => element.text === label)!;
      result = (await tool(h.page, task.id, { name: 'click', tabId: result.tabId!, snapshotId: result.snapshot!.snapshotId, elementId: ref.id, effect: 'read' })).result!;
      expect(result.blocked).toBeUndefined();
      expect(result.snapshot?.text).toContain(expected);
    }
    const submit = result.snapshot!.elements.find(element => element.text === 'Sign in')!;
    const submission = (await tool(h.page, task.id, { name: 'click', tabId: result.tabId!, snapshotId: result.snapshot!.snapshotId, elementId: submit.id, effect: 'write' })).result!;
    expect(submission.approval?.elementText).toBe('Sign in');
    expect(JSON.stringify(submission)).toContain('PRIVATE_PASSWORD');
    expect(h.errors).toEqual([]);
  } finally { await h.context.close(); }
});
