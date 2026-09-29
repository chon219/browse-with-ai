import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { getTask } from '../storage/db';
import type { Task } from '../shared/types';
import { initLocale, t } from '../i18n';
import { useConversation } from './use-conversation';
import { useLocale } from './use-locale';
import { ConversationList, DeleteDialog } from './components/ConversationList';
import { TaskView } from './components/TaskView';
import { NewConversation } from './components/NewConversation';
import { HistoryIcon, NewIcon, SettingsIcon } from './components/icons';
import { SettingsForm } from './components/SettingsForm';
import { SkillLibrary } from './components/SkillLibrary';
import './styles/style.css';
import './styles/markdown.css';
import './styles/task.css';

const isRunner = location.pathname === '/task.html';
function App() {
  useLocale(() => t('app.title'));
  const {
    tasks, task, selected, selectConversation, deleting, setDeleting,
    skillId, setSkillId,
    goal, setGoal, instruction, setInstruction, draftFiles, messageFiles, access, notice, setNotice, busy,
    guard, guarded, newConversation: resetConversation, createTask, deleteConversation, control, sendMessage, decideApproval,
    openRunner, exportConversation, pickDraftFiles, pickMessageFiles, removeDraftFile, removeMessageFile, pickCurrentPage, enableAccess,
  } = useConversation(isRunner);
  const goalInput = useRef<HTMLTextAreaElement>(null);
  function newConversation() {
    resetConversation();
    requestAnimationFrame(() => goalInput.current?.focus());
  }
  // The side panel is narrow: the conversation list opens over the conversation instead of above it.
  const [historyOpen, setHistoryOpen] = useState(false);
  const [compact, setCompact] = useState(() => !isRunner || matchMedia('(max-width: 800px)').matches);
  const [skillsHost, setSkillsHost] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!isRunner) return;
    const media = matchMedia('(max-width: 800px)');
    const resize = () => { setCompact(media.matches); setHistoryOpen(false); };
    media.addEventListener('change', resize);
    return () => media.removeEventListener('change', resize);
  }, []);
  // The side panel shows settings in place of the conversation; mounted once opened, so a draft survives going back.
  const [settingsOpen, setSettingsOpen] = useState(false); const [settingsMounted, setSettingsMounted] = useState(false);
  const drawer = useRef<HTMLElement>(null); const historyToggle = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!historyOpen) return;
    drawer.current?.querySelector<HTMLElement>('.history-item')?.focus();
    // Escape in an open dialog closes only the dialog.
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape' && !document.querySelector('dialog[open]')) setHistoryOpen(false); };
    window.addEventListener('keydown', close);
    return () => {
      window.removeEventListener('keydown', close);
      // Focus left in the closed drawer returns to its toggle; focus moved elsewhere (a message box) stays there.
      const active = document.activeElement;
      if (compact && (!active || active === document.body || drawer.current?.contains(active))) historyToggle.current?.focus();
    };
  }, [historyOpen, compact]);
  const openSettings = isRunner ? () => void guard(() => chrome.runtime.openOptionsPage())
    : () => { setHistoryOpen(false); setSettingsMounted(true); setSettingsOpen(open => !open); };
  function renderTask(task: Task) {
    return <TaskView key={task.id} task={task} busy={busy} isRunner={isRunner}
      instruction={instruction} onInstruction={setInstruction} onSend={guarded(() => sendMessage(task))}
      onOpenRunner={guarded(() => openRunner(task.id))}
      onStart={guarded(() => control(task, 'start'))} onPause={guarded(() => control(task, 'pause'))} onCancel={guarded(() => control(task, 'cancel'))}
      onExport={() => exportConversation(task)}
      onApproval={decision => void guard(() => decideApproval(task, decision))}
      onOpenSettings={openSettings}
      files={messageFiles} onAddFiles={files => void pickMessageFiles(files)} onRemoveFile={removeMessageFile}
      onViewPage={tabId => void guard(() => chrome.tabs.update(tabId, { active: true }))}/>;
  }
  const list = <ConversationList tasks={tasks} selected={selected} busy={busy}
    onSelect={item => { selectConversation(item); setHistoryOpen(false); setSettingsOpen(false); }} onDelete={item => { setNotice(''); setDeleting(item); }}/>;
  const newButton = <button className="quiet icon new-conversation-button" aria-label={t('app.newConversation')} title={t('app.newConversation')} onClick={() => { setHistoryOpen(false); setSettingsOpen(false); newConversation(); }}>
    <NewIcon/><span className="new-conversation-label">{t('app.newConversation')}</span>
  </button>;
  return <div className={`app ${isRunner ? 'runner' : 'panel'}${compact ? ' compact' : ''}`}>
    <header>
      <button type="button" className="brand" title={t('app.newConversation')} onClick={newConversation}><img className="mark" src="icons/bwai.svg" width="40" height="40" alt=""/><span>BWAI<small>Browse With AI</small></span></button>
      {/* The same actions on both pages; the task page lists conversations beside the conversation, so it hides the list toggle. */}
      <div className="header-actions">
        <button ref={historyToggle} className={`quiet icon history-toggle ${historyOpen ? 'active' : ''}`} aria-label={t('app.history')} title={t('app.history')} aria-expanded={historyOpen} aria-controls="history-drawer" onClick={() => setHistoryOpen(open => !open)}>
          <HistoryIcon/><span className="count">{tasks.length}</span>
        </button>
        {compact && <div className="skill-nav-host" ref={setSkillsHost}/>}
        {compact && newButton}
        <button className={`quiet icon ${settingsOpen ? 'active' : ''}`} aria-label={t('common.settings')} title={t('common.settings')} aria-pressed={settingsOpen} onClick={openSettings}><SettingsIcon/></button>
      </div>
    </header>
    {notice && <div className="notice" role="alert">{notice}<button className="quiet" onClick={() => setNotice('')}>{t('common.close')}</button></div>}
    <main>
      {/* One conversation list: a column on the task page, a drawer over the conversation in the side panel. */}
      {compact && historyOpen && <div className="drawer-backdrop" onClick={() => setHistoryOpen(false)}/>}
      <aside ref={drawer} id="history-drawer" className="conversations" aria-label={t('app.navLabel')} hidden={compact && !historyOpen}>
        {!compact && newButton}
        {!compact && <div className="skill-nav-host" ref={setSkillsHost}/>}
        {list}
      </aside>
      {settingsMounted && <SettingsForm embedded={{ visible: settingsOpen, onClose: () => setSettingsOpen(false) }}/>}
      <article aria-label={t('app.workspaceLabel')} hidden={settingsOpen}>
        {task ? renderTask(task) : <NewConversation skillId={skillId} onSkill={setSkillId} goal={goal} onGoal={setGoal} goalInput={goalInput} busy={busy}
          authorized={access.authorized} onEnableAccess={guarded(enableAccess)} onCreate={guarded(createTask)}
          tabs={access.availableTabs} contextTabId={access.contextTabId} onContextTab={access.setContextTabId}
          files={draftFiles} onAddFiles={files => void pickDraftFiles(files)} onRemoveFile={removeDraftFile}
          onRefreshTabs={() => void access.refreshTabs()} onUseCurrentPage={isRunner ? undefined : guarded(pickCurrentPage)}/>}
      </article>
    </main>
    <SkillLibrary navigation={{ container: skillsHost, onOpen: () => setHistoryOpen(false) }}/>
    <DeleteDialog task={deleting} busy={busy} error={notice} onCancel={() => setDeleting(undefined)} onConfirm={guarded(deleteConversation)}/>
  </div>;
}

async function boot() {
  await initLocale();
  if (isRunner) {
    const { installRunner, recoverStaleTasks, startTask } = await import('../agent/runner'); installRunner(); await recoverStaleTasks();
    const id = new URLSearchParams(location.search).get('task');
    if (id && (await getTask(id))?.status === 'ready') void startTask(id);
  }
  createRoot(document.getElementById('root')!).render(<App/>);
}
void boot();
