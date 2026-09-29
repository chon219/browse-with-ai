import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/style.css';
import { initLocale, t } from '../i18n';
import { useLocale } from './use-locale';
import { readBytes } from '../storage/workspace';
import { textContent } from '../shared/workspace';
import { printDocument } from './print-document';

/** Shows a workspace Markdown or HTML file as it will print, and opens Chrome's print dialog to save it as PDF. */
function PrintPage() {
  const params = new URLSearchParams(location.search);
  const taskId = params.get('task') ?? ''; const path = params.get('path') ?? '';
  const name = path.split('/').pop() ?? '';
  useLocale(() => `${name} · ${t('print.title')}`);
  const [html, setHtml] = useState<string>(); const [failed, setFailed] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null); const printed = useRef(false);
  useEffect(() => {
    readBytes(taskId, path).then(bytes => {
      const text = textContent(bytes);
      if (text === undefined) throw new Error('not text');
      return printDocument(path, text, file => readBytes(taskId, file));
    }).then(setHtml, () => setFailed(true));
  }, [taskId, path]);
  const print = () => frame.current?.contentWindow?.print();
  return <main className="print-view">
    <header className="card print-bar">
      <div><h1>{name}</h1><p className="hint">{t('print.hint')}</p></div>
      <button disabled={!html} onClick={print}>{t('app.printPdf')}</button>
    </header>
    {failed ? <p role="alert" className="card">{t('print.loadFailed', { path })}</p>
      : html && <iframe ref={frame} className="print-frame" title={name} sandbox="allow-same-origin allow-modals" srcDoc={html}
        onLoad={() => { if (!printed.current) { printed.current = true; print(); } }}/>}
  </main>;
}
void initLocale().then(() => createRoot(document.getElementById('root')!).render(<PrintPage/>));
