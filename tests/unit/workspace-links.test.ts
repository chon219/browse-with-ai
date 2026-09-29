import { describe, expect, it } from 'vitest';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { remarkWorkspaceLinks, workspaceHref, workspaceLinkResolver } from '../../src/ui/workspace-links';
import { formatTaskResult } from '../../src/agent/results';

describe('workspace links', () => {
  it('resolves relative, encoded and inline-code filenames within the available files', () => {
    const path = 'reports/季度 报告(终稿).xlsx';
    const resolve = workspaceLinkResolver([path, 'exports/100%增长.csv', 'literal%20name.txt']);
    expect(resolve(path)).toBe(path);
    expect(resolve(`./${path}`)).toBe(path);
    expect(resolve('季度 报告(终稿).xlsx')).toBe(path);
    expect(resolve(workspaceHref(path))).toBe(path);
    expect(resolve(encodeURI(path))).toBe(path);
    expect(resolve(workspaceHref('exports/100%增长.csv'))).toBe('exports/100%增长.csv');
    expect(resolve('literal%20name.txt')).toBe('literal%20name.txt');
  });
  it('does not guess ambiguous basenames, missing files, absolute URLs or traversal paths', () => {
    const resolve = workspaceLinkResolver(['a/report.csv', 'b/report.csv']);
    expect(resolve('a/report.csv')).toBe('a/report.csv');
    for (const value of ['report.csv', 'missing.csv', '../a/report.csv', '%2e%2e/a/report.csv', '/a/report.csv', 'workspace:/a/report.csv', 'file:///a/report.csv', 'https://example.com/a/report.csv', 'javascript:alert(1)', 'sandbox:/mnt/data/a/report.csv', 'C:\\a\\report.csv']) {
      expect(resolve(value), value).toBeUndefined();
    }
    expect(workspaceLinkResolver([])('a/report.csv')).toBeUndefined();
  });
  it('links inline code but leaves fenced code, existing links and unknown filenames alone', () => {
    const tree = fromMarkdown('`report.csv`\n\n```text\nreport.csv\n```\n\n[`report.csv`](https://example.com/)\n\n`missing.csv`');
    remarkWorkspaceLinks(workspaceLinkResolver(['report.csv']))()(tree);
    expect(tree.children[0]).toMatchObject({ type: 'paragraph', children: [{ type: 'link', url: 'workspace:report.csv', children: [{ type: 'inlineCode', value: 'report.csv' }] }] });
    expect(tree.children[1]).toMatchObject({ type: 'code', value: 'report.csv' });
    expect(tree.children[2]).toMatchObject({ children: [{ type: 'link', url: 'https://example.com/', children: [{ type: 'inlineCode' }] }] });
    expect(tree.children[3]).toMatchObject({ children: [{ type: 'inlineCode', value: 'missing.csv' }] });
    expect(formatTaskResult('[报告](reports/report.csv)')).toBe('[报告](reports/report.csv)');
  });
});
