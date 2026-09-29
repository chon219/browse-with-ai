/** Optional tracing port: diagnostics must never change execution outcomes. */
export type DebugSink = (event: string, data: unknown) => Promise<void>;

export async function debugEvent(sink: DebugSink | undefined, event: string, data: unknown) {
  try { await sink?.(event, data); } catch { /* A diagnostic failure cannot fail the task. */ }
}

export async function debugSpan<T>(sink: DebugSink | undefined, event: string, input: unknown, run: () => Promise<T>): Promise<T> {
  if (!sink) return run();
  const callId = crypto.randomUUID(); const started = Date.now();
  await debugEvent(sink, event + '.start', { callId, input });
  try {
    const result = await run();
    await debugEvent(sink, event + '.result', { callId, durationMs: Date.now() - started, result });
    return result;
  } catch (error) {
    await debugEvent(sink, event + '.error', { callId, durationMs: Date.now() - started, error });
    throw error;
  }
}
