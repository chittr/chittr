import type { ContextUsage } from './types.js';

export function contextUsage(used: unknown, limit?: unknown): ContextUsage | undefined {
  if (typeof used !== 'number' || !Number.isSafeInteger(used) || used < 0) return;
  return {
    usedTokens: used,
    ...(typeof limit === 'number' && Number.isSafeInteger(limit) && limit > 0
      ? { maxTokens: limit }
      : {}),
    updatedAt: new Date().toISOString(),
  };
}

export function contextPercent(usage?: ContextUsage): number | undefined {
  return usage?.maxTokens ? (usage.usedTokens / usage.maxTokens) * 100 : undefined;
}

export function formatContextUsage(usage?: ContextUsage): string {
  if (!usage) return 'unavailable';
  const used = usage.usedTokens.toLocaleString('en-GB');
  const percent = contextPercent(usage);
  return percent === undefined
    ? `${used} tokens · limit unavailable`
    : `${used} / ${usage.maxTokens!.toLocaleString('en-GB')} tokens · ${percent.toFixed(1)}% used`;
}
