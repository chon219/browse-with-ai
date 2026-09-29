/**
 * Stands in for the LangSmith SDK, which @langchain/core imports for tracing (vite.config.ts aliases
 * 'langsmith', 'langsmith/run_trees' and 'langsmith/singletons/traceable' here). The extension never
 * enables tracing: core turns it on only from LANGSMITH_TRACING / LANGCHAIN_TRACING environment
 * variables, which extension pages do not have. So this keeps just what core touches with tracing
 * off, behaving as langsmith 0.x does, and nothing that could send data to LangSmith.
 * A symbol core starts importing and this file lacks fails the build instead of being left out.
 */

/** Core creates one lazily and awaits its pending batches when flushing callbacks; there are none. */
export class Client {
  awaitPendingTraceBatches() { return Promise.resolve(); }
}

export const isRunTree = x => x != null && typeof x.createChild === 'function' && typeof x.postRun === 'function';

/** Core builds untraced run trees only to carry its config through async local storage. */
export class RunTree {
  constructor(config) {
    if (isRunTree(config)) { Object.assign(this, { ...config }); return; }
    const { metadata, ...rest } = config;
    Object.assign(this, rest, { extra: { ...rest.extra, metadata: { ...metadata, ...rest.extra?.metadata } } });
  }
  createChild(config) { return new RunTree({ ...config, parent_run: this, tracingEnabled: this.tracingEnabled }); }
  async postRun() {}
  async patchRun() {}
  async end() {}
}

export const getDefaultProjectName = () => 'default';

export function convertToDottedOrderFormat(epoch, runId, executionOrder = 1) {
  const microsecondPrecisionDatestring = `${new Date(epoch).toISOString().slice(0, -1)}${executionOrder.toFixed(0).slice(0, 3).padStart(3, '0')}Z`;
  return { dottedOrder: microsecondPrecisionDatestring.replace(/[-:.]/g, '') + runId, microsecondPrecisionDatestring };
}

export const isTraceableFunction = x => typeof x === 'function' && 'langsmith:traceable' in x;

/** The run tree of the enclosing traceable function: never set here, as nothing is traceable. */
export function getCurrentRunTree(permitAbsentRunTree = false) {
  const runTree = globalThis[Symbol.for('ls:tracing_async_local_storage')]?.getStore();
  if (!permitAbsentRunTree && runTree === undefined) throw new Error('Could not get the current run tree.');
  return runTree;
}
