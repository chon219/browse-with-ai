import { createAgent, createMiddleware, tool, type ToolRuntime } from 'langchain';
import { AIMessage, RemoveMessage, ToolMessage } from '@langchain/core/messages';
import { AsyncLocalStorageProviderSingleton } from '@langchain/core/singletons';
import type { RunnableConfig } from '@langchain/core/runnables';
import { Command, interrupt, REMOVE_ALL_MESSAGES } from '@langchain/langgraph/web';
import { controlSchemas, controlTools } from './tools';
import { TokenLimitError } from '../shared/budget';
import { NO_PROGRESS_LIMIT } from '../shared/tuning';
import type { BrowserResult, RunPause } from '../shared/types';
import { msg } from '../i18n';
import { formatTaskResult } from './results';
import { appendHistory, forModel, NOTES } from './prompts';
import { AgentState, alreadyShown, observe, type State } from './state';
import type { AgentDeps } from './ports';
import type { ModelInvoker, ToolCall } from './model';
import { debugSpan } from '../shared/debug';
import { decisionProgress } from './progress';

/** createAgent owns model/tool scheduling; middleware applies the task's execution rules. */
export function createTaskAgent(deps: AgentDeps) {
  const { task, signal, store, context, tools } = deps;
  const turn = task.turn ?? 0;
  const update = store.update;
  const clearMessages = () => [new RemoveMessage({ id: REMOVE_ALL_MESSAGES })];
  const feedback = (state: State, text: string): Partial<State> => ({ pending: null, pendingText: '', noProgress: (state.noProgress ?? 0) + 1, history: appendHistory(state.history, text) });
  const resetPause = { pause: null, blocked: '', noProgress: 0, unchangedReads: 0, repeatedCalls: 0, lastCall: '' } as const;

  async function pause(state: State, reason: RunPause): Promise<Partial<State>> {
    if (reason.kind === 'tokens' && state.history?.length) {
      try {
        const reply = await context.request('progress', state, await store.task());
        if (reply.content?.trim()) await store.append({ id: `pause:${turn}:${state.rounds}:${reason.limit}`, turn, role: 'assistant', kind: 'message', content: reply.content.trim() });
      } catch { signal.throwIfAborted(); }
    }
    return { pause: reason, blocked: msg(reason.kind === 'tokens' ? 'pause.tokens' : 'pause.stalled'), revision: (await store.task())?.instructions?.length ?? 0, pending: null, pendingText: '', resultText: '' };
  }

  /** The original call remains pending until approval has a definitive result. */
  async function settle(state: State, result: BrowserResult): Promise<Partial<State>> {
    signal.throwIfAborted();
    await update({ elapsedMs: deps.elapsed(), pendingApproval: result.approval }, result.error ? msg('step.pageFeedback', { error: result.error }) : undefined);
    if (result.approval) return { observation: result, blocked: result.blocked ?? msg('bg.awaitingApproval') };
    return observe(state, result);
  }

  async function resume(state: State): Promise<Partial<State>> {
    if (state.pause) {
      if (state.pause.kind === 'tokens' && task.tokenLimit !== undefined && task.tokenLimit <= state.pause.limit) return { blocked: msg('pause.tokens') };
      return { ...resetPause, pending: null, pendingText: '', observation: null };
    }
    if (state.observation?.question) {
      const instructions = (await store.task())?.instructions ?? [];
      const askedAt = state.observation.instructionCount ?? 0;
      if (instructions.length <= askedAt) return { blocked: state.observation.question };
      await update({ pendingQuestion: undefined });
      return { ...await settle(state, { note: instructions.slice(askedAt).map(item => item.text).join('\n') }), noProgress: 0 };
    }
    const approval = state.observation?.approval;
    if (approval) {
      let operation = await store.operation(approval.requestId);
      if (!operation) return settle(state, { error: NOTES.approvalLost });
      if (operation.phase === 'done' && operation.result?.approval && operation.approvalDecision !== 'rejected' && ((await store.task())?.instructions?.length ?? 0) > (state.revision ?? 0)) {
        operation = { ...operation, approvalDecision: 'rejected', approvalAt: new Date().toISOString(), supersededBy: 'new-message' };
        await store.saveOperation(operation);
      }
      return settle(state, await tools.resume(operation));
    }
    return { ...resetPause, pending: null, pendingText: '', observation: null, history: appendHistory(state.history, NOTES.manualResume) };
  }

  async function decide(original: State, invoke: ModelInvoker): Promise<Partial<State>> {
    const live = await store.task();
    const revision = live?.instructions?.length ?? 0;
    const state = { ...original, taskNotes: original.taskNotes ?? live?.taskNotes ?? '', history: original.history ?? [], rounds: original.rounds ?? 0, pause: original.pause ?? null, revision,
      noProgress: revision > (original.revision ?? 0) ? 0 : original.noProgress ?? 0 };
    if (state.noProgress >= NO_PROGRESS_LIMIT) return pause(state, { kind: 'stalled' });
    await update({ elapsedMs: deps.elapsed() }, decisionProgress(state));
    const naming = state.rounds === 0 && turn === 0 && !live?.title ? context.name(task.goal) : undefined;
    let reply;
    try { reply = await context.request('decide', state, live, invoke); }
    finally { await naming; }
    signal.throwIfAborted();
    const next = { ...state, rounds: state.rounds + 1 };
    if (((await store.task())?.instructions?.length ?? 0) !== revision) return { rounds: next.rounds, pending: null, history: appendHistory(state.history, NOTES.newMessage) };
    if ((reply.tool_calls?.length ?? 0) > 1) return { ...next, ...feedback(next, 'You returned multiple tool calls. None were executed. Call exactly one tool, then inspect its result.') };
    const pending = reply.tool_calls?.[0]; const said = reply.content?.trim();
    if (!pending) {
      const usedTools = state.history.some(entry => entry.kind === 'observation' && entry.action.tool !== 'ask_user');
      if (said && !usedTools) return { ...next, pending: null, resultText: formatTaskResult(said, live?.visitedUrls), outcome: 'success', verification: '', blocked: '' };
      return { ...next, ...feedback(next, NOTES.noToolCall(said)) };
    }
    if (!tools.has(pending.function.name) && !Object.hasOwn(controlSchemas, pending.function.name)) return { ...next, ...feedback(next, NOTES.unauthorizedTool) };
    if (said && (tools.has(pending.function.name) || pending.function.name === 'update_task_notes') && !alreadyShown(live, said)) await store.append({ id: `assistant:${turn}:${next.rounds}`, turn, role: 'assistant', kind: 'message', content: said });
    return { ...next, pending, pendingText: said ?? '', blocked: '', observation: null };
  }

  async function act(state: State): Promise<Partial<State>> {
    if (((await store.task())?.instructions?.length ?? 0) !== state.revision) return settle(state, { error: msg('step.newMessageBeforeAction') });
    const call = state.pending!;
    if (call.function.name === 'load_skill') {
      const skill = (await store.task())?.skill;
      if (!skill) return feedback(state, 'No skill was selected for this conversation. Continue using the task and current observations.');
      if (state.loadedSkill) return feedback(state, 'The selected skill is already loaded in context. Continue the task.');
      await update({}, msg('skills.loaded', { name: skill.name }));
      return { ...observe(state, { note: 'Selected skill loaded. Read loadedSkill in context; verify each step using current observations.' }), loadedSkill: skill };
    }
    if (call.function.name === 'update_task_notes') {
      const notes = controlSchemas.update_task_notes.safeParse(parseArguments(call));
      if (!notes.success) return feedback(state, NOTES.invalidTaskNotes);
      if (notes.data.notes === state.taskNotes) return feedback(state, 'Task notes are unchanged. Continue the task instead of saving the same notes again.');
      await update({ taskNotes: notes.data.notes }, msg('step.notesSaved'));
      return { ...observe(state, { note: 'Task notes saved. The latest version is included in taskNotes on subsequent requests.' }), taskNotes: notes.data.notes };
    }
    if (call.function.name === 'finish_task') {
      const finish = controlSchemas.finish_task.safeParse(parseArguments(call));
      if (!finish.success) return feedback(state, NOTES.invalidFinish);
      await update({}, msg('step.finishing'));
      return { pending: null, pendingText: '', blocked: '', resultText: formatTaskResult(finish.data.answer, (await store.task())?.visitedUrls), outcome: finish.data.outcome, verification: finish.data.verification };
    }
    if (call.function.name === 'ask_user') {
      const question = controlSchemas.ask_user.safeParse(parseArguments(call));
      if (!question.success) return feedback(state, NOTES.emptyQuestion);
      await store.append({ id: `question:${turn}:${state.rounds}`, turn, role: 'assistant', kind: 'question', content: question.data.question });
      return { blocked: question.data.question, observation: { question: question.data.question, instructionCount: state.revision } };
    }
    return settle(state, await tools.execute(call, state));
  }

  function toolResult(patch: Partial<State>, id: string, name: string) {
    const message = new ToolMessage({ tool_call_id: id, name,
      content: JSON.stringify(forModel(patch.observation ?? patch.history?.at(-1) ?? { result: patch.resultText ?? patch.blocked ?? '' })),
      status: name === 'finish_task' && !patch.resultText ? 'error' : 'success' });
    return new Command({ update: { ...patch, messages: [message] } });
  }

  const registered = [...tools.definitions, ...controlTools].map(({ function: definition }) => tool(
    async (_input, runtime: ToolRuntime<State>) => {
      const state = runtime.state;
      signal.throwIfAborted();
      const patch = await debugSpan(deps.debug, 'tool.dispatch', state.pending, () => act(state));
      // The tool call's ID includes its persisted round, even if a provider reuses IDs.
      return toolResult(patch, runtime.toolCallId, definition.name);
    },
    { name: definition.name, description: definition.description, schema: definition.parameters, returnDirect: definition.name === 'finish_task' },
  ));

  const middleware = createMiddleware({
    name: 'TaskLifecycle', stateSchema: AgentState,
    wrapModelCall: async (request, handler) => {
      signal.throwIfAborted();
      const state = AgentState.parse(request.state);
      let patch: Partial<State>;
      if (state.blocked) {
        // Only a wake-up signal crosses the interrupt. Approval decisions are read from the store.
        interruptTask({ kind: 'task', blocked: state.blocked, pause: state.pause, observation: state.observation }, request.runtime.configurable);
        patch = await debugSpan(deps.debug, 'agent.resume', state, () => resume(state));
      } else {
        try {
          patch = await debugSpan(deps.debug, 'agent.decide', state, () => decide(state, async (model, messages, options) => handler({
            ...request, model, messages, systemPrompt: '', systemMessage: undefined,
            modelSettings: { ...options, parallel_tool_calls: false },
          })));
        } catch (error) {
          signal.throwIfAborted();
          if (!(error instanceof TokenLimitError)) throw error;
          patch = await pause(state, { kind: 'tokens', limit: error.limit });
        }
      }
      return new Command({ update: { ...patch, messages: clearMessages() } });
    },
    afterModel: {
      canJumpTo: ['model', 'end'],
      hook: state => {
        // Structured, budgeted history is authoritative; keep only the current dispatch
        // message in createAgent's channel instead of a second unbounded transcript.
        if (state.blocked || !state.pending || state.resultText) return { jumpTo: state.resultText ? 'end' : 'model' };
        return { messages: [new AIMessage({ content: state.pendingText ?? '',
          tool_calls: [{ id: `${state.rounds}:${state.pending.id}`, name: state.pending.function.name, args: parseArguments(state.pending) ?? {}, type: 'tool_call' }] })] };
      },
    },
    // Executor failures must reach the runner instead of becoming retryable tool text.
    wrapToolCall: async (request, handler) => {
      signal.throwIfAborted();
      const state = request.state;
      const call = state.pending!;
      // Preserve field-level repair feedback before LangChain's schema validator runs.
      const invalid = tools.validate(call);
      if (invalid) return toolResult(await settle(state, invalid), request.toolCall.id!, request.toolCall.name);
      if (call.function.name === 'finish_task' && !controlSchemas.finish_task.safeParse(parseArguments(call)).success)
        return toolResult(feedback(state, NOTES.invalidFinish), request.toolCall.id!, call.function.name);
      if (call.function.name === 'ask_user' && !controlSchemas.ask_user.safeParse(parseArguments(call)).success)
        return toolResult(feedback(state, NOTES.emptyQuestion), request.toolCall.id!, call.function.name);
      if (call.function.name === 'update_task_notes' && !controlSchemas.update_task_notes.safeParse(parseArguments(call)).success)
        return toolResult(feedback(state, NOTES.invalidTaskNotes), request.toolCall.id!, call.function.name);
      if (call.function.name === 'load_skill' && !controlSchemas.load_skill.safeParse(parseArguments(call)).success)
        return toolResult(feedback(state, 'load_skill takes an empty object: {}.'), request.toolCall.id!, call.function.name);
      return handler(request);
    },
  });
  return createAgent({ model: deps.model, tools: registered, middleware: [middleware], checkpointer: deps.checkpointer, signal });
}

function parseArguments(call: ToolCall): Record<string, unknown> | undefined {
  try { return JSON.parse(call.function.arguments); } catch { return undefined; }
}

// Browsers have no AsyncLocalStorage. LangGraph's interrupt is synchronous, so
// explicitly scope its runtime config to this call and restore it even on throw.
// This fallback never carries context across awaits; Node keeps its native storage.
let synchronousContext: unknown;
const interruptContext = {
  getStore: () => synchronousContext,
  run<T>(value: unknown, callback: () => T): T {
    const previous = synchronousContext; synchronousContext = value;
    try { return callback(); } finally { synchronousContext = previous; }
  },
  enterWith(value: unknown) { synchronousContext = value; },
};
function interruptTask(value: unknown, configurable: RunnableConfig['configurable']) {
  AsyncLocalStorageProviderSingleton.initializeGlobalInstance(interruptContext);
  return AsyncLocalStorageProviderSingleton.runWithConfig({ configurable }, () => interrupt(value));
}
