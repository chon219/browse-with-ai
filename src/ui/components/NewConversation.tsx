import React, { useRef, useState } from 'react';
import { submitOnEnter } from '../helpers';
import { t, type MessageKey } from '../../i18n';
import { PageIcon } from './icons';
import { AttachButton, FileChips } from './AttachFiles';
import { pastedFiles, type Attachment } from '../attachments';
import { MESSAGE_CHARS } from '../../shared/tuning';
import { SkillLibrary } from './SkillLibrary';

const SUGGESTIONS: [label: MessageKey, goal: MessageKey, context?: 'page' | 'files'][] = [
  ['app.suggestFind', 'app.suggestFindGoal'],
  ['app.suggestList', 'app.suggestListGoal', 'page'],
  ['app.suggestAnalyze', 'app.suggestAnalyzeGoal', 'files'],
  ['app.suggestReport', 'app.suggestReportGoal'],
  ['app.suggestOperate', 'app.suggestOperateGoal', 'page'],
];

interface Props {
  skillId: string; onSkill: (id: string) => void;
  goal: string; onGoal: (value: string) => void; goalInput: React.RefObject<HTMLTextAreaElement | null>;
  busy: boolean; authorized: boolean; onEnableAccess: () => void; onCreate: () => void;
  tabs: chrome.tabs.Tab[]; contextTabId: string; onContextTab: (tabId: string) => void; onRefreshTabs: () => void;
  /** Only where the current tab is a web page: in the task page it is the task page itself. */
  onUseCurrentPage?: () => void;
  files: Attachment[]; onAddFiles: (files: File[]) => void; onRemoveFile: (index: number) => void;
}
export function NewConversation(props: Props) {
  const { goal, busy, authorized } = props;
  const [picking, setPicking] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const create = () => { if (!busy && authorized && goal.trim()) props.onCreate(); };
  const suggest = (text: string, context?: 'page' | 'files') => {
    props.onGoal(text);
    const needsPage = context === 'page' && !props.contextTabId;
    setPicking(needsPage);
    if (needsPage) props.onRefreshTabs();
    props.goalInput.current?.focus();
    if (context === 'files' && !props.files.length) fileInput.current?.click();
  };
  const choose = (tabId: string) => { props.onContextTab(tabId); setPicking(false); };
  const togglePicker = () => { if (!picking) props.onRefreshTabs(); setPicking(!picking); };
  const attached = props.tabs.find(tab => String(tab.id) === props.contextTabId);
  let domain = '';
  try { if (attached?.url) domain = new URL(attached.url).host; } catch { /* The title still identifies tabs without a valid URL. */ }
  return <section className="card conversation-card draft-thread" data-testid="new-thread">
    <div className="draft-welcome">
      <h2>{t('app.welcome')}</h2>
      <p>{t('app.welcomeHint')}</p>
      {!goal && <div className="suggested-tasks" role="group" aria-label={t('app.suggestions')}>
        {SUGGESTIONS.map(([label, text, context]) => <button key={label} type="button" title={t(text)} onClick={() => suggest(t(text), context)}>{t(label)} <span aria-hidden="true">↗</span></button>)}
      </div>}
    </div>
    <form className="chat-composer" onSubmit={event => { event.preventDefault(); create(); }}>
      <p className="page-context" id="page-context" title={attached?.url}>
        <PageIcon/><span>{attached ? <>{attached.title || attached.url}{domain && <small>{domain}</small>}</> : t(props.contextTabId ? 'app.tabUnavailable' : 'app.pageContextAuto')}</span>
      </p>
      <textarea id="goal" ref={props.goalInput} aria-label={t('app.message')} aria-describedby="page-context" placeholder={t('app.goalPlaceholder')} rows={3} maxLength={MESSAGE_CHARS} value={goal} onChange={event => props.onGoal(event.target.value)} onKeyDown={submitOnEnter(create)} onPaste={event => { const files = pastedFiles(event); if (files.length) { event.preventDefault(); props.onAddFiles(files); } }}/>
      {/* One row that keeps its place: what the chips open and the files they add show below it. */}
      <div className="composer-actions">
        <div className="composer-tools">
          {/* Starting from an open page is optional: by default the agent opens the pages it needs. */}
          <button type="button" className={`chip attach-page${attached ? ' attached' : ''}`} aria-expanded={picking} aria-controls="attach-menu" title={t('app.startPageHint')} onClick={togglePicker}><PageIcon/><span>{attached ? attached.title || attached.url : t('app.attachPage')}</span></button>
          {attached && <button className="quiet icon detach-page" type="button" aria-label={t('app.detachPage')} title={t('app.detachPage')} onClick={() => choose('')}>×</button>}
          <AttachButton onAdd={props.onAddFiles} inputRef={fileInput}/>
          <SkillLibrary selected={props.skillId} onSelect={props.onSkill}/>
        </div>
        <div className="buttons">
          {!authorized && <button type="button" className="secondary" onClick={props.onEnableAccess}>{t('app.enableWebAccess')}</button>}
          <button type="submit" disabled={busy || !authorized || !goal.trim()}>{t('app.send')}</button>
        </div>
      </div>
      {picking && <div className="attach-menu" id="attach-menu">
        <label>{t('app.startPage')}<select value={props.contextTabId} onChange={event => choose(event.target.value)}>
          <option value="">{t('app.agentOpensPage')}</option>
          {props.tabs.map(tab => <option key={tab.id} value={tab.id}>{tab.title || tab.url}</option>)}
        </select></label>
        {props.onUseCurrentPage && <button className="quiet" type="button" onClick={() => { props.onUseCurrentPage!(); setPicking(false); }}>{t('app.useCurrentPage')}</button>}
      </div>}
      {!!props.files.length && <div className="composer-files"><FileChips files={props.files} onRemove={props.onRemoveFile}/></div>}
      {!authorized && <p className="hint composer-hint">{t('app.needsWebAccess')}</p>}
    </form>
  </section>;
}
