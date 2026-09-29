import { createTaskAgent } from './agent';
import { createAgentContext } from './context';
import { createAgentTools, controlTools } from './tools';
import { IndexedDBSaver } from './checkpointer';
import { chat, createModel } from './model';
import type { AgentStore } from './ports';
import { appendMessage, getOperation, getTask, patchTask, recordUsage, saveOperation, workspaceAction } from '../storage/db';
import { listFiles } from '../storage/workspace';
import { normalizeWebPolicy } from '../shared/web-policy';
import type { BrowserAction, BrowserResult, ModelConfig, Task } from '../shared/types';
import type { CodeRun } from '../shared/code';
import type { DocumentKind } from '../shared/workspace';
import { debugSpan, type DebugSink } from '../shared/debug';

interface ExtensionAgentDeps {
  task: Task; config: ModelConfig; signal: AbortSignal; elapsed(): number;
  browser(action: BrowserAction, requestId: string): Promise<BrowserResult>;
  runCode?: (code: string) => Promise<CodeRun>;
  loadImage?: (path: string) => Promise<string>;
  readDocument?: (path: string, kind: DocumentKind) => Promise<string>;
  debug?: DebugSink;
}

/** Composition root: only this module binds the agent to the extension's storage and model transport. */
export function createExtensionAgent(deps: ExtensionAgentDeps) {
  const { task, config } = deps;
  const turn = task.turn ?? 0;
  const store: AgentStore = {
    task: () => getTask(task.id),
    update: (patch, step) => patchTask(task.id, patch, step, turn),
    append: message => appendMessage(task.id, message, turn),
    operation: getOperation,
    saveOperation,
    recordUsage: usage => recordUsage(task.id, usage, turn),
  };
  const tools = createAgentTools({ ...deps, store, workspace: action => workspaceAction(task.id, action), imagesEnabled: !!config.visionInput && !!deps.loadImage });
  const tracedTools = { ...tools,
    execute: (...args: Parameters<typeof tools.execute>) => debugSpan(deps.debug, 'tool.execute', { call: args[0], round: args[1].rounds }, () => tools.execute(...args)),
    resume: (...args: Parameters<typeof tools.resume>) => debugSpan(deps.debug, 'tool.resume', args[0], () => tools.resume(...args)),
  };
  const context = createAgentContext({
    ...deps, store, definitions: [...tools.definitions, ...controlTools],
    model: (messages, signal, definitions, maxTokens, invoke) => debugSpan(deps.debug, 'model.request', { model: config.model, baseUrl: config.baseUrl, messages, tools: definitions }, () => chat(config, messages, signal, definitions, undefined, maxTokens, invoke)),
    files: () => listFiles(task.id),
    webPolicy: normalizeWebPolicy(config.webPolicy),
    loadImage: config.visionInput ? deps.loadImage : undefined,
  });
  return createTaskAgent({ ...deps, model: createModel(config), store, context, tools: tracedTools, checkpointer: new IndexedDBSaver(task.id) });
}
