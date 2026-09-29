/** A complete Chat Completions HTTP response, shared by transport and agent tests. */
export function modelResponse(payload: Record<string, unknown>): Response {
  const choices = payload.choices as Array<{ message?: Record<string, unknown> }> | undefined;
  return new Response(JSON.stringify({ id: crypto.randomUUID(), object: 'chat.completion', created: 0, model: 'mock', ...payload,
    ...(choices ? { choices: choices.map((choice, index) => ({ index, finish_reason: 'stop', ...choice, message: { role: 'assistant', ...choice.message } })) } : {}),
  }), { headers: { 'Content-Type': 'application/json' } });
}
