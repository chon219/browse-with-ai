import type { ConversationMessage, Task } from './types';
import { display, t } from '../i18n';

/** The conversation timeline; a task saved without one has only its first message. */
export function conversationMessages(task: Task): ConversationMessage[] {
  return task.messages ?? [{ id: 'initial', at: task.createdAt, turn: 0, role: 'user', kind: 'message', content: task.goal }];
}
/** Text to show for a message in the current locale. */
export const messageText = (message: ConversationMessage) => message.localText ? display(message.localText) : message.content;
export function upsertMessage(messages: ConversationMessage[], message: ConversationMessage): ConversationMessage[] {
  const index = messages.findIndex(m => m.id === message.id);
  if (index < 0) return [...messages, message];
  return messages.map((m, i) => i === index ? { ...m, ...message, at: m.at } : m);
}
/** The turn's graph thread; also the prefix of its operation IDs. */
export function threadId(task: Task) { return (task.turn ?? 0) === 0 ? task.id : `${task.id}:turn:${task.turn}`; }
/** The conversation as Markdown, without activity entries. */
export function conversationMarkdown(task: Task): string {
  return conversationMessages(task).filter(m => m.role !== 'activity').map(m => {
    const decision = m.approval ? `\n\n${m.approval.url}\n\n${t(m.decision === 'approved' || m.decision === 'rejected' ? `decision.${m.decision}` : 'decision.notExecuted')}` : '';
    const files = m.attachments?.length ? `\n\n${t('chat.attachments')}: ${m.attachments.map(file => file.path).join(', ')}` : '';
    return `## ${m.role === 'user' ? t('export.you') : 'BWAI'}\n\n${messageText(m)}${files}${decision}`;
  }).join('\n\n');
}
