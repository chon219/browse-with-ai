import React, { useEffect, useMemo, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { conversationMessages, messageText } from '../../shared/conversation';
import { display, getLocale, t } from '../../i18n';
import type { ConversationMessage, Task } from '../../shared/types';
import '../styles/conversation.css';
import { MessageFiles } from './AttachFiles';
import { SkillLibrary } from './SkillLibrary';
import type { WorkspaceFile } from '../../shared/workspace';
import { remarkWorkspaceLinks, workspaceHref, workspaceLinkResolver } from '../workspace-links';

/** A code run in the activity log: what the agent ran and what came back. */
function CodeRunDetails({ label, run }: { label: string; run: NonNullable<ConversationMessage['code']> }) {
  return <details className="code-run" data-testid="code-run">
    <summary className={run.error ? 'failed' : undefined}>{label}</summary>
    <h4>{t('chat.codeSource')}</h4><pre>{run.source}</pre>
    {!!run.logs && <><h4>{t('chat.codeOutput')}</h4><pre>{run.logs}</pre></>}
    {run.result !== undefined && <><h4>{t('chat.codeResult')}</h4><pre>{run.result}</pre></>}
    {run.error !== undefined && <><h4>{t('chat.codeError')}</h4><pre className="error">{display(run.error)}</pre></>}
    {!!run.changedFiles?.length && <><h4>{t('chat.codeChangedFiles')}</h4><p>{run.changedFiles.join(', ')}</p></>}
  </details>;
}

interface Props {
  task: Task; busy: boolean;
  onApproval: (decision: 'approved' | 'rejected') => void;
  onViewPage: (tabId: number) => void;
  onExport: () => void;
  files: WorkspaceFile[]; onPreviewFile: (path: string) => void;
}
export function ChatThread({ task, busy, onApproval, onViewPage, onExport, files, onPreviewFile }: Props) {
  const resolveFile = useMemo(() => workspaceLinkResolver(files.map(file => file.path)), [files]);
  const fileLinks = useMemo(() => remarkWorkspaceLinks(resolveFile), [resolveFile]);
  const log = useRef<HTMLDivElement>(null); const following = useRef(true);
  const [showLatest, setShowLatest] = useState(false);
  const [hasNewMessages, setHasNewMessages] = useState(false);
  const messages = conversationMessages(task);
  const previousCount = useRef(messages.length);
  useEffect(() => { following.current = true; previousCount.current = messages.length; setShowLatest(false); setHasNewMessages(false); }, [task.id]);
  useEffect(() => {
    if (following.current && log.current) log.current.scrollTop = log.current.scrollHeight;
    else if (messages.length > previousCount.current) setHasNewMessages(true);
    previousCount.current = messages.length;
  }, [task.id, messages.length, task.status]);
  function trackScroll() {
    const el = log.current;
    if (!el) return;
    following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    setShowLatest(!following.current);
    if (following.current) setHasNewMessages(false);
  }
  function latest() {
    following.current = true;
    if (log.current) log.current.scrollTop = log.current.scrollHeight;
    setShowLatest(false); setHasNewMessages(false);
  }
  const groups: ConversationMessage[][] = [];
  for (const message of messages) {
    const last = groups.at(-1);
    if (message.role === 'activity' && last?.[0].role === 'activity') last.push(message);
    else groups.push([message]);
  }
  return <div className="conversation-scroll">
    <div className="conversation-log" role="log" aria-label={t('chat.label')} aria-live="polite" ref={log} onScroll={trackScroll}>
    {groups.map((group, index) => {
      const message = group[0];
      if (message.role === 'activity') return <details key={message.id} className="chat-activity"><summary>{task.status === 'running' && index === groups.length - 1 ? messageText(group.at(-1)!) : t('chat.activityHistory', { count: group.length })}</summary><ol>{group.map(step => <li key={step.id}><time>{new Date(step.at).toLocaleTimeString(getLocale(), { hour12: false })}</time>{step.code ? <CodeRunDetails label={messageText(step)} run={step.code}/> : <span>{messageText(step)}</span>}</li>)}</ol></details>;
      if (message.kind === 'approval' && message.approval) {
        const approval = message.approval;
        const active = task.status === 'blocked' && task.pendingApproval?.requestId === approval.requestId && !message.decision;
        return <div key={message.id} className="chat-message assistant approval" data-testid={active ? 'approval' : 'approval-history'}>
          <h3>{approval.elementText || t('chat.approvalDefault')}</h3><p>{display(approval.description)}</p><p className="approval-url">{approval.url}</p>
          {approval.reason && <p className="approval-reason"><strong>{t('chat.modelReason')}</strong> {approval.reason}</p>}
          {!!approval.fields?.length && <dl>{approval.fields.map((field, i) => <React.Fragment key={i}><dt>{display(field.label)}</dt><dd>{display(field.value) || t('chat.emptyValue')}</dd></React.Fragment>)}</dl>}
          {approval.fieldsTruncated && <p>{t('chat.fieldsTruncated')}</p>}
          {active ? <div className="buttons"><button disabled={busy} onClick={() => onApproval('approved')}>{t('chat.approve')}</button><button disabled={busy} className="secondary" onClick={() => onApproval('rejected')}>{t('chat.reject')}</button>{approval.tabId && <button className="quiet" onClick={() => onViewPage(approval.tabId!)}>{t('chat.viewPage')}</button>}</div>
            : <span className="decision-status">{t(message.decision ? `decision.${message.decision}` : 'decision.invalid')}</span>}
        </div>;
      }
      const known = new Set([...(task.visitedUrls ?? []), ...(message.visitedUrls ?? [])]);
      // The outcome sits outside the bubble so the reply text stays exactly what the agent wrote.
      const outcome = message.kind === 'result' && message.outcome && <p className={`result-outcome ${message.outcome}`}>{message.outcome === 'success' ? `✓ ${t('status.completed')}` : t('status.incomplete')}</p>;
      return <React.Fragment key={message.id}>{outcome}<div className={`chat-message ${message.role} ${message.kind}`} aria-label={t(message.role === 'user' ? 'chat.yourMessage' : 'chat.bwaiMessage')} data-testid={message.kind === 'result' ? 'task-result' : `chat-${message.kind}`}>
        {message.role === 'user' ? <><p>{messageText(message)}</p>{!!message.attachments?.length && <MessageFiles taskId={task.id} files={message.attachments}/>}</> : <div className="markdown"><Markdown remarkPlugins={[remarkGfm, fileLinks]} skipHtml disallowedElements={['img']}
          urlTransform={url => { const path = resolveFile(url); return path ? workspaceHref(path) : known.has(url) ? url : ''; }}
          components={{ a: ({ href, children }) => {
            const path = href && resolveFile(href);
            return path ? <button type="button" className="workspace-link" title={t('app.previewFile', { path })} onClick={() => onPreviewFile(path)}>{children}</button>
              : href ? <a href={href} target="_blank" rel="noreferrer">{children}</a> : <span>{children}</span>;
          } }}>{messageText(message)}</Markdown></div>}
      </div></React.Fragment>;
    })}
    <div className="conversation-actions">
      {task.status === 'completed' && task.outcome === 'success' && <SkillLibrary key={task.id} task={task}/>}
      <button type="button" className="secondary" onClick={onExport}>{t('app.exportMarkdown')}</button>
    </div>
    </div>
    {showLatest && <button type="button" className="latest-messages secondary" onClick={latest}>{t(hasNewMessages ? 'chat.newMessages' : 'chat.backToLatest')} ↓</button>}
  </div>;
}
