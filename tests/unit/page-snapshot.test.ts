import { describe, expect, it } from 'vitest';
import { composeSnapshot, type ObservedFrame } from '../../src/background/page-snapshot';

const frame = (): ObservedFrame => ({ frameId: 0, documentId: 'doc-a',
  snapshot: { url: 'https://page.example/', title: 'Page', text: '', snapshotId: 's1', elements: [{ id: 'e1', kind: 'button', text: 'Details' }] },
  metadata: { framePath: [], tree: [
    { id: 'root', role: 'main', inView: true },
    { id: 'card', parent: 'root', inView: true },
    { id: 'name', parent: 'card', role: 'text', text: 'Product Alpha 99', inView: true },
    { id: 'button', parent: 'card', role: 'button', text: 'Details', elementId: 'e1', inView: true },
  ] },
});

describe('semantic DOM model snapshots', () => {
  it('keeps card relationships and ties action IDs to the original document', () => {
    const result = composeSnapshot([frame()], '{}');
    expect(result.fullText).toBe('main\n  group\n    text: Product Alpha 99\n    [e1] button: Details');
    expect(result.targets.elements.e1).toMatchObject({ frameId: 0, documentId: 'doc-a', localId: 'e1', snapshotId: 's1' });
    expect(result.evidenceText).toBe('Product Alpha 99\nDetails');
    expect(result.evidenceText).not.toContain('group');
    expect(result.evidenceText).not.toContain('[e1]');
  });

  it('inserts nested frame contents at their host and prefixes action IDs', () => {
    const root = frame();
    root.metadata.tree.push({ id: 'host', parent: 'root', role: 'iframe', frameIndex: 0, inView: true });
    const child = frame(); child.frameId = 7; child.documentId = 'doc-child'; child.metadata.framePath = [0];
    child.metadata.tree.push({ id: 'host', parent: 'root', role: 'iframe', frameIndex: 2, inView: true });
    const nested = frame(); nested.frameId = 12; nested.metadata.framePath = [0, 2];
    const result = composeSnapshot([nested, root, child], '{}');
    expect(result.fullText).toContain('[f7-e1] button: Details');
    expect(result.fullText).toContain('[f12-e1] button: Details');
    expect(result.targets.elements['f7-e1'].documentId).toBe('doc-child');
  });

  it('excludes frames without a captured host', () => {
    const orphan = frame(); orphan.frameId = 3; orphan.metadata.framePath = [9];
    orphan.metadata.tree[2].text = 'PRIVATE';
    const result = composeSnapshot([frame(), orphan], '{}');
    expect(result.fullText).not.toContain('PRIVATE');
    expect(result.targets.elements['f3-e1']).toBeUndefined();
  });

  it('retains full evidence and the viewport tail beyond the model excerpt', () => {
    const f = frame(); f.metadata.tree[2].text = 'x'.repeat(30000) + 'BOTTOM';
    const result = composeSnapshot([f], '{}');
    expect(result.snapshot.text.length).toBe(14000);
    expect(result.fullText).toContain('BOTTOM');
    expect(result.snapshot.viewText).toContain('BOTTOM');
    expect(result.snapshot.textChars).toBeGreaterThan(30000);
  });

  it('only exposes controls that are bound into the tree', () => {
    const f = frame(); f.metadata.tree = [];
    expect(composeSnapshot([f], '{}').snapshot.elements).toEqual([]);
  });
  it('renders heading labels on one line and keeps table columns together', () => {
    const f = frame();
    f.metadata.tree = [
      { id: 'h', role: 'heading level=3', inView: true },
      { id: 'ht', parent: 'h', role: 'text', text: 'Battery', inView: true },
      { id: 'r', role: 'row', inView: true },
      { id: 'c1', parent: 'r', role: 'cell', inView: true },
      { id: 't1', parent: 'c1', text: 'Phone A', inView: true },
      { id: 'c2', parent: 'r', role: 'cell', inView: true },
      { id: 't2', parent: 'c2', text: '27 hours', inView: true },
    ];
    expect(composeSnapshot([f], '{}').evidenceText).toBe('\n### Battery\n| Phone A | 27 hours |');
  });
});
