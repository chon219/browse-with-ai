import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { SkillIcon } from './icons';
import { deleteSkill, listSkills, saveSkill } from '../../storage/skills';
import { getTask, recordUsage, taskOperations } from '../../storage/db';
import { loadConfig } from '../../storage/settings';
import { skillMarkdown, type Skill, type SkillDraft } from '../../shared/skills';
import type { Task } from '../../shared/types';
import { downloadBlob } from '../helpers';
import { LocalizedError, t } from '../../i18n';
import '../styles/skills.css';

interface Props {
  task?: Task; selected?: string; onSelect?: (id: string) => void;
  /** Move only the navigation trigger when the layout changes, keeping an open editor mounted. */
  navigation?: { container: HTMLElement | null; onOpen: () => void };
}
export function SkillLibrary({ task, selected = '', onSelect, navigation }: Props) {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<SkillDraft>();
  const [editing, setEditing] = useState<Skill>();
  const [source, setSource] = useState({ sourceTaskId: '', sourceTurn: 0 });
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [deleting, setDeleting] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const controller = useRef<AbortController | undefined>(undefined);
  const refresh = async () => setSkills(await listSkills());
  useEffect(() => { void refresh().catch(() => {}); return () => controller.current?.abort(); }, []);
  useEffect(() => { if (open) dialog.current?.showModal(); else dialog.current?.close(); }, [open]);
  function close() { controller.current?.abort(); setOpen(false); setBusy(false); setDraft(undefined); setEditing(undefined); setError(''); setDeleting(false); }
  const failure = (e: unknown) => setError(e instanceof Error ? e.message : t('skills.failed'));
  async function library() {
    setOpen(true); setDraft(undefined); setEditing(undefined); setError(''); setDeleting(false);
    try { await refresh(); } catch (e) { failure(e); }
  }
  async function extract() {
    if (!task) return;
    setOpen(true); setDraft(undefined); setEditing(undefined); setError(''); setBusy(true); setDeleting(false);
    const run = new AbortController(); controller.current?.abort(); controller.current = run;
    try {
      const [current, operations, config, module] = await Promise.all([getTask(task.id), taskOperations(task.id), loadConfig(), import('../../agent/skill-draft')]);
      run.signal.throwIfAborted();
      if (!current || current.turn !== task.turn) throw new LocalizedError('skills.completedOnly');
      const result = await module.draftSkill(current, operations, config, run.signal);
      if (result.usage) await recordUsage(current.id, result.usage, current.turn ?? 0);
      run.signal.throwIfAborted();
      setSource({ sourceTaskId: current.id, sourceTurn: current.turn ?? 0 });
      setDraft(result.draft);
    } catch (e) { if (!run.signal.aborted) failure(e); }
    finally { if (!run.signal.aborted) setBusy(false); }
  }
  async function save() {
    if (!draft) return;
    setBusy(true); setError('');
    try { await saveSkill(draft, source, editing); await refresh(); setDraft(undefined); setEditing(undefined); }
    catch (e) { failure(e); } finally { setBusy(false); }
  }
  async function remove() {
    if (!editing) return;
    setBusy(true); setError('');
    try { await deleteSkill(editing.id); if (selected === editing.id) onSelect?.(''); await refresh(); setDraft(undefined); setEditing(undefined); setDeleting(false); }
    catch (e) { failure(e); } finally { setBusy(false); }
  }
  function download() {
    if (!draft) return;
    downloadBlob(new Blob([skillMarkdown(draft)], { type: 'text/markdown;charset=utf-8' }), 'SKILL.md');
  }
  const chosen = skills.find(skill => skill.id === selected);
  const choose = (id: string) => { onSelect?.(id); close(); };
  const edit = (skill: Skill) => { setDraft({ name: skill.name, description: skill.description, instructions: skill.instructions }); setEditing(skill); setDeleting(false); setError(''); };
  const trigger = <div className={navigation ? 'skill-navigation' : onSelect ? 'skill-picker' : 'skill-controls'}>
    {onSelect ? <>
      <button type="button" className={`chip skill-chip${selected ? ' selected' : ''}`} aria-label={t('skills.choose')} aria-haspopup="dialog" title={chosen?.description ?? t('skills.choose')} onClick={() => void library()}><SkillIcon/><span>{chosen?.name ?? t(selected ? 'skills.missing' : 'skills.choose')}</span></button>
      {selected && <button type="button" className="quiet icon detach-page" aria-label={t('skills.none')} onClick={() => onSelect('')}>×</button>}
    </> : !task && <button type="button" className={navigation ? 'quiet icon skill-nav-button' : 'secondary'} aria-label={t('skills.library')} title={t('skills.library')} aria-haspopup="dialog" onClick={() => { navigation?.onOpen(); void library(); }}>
      {navigation && <SkillIcon/>}<span className="skill-nav-label">{t('skills.library')}</span>
    </button>}
    {task?.status === 'completed' && task.outcome === 'success' && <button type="button" className="secondary" onClick={() => void extract()}>{t('skills.extract')}</button>}
  </div>;
  return <>
    {navigation ? navigation.container && createPortal(trigger, navigation.container) : trigger}
    {createPortal(<dialog ref={dialog} className="skill-dialog" aria-label={t('skills.library')} onCancel={close} onClose={close}>
      <div className="skill-dialog-heading"><h2>{draft ? t('skills.edit') : t(onSelect ? 'skills.choose' : 'skills.library')}</h2><button type="button" className="quiet icon" aria-label={t('common.close')} onClick={close}>×</button></div>
      {busy && <p role="status">{t(draft ? 'skills.save' : 'skills.drafting')}</p>}
      {error && <p role="alert">{error}</p>}
      {draft ? <>
        <p className="hint">{t('skills.review')}</p>
        {editing && <p className="hint">{t('skills.source', { turn: editing.sourceTurn + 1, version: editing.version })}</p>}
        <label>{t('skills.name')}<input maxLength={80} disabled={busy} value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })}/></label>
        <label>{t('skills.description')}<textarea rows={2} maxLength={500} disabled={busy} value={draft.description} onChange={e => setDraft({ ...draft, description: e.target.value })}/></label>
        <label>{t('skills.instructions')}<textarea className="skill-body" rows={12} maxLength={12000} disabled={busy} value={draft.instructions} onChange={e => setDraft({ ...draft, instructions: e.target.value })}/></label>
        <div className="buttons">
          <button type="button" disabled={busy} onClick={() => void save()}>{t('skills.save')}</button>
          <button type="button" className="secondary" disabled={busy} onClick={download}>{t('skills.export')}</button>
          {editing && <button type="button" className="quiet" disabled={busy} onClick={() => setDeleting(true)}>{t('skills.delete')}</button>}
        </div>
        {deleting && <div><p>{t('skills.confirmDelete')}</p><div className="buttons"><button type="button" disabled={busy} onClick={() => void remove()}>{t('skills.deleteConfirm')}</button><button type="button" className="secondary" disabled={busy} onClick={() => setDeleting(false)}>{t('skills.cancel')}</button></div></div>}
      </> : !busy && <ul className="skill-list">
        {!skills.length && <li className="skill-empty"><SkillIcon/><p>{t('skills.empty')}</p></li>}
        {skills.map(skill => <li key={skill.id} className={`skill-option${selected === skill.id ? ' selected' : ''}`}>
          <button type="button" className="skill-option-main" onClick={() => onSelect ? choose(skill.id) : edit(skill)}>
            <span className="skill-option-title"><SkillIcon/><strong>{skill.name}</strong><small>v{skill.version}</small>{selected === skill.id && <span aria-hidden="true">✓</span>}</span>
            <span className="skill-option-description">{skill.description}</span>
          </button>
          {onSelect && <button type="button" className="quiet skill-edit" aria-label={`${t('skills.edit')} ${skill.name}`} onClick={() => edit(skill)}>{t('skills.edit')}</button>}
        </li>)}
      </ul>}
      <div className="buttons">{onSelect && selected && !draft && <button type="button" className="quiet" onClick={() => choose('')}>{t('skills.none')}</button>}<button type="button" className="secondary" onClick={close}>{t('skills.cancel')}</button></div>
    </dialog>, document.body)}
  </>;
}
