import type { CompactionResult, MaintenanceRequest, MaintenanceResult } from '../types.js';
import { version as packageVersion } from '../version.js';
import { maintenancePrompt, parseMaintenance, maintenanceOutputSchema } from '../protocol.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { contextUsage } from '../context-usage.js';
import { join, resolve } from 'node:path';
import type {
  AgentAdapter,
  AgentConfig,
  InitialImageSupport,
  RoomConfig,
  TurnInput,
  TurnResult,
  AdapterEvent,
} from '../types.js';
import { JsonLinesProcess, providerEnv, providerEventBytes, runProcess } from '../process.js';
import {
  instructions,
  processOutputSchema as outputSchema,
  parseOutcomes,
  previewText,
  turnPrompt,
} from '../protocol.js';
import { IsolatedRuntime, roomToolNames } from './isolated.js';
import { effortError } from '../providers.js';
import { commandMode } from '../command-access.js';
import { AttachmentError, grokInitialContent, type AttachmentAccess } from '../attachments.js';

const mcpNames = new Set(roomToolNames.map((name) => `chittr__${name}`));
const allowedTools = new Set(['search_tool', 'use_tool', ...mcpNames]);

// Some Grok builds leak the end-of-sequence marker into the final text. Remove
// only that transport suffix; never guess how to repair truncated JSON.
export function grokOutput(text: string): string {
  return text
    .trim()
    .replace(/<\|eos\|>$/, '')
    .trimEnd();
}

const cleanDetail = (value: unknown): string =>
  typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 400) : '';

export function grokStopMessage(result: any, deniedTool?: string): string {
  const meta = result?._meta;
  const context = meta?.cancellationContext;
  const details = [
    deniedTool ? `room policy denied tool ${cleanDetail(deniedTool)}` : '',
    cleanDetail(meta?.cancellationCategory),
    cleanDetail(context?.reason),
    context?.tool_name ? `tool: ${cleanDetail(context.tool_name)}` : '',
    context?.hook_name ? `hook: ${cleanDetail(context.hook_name)}` : '',
    cleanDetail(meta?.cancelTrigger ?? context?.trigger),
  ].filter(Boolean);
  return `Grok stopped: ${cleanDetail(result?.stopReason) || 'unknown reason'}${details.length ? ` (${details.join('; ')})` : '; the provider supplied no further reason'}`;
}

export function grokPermission(params: any): {
  outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' };
} {
  const call = params?.toolCall;
  const name = call?._meta?.['x.ai/tool']?.name;
  const allowed =
    (name === 'use_tool' &&
      call?.rawInput?.variant === 'UseTool' &&
      mcpNames.has(call.rawInput.tool_name)) ||
    mcpNames.has(name);
  const option = params?.options?.find((value: any) => value.kind === 'allow_once');
  return {
    outcome:
      allowed && option
        ? { outcome: 'selected', optionId: option.optionId }
        : { outcome: 'cancelled' },
  };
}

export { grokInitialImageGate, legacyRestrictedGrokBuild } from '../image-support.js';
import {
  grokImageBridge,
  grokImageSupport,
  type GrokImageTuple,
  type GrokRoomContract,
  type ImageSupportReport,
} from '../image-support.js';

export function checkGrokTools(value: unknown): void {
  if (!Array.isArray(value) || value.some((name) => !allowedTools.has(name)))
    throw new Error('Grok exposed unexpected tools; this CLI cannot enforce room permissions');
}

export class GrokAdapter implements AgentAdapter {
  nativeCompaction = false;
  get nativeInitialImages() {
    return this.imageSupport().initial.available;
  }
  readonly nativeCompactionInstructions = true;
  readonly sourceHandoff = false;
  private proc?: JsonLinesProcess;
  private runtime?: IsolatedRuntime;
  private sessionId?: string;
  private policyError?: Error;
  private inventorySeen = false;
  private compacting = false;
  private deniedTool?: string;
  private imageGate?: ImageSupportReport;
  private observedImageTuple?: GrokImageTuple;
  private observedEffort = 'unknown';
  initialImageTuple?: GrokImageTuple;
  /** Byte-free native session observation for opt-in product acceptance. */
  get imageEvidence() {
    return {
      ...this.observedImageTuple,
      sessionId: this.sessionId,
      requestedEffort: this.agent.effort ?? 'provider default',
      observedEffort: this.observedEffort,
      effortObservationSource:
        this.observedEffort === 'unknown' ? 'unknown' : 'session/new configOptions currentValue',
      commandMode: commandMode(this.config),
      commandModeSource: this.config.commandAccess?.source ?? 'permissions.commands',
      skillBundleCount:
        this.config.skills?.enabled === false ? 0 : (this.agent.skills?.bundles.length ?? 0),
      nativeInventoryVerified:
        this.inventorySeen && !this.policyError && this.proc?.closed === false,
      // The gate input is the start-time snapshot; evidence reports liveness now.
      roomContract: this.observedImageTuple?.roomContract && {
        ...this.observedImageTuple.roomContract,
        processLive: this.proc?.closed === false,
      },
    };
  }
  constructor(
    private agent: AgentConfig,
    private config: RoomConfig,
    private environment = { ...process.env },
    private attachments?: AttachmentAccess,
  ) {}

  async start(previousSession?: string): Promise<{ sessionId: string; restored: boolean }> {
    try {
      this.inventorySeen = false;
      this.policyError = undefined;
      this.observedImageTuple = undefined;
      this.observedEffort = 'unknown';
      // Each check below flips to true only after it passed on this process.
      // The image gate reads this observation; it never reads room config.
      const contract: GrokRoomContract = {
        policy: 'isolated-rooms-v1',
        isolatedRuntime: false,
        acpInitialized: false,
        subscriptionAuthenticated: false,
        roomMcpInventory: false,
        processLive: false,
      };
      const help = await runProcess('grok', ['agent', '--help'], { env: providerEnv() });
      const version = await runProcess('grok', ['--version'], { env: providerEnv() });
      // No native route until this start completes; see the end of start().
      this.nativeCompaction = false;
      delete this.initialImageTuple;
      delete this.imageGate;
      if (help.code || !help.stdout.includes('--agent-profile') || !help.stdout.includes('stdio'))
        throw new Error('Grok Build with ACP and --agent-profile is required. Update grok.');
      if (this.agent.effort && !help.stdout.includes('--reasoning-effort'))
        throw new Error('Installed Grok Build lacks --reasoning-effort; update grok');
      const runtime = (this.runtime = new IsolatedRuntime(
        this.agent,
        this.config,
        this.environment,
        this.attachments,
      ));
      await runtime.tools.check();
      const grokHome = join(runtime.home, '.grok');
      mkdirSync(grokHome);
      writeFileSync(
        join(grokHome, 'config.toml'),
        `[cli]
auto_update=false
use_leader=false
[features]
codebase_indexing=false
title_refresh=false
image_gen=false
video_gen=false
[managed_mcps]
enabled=false
gateway_tools_enabled=false
[subagents]
enabled=false
[memory]
enabled=false
`,
      );
      const profile = join(runtime.directory, 'agent.md');
      // Grok treats unknown allowlist names as a request for the full toolset.
      // The mcp__ prefix is intentional; also verify the effective inventory.
      writeFileSync(
        profile,
        `---
name: chittr
description: Chittr participant
discoverSkills: false
agentsMd: false
injectDefaultTools: false
tools:
  - mcp__chittr__*
permissionMode: default
---
${instructions(this.agent, this.config)}
Return only JSON in your final answer, without markdown fences or commentary.
Complete any tool work before the final answer. Required JSON schema:
${JSON.stringify(outputSchema)}
`,
      );
      const env = providerEnv();
      const authPath = resolve(
        process.env.GROK_AUTH_PATH ||
          join(process.env.GROK_HOME || join(homedir(), '.grok'), 'auth.json'),
      );
      for (const key of Object.keys(env))
        if (key.startsWith('GROK_') || key.startsWith('XAI_')) delete env[key];
      Object.assign(env, { HOME: runtime.home, GROK_HOME: grokHome, GROK_AUTH_PATH: authPath });
      const proc = (this.proc = new JsonLinesProcess(
        'grok',
        [
          'agent',
          '--no-leader',
          '--agent-profile',
          profile,
          ...(this.agent.model ? ['--model', this.agent.model] : []),
          ...(this.agent.effort ? ['--reasoning-effort', this.agent.effort] : []),
          'stdio',
        ],
        runtime.cwd,
        env,
      ));
      contract.isolatedRuntime =
        env.HOME === runtime.home &&
        env.GROK_HOME === grokHome &&
        resolve(runtime.home) !== resolve(homedir()) &&
        resolve(runtime.cwd) !== resolve(this.config.workspace);
      proc.on('message', (message) => {
        if (message.method === 'session/request_permission') {
          const permission = grokPermission(message.params);
          if (permission.outcome.outcome === 'cancelled')
            this.deniedTool = message.params?.toolCall?._meta?.['x.ai/tool']?.name ?? 'unknown';
          proc.send({ jsonrpc: '2.0', id: message.id, result: permission });
        } else if (message.id !== undefined && message.method) {
          proc.send({
            jsonrpc: '2.0',
            id: message.id,
            error: { code: -32601, message: 'Use the room MCP tools' },
          });
        }
        const inventory = message.params?.update?._meta?.tools;
        if (inventory !== undefined) {
          try {
            checkGrokTools(inventory);
            this.inventorySeen = true;
          } catch (error) {
            this.policyError = error as Error;
            void proc.close();
          }
        }
      });
      await proc.rpc('initialize', {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: 'chittr', version: packageVersion },
      });
      contract.acpInitialized = true;
      const auth = await proc.rpc('authenticate', {
        methodId: 'cached_token',
        _meta: { headless: true },
      });
      if (auth?._meta?.auth_mode !== 'Oidc')
        throw new Error(
          'Sign in to Grok Build using grok with your subscription. API-key billing is not supported.',
        );
      contract.subscriptionAuthenticated = true;
      const session = await proc.rpc('session/new', {
        cwd: runtime.cwd,
        mcpServers: [{ name: 'chittr', ...(await runtime.mcp()), env: [] }],
        _meta: { startupHints: { nonInteractive: true, skipGitStatus: true } },
      });
      if (typeof session.sessionId !== 'string')
        throw new Error('Grok did not return an ACP session ID');
      this.sessionId = session.sessionId;
      const nativeEffort = session.configOptions?.find(
        (option: any) => option.id === 'reasoning_effort' && option.type === 'select',
      )?.currentValue;
      if (['low', 'medium', 'high', 'xhigh'].includes(nativeEffort))
        this.observedEffort = nativeEffort;
      if (this.agent.effort) {
        const model = session.models?.currentModelId;
        const entry = session.models?.availableModels?.find((item: any) => item.modelId === model);
        const metadata = entry?._meta;
        const accepted = Array.isArray(metadata?.reasoningEfforts)
          ? metadata.reasoningEfforts.map((item: any) => item.value ?? item.id)
          : metadata?.supportsReasoningEffort === false
            ? []
            : undefined;
        if (accepted) {
          const message = effortError('grok', this.agent.effort, accepted, model);
          if (message) throw new Error(`@${this.agent.id}: ${message}`);
        }
      }
      if (!this.inventorySeen || this.policyError)
        throw this.policyError ?? new Error('Grok did not report its effective tool inventory');
      await this.waitForTools();
      contract.roomMcpInventory = true;
      contract.processLive = this.proc?.closed === false;
      const tuple: GrokImageTuple = {
        cliVersion: version.code === 0 ? version.stdout.trim() : '',
        requestedModel: this.agent.model ?? 'provider default',
        observedModel:
          typeof session.models?.currentModelId === 'string'
            ? session.models.currentModelId
            : 'unavailable',
        permissions: { ...this.config.permissions },
        skillsEnabled: this.config.skills?.enabled !== false,
        commandMode: commandMode(this.config),
        nativeInventoryVerified:
          this.inventorySeen && !this.policyError && this.proc?.closed === false,
        roomContract: contract,
      };
      this.observedImageTuple = tuple;
      this.imageGate = grokImageSupport(tuple);
      runtime.tools.registerRetrievalBridge({ key: grokImageBridge.key, report: this.imageGate });
      if (this.imageGate.initial.available) {
        this.initialImageTuple = tuple;
      }
      // Attempt then validate: the isolated profile, exact inventory and room
      // MCP routing were verified on this process, so `_x.ai/compact_conversation`
      // may be attempted on any CLI identity. compact() accepts only the
      // correlated empty-object completion; an unknown-method error, another
      // shape, a timeout or cancellation closes the uncertain native state and
      // requires explicit recovery.
      this.nativeCompaction = true;
      // Isolated native state is disposable; the room supplies saved public
      // context on reconnect and explicitly discloses this fresh session.
      return { sessionId: session.sessionId, restored: Boolean(previousSession) };
    } catch (error) {
      await this.close();
      throw this.policyError ?? error;
    }
  }

  imageSupport(): ImageSupportReport {
    return this.proc?.closed === false
      ? (this.imageGate ?? grokImageSupport())
      : grokImageSupport();
  }
  /** Compatibility accessor, derived from the shared report. */
  initialImageSupport(): InitialImageSupport {
    return this.imageSupport().initial;
  }

  private async waitForTools(): Promise<void> {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const value = await this.proc!.rpc('_x.ai/mcp/list', {
        sessionId: this.sessionId,
        cache: true,
      });
      const servers = value?.result?.servers;
      if (!Array.isArray(servers) || servers.length !== 1 || servers[0]?.name !== 'chittr')
        throw new Error('Grok loaded an unexpected MCP configuration');
      const session = servers[0].session;
      if (session?.status === 'ready') {
        const names = session.tools
          ?.filter((tool: any) => tool.enabled)
          .map((tool: any) => tool.name);
        if (
          !Array.isArray(names) ||
          names.length !== roomToolNames.length ||
          roomToolNames.some((name) => !names.includes(name))
        )
          throw new Error('Grok did not connect all room tools');
        return;
      }
      if (session?.status !== 'initializing')
        throw new Error('Grok could not connect the room MCP tools');
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error('Grok room tools did not become ready within 30 seconds');
  }

  async maintain(request: MaintenanceRequest, signal: AbortSignal): Promise<MaintenanceResult> {
    this.runtime!.tools.setMaintenance(true);
    const result = (await this.execute(
      { messages: [], context: [], participants: [] },
      () => {},
      signal,
      request,
    )) as MaintenanceResult;
    signal.throwIfAborted();
    this.runtime!.tools.setMaintenance(false);
    return result;
  }
  async compact(
    _operationId: string,
    signal: AbortSignal,
    instructions?: string,
  ): Promise<CompactionResult> {
    const proc = this.proc;
    if (!proc || !this.sessionId || !this.nativeCompaction)
      throw new Error('Grok native compaction is unavailable');
    signal.throwIfAborted();
    if (this.compacting) throw new Error('Grok compaction is already running');
    this.compacting = true;
    this.runtime!.tools.setMaintenance(true);
    const abort = () => {
      if (!proc.closed)
        proc.send({
          jsonrpc: '2.0',
          method: 'session/cancel',
          params: { sessionId: this.sessionId },
        });
      void proc.close();
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
      // Unlike Codex's start acknowledgement, this extension replies only after
      // its CompactSession command completes. JsonLinesProcess correlates the RPC ID.
      const result = await proc.rpc(
        '_x.ai/compact_conversation',
        {
          session_id: this.sessionId,
          ...(instructions ? { user_context: instructions } : {}),
        },
        120000,
      );
      signal.throwIfAborted();
      if (this.policyError) throw this.policyError;
      if (
        !result ||
        typeof result !== 'object' ||
        Array.isArray(result) ||
        Object.keys(result).length
      )
        throw new Error('Grok returned an unsupported compaction response');
      this.runtime!.tools.setMaintenance(false);
      return { status: 'completed' };
    } catch (error) {
      abort();
      await this.close().catch(() => {});
      throw signal.aborted ? new Error('Grok compaction interrupted') : error;
    } finally {
      signal.removeEventListener('abort', abort);
      this.compacting = false;
    }
  }
  async run(
    input: TurnInput,
    event: (event: AdapterEvent) => void,
    signal: AbortSignal,
  ): Promise<TurnResult> {
    return this.execute(input, event, signal) as Promise<TurnResult>;
  }
  private async execute(
    input: TurnInput,
    event: (event: AdapterEvent) => void,
    signal: AbortSignal,
    maintenance?: MaintenanceRequest,
  ): Promise<TurnResult | MaintenanceResult> {
    const proc = this.proc;
    const prompt = maintenance
      ? maintenancePrompt(maintenance)
      : turnPrompt({ ...input, humanName: input.humanName ?? this.config.humanName });
    if (!proc || !this.sessionId) throw new Error('Grok is not connected');
    const hasImages = input.messages.some((message) => message.attachments?.length);
    if (hasImages) {
      // The room preflight rejects unsupported images before any provider work,
      // so reaching this guard with a closed gate is an invariant failure. It
      // repeats the shared diagnostic rather than inventing a second explanation.
      const gate = this.initialImageSupport();
      if (!gate.available)
        throw new Error(
          `Invariant violation: Grok received initial images that room preflight should have rejected (${gate.reason})`,
        );
    }
    const images = maintenance ? [] : grokInitialContent(input.messages, this.attachments);
    this.deniedTool = undefined;
    this.runtime!.tools.setHistory(input.history ?? input.context);
    if (!maintenance) this.runtime!.tools.beginTurn();
    let text = '',
      lastActivity = '';
    let received = false;
    const activity = (value: 'considering' | 'working' | 'replying', detail?: string) => {
      const key = JSON.stringify([value, detail]);
      if (key !== lastActivity) {
        lastActivity = key;
        event({ type: 'activity', activity: value, detail });
      }
    };
    const listener = (message: any) => {
      const update = message.params?.update;
      if (message.method !== 'session/update' || message.params.sessionId !== this.sessionId)
        return;
      if (update?.sessionUpdate === 'usage_update') {
        const usage = contextUsage(update.used, update.size);
        if (usage?.maxTokens) event({ type: 'context', usage });
      }
      if (update.sessionUpdate === 'user_message_chunk' && !received) {
        received = true;
        event({ type: 'received' });
      }
      if (update.sessionUpdate === 'agent_thought_chunk') activity('considering');
      if (update.sessionUpdate === 'tool_call') {
        text = ''; // Discard any pre-tool commentary; only the final answer is parsed.
        activity('working', update.rawInput?.tool_name ?? update.title);
      }
      if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
        text += update.content.text;
        if (maintenance && Buffer.byteLength(text) > 131072) {
          void this.interrupt();
          return;
        }
        const preview = previewText(text);
        if (preview) {
          activity('replying');
          event({ type: 'text', text: preview });
        }
      }
    };
    const abort = () => {
      void this.interrupt();
    };
    proc.on('message', listener);
    signal.addEventListener('abort', abort, { once: true });
    try {
      if (signal.aborted) throw new Error('Interrupted');
      activity('considering');
      const parameters = {
        sessionId: this.sessionId,
        prompt: [
          ...images,
          {
            type: 'text',
            text: prompt,
          },
        ],
        // Native outputSchema forces a final answer before tool work. That is
        // appropriate only during maintenance, where task tools are denied.
        _meta: {
          verbatim: true,
          ...(maintenance ? { outputSchema: maintenanceOutputSchema } : {}),
        },
      };
      if (
        hasImages &&
        Buffer.byteLength(
          JSON.stringify({
            id: Number.MAX_SAFE_INTEGER,
            method: 'session/prompt',
            params: parameters,
          }),
        ) > providerEventBytes
      )
        throw new AttachmentError(
          'attachment-limit',
          'Images and conversation context exceed the provider frame limit',
        );
      const result = await proc.rpc('session/prompt', parameters, 600000);
      if (this.policyError) throw this.policyError;
      if (result.stopReason !== 'end_turn')
        throw new Error(grokStopMessage(result, this.deniedTool));
      if (maintenance && result._meta?.structuredOutputError) {
        const error = result._meta.structuredOutputError;
        const detail = cleanDetail(typeof error === 'string' ? error : JSON.stringify(error));
        throw new Error(
          `Grok could not produce a valid context summary or acknowledgement${detail ? ': ' + detail : ''}`,
        );
      }
      try {
        return maintenance
          ? {
              ...parseMaintenance(
                result._meta?.structuredOutput ?? grokOutput(text),
                maintenance.id,
                maintenance.kind,
              ),
              sessionId: this.sessionId,
            }
          : { outcomes: parseOutcomes(grokOutput(text)), sessionId: this.sessionId };
      } catch (error) {
        if (error instanceof SyntaxError)
          throw new Error(
            `Grok returned incomplete or invalid JSON; ${maintenance ? 'chat context was not replaced' : 'no reply was published'}`,
            { cause: error },
          );
        throw error;
      }
    } catch (error) {
      await this.interrupt();
      throw this.policyError ?? (signal.aborted ? new Error('Interrupted') : error);
    } finally {
      this.runtime?.tools.endTurn();
      proc.off('message', listener);
      signal.removeEventListener('abort', abort);
    }
  }
  async interrupt(): Promise<void> {
    this.runtime?.tools.interrupt();
    await this.proc?.close();
  }
  async close(): Promise<void> {
    this.nativeCompaction = false;
    delete this.imageGate;
    delete this.initialImageTuple;
    await this.interrupt();
    this.runtime?.close();
    this.runtime = undefined;
  }
}
