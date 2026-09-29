import { z } from 'zod';
import type { AgentStore, AgentTools } from './ports';
import type { State } from './state';
import type { FunctionTool, ToolCall } from './model';
import { alreadyShown, callRepeats, readsSamePage } from './state';
import { browserProgress } from './progress';
import { actionSchema } from '../shared/policy';
import { runCodeSchema, type CodeRun } from '../shared/code';
import { documentKind, textSlice, workspaceActionSchema, type DocumentKind, type WorkspaceAction, type WorkspaceResult } from '../shared/workspace';
import { now, type BrowserAction, type BrowserResult, type LocalAction, type Task } from '../shared/types';
import { threadId } from '../shared/conversation';
import { asContent, errorText, msg } from '../i18n';
import { TOOL_ARGUMENT_HINTS, TOOL_DESCRIPTIONS } from './prompts';
import { CONTEXT } from '../shared/tuning';

interface ToolDeps {
  task: Task;
  store: AgentStore;
  signal: AbortSignal;
  browser(action: BrowserAction, requestId: string): Promise<BrowserResult>;
  workspace(action: WorkspaceAction): Promise<WorkspaceResult>;
  runCode?: (code: string) => Promise<CodeRun>;
  readDocument?: (path: string, kind: DocumentKind) => Promise<string>;
  imagesEnabled: boolean;
}

export interface ToolHandler {
  definition: FunctionTool;
  validate?(call: ToolCall): BrowserResult | undefined;
  execute(call: ToolCall, state: State): Promise<BrowserResult>;
}

/** A static registry: adding an execution tool does not change the workflow. */
export function toolRegistry(handlers: ToolHandler[], resume: AgentTools['resume']): AgentTools {
  const registered = new Map(handlers.map(handler => [handler.definition.function.name, handler]));
  if (registered.size !== handlers.length) throw new Error('Duplicate agent tool name');
  return {
    definitions: handlers.map(handler => handler.definition),
    has: name => registered.has(name),
    validate: call => registered.get(call.function.name)?.validate?.(call),
    execute: (call, state) => {
      const handler = registered.get(call.function.name);
      return handler ? handler.execute(call, state) : Promise.resolve({ error: msg('step.invalidToolArgs') });
    },
    resume,
  };
}

/** Control decisions are interpreted by the workflow, not executed as tools. */
export const controlSchemas = {
  finish_task: z.object({ answer: z.string().trim().min(1).max(24000).describe('The complete final answer to the user. Returned directly without another model request.'), outcome: z.enum(['success', 'incomplete']), verification: z.string().trim().min(1).max(2000) }).strict(),
  ask_user: z.object({ question: z.string().trim().min(1).max(2000) }).strict(),
  update_task_notes: z.object({ notes: z.string().trim().min(1).max(CONTEXT.notesChars) }).strict(),
  load_skill: z.object({}).strict(),
};
const definition = (name: keyof typeof TOOL_DESCRIPTIONS, schema: z.ZodType): FunctionTool => ({
  type: 'function', function: { name, description: `${TOOL_DESCRIPTIONS[name]} ${TOOL_ARGUMENT_HINTS[name] ?? ''}`.trim(), parameters: z.toJSONSchema(schema) },
});
export const controlTools = (Object.keys(controlSchemas) as (keyof typeof controlSchemas)[]).map(name => definition(name, controlSchemas[name]));

export function createAgentTools(deps: ToolDeps): AgentTools {
  const { task, store, signal } = deps;
  const turn = task.turn ?? 0;
  const operationId = (call: ToolCall, state: State) => `${threadId(task)}:${state.rounds}:${call.id}`;

  // The graph checkpoint may lag behind an effect. Reuse completed results; never replay unknown effects.
  async function once(id: string, action: LocalAction, run: () => Promise<BrowserResult>): Promise<BrowserResult> {
    const old = await store.operation(id);
    if (old?.phase === 'done') return old.result!;
    if (old) { const result = { error: msg('bg.unknownResult') }; await store.saveOperation({ ...old, phase: 'done', result }); return result; }
    const op = { id, taskId: task.id, turn, action, phase: 'pending' as const, startedAt: now() };
    await store.saveOperation(op);
    const result = await run();
    await store.saveOperation({ ...op, phase: 'done', result });
    return result;
  }

  function handler<S extends z.ZodType>(name: keyof typeof TOOL_DESCRIPTIONS, schema: S,
    execute: (args: z.output<S>, call: ToolCall, state: State) => Promise<BrowserResult>): ToolHandler {
    function parse(call: ToolCall): { args: z.output<S> } | { result: BrowserResult } {
      let input: unknown;
      try { input = JSON.parse(call.function.arguments); }
      catch {
        return { result: { error: msg('step.invalidToolArgsFields', { tool: name, fields: 'JSON' }),
          note: 'Arguments are not valid JSON. Send one JSON object matching the tool schema, with properly escaped strings and no Markdown fences. No action was performed.' } };
      }
      const parsed = schema.safeParse(input);
      if (!parsed.success) {
        const issues = parsed.error.issues.slice(0, 5).map(issue => ({
          path: issue.path.map(String).join('.') || '$', message: issue.message.slice(0, 300),
        }));
        return { result: { error: msg('step.invalidToolArgsFields', { tool: name, fields: [...new Set(issues.map(issue => issue.path))].join(', ') }),
          note: `No action was performed. Correct these argument errors using the tool schema before calling again: ${JSON.stringify(issues)}. Use actual tab, snapshot, element IDs from observations; read the page if the required reference is unavailable. Do not repeat the same invalid arguments.` } };
      }
      return { args: parsed.data };
    }
    return {
      definition: definition(name, schema),
      validate(call) { const parsed = parse(call); return 'result' in parsed ? parsed.result : undefined; },
      async execute(call, state) {
        signal.throwIfAborted();
        const parsed = parse(call);
        return 'result' in parsed ? parsed.result : execute(parsed.args, call, state);
      },
    };
  }

  const browser = handler('browser', z.object({ action: actionSchema }).strict(), async ({ action }, call, state) => {
    if (readsSamePage(state, action)) return { error: msg('step.readRepeated') };
    if (callRepeats(state)) return { error: msg('step.callRepeated') };
    if (!state.pendingText && 'reason' in action && action.reason && !alreadyShown(await store.task(), action.reason)) {
      await store.append({ id: `assistant:${turn}:${state.rounds}`, turn, role: 'assistant', kind: 'message', content: action.reason });
    }
    await store.update({}, browserProgress(action, state));
    return deps.browser(action, operationId(call, state));
  });

  const workspace = handler('workspace', z.object({ action: workspaceActionSchema }).strict(), async ({ action }, call, state) => {
    if (['read_file', 'list_files', 'view_image'].includes(action.name) && callRepeats(state)) return { error: msg('step.callRepeated') };
    if (action.name === 'view_image' && !deps.imagesEnabled) return { error: msg('workspace.imagesDisabled') };
    await store.update({}, msg('step.action', { action: msg(`action.${action.name}`), detail: 'path' in action ? ' · ' + action.path : '' }));
    if (action.name === 'write_file' || action.name === 'append_file' || action.name === 'delete_file') {
      return once(operationId(call, state), { name: 'workspace', action }, async () => {
        try { return { workspace: await deps.workspace(action) }; }
        catch (e) { signal.throwIfAborted(); return { error: errorText(e, 'workspace.failed') }; }
      });
    }
    let result: WorkspaceResult;
    try { result = await deps.workspace(action); }
    catch (e) { signal.throwIfAborted(); return { error: errorText(e, 'workspace.failed') }; }
    const file = result.file; const kind = file && 'binary' in file ? documentKind(file.type) : undefined;
    if (action.name === 'read_file' && file && 'binary' in file && kind && deps.readDocument) {
      try { result = { file: { ...textSlice(file.path, await deps.readDocument(file.path, kind), action.offset), convertedFrom: file.type } }; }
      catch (e) { signal.throwIfAborted(); return { error: errorText(e, 'document.failed') }; }
    }
    return { workspace: result };
  });

  const code = handler('run_code', runCodeSchema, async ({ code }, call, state) => {
    if (callRepeats(state)) return { error: msg('step.callRepeated') };
    const runCode = deps.runCode;
    if (!runCode) return { error: msg('code.unavailable') };
    await store.update({}, msg('step.action', { action: msg('action.run_code'), detail: '' }));
    const observation = await once(operationId(call, state), { name: 'run_code', code }, async () => {
      try { return { code: await runCode(code) }; }
      catch (e) { signal.throwIfAborted(); return { error: errorText(e, 'code.unavailable') }; }
    });
    signal.throwIfAborted();
    const run = observation.code; if (!run) return observation;
    await store.append({ id: `code:${turn}:${state.rounds}:${call.id}`, turn, role: 'activity', kind: 'code', ...asContent(msg(run.error ? 'step.codeFailed' : 'step.codeDone')), code: { ...run, source: code } });
    return { code: run, ...(run.truncated ? { note: 'Code preview was truncated. Read outputFiles with workspace.read_file and nextOffset instead of rerunning the code. If archiveTruncated is true, the archive also reached its capture limit. outputSaveError means saving failed.' } : {}) };
  });

  return toolRegistry([browser, workspace, code], operation => {
    if (operation.action.name === 'workspace' || operation.action.name === 'run_code') throw new Error('Local tools do not request confirmation');
    return deps.browser(operation.action, operation.id);
  });
}
