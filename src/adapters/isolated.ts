import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { builtFile, ToolService, toolInputs } from '../tools.js';
import type { AgentConfig, RoomConfig } from '../types.js';
import { commandMode } from '../command-access.js';
import type { AttachmentAccess } from '../attachments.js';

export const roomToolNames = Object.keys(toolInputs);

// Native configuration discovery happens in an empty home and workspace. Only
// the MCP task tools receive the real launch directory and permission policy.
export class IsolatedRuntime {
  readonly directory = realpathSync(mkdtempSync(join(tmpdir(), 'chittr-provider-')));
  readonly home = join(this.directory, 'home');
  readonly cwd = join(this.directory, 'workspace');
  readonly tools: ToolService;
  constructor(
    private agent: AgentConfig,
    config: RoomConfig,
    environment = { ...process.env },
    attachments?: AttachmentAccess,
  ) {
    mkdirSync(this.home);
    mkdirSync(this.cwd);
    this.tools = new ToolService(
      config.workspace,
      config.permissions,
      undefined,
      config.skills?.enabled === false ? [] : agent.skills?.bundles,
      { mode: commandMode(config), environment },
      undefined,
      attachments,
    );
  }
  async mcp() {
    return {
      command: process.execPath,
      args: [builtFile('mcp.js'), JSON.stringify(await this.tools.mcpSettings(this.agent.id))],
    };
  }
  close(): void {
    this.tools.close();
    rmSync(this.directory, { recursive: true, force: true });
  }
}
