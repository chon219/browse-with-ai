import { useState } from 'react';
import { ChatThread } from './ChatThread';
import { WorkspaceFiles } from './WorkspaceFiles';
import { WorkspacePreview } from './WorkspacePreview';
import { useWorkspaceFiles } from '../use-workspace-files';
import type { ResourceFile } from '../page-resources';
import { AttachButton, FileChips } from './AttachFiles';
import { pastedFiles, type Attachment } from '../attachments';
import { formatTokens, needsSettings, submitOnEnter, taskStatusLabel } from '../helpers';
import { MESSAGE_CHARS } from '../../shared/tuning';
import { t } from '../../i18n';
import { isFinished, type Task } from '../../shared/types';
import { conversationMessages, messageText } from '../../shared/conversation';

/** Live context size and total token use; figures the service did not report are estimates, marked with ≈. */
function TokenUsageLine({ usage }: { usage: NonNullable<Task['usage']> }) {
  const mark = usage.estimated ? '≈' : '';
  const detail = t('app.tokenUsageDetail', { requests: usage.requests, prompt: formatTokens(usage.promptTokens), completion: formatTokens(usage.completionTokens) }) + (usage.estimated ? ' ' + t('app.tokenEstimated') : '');
  return <span className="token-usage" data-testid="token-usage" title={detail}>
    <span className="stat">{t('app.tokenContext', { context: mark + formatTokens(usage.contextTokens) })}</span>
    <span className="stat">{t('app.tokenTotal', { total: mark + formatTokens(usage.promptTokens + usage.completionTokens) })}</span>
  </span>;
}

interface Props {
  task: Task; busy: boolean; isRunner: boolean;
  instruction: string; onInstruction: (value: string) => void; onSend: () => void;
  onOpenRunner: () => void; onStart: () => void; onPause: () => void; onCancel: () => void; onExport: () => void;
  onOpenSettings: () => void;
  files: Attachment[]; onAddFiles: (files: File[]) => void; onRemoveFile: (index: number) => void; onApproval: (decision: 'approved' | 'rejected') => void; onViewPage: (tabId: number) => void;
}
export function TaskView(props: Props) {
  const { task, busy, instruction } = props;
  const workspaceFiles = useWorkspaceFiles(task.id);
  const [previewFile, setPreviewFile] = useState<ResourceFile>();
  const canStart = !isFinished(task.status) && (task.status === 'paused' || !task.pendingApproval && !task.pendingQuestion);
  const settingsFirst = needsSettings(task);
  const send = () => { if (instruction.trim() && !busy) props.onSend(); };
  const progress = [...conversationMessages(task)].reverse().find(message => message.turn === (task.turn ?? 0) && message.role === 'activity');
  return <>
    <section className="card task-header">
      <div className="task-summary">
        <h2 title={task.goal}>{task.title ?? task.goal}</h2>
        <div className="task-state-controls">
          <span className={`badge ${task.status}`} data-testid="task-status">{taskStatusLabel(task)}</span>
          {settingsFirst && <button onClick={props.onOpenSettings}>{t('app.openSettings')}</button>}
          {task.status === 'running' ? <button className="secondary" disabled={busy} onClick={props.onPause}>{t('app.pause')}</button>
            : canStart && <button className={settingsFirst ? 'secondary' : undefined} disabled={busy} onClick={props.onStart}>{t(task.status === 'ready' ? 'app.start' : 'app.resume')}</button>}
          {!isFinished(task.status) && <button className="quiet" disabled={busy} onClick={props.onCancel}>{t('app.cancelTask')}</button>}
          {!props.isRunner && <button className="secondary" disabled={busy} onClick={props.onOpenRunner}>{t('app.openRunner')}</button>}
        </div>
      </div>
      {task.usage && <div className="task-stats hint"><div><TokenUsageLine usage={task.usage}/></div></div>}
      {task.status === 'running' && <p className="task-progress" role="status" data-testid="task-progress"><strong>{t('app.currentProgress')}</strong> {progress ? messageText(progress) : t('step.deciding')}</p>}
      {task.pause && task.status === 'paused' && <p className="task-note">{t(task.pause.kind === 'tokens' ? 'pause.tokens' : 'pause.stalled')}</p>}
      <div className="task-toolbar">
        <WorkspaceFiles task={task} files={workspaceFiles} onPreview={setPreviewFile}/>
      </div>
      {task.status === 'running' && <p className="hint">{t(props.isRunner ? 'app.closingPauses' : 'app.runsInTaskPage')}</p>}
      {task.skill && <p className="hint">{t('skills.selected', { name: task.skill.name, version: task.skill.version })}</p>}
    </section>
    <section className="card conversation-card">
      <ChatThread task={task} busy={busy} onApproval={props.onApproval} onViewPage={props.onViewPage} onExport={props.onExport}
        files={workspaceFiles} onPreviewFile={path => setPreviewFile(workspaceFiles.find(file => file.path === path))}/>
      <form className="chat-composer inline" onSubmit={event => { event.preventDefault(); send(); }}>
        {!!props.files.length && <div className="composer-files"><FileChips files={props.files} onRemove={props.onRemoveFile}/></div>}
        <textarea id="instruction" aria-label={t(task.pendingQuestion ? 'app.answer' : 'app.message')} placeholder={t(task.pendingQuestion ? 'app.answerPlaceholder' : 'app.followupPlaceholder')} rows={2} maxLength={MESSAGE_CHARS} value={instruction}
          onChange={event => props.onInstruction(event.target.value)} onKeyDown={submitOnEnter(send)} onPaste={event => { const files = pastedFiles(event); if (files.length) { event.preventDefault(); props.onAddFiles(files); } }}/>
        <div className="buttons"><AttachButton compact onAdd={props.onAddFiles}/><button disabled={!instruction.trim() || busy} type="submit">{t(task.pendingQuestion ? 'app.answerAndContinue' : 'app.send')}</button></div>
      </form>
    </section>
    <WorkspacePreview taskId={task.id} file={previewFile} onClose={() => setPreviewFile(undefined)}/>
  </>;
}
