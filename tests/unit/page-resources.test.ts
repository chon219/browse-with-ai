import { describe, expect, it } from 'vitest';
import { archiveSource, pageResources, pageUrl, type ResourceFile } from '../../src/ui/page-resources';

const path = `pages/${'a'.repeat(32)}.md`;
const file = (path: string, title?: string, modifiedAt = '2026-01-01'): ResourceFile => ({
  path, size: 100, type: 'text/markdown', modifiedAt,
  ...(title === undefined ? {} : { page: { url: 'https://example.com/guide#part', title } }),
});

describe('page resources', () => {
  it('reads existing archive headers without interpreting arbitrary Markdown as a source', () => {
    expect(archiveSource(path, 'URL: https://example.com/guide#part\r\nTitle: 网页标题\r\n\r\n# 正文')).toEqual({ url: 'https://example.com/guide', title: '网页标题' });
    expect(archiveSource('notes.md', 'URL: https://example.com/\nTitle: 普通笔记\n')).toBeUndefined();
    expect(archiveSource(path, '# 普通 Markdown')).toBeUndefined();
    expect(archiveSource(path, 'URL: javascript:alert(1)\nTitle: 链接\n')).toBeUndefined();
    expect(archiveSource(path, 'URL: https://example.com/\nTitle: incomplete')).toBeUndefined();
  });

  it('groups versions by page while retaining query distinctions and ordinary files', () => {
    const old = file(path, '旧标题');
    const latest = file(`pages/${'b'.repeat(32)}.md`, '新标题', '2026-02-01');
    const note = file('notes.md');
    const invalid = file(`pages/${'c'.repeat(32)}.md`);
    const grouped = pageResources([old, note, latest, invalid], ['https://example.com/guide', 'https://example.com/guide#other', 'https://example.com/guide?q=2']);
    expect(grouped.files).toEqual([note, invalid]);
    expect(grouped.pages).toHaveLength(2);
    expect(grouped.pages[0]).toEqual({ url: 'https://example.com/guide', title: '新标题', files: [latest, old] });
    expect(grouped.pages[1].files).toEqual([]);
  });

  it('keeps titles without archives, falls back to archive titles, and excludes unsafe history links', () => {
    const grouped = pageResources([file(path, '历史快照标题')], ['https://example.com/guide', 'https://example.com/empty', 'javascript:alert(1)'], [
      { url: 'https://example.com/empty', title: '无快照页面' }, { url: 'https://example.com/guide', title: '' },
    ]);
    expect(grouped.pages.map(page => page.title)).toEqual(['历史快照标题', '无快照页面']);
    expect(pageUrl('file:///tmp/example.html')).toBe('file:///tmp/example.html');
    expect(pageUrl('data:text/html,test')).toBeUndefined();
  });
});
