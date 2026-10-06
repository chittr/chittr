export const providerIds = ['codex', 'claude', 'grok', 'antigravity'] as const;
export type Provider = (typeof providerIds)[number];
export const providers: Record<Provider, { label: string; command: string }> = {
  codex: { label: 'Codex CLI', command: 'codex' },
  claude: { label: 'Claude Code', command: 'claude' },
  grok: { label: 'Grok Build', command: 'grok' },
  antigravity: { label: 'Antigravity CLI', command: 'agy' },
};
// The providers this preview supports. Setup offers and doctor checks only these;
// Antigravity can still be configured in YAML.
export const supportedProviders: readonly Provider[] = ['codex', 'claude', 'grok'];

// CLI-level vocabulary. Individual models can advertise a smaller set at startup.
export const providerEfforts: Record<Provider, readonly string[]> = {
  codex: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
  grok: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  antigravity: ['low', 'medium', 'high'],
};

export function effortError(
  provider: Provider,
  effort: string,
  accepted: readonly string[] = providerEfforts[provider],
  model?: string,
): string | undefined {
  if (accepted.includes(effort)) return undefined;
  return `Unsupported effort ${JSON.stringify(effort)} for ${provider}${model ? ` model ${JSON.stringify(model)}` : ''}. Accepted values: ${accepted.length ? accepted.join(', ') : 'none; this model does not support effort'}. Omit effort to use the provider default.`;
}
