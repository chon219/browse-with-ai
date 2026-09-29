import { useEffect, useRef } from 'react';
import { getLocale, t } from '../../i18n';
import type { Task } from '../../shared/types';
import { taskStatusLabel } from '../helpers';
import { DeleteIcon } from './icons';

/** Today's conversations show the time; older ones the date. */
function when(iso: string) {
  const date = new Date(iso);
  return date.toDateString() === new Date().toDateString()
    ? date.toLocaleTimeString(getLocale(), { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString(getLocale());
}

interface ListProps { tasks: Task[]; selected: string; busy: boolean; onSelect: (task: Task) => void; onDelete: (task: Task) => void }
export function ConversationList({ tasks, selected, busy, onSelect, onDelete }: ListProps) {
  return <section className="history">
    <div className="section-title"><h2>{t('app.history')}</h2><span className="count">{tasks.length}</span></div>
    {tasks.map(item => <div key={item.id} className="history-row">
      <button className={`history-item ${selected === item.id ? 'selected' : ''}`} aria-current={selected === item.id || undefined} onClick={() => onSelect(item)}>
        <span title={item.goal}>{item.title ?? item.goal}</span>
        <small><i className={`status-dot ${item.status}`} aria-hidden="true"/>{taskStatusLabel(item)} · {when(item.createdAt)}</small>
      </button>
      <button className="quiet icon delete-conversation" aria-label={t('app.deleteConversation')} title={t('app.deleteConversation')} disabled={busy} onClick={() => onDelete(item)}><DeleteIcon/></button>
    </div>)}
  </section>;
}

interface DialogProps { task?: Task; busy: boolean; error: string; onCancel: () => void; onConfirm: () => void }
/** Modal confirmation for deleting a conversation; open while `task` is set. */
export function DeleteDialog({ task, busy, error, onCancel, onConfirm }: DialogProps) {
  const dialog = useRef<HTMLDialogElement>(null); const cancel = useRef<HTMLButtonElement>(null);
  // Cancel is the safe default; focus it explicitly rather than relying on autofocus in a reused dialog.
  useEffect(() => { if (task) { if (!dialog.current?.open) dialog.current?.showModal(); cancel.current?.focus(); } else dialog.current?.close(); }, [task]);
  return <dialog ref={dialog} className="delete-dialog" aria-labelledby="delete-title" aria-describedby="delete-description" onCancel={event => { event.preventDefault(); if (!busy) onCancel(); }}>
    <h2 id="delete-title">{t('app.deleteTitle')}</h2>
    <p className="delete-goal" title={task?.goal}>{task?.title ?? task?.goal}</p>
    <p id="delete-description">{t('app.deleteDescription')}</p>
    {error && <p role="alert">{error}</p>}
    <div className="buttons">
      <button ref={cancel} className="secondary" disabled={busy} onClick={onCancel}>{t('common.cancel')}</button>
      <button className="danger" disabled={busy} onClick={onConfirm}>{busy ? t('app.deleting') : t('app.delete')}</button>
    </div>
  </dialog>;
}
