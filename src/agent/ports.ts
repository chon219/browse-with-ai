import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { ConversationMessage, Task, Operation, BrowserResult } from '../shared/types';
import type { RequestUsage } from '../shared/usage';
import type { Text } from '../i18n';
import type { FunctionTool, ModelReply, ModelInvoker, ToolCall } from './model';
import type { State } from './state';
import type { DebugSink } from '../shared/debug';

/** A store bound to one conversation and turn; task/message updates must ignore superseded turns. */
export interface AgentStore {
  task(): Promise<Task | undefined>;
  update(patch: Partial<Task>, step?: Text): Promise<unknown>;
  append(message: Omit<ConversationMessage, 'at'>): Promise<unknown>;
  operation(id: string): Promise<Operation | undefined>;
  saveOperation(operation: Operation): Promise<void>;
  recordUsage(usage: RequestUsage): Promise<void>;
}

/** Context assembly and model transport belong behind this boundary. */
export interface AgentContext {
  request(phase: 'decide' | 'progress', state: State, live: Task | undefined, invoke?: ModelInvoker): Promise<ModelReply>;
  name(goal: string): Promise<void>;
}

export interface AgentTools {
  definitions: FunctionTool[];
  has(name: string): boolean;
  validate(call: ToolCall): BrowserResult | undefined;
  execute(call: ToolCall, state: State): Promise<BrowserResult>;
  resume(operation: Operation): Promise<BrowserResult>;
}

/** The workflow has no browser, file-system, database or HTTP dependency. */
export interface AgentDeps {
  task: Task;
  signal: AbortSignal;
  elapsed(): number;
  store: AgentStore;
  context: AgentContext;
  model: BaseChatModel;
  tools: AgentTools;
  checkpointer: BaseCheckpointSaver;
  debug?: DebugSink;
}
