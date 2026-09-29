/** Model token usage of a conversation, as reported by the model service or estimated when it reports none. */
export interface TokenUsage {
  /** Input and output tokens of every model request in the conversation. */
  promptTokens: number; completionTokens: number; requests: number;
  /** Input tokens of the most recent request: how much context the model was last given. */
  contextTokens: number;
  /** Some figures are estimates because the service did not report usage. */
  estimated?: boolean;
  /** Input and output tokens of the turn `turn`, for the per-turn token budget. */
  turn?: number; turnTokens?: number;
}
export interface RequestUsage { prompt: number; completion: number; estimated?: boolean }

/** A rough token count: about one token per CJK character and four characters per token otherwise. */
export function estimateTokens(text: string): number {
  const wide = text.match(/[\u3000-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/g)?.length ?? 0;
  return Math.ceil(wide + (text.length - wide) / 4);
}
export function addUsage(usage: TokenUsage | undefined, request: RequestUsage, turn = 0): TokenUsage {
  return {
    turn, turnTokens: (usage?.turn === turn ? usage.turnTokens ?? 0 : 0) + request.prompt + request.completion,
    promptTokens: (usage?.promptTokens ?? 0) + request.prompt,
    completionTokens: (usage?.completionTokens ?? 0) + request.completion,
    requests: (usage?.requests ?? 0) + 1,
    contextTokens: request.prompt,
    ...(usage?.estimated || request.estimated ? { estimated: true } : {}),
  };
}
