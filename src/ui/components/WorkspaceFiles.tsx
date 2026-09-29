import { getLocale, t } from '../../i18n';
import type { Task } from '../../shared/types';
import { formatSize } from '../helpers';
import { pageAddress, pageResources, type ResourceFile } from '../page-resources';

const modified = (file: ResourceFile) => new Date(file.modifiedAt).toLocaleString(getLocale(), { dateStyle: 'short', timeStyle: 'short' });

export function WorkspaceFiles({ task, files, onPreview }: { task: Task; files: ResourceFile[]; onPreview: (file: ResourceFile) => void }) {
  const resources = pageResources(files, task.visitedUrls ?? [], [
    ...(task.contextTab ? [task.contextTab] : []), ...(task.lastPage ? [task.lastPage] : []), ...(task.visitedPages ?? []),
  ]);
  return <>
    <details className="files" data-testid="workspace-files">
      <summary>{t('app.files')} <span className="count">{resources.files.length}</span></summary>
      <p className="hint">{t(resources.files.length ? 'app.filesHint' : 'app.filesEmpty')}</p>
      {!!resources.files.length && <ul>{resources.files.map(file => <li key={file.path}>
        <button className="file-item" aria-label={t('app.previewFile', { path: file.path })} onClick={() => onPreview(file)}>
          <span className="file-path">{file.path}</span><small>{formatSize(file.size)} · {modified(file)}</small>
        </button>
      </li>)}</ul>}
    </details>
    {!!resources.pages.length && <details className="visited" data-testid="visited-pages">
      <summary>{t('app.visitedPages')} <span className="count">{resources.pages.length}</span></summary>
      <ul className="page-list">{resources.pages.map(page => <li className="page-resource" key={page.url}>
        <div className="page-heading">
          <a className="page-title" href={page.url} target="_blank" rel="noreferrer" title={page.title ? `${page.title}\n${page.url}` : page.url}>{page.title || page.url}</a>
          {!!page.files.length && <button type="button" className="secondary page-preview" aria-label={t('app.previewPage', { title: page.title || page.url })} onClick={() => onPreview(page.files[0])}>{t('app.previewMarkdown')}</button>}
        </div>
        <span className="page-address" title={page.url}>{pageAddress(page.url)}</span>
        {page.files.length ? <>
          {page.files.length > 1 && <details className="page-versions">
            <summary>{t('app.pageSnapshots', { count: page.files.length })}</summary>
            <ul>{page.files.map((file, index) => <li key={file.path}><button type="button" className="file-item" title={file.path} onClick={() => onPreview(file)}>
              <span>{t('app.previewSnapshot', { index: page.files.length - index, at: modified(file) })}</span><small>{formatSize(file.size)}</small>
            </button></li>)}</ul>
          </details>}
        </> : <span className="hint">{t('app.noPageSnapshot')}</span>}
      </li>)}</ul>
    </details>}
  </>;
}
