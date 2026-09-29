import { msg } from '../i18n';
import type { BrowserAction } from '../shared/types';
import type { State } from './state';

const short = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, 160);

export function decisionProgress(state: State) {
  const latest = state.history.at(-1);
  if (latest?.kind === 'note' || latest?.kind === 'observation' && latest.error) return msg('step.reconsidering');
  if (latest?.kind === 'observation') {
    const subject = latest.snapshot?.title || latest.snapshot?.url || latest.workspace?.file?.path;
    if (subject) return msg('step.reviewing', { subject: short(subject) });
    if (latest.code) return msg('step.reviewingCode');
  }
  return msg('step.deciding');
}

/** Only observed labels and action metadata; never expose typed values or code. */
export function browserProgress(action: BrowserAction, state: State) {
  const page = 'tabId' in action ? [...state.history].reverse().find(entry => entry.kind === 'observation' && entry.tabId === action.tabId && entry.snapshot) : undefined;
  const snapshot = page?.kind === 'observation' ? page.snapshot : undefined;
  const target = 'snapshotId' in action && action.snapshotId === snapshot?.snapshotId
    ? snapshot.elements?.find(element => element.id === action.elementId)?.text : undefined;
  const subject = action.name === 'search' ? action.query : action.name === 'open' ? action.url : snapshot?.title || snapshot?.url;
  const detail = [subject, target].filter((value): value is string => !!value).map(short);
  if (action.name === 'wait') detail.push(`${action.milliseconds / 1000}s`);
  const label = action.name === 'scroll' ? msg(action.direction === 'down' ? 'action.scrollDown' : 'action.scrollUp') : msg(`action.${action.name}`);
  return msg('step.action', { action: label, detail: detail.length ? ' · ' + detail.join(' · ') : '' });
}
