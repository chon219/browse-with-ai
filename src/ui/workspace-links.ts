import type { Root } from 'mdast';
import { workspacePath } from '../shared/workspace';

export const workspaceHref = (path: string) => `workspace:${path.split('/').map(encodeURIComponent).join('/')}`;

/** Resolve only existing files in this conversation. A basename is usable only when unambiguous. */
export function workspaceLinkResolver(paths: string[]) {
  const known = new Set(paths);
  const names = new Map<string, string | undefined>();
  for (const path of paths) {
    const name = path.split('/').at(-1)!;
    names.set(name, names.has(name) ? undefined : path);
  }
  const match = (value: string) => {
    if (/^(?:[a-z][\w+.-]*:|[/\\])/i.test(value)) return;
    const path = workspacePath(value)?.join('/');
    if (!path) return;
    return known.has(path) ? path : !path.includes('/') ? names.get(path) : undefined;
  };
  return (reference: string): string | undefined => {
    const encoded = reference.startsWith('workspace:');
    const value = encoded ? reference.slice('workspace:'.length) : reference;
    // Literal percent signs in an actual filename take precedence for ordinary references.
    if (!encoded) { const path = match(value); if (path) return path; }
    try { return match(decodeURIComponent(value)); } catch { return; }
  };
}

interface MarkdownNode { type: string; value?: string; url?: string; children?: MarkdownNode[] }

/** Link inline code filenames in older replies, without rewriting code blocks or nesting links. */
export function remarkWorkspaceLinks(resolve: (reference: string) => string | undefined) {
  return () => (tree: Root) => {
    const walk = (parent: MarkdownNode) => {
      if (['link', 'linkReference', 'code', 'html'].includes(parent.type)) return;
      parent.children?.forEach((node, index) => {
        const path = node.type === 'inlineCode' && node.value ? resolve(node.value) : undefined;
        if (path) parent.children![index] = { type: 'link', url: workspaceHref(path), children: [node] };
        else walk(node);
      });
    };
    walk(tree);
  };
}
