import type { PageNode, PageObservation } from '../shared/page';
import type { Snapshot } from '../shared/types';

export interface ObservedFrame extends PageObservation { frameId: number; documentId?: string }
interface PageTarget { frameId: number; documentId?: string; localId: string; snapshotId: string; url: string }
export interface PageTargets { snapshotId: string; url: string; policy: string; elements: Record<string, PageTarget> }
const publicId = (frame: ObservedFrame, id: string) => frame.frameId ? `f${frame.frameId}-${id}` : id;
const localTarget = (frame: ObservedFrame, id: string): PageTarget => ({ frameId: frame.frameId, documentId: frame.documentId, localId: id, snapshotId: frame.snapshot.snapshotId, url: frame.snapshot.url });
interface JoinedNode extends PageNode { key: string; parentKey?: string }

/** Reading evidence has no action IDs or layout wrappers. Headings and table
 * rows keep their contents together, so the agent need not parse DOM outlines. */
function readableEvidence(children: Map<string | undefined, JoinedNode[]>): string {
  const textOf = (root: JoinedNode) => {
    const parts: string[] = [];
    const pending = [root];
    while (pending.length) {
      const node = pending.pop()!;
      if (node.text) parts.push(node.text.replace(/\s+/g, ' ').trim());
      const nested = children.get(node.key) ?? [];
      for (let i = nested.length - 1; i >= 0; i--) pending.push(nested[i]);
    }
    return parts.join(' ');
  };
  const lines: string[] = [];
  const pending = [...children.get(undefined) ?? []].reverse();
  while (pending.length) {
    const node = pending.pop()!;
    const nested = children.get(node.key) ?? [];
    const heading = /^heading(?: level=(\d))?$/.exec(node.role ?? '');
    if (heading) { lines.push('\n' + '#'.repeat(Number(heading[1] ?? 2)) + ' ' + textOf(node)); continue; }
    if (node.role === 'row') {
      const cells: JoinedNode[] = [];
      const candidates = [...nested].reverse();
      while (candidates.length) {
        const item = candidates.pop()!;
        if (['cell', 'columnheader', 'rowheader'].includes(item.role ?? '')) cells.push(item);
        else candidates.push(...[...children.get(item.key) ?? []].reverse());
      }
      lines.push(cells.length ? '| ' + cells.map(textOf).map(text => text.replace(/\|/g, '\\|')).join(' | ') + ' |' : textOf(node));
      continue;
    }
    if (node.role === 'paragraph') { lines.push(textOf(node)); continue; }
    if (node.text) lines.push((node.role === 'listitem' ? '- ' : '') + node.text.replace(/\s+/g, ' ').trim());
    for (let i = nested.length - 1; i >= 0; i--) pending.push(nested[i]);
  }
  return lines.filter(line => line.trim()).join('\n');
}

/** Merge permitted frame trees at their actual iframe nodes before rendering.
 * Node IDs are internal; only selected, locally bound action IDs are exposed. */
export function composeSnapshot(frames: ObservedFrame[], policy: string, preferredFrame = 0) {
  const top = frames.find(frame => frame.frameId === 0);
  if (!top) throw new Error('Top frame observation missing');
  const targets: PageTargets = { snapshotId: top.snapshot.snapshotId, url: top.snapshot.url, policy, elements: {} };
  const snapshot: Snapshot = { ...top.snapshot, source: 'dom', text: '', elements: [] };
  const joined: JoinedNode[] = [];
  const pages: NonNullable<Snapshot['elementPages']> = [];
  let otherControls = 0;
  const included = new Map<string, { frame: ObservedFrame; onScreen: boolean }>();
  for (const frame of [...frames].sort((a, b) => a.metadata.framePath.length - b.metadata.framePath.length)) {
    const indices = frame.metadata.framePath;
    const parent = indices.length ? included.get(indices.slice(0, -1).join('.')) : undefined;
    const host = parent?.frame.metadata.tree.find(node => node.frameIndex === indices.at(-1));
    if (indices.length && (!parent || !host)) continue;
    const onScreen = !parent || (parent.onScreen && !!host?.inView);
    included.set(indices.join('.'), { frame, onScreen });
    const bound = new Set(frame.metadata.tree.flatMap(node => node.elementId ? [node.elementId] : []));
    let emitted = 0;
    for (const ref of frame.snapshot.elements) {
      if (!bound.has(ref.id) || snapshot.elements.length >= 200 || (!onScreen && frame.frameId !== preferredFrame) || (frame.frameId !== preferredFrame && otherControls >= 100)) continue;
      const id = publicId(frame, ref.id);
      snapshot.elements.push({ ...ref, id }); targets.elements[id] = localTarget(frame, ref.id);
      emitted++; if (frame.frameId !== preferredFrame) otherControls++;
    }
    const total = frame.snapshot.elementCount ?? frame.snapshot.elements.length;
    const offset = frame.snapshot.elementOffset ?? 0;
    pages.push({ frameId: frame.frameId, total, offset, ...(emitted < frame.snapshot.elements.length ? { nextOffset: offset } : frame.snapshot.nextElementOffset === undefined ? {} : { nextOffset: frame.snapshot.nextElementOffset }) });
    for (const node of frame.metadata.tree) joined.push({ ...node, key: `${frame.frameId}/${node.id}`,
      parentKey: node.parent ? `${frame.frameId}/${node.parent}` : parent && host ? `${parent.frame.frameId}/${host.id}` : undefined,
      elementId: node.elementId ? publicId(frame, node.elementId) : undefined, inView: node.inView && onScreen });
  }
  const byKey = new Map(joined.map(node => [node.key, node]));
  const children = new Map<string | undefined, JoinedNode[]>();
  for (const node of joined) {
    const list = children.get(node.parentKey) ?? [];
    list.push(node); children.set(node.parentKey, list);
  }
  const view = new Set<string>();
  for (const node of joined) if (node.inView) {
    for (let current: JoinedNode | undefined = node; current && !view.has(current.key); current = current.parentKey ? byKey.get(current.parentKey) : undefined) view.add(current.key);
  }
  const lines: string[] = [], viewLines: string[] = [];
  const stack = [...children.get(undefined) ?? []].reverse().map(node => ({ node, depth: 0 }));
  while (stack.length) {
    const { node, depth } = stack.pop()!;
    const descendants = children.get(node.key) ?? [];
    // Flatten empty single-child wrappers while keeping multi-child groups,
    // which preserve card/button associations even without semantic HTML.
    const keep = !!(node.role || node.text || node.elementId || node.frameIndex !== undefined || descendants.length > 1);
    if (keep) {
      const id = node.elementId && targets.elements[node.elementId] ? `[${node.elementId}] ` : '';
      const text = (node.text ?? '').replace(/\s+/g, ' ').trim();
      const line = `${'  '.repeat(Math.min(depth, 40))}${id}${node.role ?? 'group'}${text ? ': ' + text : ''}`;
      lines.push(line); if (view.has(node.key)) viewLines.push(line);
    }
    for (let i = descendants.length - 1; i >= 0; i--) stack.push({ node: descendants[i], depth: depth + Number(keep) });
  }
  const fullText = lines.join('\n');
  snapshot.text = fullText.slice(0, 14000);
  const viewText = viewLines.join('\n');
  snapshot.viewText = viewText.length <= 6000 ? viewText : viewText.slice(0, 3000) + '\n[Middle of viewport text omitted; read sourceFile for the full page.]\n' + viewText.slice(-3000);
  snapshot.textChars = fullText.length;
  snapshot.textTruncated = fullText.length > snapshot.text.length;
  snapshot.viewTextTruncated = viewText.length > 6000;
  snapshot.elementCount = pages.reduce((sum, page) => sum + page.total, 0);
  snapshot.elementPages = pages;
  return { snapshot, targets, fullText, evidenceText: readableEvidence(children) };
}
