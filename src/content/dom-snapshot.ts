import { computeAccessibleName, getRole } from 'dom-accessibility-api';
import type { PageMetadata, PageNode } from '../shared/page';
import type { ElementRef } from '../shared/types';
import { validatePageUrl, type WebPolicy } from '../shared/web-policy';

export const accessibleLabel = (node: HTMLElement): string => computeAccessibleName(node);
const clean = (text: string) => text.replace(/\s+/g, ' ').trim();
const OMIT = new Set(['script', 'style', 'noscript', 'template', 'head']);
const ROLES: Record<string, string> = { p: 'paragraph', article: 'article', section: 'section', form: 'form',
  header: 'banner', footer: 'contentinfo', details: 'details', summary: 'button', figure: 'figure', figcaption: 'caption',
  table: 'table', thead: 'rowgroup', tbody: 'rowgroup', tfoot: 'rowgroup', tr: 'row', th: 'columnheader', td: 'cell',
  ul: 'list', ol: 'list', li: 'listitem', dl: 'list', dt: 'term', dd: 'definition', blockquote: 'blockquote' };
const ACTIONABLE = 'a[href],summary,button,input,textarea,select,[role="button"],[role="tab"],[role="checkbox"],[role="radio"],[role="switch"],[contenteditable]:not([contenteditable="false"])';
const STRUCTURED_CHILD = 'h1,h2,h3,h4,h5,h6,p,div,section,article,table,ul,ol,dl';
interface Rect { left: number; top: number; right: number; bottom: number }
const intersects = (a: Rect, b: Rect) => a.right > b.left && a.left < b.right && a.bottom > b.top && a.top < b.bottom;
const intersect = (a: Rect, b: Rect): Rect => ({ left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) });

function framePath(): number[] {
  const path: number[] = [];
  for (let frame: Window = window; frame !== frame.parent;) {
    const parent = frame.parent;
    let index = -1;
    for (let i = 0; i < parent.length; i++) if (parent[i] === frame) { index = i; break; }
    if (index < 0 || path.length >= 32) throw new Error('Could not determine the frame path');
    path.unshift(index); frame = parent;
  }
  return path;
}

/** Capture before cropping: no document-prefix limit can hide page-bottom data.
 * Traverse the composed tree (including distributed slots and author shadow
 * roots) while native nodes and action state remain in the isolated world. */
export function createDOMCapture() {
  const nodeIds = new WeakMap<Node, string>();
  const elementIds = new WeakMap<HTMLElement, string>();
  let nextNode = 0, nextElement = 0;
  const idFor = (node: Node) => {
    let id = nodeIds.get(node);
    if (!id) { id = `n${++nextNode}`; nodeIds.set(node, id); }
    return id;
  };
  return (policy: WebPolicy, describe: (node: HTMLElement, id: string) => ElementRef | undefined, elementOffset = 0) => {
    const tree: PageNode[] = [];
    const candidates: { node: HTMLElement; ref: ElementRef; entry: PageNode; rank: number; distance: number; order: number }[] = [];
    const visited = new WeakSet<Node>();
    const viewport: Rect = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
    const range = document.createRange();
    type Work = { node: Node; parent?: string; clip: Rect; textVisible: boolean };
    const stack: Work[] = [{ node: document.documentElement, clip: viewport, textVisible: true }];
    while (stack.length) {
      const { node, parent, clip, textVisible } = stack.pop()!;
      if (visited.has(node)) continue;
      visited.add(node);
      if (node.nodeType === Node.TEXT_NODE) {
        const text = clean(node.textContent ?? '');
        if (!text || !textVisible) continue;
        range.selectNodeContents(node);
        const rects = [...range.getClientRects()];
        if (!rects.some(rect => rect.width && rect.height)) continue;
        tree.push({ id: idFor(node), parent, role: 'text', text, inView: rects.some(rect => intersects(rect, clip)) });
        continue;
      }
      if (!(node instanceof Element) || OMIT.has(node.localName) || node.getAttribute('aria-hidden') === 'true' || node.hasAttribute('inert')) continue;
      const style = getComputedStyle(node);
      if (style.display === 'none' || Number(style.opacity) === 0) continue;
      const rect = node.getBoundingClientRect();
      const shown = style.visibility !== 'hidden' && style.visibility !== 'collapse' && (rect.width > 0 || rect.height > 0 || style.display === 'contents');
      const field = node.matches('input,textarea,select');
      if (node instanceof HTMLAnchorElement) {
        try { validatePageUrl(node.href, policy); } catch { continue; }
      }
      const inView = shown && intersects(rect, clip);
      const id = idFor(node);
      const role = getRole(node) ?? ROLES[node.localName];
      const entry: PageNode = { id, parent, role: role === 'generic' || role === 'none' || role === 'presentation' ? undefined : role, inView };
      if (/^h[1-6]$/.test(node.localName)) entry.role = `heading level=${node.localName[1]}`;
      let ref: ElementRef | undefined;
      if (node instanceof HTMLElement && shown) {
        if (node.matches(ACTIONABLE)) ref = describe(node, 'pending');
      }
      // Native field values are supplied by their descriptors.
      if (field && !ref) continue;
      if (ref && node instanceof HTMLElement) {
        entry.role = ref.kind; entry.text = clean(ref.text);
        const rank = inView ? 0 : rect.bottom <= 0 ? 2 : 1;
        candidates.push({ node, ref, entry, rank, distance: rank === 1 ? Math.max(0, rect.top - innerHeight) : rank === 2 ? -rect.bottom : 0, order: candidates.length });
      } else if (node instanceof HTMLImageElement) entry.text = clean(node.alt);
      else if (entry.role && (node.hasAttribute('aria-label') || node.hasAttribute('aria-labelledby'))) entry.text = clean(computeAccessibleName(node));
      if (node instanceof HTMLIFrameElement || node instanceof HTMLFrameElement) {
        for (let i = 0; i < window.length; i++) if (window[i] === node.contentWindow) { entry.frameIndex = i; break; }
        entry.role = 'iframe'; if (shown) tree.push(entry); continue;
      }
      if (shown) tree.push(entry);
      let children: Node[];
      if (field || (node instanceof HTMLElement && node.isContentEditable) || (ref && !node.querySelector(`${ACTIONABLE},${STRUCTURED_CHILD}`))) children = [];
      else if (node instanceof HTMLSlotElement) {
        const assigned = node.assignedNodes({ flatten: true });
        children = assigned.length ? assigned : [...node.childNodes];
      } else {
        const shadow = node instanceof HTMLElement ? chrome.dom?.openOrClosedShadowRoot(node) ?? node.shadowRoot : node.shadowRoot;
        children = [...(shadow ?? node).childNodes];
      }
      const childClip = intersect(clip, {
        left: /hidden|clip|auto|scroll/.test(style.overflowX) ? rect.left : clip.left,
        right: /hidden|clip|auto|scroll/.test(style.overflowX) ? rect.right : clip.right,
        top: /hidden|clip|auto|scroll/.test(style.overflowY) ? rect.top : clip.top,
        bottom: /hidden|clip|auto|scroll/.test(style.overflowY) ? rect.bottom : clip.bottom,
      });
      for (let i = children.length - 1; i >= 0; i--) stack.push({ node: children[i], parent: shown ? id : parent, clip: childClip, textVisible: shown });
    }
    const chosen = candidates.sort((a, b) => a.rank - b.rank || a.distance - b.distance || Number(a.node instanceof HTMLAnchorElement) - Number(b.node instanceof HTMLAnchorElement) || a.order - b.order)
      .slice(elementOffset, elementOffset + 100).sort((a, b) => a.order - b.order);
    const controls = chosen.map(candidate => {
      let id = elementIds.get(candidate.node);
      if (!id) { id = `e${++nextElement}`; elementIds.set(candidate.node, id); }
      candidate.entry.elementId = id;
      return { node: candidate.node, ref: { ...candidate.ref, id } };
    });
    return { metadata: { framePath: framePath(), tree } satisfies PageMetadata, controls, elementCount: candidates.length };
  };
}
