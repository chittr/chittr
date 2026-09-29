import type { AgentAdapter, AgentConfig, RoomConfig } from '../types.js';
import { CodexAdapter } from './codex.js';
import { GrokAdapter } from './grok.js';
import { AntigravityAdapter } from './antigravity.js';
import { ClaudeAdapter } from './claude.js';
import type { AttachmentAccess } from '../attachments.js';
export function createAdapter(
  agent: AgentConfig,
  config: RoomConfig,
  environment = { ...process.env },
  attachments?: AttachmentAccess,
): AgentAdapter {
  if (agent.provider === 'grok') return new GrokAdapter(agent, config, environment, attachments);
  if (agent.provider === 'antigravity')
    return new AntigravityAdapter(agent, config, environment, attachments);
  return agent.provider === 'codex'
    ? new CodexAdapter(agent, config, environment, attachments)
    : new ClaudeAdapter(agent, config, environment, attachments);
}
