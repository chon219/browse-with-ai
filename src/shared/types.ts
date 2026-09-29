import type { SearchEngine } from './search-engines';
import type { WebPolicy } from './web-policy';
import type { AttachedFile, WorkspaceAction, WorkspaceResult } from './workspace';
import type { CodeRun } from './code';
import type { TokenUsage } from './usage';
import type { LocalText, Text } from '../i18n';
import type { actionSchema } from './policy';
import type { z } from 'zod';
import type { Skill } from './skills';
export type Status = 'ready' | 'running' | 'paused' | 'blocked' | 'completed' | 'incomplete' | 'cancelled' | 'error';
/** Statuses a turn ends in; a new message starts the next turn. */
const FINISHED_STATUSES: readonly Status[] = ['completed', 'incomplete', 'cancelled'];
export const isFinished = (status: Status) => FINISHED_STATUSES.includes(status);
export type RunPause = { kind: 'tokens'; limit: number } | { kind: 'stalled' };
export type Outcome = 'success' | 'incomplete';
export interface ModelSettings { baseUrl: string; model: string; remember: boolean; search: SearchEngine; webPolicy?: WebPolicy; /** Optional per-turn token limit. Missing means unrestricted. */ tokenLimit?: number; closeAgentTabs?: boolean;
  /** The model accepts images: attached and viewed images are sent to it. */
  visionInput?: boolean;
  /** Persist internal diagnostics. Missing values default to off. */
  debug?: boolean }
export interface ModelConfig extends ModelSettings { apiKey: string }
export interface Step { at: string; text: string }
export interface ConversationMessage {
  id: string; at: string; turn: number; role: 'user' | 'assistant' | 'activity';
  kind: 'message' | 'question' | 'approval' | 'result' | 'status' | 'error' | 'code'; content: string;
  /** When set, rendered in the current locale instead of `content` (the text as written). */
  localText?: LocalText;
  approval?: ApprovalRequest; decision?: 'approved' | 'rejected' | 'superseded'; outcome?: Outcome;
  visitedUrls?: string[];
  /** Files the user attached to this message. */
  attachments?: AttachedFile[];
  /** A code run in the activity log: the source and what it printed and returned. */
  code?: CodeRun & { source: string };
}
export interface Task {
  id: string; goal: string; status: Status;
  /** Agent working notes, retained across follow-up turns independently of history. */
  taskNotes?: string;
  /** The user-selected skill version is pinned for this conversation. */
  skill?: Skill;
  /** A short name the model gave the conversation; the goal is shown when there is none. */
  title?: string; createdAt: string; updatedAt: string; tokenLimit?: number;
  resultText: string; error?: Text; elapsedMs: number;
  instructions?: Step[]; contextTab?: { id: number; url: string; title: string }; pendingApproval?: ApprovalRequest; pendingQuestion?: string;
  outcome?: Outcome; visitedUrls?: string[];
  /** Display titles retained even when a page has no saved evidence file. */
  visitedPages?: { url: string; title: string }[];
  turn?: number; turnGoal?: string; turnVisitedUrls?: string[]; messages?: ConversationMessage[];
  lastPage?: { id: number; url: string; title: string };
  pause?: RunPause;
  usage?: TokenUsage;
}
export interface ElementRef { id: string; kind: 'link' | 'input' | 'button' | 'select' | 'checkbox' | 'radio'; text: string; textChars?: number; valueChars?: number; optionCount?: number; tag?: string; form?: { action: string; method: string }; disabled?: boolean; readOnly?: boolean; expanded?: boolean; role?: string; href?: string; inputType?: string; value?: string; checked?: boolean; options?: { label: string; value: string; disabled?: boolean }[] }
export interface Snapshot {
  /** Sanitized semantic DOM tree; full evidence is available through the workspace. */
  source?: 'dom'; sourceFile?: string; textChars?: number;
  textTruncated?: boolean; viewTextTruncated?: boolean;
  elementCount?: number; elementOffset?: number; nextElementOffset?: number;
  elementPages?: { frameId: number; total: number; offset: number; nextOffset?: number }[];
  url: string; title: string; text: string; snapshotId: string; elements: ElementRef[]; isSearchResult?: boolean;
  /** Text in the viewport, when `text` may not include it (long pages, or pages reduced to their main article). */
  viewText?: string;
  scroll?: { top: number; height: number; atBottom: boolean };
}
/** Browser actions and their effect declarations come from the executor schema. */
export type BrowserAction = z.infer<typeof actionSchema>;
export interface Confirmation { description: Text; url: string; elementText?: string; fields?: { label: Text; value: Text }[]; fieldsTruncated?: boolean; /** What the model says the step does, in its own words. */ reason?: string }
export interface ElementDetails { elementId: string; snapshotId: string; part: 'label' | 'value' | 'options'; offset: number; total: number; nextOffset?: number; content?: string; options?: NonNullable<ElementRef['options']> }
export interface ApprovalRequest extends Confirmation { requestId: string; tabId?: number }
export interface BrowserResult { element?: ElementDetails; /** Extra information for the model that is neither an error nor a block. */ note?: Text; tabId?: number; snapshot?: Snapshot; tabs?: { id: number; title: string; url: string; active: boolean }[]; closed?: boolean; error?: Text; blocked?: Text; approval?: ApprovalRequest; question?: string; instructionCount?: number; workspace?: WorkspaceResult; code?: CodeRun }
/** A tool call the agent runs in the task page rather than in the browser; recorded so a crash never repeats it. */
export type LocalAction = { name: 'workspace'; action: WorkspaceAction } | { name: 'run_code'; code: string };
export interface Operation { id: string; taskId: string; turn?: number; action: BrowserAction | LocalAction; phase: 'pending' | 'done'; result?: BrowserResult; startedAt: string; approvalDecision?: 'approved' | 'rejected'; approvalAt?: string; supersededBy?: string }
export interface ToolMessage { type: 'tool'; taskId: string; requestId: string; turn?: number; action: BrowserAction; search: SearchEngine }
export type Command = ToolMessage
  | { type: 'deleteTask' | 'taskDeleted'; taskId: string; requestId: string }
  | { type: 'attachTab'; taskId: string; requestId: string; tabId: number; expectedUrl: string }
  | { type: 'approval'; taskId: string; requestId: string; decision: 'approved' | 'rejected' }
  | { type: 'openRunner'; taskId: string; requestId: string; start?: boolean }
  | { type: 'control'; taskId: string; requestId: string; command: 'start' | 'pause' | 'cancel' }
  | { type: 'taskUpdated' | 'workspaceUpdated'; taskId: string; requestId: string };
/** `navigated`: openRunner loaded the task page for the task, which starts it itself. */
export interface RpcResult { ok: boolean; result?: BrowserResult; error?: string; navigated?: boolean }
export const now = () => new Date().toISOString();
