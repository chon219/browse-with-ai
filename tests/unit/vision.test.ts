import { modelResponse } from '../fixtures/model-response';
import { modelInput } from '../fixtures/model-input';
import { describe, expect, it, vi } from 'vitest';
import { createExtensionAgent } from '../../src/agent/extension-agent';
import { chat, probeVision } from '../../src/agent/model';
import { attachFiles, getTask, saveTask } from '../../src/storage/db';
import { LocalizedError } from '../../src/i18n';
import { fakeFileSystem } from '../fixtures/fake-file-system';
import type { Task } from '../../src/shared/types';

const config = { baseUrl: 'https://model.example/v1', model: 'mock', apiKey: 'key', remember: false, search: 'bing' as const };
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const task = (): Task => ({ id: crypto.randomUUID(), goal: '看看这张截图里的报错', status: 'running', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), resultText: '', elapsedMs: 0 });
const reply = (message: object) => modelResponse({ choices: [{ message }] });
type Body = { messages: { role: string; content: string | { type: string; text?: string; image_url?: { url: string } }[] }[] };

/** A model that views the image `view`, if given, then finishes; every request body is kept. */
function model(view?: string) {
  const bodies: Body[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    const body = JSON.parse(init.body) as Body; bodies.push(body);
    const system = body.messages[0].content as string;
    if (!system.includes('BWAI_DECIDE')) return reply({ content: '好的' });
    const decisions = bodies.filter(b => (b.messages[0].content as string).includes('BWAI_DECIDE')).length;
    const fn = view && decisions === 1 ? { name: 'workspace', arguments: JSON.stringify({ action: { name: 'view_image', path: view } }) }
      : { name: 'finish_task', arguments: JSON.stringify({ outcome: 'success', answer: '已查看', verification: '看到了图片' }) };
    return reply({ content: null, tool_calls: [{ id: 'c' + decisions, type: 'function', function: fn }] });
  }));
  return bodies;
}
const phase = (body: Body) => (body.messages[0].content as string).match(/BWAI_[A-Z]+/)?.[0];
const images = (body: Body) => { const content = body.messages[1].content; return Array.isArray(content) ? content.filter(part => part.type === 'image_url').map(part => part.image_url!.url) : []; };
const input = modelInput;

async function taskWithImage() {
  fakeFileSystem(vi.stubGlobal); const t = task(); await saveTask(t);
  const attachments = await attachFiles(t.id, [{ name: 'error.png', bytes: PNG }, { name: 'log.txt', bytes: new TextEncoder().encode('log') }]);
  const { appendMessage } = await import('../../src/storage/db');
  await appendMessage(t.id, { id: 'initial', turn: 0, role: 'user', kind: 'message', content: t.goal, attachments });
  return t;
}

describe('image input', () => {
  it('shows images attached in this turn with every request when the model accepts images', async () => {
    const t = await taskWithImage(); const bodies = model();
    const loadImage = vi.fn(async (path: string) => `data:image/png;base64,${btoa(path)}`);
    const graph = createExtensionAgent({ task: t, config: { ...config, visionInput: true }, signal: new AbortController().signal, elapsed: () => 10, browser: vi.fn(), loadImage });
    await graph.invoke({ messages: [], goal: t.goal, history: [], rounds: 0 }, { configurable: { thread_id: t.id } });
    for (const name of ['BWAI_DECIDE']) {
      const body = bodies.find(b => phase(b) === name)!;
      expect(images(body), name).toEqual([`data:image/png;base64,${btoa('uploads/error.png')}`]);
      expect(input(body).images, name).toEqual(['uploads/error.png']);
    }
    // Loaded once and reused; the text file is not an image.
    expect(loadImage).toHaveBeenCalledTimes(1);
    // The naming request does not need images.
    expect(images(bodies.find(b => phase(b) === 'BWAI_TITLE')!)).toEqual([]);
    const usage = (await getTask(t.id))!.usage!;
    expect(usage.estimated).toBe(true); expect(usage.contextTokens).toBeGreaterThan(1000);
  });
  it('shows an image the agent asked to view with the next request only', async () => {
    fakeFileSystem(vi.stubGlobal); const t = task(); await saveTask(t);
    const { workspaceWriteBytes } = await import('../../src/storage/db');
    await workspaceWriteBytes(t.id, 'shots/page.png', PNG);
    const bodies = model('shots/page.png');
    const graph = createExtensionAgent({ task: t, config: { ...config, visionInput: true }, signal: new AbortController().signal, elapsed: () => 10, browser: vi.fn(), loadImage: async path => `data:${path}` });
    await graph.invoke({ messages: [], goal: t.goal, history: [], rounds: 0 }, { configurable: { thread_id: t.id } });
    const decisions = bodies.filter(b => phase(b) === 'BWAI_DECIDE');
    expect(decisions.map(images)).toEqual([[], ['data:shots/page.png']]);
    expect(bodies.some(b => phase(b) === 'BWAI_RESULT')).toBe(false);
  });
  it('sends no images and refuses view_image when the model does not accept images', async () => {
    const t = await taskWithImage(); const bodies = model('uploads/error.png');
    const graph = createExtensionAgent({ task: t, config, signal: new AbortController().signal, elapsed: () => 10, browser: vi.fn(), loadImage: async () => 'data:x' });
    await graph.invoke({ messages: [], goal: t.goal, history: [], rounds: 0 }, { configurable: { thread_id: t.id } });
    expect(bodies.every(body => images(body).length === 0)).toBe(true);
    const second = input(bodies.filter(b => phase(b) === 'BWAI_DECIDE')[1]);
    expect(second.observations[0].error).toBe('Image input is not turned on in the model settings');
    // The model still sees what was attached.
    expect(second.conversation[0].attachments).toEqual([{ path: 'uploads/error.png', size: PNG.byteLength, type: 'image/png' }, { path: 'uploads/log.txt', size: 3, type: 'text/plain' }]);
  });
});

describe('detecting image input', () => {
  const probe = { dataUrl: 'data:image/png;base64,AAAA', answer: '47' };
  it('accepts a model that reads the number and rejects one that guesses or refuses images', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(reply({ content: '47' })).mockResolvedValueOnce(reply({ content: 'I cannot see images.' })).mockResolvedValueOnce(new Response('', { status: 400 })));
    expect(await probeVision(config, new AbortController().signal, probe)).toBe(true);
    expect(await probeVision(config, new AbortController().signal, probe)).toBe(false);
    expect(await probeVision(config, new AbortController().signal, probe)).toBe(false);
    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
    expect(body.messages[0].content[1]).toEqual({ type: 'image_url', image_url: { url: probe.dataUrl } });
  });
  it('explains a rejected request with images instead of a bare HTTP error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 400 })));
    const withImage = chat(config, [{ role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image_url', image_url: { url: 'data:x' } }] }], new AbortController().signal);
    await expect(withImage).rejects.toSatisfy((error: unknown) => error instanceof LocalizedError && error.text.key === 'model.imagesRejected');
    const withoutImage = chat(config, [{ role: 'user', content: 'hi' }], new AbortController().signal);
    await expect(withoutImage).rejects.toSatisfy((error: unknown) => error instanceof LocalizedError && error.text.key === 'model.httpFailed');
  });
});
