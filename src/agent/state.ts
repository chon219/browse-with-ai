import { z } from 'zod';
import type { BrowserAction, BrowserResult, RunPause, Snapshot, Task } from '../shared/types';
import { isLocalText, type Text } from '../i18n';
import type { ToolCall } from './model';
import type { Skill } from '../shared/skills';
import { conversationMessages } from '../shared/conversation';
import { appendHistory, callForHistory, NOTES, type HistoryEntry } from './prompts';

export const AgentState = z.object({
  goal: z.string().default(''),
  taskNotes: z.string().nullable().default(null),
  loadedSkill: z.custom<Skill>().nullable().default(null),
  history: z.array(z.custom<HistoryEntry>()).default([]), pending: z.custom<ToolCall>().nullable().default(null), observation: z.custom<BrowserResult>().nullable().default(null),
  rounds: z.number().default(0), blocked: z.custom<Text>().default(''), resultText: z.string().default(''),
  outcome: z.enum(['success', 'incomplete']).default('incomplete'), verification: z.string().default(''),
  revision: z.number().default(0), pendingText: z.string().default(''),
  /** The latest page snapshot's tab and content hash, and how many observations in a row returned it unchanged. */
  pageSignature: z.string().default(''), unchangedReads: z.number().default(0),
  pageCursor: z.string().default(''),
  /** The latest call that returned no page, with a hash of its result, and how many times in a row it returned the same result. */
  lastCall: z.string().default(''), repeatedCalls: z.number().default(0),
  pause: z.custom<RunPause>().nullable().default(null), noProgress: z.number().default(0),
});
export type State = z.infer<typeof AgentState>;
/** A short hash of what the model sees of a page, to tell when an observation repeats the previous one. */
function hash(content: string) {
  let a = 0x811c9dc5, b = 0x01000193;
  for (let i = 0; i < content.length; i++) { const c = content.charCodeAt(i); a = Math.imul(a ^ c, 0x01000193); b = Math.imul(b ^ c, 0x5bd1e995); }
  return `${(a >>> 0).toString(16)}${(b >>> 0).toString(16)}`;
}
export function pageSignature(tabId: number | undefined, snapshot: Snapshot): string {
  return `${tabId ?? ''}|${hash(JSON.stringify([snapshot.url, snapshot.title, snapshot.text, snapshot.viewText, snapshot.scroll, snapshot.elementPages, snapshot.elements.map(e => [e.kind, e.text, e.href, e.value, e.checked, e.options, e.disabled, e.readOnly, e.expanded, e.role, e.tag, e.form, e.inputType])]))}`;
}
/** A tool call without its free-text reason, so the same call is recognized however the model words it. */
function callKey(call: { name: string; arguments: string }): string {
  try {
    const args = JSON.parse(call.arguments);
    if (args?.action && typeof args.action === 'object') { const { reason: _reason, ...action } = args.action; return call.name + ':' + JSON.stringify(action); }
    return call.name + ':' + JSON.stringify(args);
  } catch { /* Compare the raw arguments. */ }
  return call.name + ':' + call.arguments;
}
const REPEAT_LIMIT = 2;
/** The same call has already returned the same result REPEAT_LIMIT more times in a row, so running it again cannot help. */
export const callRepeats = (state: State) => !!state.pending && (state.repeatedCalls ?? 0) >= REPEAT_LIMIT && !!state.lastCall?.startsWith(callKey(state.pending.function) + '|');
/** Two observations in a row returned the same page, so reading it once more cannot help. */
export const readsSamePage = (state: State, action: BrowserAction) => action.name === 'read' && (state.pageCursor ?? '0:0') === `${action.frameId ?? 0}:${action.elementOffset ?? 0}` && (state.unchangedReads ?? 0) >= 2 && !!state.pageSignature?.startsWith(`${action.tabId}|`);

/** Whether text says nothing beyond a plan or update already shown in this turn, ignoring spacing and punctuation. */
export function alreadyShown(task: Task | undefined, text: string) {
  const plain = (value: string) => value.replace(/[\s\p{P}\p{S}]/gu, '');
  const said = plain(text);
  if (!said || !task) return false;
  return conversationMessages(task).some(m => m.turn === (task.turn ?? 0) && m.role === 'assistant' && m.kind === 'message' && plain(m.content).includes(said));
}
/** Reduce an observation into structured history and repetition counters. */
export function observe(state: State, observation: BrowserResult): Partial<State> {
  if (!state.pending) throw new Error('An observation must belong to a tool call');
  const signature = observation.snapshot ? pageSignature(observation.tabId, observation.snapshot) : undefined;
  const unchanged = !!signature && signature === state.pageSignature;
  let pageCursor = '0:0';
  try { const action = JSON.parse(state.pending.function.arguments).action; if (action?.name === 'read') pageCursor = `${action.frameId ?? 0}:${action.elementOffset ?? 0}`; } catch { /* No browser read. */ }
  const page = signature ? { pageSignature: signature, pageCursor, unchangedReads: unchanged ? (state.unchangedReads ?? 0) + 1 : 0 } : {};
  // Calls that return no page, such as list_tabs, repeat too: count identical results in a row. A refusal keeps the count.
  const refused = isLocalText(observation.error) && observation.error.key === 'step.callRepeated';
  const call = !signature ? `${callKey(state.pending.function)}|${hash(JSON.stringify(observation))}` : '';
  const repeated = !!call && call === state.lastCall;
  const calls = refused ? { repeatedCalls: (state.repeatedCalls ?? 0) + 1 } : { lastCall: call, repeatedCalls: repeated ? (state.repeatedCalls ?? 0) + 1 : 0 };
  const entry = { ...observation, ...(unchanged ? { unchanged: true, note: NOTES.pageUnchanged } : repeated ? { unchanged: true, note: NOTES.callRepeated } : {}), action: callForHistory({ ...state.pending.function, id: `${state.rounds}:${state.pending.id}` }), revision: state.revision, assistantText: state.pendingText };
  return { history: appendHistory(state.history, { kind: 'observation', ...entry }), pending: null, pendingText: '', observation: observation.blocked ? observation : null, blocked: observation.blocked ?? '', ...page, ...calls,
    noProgress: observation.error || unchanged || repeated ? (state.noProgress ?? 0) + 1 : 0 };
}
