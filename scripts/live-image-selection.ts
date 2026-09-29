import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { commandMode, resolveCommandAccess } from '../src/command-access.js';
import { discoverSkills } from '../src/skills.js';
import { ClaudeAdapter } from '../src/adapters/claude.js';
import { GrokAdapter } from '../src/adapters/grok.js';
import { CodexAdapter } from '../src/adapters/codex.js';
import { ToolService } from '../src/tools.js';
import { observeCodex } from './codex-native-observer.mjs';
import { createAdapter } from '../src/adapters/index.js';
import { IsolatedRuntime } from '../src/adapters/isolated.js';
import { JsonLinesProcess } from '../src/process.js';
import type { AgentAdapter, AgentConfig, RoomConfig } from '../src/types.js';
import type { AttachmentAccess } from '../src/attachments.js';

export function liveImageSelection(args = process.argv.slice(2)) {
  const { values } = parseArgs({
    args,
    options: {
      adapter: { type: 'string', default: 'grok' },
      model: { type: 'string', default: 'provider-default' },
      effort: { type: 'string', default: 'provider-default' },
      room: { type: 'string', default: 'restricted' },
      'trusted-commands': { type: 'boolean', default: false },
      'scratch-parent': { type: 'string', default: '/private/tmp' },
      'fresh-route': { type: 'string', default: 'checkpoint' },
      'evidence-issue': { type: 'string' },
    },
  });
  if (values['evidence-issue'] !== undefined && values['evidence-issue'] !== '57')
    throw new Error('Unavailable: --evidence-issue accepts only 57, the integrated acceptance');
  if (
    !['checkpoint', 'saved-room'].includes(values['fresh-route']!) ||
    (values['fresh-route'] === 'saved-room' && !['claude', 'codex'].includes(values.adapter!))
  )
    throw new Error('Unavailable: saved-room fresh start is a Claude and Codex verification route');
  if (!['grok', 'codex', 'claude', 'antigravity'].includes(values.adapter!))
    throw new Error('Unavailable: unknown adapter selection');
  if (!['restricted', 'trusted'].includes(values.room!))
    throw new Error('Unavailable: room must be restricted or trusted');
  if (
    (values['trusted-commands'] && values.room !== 'trusted') ||
    (values.adapter !== 'grok' && values['trusted-commands'] !== (values.room === 'trusted'))
  )
    throw new Error(
      'Unavailable: trusted room requires explicit --trusted-commands; restricted room cannot grant it',
    );
  const permissions = {
    edits: values.room === 'trusted',
    commands: values.room === 'trusted',
    network: values.room === 'trusted',
  };
  return {
    adapter: values.adapter as AgentConfig['provider'],
    freshRoute: values['fresh-route'] as 'checkpoint' | 'saved-room',
    model: values.model === 'provider-default' ? undefined : values.model,
    effort: values.effort === 'provider-default' ? undefined : values.effort,
    room: values.room as 'restricted' | 'trusted',
    evidenceIssue: values['evidence-issue'] === '57' ? (57 as const) : undefined,
    scratchParent: resolve(values['scratch-parent']!),
    permissions,
    skills: { enabled: values.room === 'trusted' },
    commandAccess: resolveCommandAccess(
      { permissions, provenance: {} },
      undefined,
      values['trusted-commands'],
    ),
  };
}
export type LiveImageSelection = ReturnType<typeof liveImageSelection>;

/** The acceptance ticket a new evidence record belongs to. The amended #69 owns
 * every new Grok run: the restricted, sandboxed-command and trusted-command rooms
 * on the installed CLI. #56's retained 1.0.30 records keep their own stamp and
 * are never relabelled; each run also records the command mode it resolved.
 * #57 reruns these same provider scripts on its one integrated build: only an
 * explicit `--evidence-issue 57` stamps a run as that ticket's, never a default.
 */
export function liveEvidenceIssue(
  selection: Pick<LiveImageSelection, 'adapter'> &
    Partial<Pick<LiveImageSelection, 'evidenceIssue'>>,
): number {
  if (selection.evidenceIssue) return selection.evidenceIssue;
  if (selection.adapter === 'codex') return 52;
  if (selection.adapter === 'claude') return 53;
  return 69;
}

/** A provider ticket supplies all these methods and its native observers together.
 * This is observation only: construction always uses the ordinary product factory.
 * No driver may register a script-only mapping or change the product support gate.
 */
export interface LiveImageDriver {
  create(
    agent: AgentConfig,
    config: RoomConfig,
    env: NodeJS.ProcessEnv | undefined,
    access: AttachmentAccess | undefined,
  ): AgentAdapter;
  tuple(adapter: AgentAdapter | undefined): unknown;
  policy(adapter: AgentAdapter | undefined, config: RoomConfig): unknown;
  observe(root: string, phase: () => string, events: object[]): () => void;
}
const grokDriver: LiveImageDriver = {
  create(agent, config, env, access) {
    return createAdapter(
      {
        ...agent,
        skills:
          config.skills?.enabled === false ? undefined : discoverSkills('grok', config.workspace),
      },
      config,
      env,
      access,
    );
  },
  tuple: (adapter) => (adapter instanceof GrokAdapter ? adapter.imageEvidence : undefined),
  policy(adapter, config) {
    const support = adapter?.imageSupport?.();
    const tuple = adapter instanceof GrokAdapter ? adapter.imageEvidence : undefined;
    if (!support?.initial.available || !support.retrieval.available || !tuple) return 'unknown';
    return {
      permissions: { ...tuple.permissions },
      skillsEnabled: tuple.skillsEnabled,
      commandMode: commandMode(config),
      commandModeSource: config.commandAccess?.source ?? 'permissions.commands',
      trustGrant: config.commandAccess?.source ?? null,
      blockedBy: config.commandAccess?.blockedBy ?? [],
      isolatedNativeProfile: true,
      effectiveRoomMcpInventoryVerified: true,
      nativeImageGenerationDisabled: true,
      skillBundleCount: tuple.skillBundleCount,
      evidenceSource:
        'live adapter tuple after inventory validation and accepted report; product-resolved command access',
    };
  },
  observe(root, phase, events) {
    const send = JsonLinesProcess.prototype.send;
    const mcp = IsolatedRuntime.prototype.mcp;
    JsonLinesProcess.prototype.send = function (value: any, ...rest: any[]) {
      const images = (value.params?.prompt ?? []).filter((x: any) => x.type === 'image');
      if (value.method === 'session/prompt')
        events.push({
          phase: phase(),
          boundary: 'initial-native-request',
          sessionId: value.params.sessionId,
          requestId: value.id,
          frameBytes: Buffer.byteLength(JSON.stringify(value)),
          associations: (value.params.prompt ?? [])
            .filter(
              (x: any) =>
                x.type === 'text' &&
                /^Chittr image for message #[a-zA-Z0-9-]+, attachment att-[a-f0-9]{32}\.$/.test(
                  x.text,
                ),
            )
            .map((x: any) => x.text),
          images: images.map((x: any) => ({
            mimeType: x.mimeType,
            byteSize: Buffer.from(x.data, 'base64').length,
            sha256: createHash('sha256').update(Buffer.from(x.data, 'base64')).digest('hex'),
          })),
        });
      // Forward every argument: Codex passes a final validator that must still run.
      return (send as any).call(this, value, ...rest);
    };
    IsolatedRuntime.prototype.mcp = async function () {
      const original = await mcp.call(this);
      return {
        command: process.execPath,
        args: [
          resolve('scripts/attachment-mcp-observer.mjs'),
          join(root, `${phase()}-mcp.jsonl`),
          original.command,
          ...original.args,
        ],
      };
    };
    return () => {
      JsonLinesProcess.prototype.send = send;
      IsolatedRuntime.prototype.mcp = mcp;
    };
  },
};
const claudeDriver: LiveImageDriver = {
  create(agent, config, env, access) {
    return createAdapter(
      {
        ...agent,
        skills:
          config.skills?.enabled === false ? undefined : discoverSkills('claude', config.workspace),
      },
      config,
      env,
      access,
    );
  },
  tuple: (adapter) => (adapter instanceof ClaudeAdapter ? adapter.imageEvidence : undefined),
  policy(adapter, config) {
    if (!(adapter instanceof ClaudeAdapter)) return 'unknown';
    const evidence = adapter.imageEvidence;
    return {
      permissions: evidence.permissions,
      skillsEnabled: evidence.skillsEnabled,
      commandMode: evidence.commandMode,
      commandModeSource: evidence.commandModeSource,
      trustGrant: config.commandAccess?.source ?? null,
      nativeInventoryVerified: evidence.nativeInventoryVerified,
      skillBundleCount: evidence.skillBundleCount,
      nativePolicy:
        'restricted; native tools empty; Skill/Agent/Task denied; strict MCP; dontAsk; inherited settings/hooks/plugins disabled',
      evidenceSource: 'product-resolved host policy and live native init inventory',
    };
  },
  observe(root, phase, events) {
    const send = JsonLinesProcess.prototype.send;
    const emit = JsonLinesProcess.prototype.emit;
    const mcp = ClaudeAdapter.prototype.mcpServer;
    const images = (value: any): object[] => {
      if (!value || typeof value !== 'object') return [];
      if (value.type === 'image' && (value.source?.type === 'base64' || value.data)) {
        const bytes = Buffer.from(value.source?.data ?? value.data, 'base64');
        return [
          {
            mimeType: value.source?.media_type ?? value.mimeType,
            byteSize: bytes.length,
            sha256: createHash('sha256').update(bytes).digest('hex'),
          },
        ];
      }
      return Object.values(value).flatMap(images);
    };
    JsonLinesProcess.prototype.send = function (value: any, ...rest: any[]) {
      if (value.type === 'user') {
        const found = images(value.message?.content);
        events.push({
          phase: phase(),
          boundary: 'initial-native-request',
          sessionId: value.session_id,
          requestId: value.uuid,
          frameBytes: Buffer.byteLength(JSON.stringify(value)),
          images: found,
          associations: (Array.isArray(value.message?.content) ? value.message.content : [])
            .filter(
              (x: any) =>
                x.type === 'text' &&
                /^Chittr image for message #[a-zA-Z0-9-]+, attachment att-[a-f0-9]{32}\.$/.test(
                  x.text,
                ),
            )
            .map((x: any) => x.text),
        });
      }
      // Forward every argument: Codex passes a final validator that must still run.
      return (send as any).call(this, value, ...rest);
    };
    JsonLinesProcess.prototype.emit = function (name: string | symbol, ...args: any[]) {
      const value = args[0];
      if (name === 'message' && value?.type === 'user') {
        events.push({
          phase: phase(),
          boundary: 'native-user-replay',
          sessionId: value.session_id,
          requestId: value.uuid,
          parentToolUseId: value.parent_tool_use_id,
          frameBytes: Buffer.byteLength(JSON.stringify(value)),
          images: images(value),
        });
      }
      return emit.call(this, name, ...args);
    };
    ClaudeAdapter.prototype.mcpServer = async function (tools) {
      const original = await mcp.call(this, tools);
      return {
        command: process.execPath,
        args: [
          resolve('scripts/attachment-mcp-observer.mjs'),
          join(root, `${phase()}-mcp.jsonl`),
          original.command,
          ...original.args,
        ],
      };
    };
    return () => {
      JsonLinesProcess.prototype.send = send;
      JsonLinesProcess.prototype.emit = emit;
      ClaudeAdapter.prototype.mcpServer = mcp;
    };
  },
};
const codexDriver: LiveImageDriver = {
  create(agent, config, env, access) {
    return createAdapter(
      {
        ...agent,
        skills:
          config.skills?.enabled === false ? undefined : discoverSkills('codex', config.workspace),
      },
      config,
      env,
      access,
    );
  },
  tuple: (adapter) => (adapter instanceof CodexAdapter ? adapter.imageEvidence : undefined),
  policy(adapter, config) {
    if (!(adapter instanceof CodexAdapter)) return 'unknown';
    const tuple = adapter.imageEvidence;
    return {
      permissions: tuple.permissions,
      skillsEnabled: tuple.skillsEnabled,
      skillBundleCount: tuple.skillBundleCount,
      commandMode: tuple.commandMode,
      commandModeSource: config.commandAccess?.source ?? 'permissions.commands',
      nativePolicy: tuple.policy,
      nativePolicyVerified: tuple.nativePolicyVerified,
    };
  },
  observe(_root, phase, events) {
    return observeCodex(JsonLinesProcess, ToolService, (event: object) =>
      events.push({ phase: phase(), ...event }),
    );
  },
};
export function liveImageDriver(selection: LiveImageSelection): LiveImageDriver {
  if (selection.adapter === 'grok') return grokDriver;
  if (selection.adapter === 'claude') return claudeDriver;
  if (selection.adapter === 'codex') return codexDriver;
  const blockers = {
    antigravity:
      '#54 evidence, Bill version/configuration decision and #55 native mapping/observers',
  };
  throw new Error(`Unavailable: ${selection.adapter} requires ${blockers[selection.adapter]}`);
}
/** #57 mixed-recipient roster: the three supported providers at their required
 * requested tuples, plus Antigravity as the unsupported recipient. The room is
 * shared, so the trusted room needs the explicit grant Claude and Codex require,
 * which is also Grok's #69 trusted-command row. No sandboxed mixed room exists.
 */
export function liveImageRoster(args = process.argv.slice(2)) {
  const { values } = parseArgs({
    args,
    options: {
      room: { type: 'string', default: 'restricted' },
      'trusted-commands': { type: 'boolean', default: false },
      'scratch-parent': { type: 'string', default: '/private/tmp' },
    },
  });
  if (!['restricted', 'trusted'].includes(values.room!))
    throw new Error('Unavailable: room must be restricted or trusted');
  const trusted = values.room === 'trusted';
  if (values['trusted-commands'] !== trusted)
    throw new Error(
      'Unavailable: trusted room requires explicit --trusted-commands; restricted room cannot grant it',
    );
  const permissions = { edits: trusted, commands: trusted, network: trusted };
  const supported: { id: 'codex' | 'claude' | 'grok'; model?: string; effort?: string }[] = [
    { id: 'codex', model: 'gpt-6-astra', effort: 'xhigh' },
    { id: 'claude', model: 'opus', effort: 'xhigh' },
    { id: 'grok', effort: trusted ? 'high' : undefined },
  ];
  return {
    room: values.room as 'restricted' | 'trusted',
    scratchParent: resolve(values['scratch-parent']!),
    permissions,
    skills: { enabled: trusted },
    commandAccess: resolveCommandAccess(
      { permissions, provenance: {} },
      undefined,
      values['trusted-commands'],
    ),
    supported,
    unsupported: { id: 'antigravity' as const },
  };
}
export type LiveImageRoster = ReturnType<typeof liveImageRoster>;

/** Every driver patches shared prototypes, and the Grok and Claude drivers both
 * name their MCP log after the phase. Give each agent its own observation
 * directory and tag its events, then restore in reverse order. Native events are
 * still bound to a recipient by provider session, never by this tag alone.
 */
export function observeRoster(
  root: string,
  agents: readonly AgentConfig['provider'][],
  phase: () => string,
  events: object[],
) {
  const restores = agents.map((agent) => {
    const directory = join(root, 'observation', agent);
    mkdirSync(directory, { recursive: true });
    const tagged = { push: (event: object) => events.push({ observer: agent, ...event }) };
    const driver = liveImageDriver({ adapter: agent } as LiveImageSelection);
    return driver.observe(directory, phase, tagged as unknown as object[]);
  });
  return () => restores.reverse().forEach((restore) => restore());
}
export function liveSourceIdentity() {
  return {
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    patchSha256: createHash('sha256')
      .update(execFileSync('git', ['diff', '--binary', 'HEAD']))
      .digest('hex'),
    // New files must be staged before running so the patch identity covers them.
    untracked:
      execFileSync('git', ['ls-files', '--others', '--exclude-standard'], {
        encoding: 'utf8',
      }).trim().length > 0,
  };
}
