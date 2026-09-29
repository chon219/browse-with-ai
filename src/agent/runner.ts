import { createExtensionAgent } from './extension-agent';
import { Command as ResumeCommand, REMOVE_ALL_MESSAGES } from '@langchain/langgraph/web';
import { RemoveMessage } from '@langchain/core/messages';
import { convertDocument, runCode } from './code-runner';
import { imageDataUrl } from './images';
import { readBytes } from '../storage/workspace';
import { allTasks, completeTurn, getTask, patchTask, recordElapsed } from '../storage/db';
import { threadId } from '../shared/conversation';
import { loadConfig } from '../storage/settings';
import { normalizeTokenLimit } from '../shared/budget';
import { GRAPH_RECURSION_LIMIT } from '../shared/tuning';
import { isFinished, type Command, type RpcResult, type Task } from '../shared/types';
import { errorText, LocalizedError, msg, t } from '../i18n';
import { createDebugSink } from '../storage/debug';
import { debugEvent, type DebugSink } from '../shared/debug';

let current: { id: string; controller: AbortController } | undefined;
/** Closing or reloading the page while a task runs here pauses it, so ask first. Browsers only show this after the user has interacted with the page. */
const confirmLeave = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
const allowLeaving = () => window.removeEventListener('beforeunload', confirmLeave);
/** A pause or cancel is under way: the task stops either way, so closing the page no longer needs a prompt. */
export function releaseClose(taskId: string) { if (current?.id === taskId) allowLeaving(); }
export function stopTask(taskId: string) { if (current?.id === taskId) { allowLeaving(); current.controller.abort(); } }
/**
 * Run a task until it finishes, pauses or needs the user. Resolves to false when it could not start
 * because another task runs in this page or another task page holds the runner lock.
 */
export async function runTask(taskId: string): Promise<boolean> {
  if (current) return current.id === taskId;
  return navigator.locks.request('bwai-task-runner', { ifAvailable: true }, async lock => {
    if (!lock) return false;
    const task = await getTask(taskId); if (!task || isFinished(task.status)) return true;
    const turn = task.turn ?? 0;
    // Status changes check the current status in the same transaction, so a pause or cancel from the user always wins.
    const update = (patch: Partial<Task>, step?: Parameters<typeof patchTask>[2], onlyIf?: (task: Task) => boolean) => patchTask(taskId, patch, step, turn, onlyIf);
    const whileRunning = (live: Task) => live.status === 'running';
    let claimed = false;
    history.replaceState(null, '', chrome.runtime.getURL('task.html') + '?task=' + encodeURIComponent(taskId));
    const controller = new AbortController(); current = { id: taskId, controller };
    window.addEventListener('beforeunload', confirmLeave);
    const started = Date.now(); const elapsed = () => task.elapsedMs + Date.now() - started;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let debug: DebugSink | undefined;
    try {
      const config = await loadConfig();
      task.tokenLimit = normalizeTokenLimit(config.tokenLimit);
      debug = createDebugSink(taskId, turn, config.debug === true, config.apiKey);
      await debugEvent(debug, 'runner.start', { status: task.status, threadId: threadId(task), tokenLimit: task.tokenLimit, model: config.model });
      if (!config.apiKey || !config.model) throw new LocalizedError('runner.configureFirst');
      if ((await update({ status: 'running', error: undefined, pause: undefined, tokenLimit: task.tokenLimit }, msg(task.status === 'ready' ? 'runner.started' : 'runner.resumed'), live => live.status === task.status)).status !== 'running') return true;
      claimed = true;
      heartbeat = setInterval(() => { void recordElapsed(taskId, elapsed(), turn).catch(() => controller.abort()); }, 10_000);
      const agent = createExtensionAgent({ task, config, signal: controller.signal, elapsed, debug,
        runCode: code => runCode(taskId, code, controller.signal),
        loadImage: path => imageDataUrl(taskId, path),
        readDocument: async (path, kind) => convertDocument(await readBytes(taskId, path), kind, controller.signal),
        browser: async (action, requestId) => {
          controller.signal.throwIfAborted();
          const reply = await chrome.runtime.sendMessage({ type: 'tool', taskId, turn, requestId, action, search: config.search } satisfies Command) as RpcResult;
          if (!reply?.ok) throw new Error(reply?.error ?? t('runner.toolChannelFailed'));
          return reply.result!;
        } });
      const invokeConfig = { configurable: { thread_id: threadId(task) }, recursionLimit: GRAPH_RECURSION_LIMIT, signal: controller.signal, durability: 'sync' as const };
      while (true) {
        controller.signal.throwIfAborted();
        const live = await getTask(taskId);
        if (!live || (live.turn ?? 0) !== turn || ['paused', 'cancelled'].includes(live.status)) break;
        if (live.status === 'ready') await update({ status: 'running' }, undefined, latest => latest.status === 'ready');
        const snapshot = await agent.graph.getState(invokeConfig);
        let restart = false;
        await debugEvent(debug, 'runner.checkpoint', { next: snapshot.next, createdAt: snapshot.createdAt, values: snapshot.values });
        if (snapshot.values?.resultText && !snapshot.next.length) {
          const values = snapshot.values; const outcome = values.outcome ?? 'success';
          const committed = await completeTurn(taskId, turn, values.revision ?? 0, { status: outcome === 'success' ? 'completed' : 'incomplete', outcome, pendingApproval: undefined, pendingQuestion: undefined, pause: undefined, resultText: values.resultText, elapsedMs: elapsed() });
          await debugEvent(debug, 'runner.complete', { committed, outcome, revision: values.revision });
          if (committed) break;
          const latest = await getTask(taskId);
          if (!latest || (latest.turn ?? 0) !== turn || ['paused', 'cancelled'].includes(latest.status)) break;
          restart = true;
        }
        // A rejected final result restarts through one input checkpoint. Keep the
        // observations and round IDs, and remove the previous returnDirect tool.
        const input: Parameters<typeof agent.invoke>[0] = restart ? { ...snapshot.values,
          messages: [new RemoveMessage({ id: REMOVE_ALL_MESSAGES })], resultText: '', pending: null, observation: null, blocked: '' }
          : !snapshot.createdAt ? { messages: [], goal: task.turnGoal ?? task.goal, history: [], rounds: 0, blocked: '', resultText: '', revision: 0 }
          : snapshot.tasks.some(task => task.interrupts?.length) ? new ResumeCommand({ resume: true }) : null;
        const result = await agent.invoke(input, invokeConfig);
        controller.signal.throwIfAborted();
        const after = await agent.graph.getState(invokeConfig);
        await debugEvent(debug, 'runner.checkpoint.saved', { next: after.next, createdAt: after.createdAt, values: after.values });
        if (after.tasks.some(task => task.interrupts?.length)) {
          if (result.pause) {
            if (result.pause.kind === 'stalled' && ((await getTask(taskId))?.instructions?.length ?? 0) > (result.revision ?? 0)) continue;
            await update({ status: 'paused', pause: result.pause, pendingApproval: undefined, pendingQuestion: undefined, error: result.blocked, elapsedMs: elapsed() }, result.blocked, whileRunning);
            break;
          }
          const latest = await getTask(taskId);
          if ((latest?.instructions?.length ?? 0) > (result.revision ?? 0)) continue;
          await update({ status: 'blocked', pendingApproval: result.observation?.approval, pendingQuestion: result.observation?.question, error: result.blocked, elapsedMs: elapsed() }, undefined, whileRunning);
          break;
        }
        // Completion is committed atomically at the top of the loop, after checking for new messages.
      }
    } catch (e) {
      await debugEvent(debug, 'runner.error', { error: e, aborted: controller.signal.aborted });
      const latest = await getTask(taskId);
      if (!latest) return true;
      if (controller.signal.aborted) {
        // A cancel stays a cancel; anything else still under way here becomes a pause. Finished and ready tasks are left alone.
        await update({ elapsedMs: elapsed() }, msg('runner.stopped'), live => live.status === 'cancelled');
        await update({ status: 'paused', elapsedMs: elapsed() }, msg('runner.stopped'), live => live.status !== 'ready' && !isFinished(live.status));
      } else await update({ status: 'error', error: errorText(e, 'runner.failed'), elapsedMs: elapsed() }, undefined, claimed ? whileRunning : live => live.status === task.status);
    } finally {
      await debugEvent(debug, 'runner.stop', { aborted: controller.signal.aborted, elapsedMs: elapsed() });
      if (heartbeat) clearInterval(heartbeat); current = undefined;
      allowLeaving();
      if ((await getTask(taskId))?.status === 'ready') setTimeout(() => void startTask(taskId), 0);
    }
    return true;
  });
}
/**
 * Start a task; callers need not wait. Resolves to false when it could not start: another task page holds the
 * runner lock (that page handles its own tasks), or this page runs another task, which then pauses this one with a notice.
 */
export async function startTask(taskId: string): Promise<boolean> {
  try {
    const started = await runTask(taskId);
    if (!started && current && current.id !== taskId) await patchTask(taskId, { status: 'paused' }, msg('app.pauseRunningFirst'), undefined, live => live.status === 'ready');
    return started;
  } catch (error) { console.error('BWAI task runner failed', error); return false; }
}
export function installRunner() {
  chrome.runtime.onMessage.addListener((message: Command, sender) => {
    if (sender.id !== chrome.runtime.id) return;
    if (message.type === 'taskDeleted') { stopTask(message.taskId); return; }
    if (message.type === 'control') {
      if (message.command === 'start') void startTask(message.taskId);
      else stopTask(message.taskId);
    }
  });
}
export async function recoverStaleTasks() {
  await navigator.locks.request('bwai-task-runner', { ifAvailable: true }, async lock => {
    if (!lock) return;
    for (const task of await allTasks()) if (task.status === 'running') await patchTask(task.id, { status: 'paused' }, msg('runner.stalePage'), undefined, live => live.status === 'running');
  });
}
