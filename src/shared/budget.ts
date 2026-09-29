import type { Task } from './types';
import { LocalizedError } from '../i18n';

/** Missing values opt out. Old executionLimits are deliberately not adopted. */
export const TOKEN_LIMIT = { min: 50_000, max: 5_000_000, reserve: 8_000, output: 8_000, summaryOutput: 2_000 } as const;
export function normalizeTokenLimit(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= TOKEN_LIMIT.min && value <= TOKEN_LIMIT.max ? value : undefined;
}
export function validateTokenLimit(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const limit = normalizeTokenLimit(value);
  if (limit === undefined) throw new LocalizedError('limits.tokenRange', { min: TOKEN_LIMIT.min, max: TOKEN_LIMIT.max });
  return limit;
}
export const turnTokens = (task: Task) => task.usage?.turn === (task.turn ?? 0) ? task.usage.turnTokens ?? 0 : 0;
export class TokenLimitError extends LocalizedError {
  constructor(public limit: number) { super('pause.tokens'); }
}
