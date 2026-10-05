import { claudeImageBridge, claudeImageSupport, type ClaudeImageTuple } from '../image-support.js';
import { assertClaudeFrame, claudeInitialContent } from '../claude-images.js';
import type { CompactionResult, MaintenanceRequest, MaintenanceResult } from '../types.js';
import { maintenancePrompt, parseMaintenance } from '../protocol.js';
import { randomUUID } from 'node:crypto';
import type {
  AgentAdapter,
  AgentConfig,
  RoomConfig,
  TurnInput,
  TurnResult,
  AdapterEvent,
  ContextUsage,
} from '../types.js';
import { JsonLinesProcess, errorText, runProcess, providerEnv } from '../process.js';
import {
  instructions,
  processOutputSchema as outputSchema,
  parseOutcomes,
  previewText,
  turnPrompt,
} from '../protocol.js';
import { builtFile, ToolService } from '../tools.js';
import { effortError } from '../providers.js';
import { contextUsage } from '../context-usage.js';
import { commandMode } from '../command-access.js';
import type { AttachmentAccess } from '../attachments.js';

interface ClaudeModel {
  value: string;
  resolvedModel?: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: string[];
}

function providerRefusal(category: unknown, explanation: unknown): Error {
  const kind = typeof category === 'string' && category.trim() ? category.trim() : 'unknown';
  const detail =
    typeof explanation === 'string' && explanation.trim()
      ? explanation.trim()
      : 'Claude Code supplied no refusal explanation.';
  return new Error(`Claude provider refusal (${kind}): ${detail}`);
}

/**
 * Every launch control the room policy relies on. The built-in `/compact`
 * command is reachable only without `--disable-slash-commands`, so the native
 * command surface is bounded by these flags and settings instead, on every
 * build: no native task tools, `Skill`, `Agent` and `Task` denied, no setting
 * sources, no bundled skills, no skill shell execution, no hooks, strict MCP.
 * A CLI that lacks one of them refuses startup with the flag named; the live
 * init inventory is then checked on every turn and compaction.
 */
export const claudeLaunchControls = Object.freeze([
  '--restricted',
  '--replay-user-messages',
  '--include-partial-messages',
  '--strict-mcp-config',
  '--tools',
  '--disallowedTools',
  '--allowedTools',
  '--permission-mode',
  '--setting-sources',
  '--settings',
  '--mcp-config',
  '--json-schema',
  '--no-chrome',
] as const);
export class ClaudeAdapter implements AgentAdapter {
  private imageCliVersion = '';
  private observedImageModel?: string;
  private imageInventoryVerified?: boolean;
  private observedEffort?: string;
  get imageEvidence() {
    return {
      ...this.imageTuple,
      sessionId: this.sessionId,
      nativeCompaction: this.nativeCompaction,
      nativeInventoryVerified: this.imageInventoryVerified,
      observedEffort: this.observedEffort,
      permissions: { ...this.config.permissions },
      skillsEnabled: this.config.skills?.enabled !== false,
      skillBundleCount:
        this.config.skills?.enabled === false ? 0 : (this.agent.skills?.bundles.length ?? 0),
      commandMode: commandMode(this.config),
      commandModeSource: this.config.commandAccess?.source ?? 'permissions.commands=false',
    };
  }
  async mcpServer(tools: ToolService) {
    return {
      command: process.execPath,
      args: [builtFile('mcp.js'), JSON.stringify(await tools.mcpSettings(this.agent.id))],
    };
  }
  get imageTuple(): ClaudeImageTuple {
    return {
      cliVersion: this.imageCliVersion,
      requestedModel: this.agent.model ?? 'provider default',
      requestedEffort: this.agent.effort ?? 'provider default',
      observedModel: this.observedImageModel,
      observedEffort: this.observedEffort,
      connected: Boolean(this.proc && !this.proc.closed),
      nativeInventoryVerified: this.imageInventoryVerified,
    };
  }
  imageSupport() {
    return claudeImageSupport(this.imageTuple);
  }
  get nativeInitialImages() {
    return this.imageSupport().initial.available;
  }
  private registerImages() {
    const report = this.imageSupport();
    this.historyTools?.registerRetrievalBridge({
      key: report.retrieval.available ? claudeImageBridge.key : 'claude',
      report,
    });
  }
  nativeCompaction = false;
  readonly nativeCompactionInstructions = true;
  readonly sourceHandoff = false;
  private proc?: JsonLinesProcess;
  private sessionId?: string;
  private historyTools?: ToolService;
  private contextWindows = new Map<string, number>();
  private compacting = false;
  private compactBoundaries = new Set<string>();
  private refusedTransport = false;
  constructor(
    private agent: AgentConfig,
    private config: RoomConfig,
    private environment = { ...process.env },
    private attachments?: AttachmentAccess,
  ) {}
  async start(sessionId?: string): Promise<{ sessionId?: string; restored: boolean }> {
    this.contextWindows.clear();
    this.nativeCompaction = false;
    this.imageInventoryVerified = undefined;
    this.observedEffort = undefined;
    this.observedImageModel = undefined;
    this.historyTools?.close();
    const tools = (this.historyTools = new ToolService(
      this.config.workspace,
      this.config.permissions,
      undefined,
      this.config.skills?.enabled === false ? [] : this.agent.skills?.bundles,
      { mode: commandMode(this.config), environment: this.environment },
      undefined,
      this.attachments,
      undefined,
      this.agent.planState,
    ));
    await tools.check();
    const help = await runProcess('claude', ['--help'], { env: providerEnv() });
    const version = await runProcess('claude', ['--version'], { env: providerEnv() });
    this.imageCliVersion = version.code === 0 ? version.stdout.trim() : '';
    this.registerImages();
    for (const flag of [...claudeLaunchControls, ...(this.agent.effort ? ['--effort'] : [])])
      if (!help.stdout.includes(flag))
        throw new Error(`Installed Claude Code lacks ${flag}; update Claude Code`);
    const auth = await runProcess('claude', ['auth', 'status', '--json'], { env: providerEnv() });
    let account: any;
    try {
      account = JSON.parse(auth.stdout);
    } catch {
      throw new Error('Could not verify Claude subscription login. Run claude auth login.');
    }
    if (!account.loggedIn || !['claude.ai', 'oauth'].includes(account.authMethod))
      throw new Error(
        'Sign in using claude auth login with your Claude subscription. Chittr does not use API-key billing.',
      );
    this.sessionId = sessionId ?? randomUUID();
    const args = [
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--replay-user-messages',
      '--restricted',
      '--tools',
      '',
      // The built-in /compact command stays reachable, so slash commands are not
      // disabled wholesale. Native skills, agents and tasks remain denied by the
      // controls below on every build, and the live init inventory is verified
      // before any turn or compaction result is accepted. Chittr reads its own
      // catalogue through the room tools.
      '--disallowedTools',
      'Skill,Agent,Task',
      '--no-chrome',
      '--strict-mcp-config',
      '--setting-sources',
      '',
      '--settings',
      JSON.stringify({
        disableAllHooks: true,
        disableBundledSkills: true,
        disableSkillShellExecution: true,
        enabledPlugins: {},
        permissions: { defaultMode: 'dontAsk', blockReadsOutsideWorkingDirectories: true },
      }),
      '--permission-mode',
      'dontAsk',
      '--allowedTools',
      'mcp__chittr__*',
      '--mcp-config',
      JSON.stringify({
        mcpServers: {
          chittr: await this.mcpServer(tools),
        },
      }),
      '--append-system-prompt',
      instructions(this.agent, this.config),
      '--json-schema',
      JSON.stringify(outputSchema),
      ...(sessionId ? ['--resume', sessionId] : ['--session-id', this.sessionId]),
      ...(this.agent.model ? ['--model', this.agent.model] : []),
      ...(this.agent.effort ? ['--effort', this.agent.effort] : []),
    ];
    const env = providerEnv();
    // The environment takes precedence over --effort in Claude Code.
    // An explicit room value applies only to this participant's process.
    if (this.agent.effort) delete env.CLAUDE_CODE_EFFORT_LEVEL;
    this.proc = new JsonLinesProcess('claude', args, this.config.workspace, env);
    this.proc.on('message', (message) => {
      if (
        message.session_id === this.sessionId &&
        message.type === 'system' &&
        message.subtype === 'compact_boundary' &&
        typeof message.uuid === 'string'
      )
        this.compactBoundaries.add(message.uuid);
      if (message.type === 'control_request')
        this.proc?.send({
          type: 'control_response',
          response: {
            subtype: 'success',
            request_id: message.request_id,
            response: {
              behavior: 'deny',
              message:
                'Use the room task tools. Missing permissions require a YAML config change and idle reload.',
            },
          },
        });
    });
    try {
      const initialized = await this.initialize();
      if (this.agent.effort) {
        const model =
          this.agent.model ??
          env.ANTHROPIC_MODEL ??
          (sessionId ? undefined : (env.ANTHROPIC_DEFAULT_MODEL ?? 'default'));
        // A resumed session can retain its saved model, which initialization
        // does not report. Do not mistake the account default for that model.
        const normalize = (name: string) => name.replace(/\[1m\]$/, '');
        const entry =
          model === undefined
            ? undefined
            : (initialized.models?.find(
                (item) => item.value === model || item.resolvedModel === model,
              ) ??
              initialized.models?.find(
                (item) =>
                  normalize(item.value) === normalize(model) ||
                  (item.resolvedModel && normalize(item.resolvedModel) === normalize(model)),
              ));
        const accepted =
          entry?.supportedEffortLevels ?? (entry?.supportsEffort === false ? [] : undefined);
        if (accepted) {
          const message = effortError(
            'claude',
            this.agent.effort,
            accepted,
            entry?.resolvedModel ?? model,
          );
          if (message) throw new Error(`@${this.agent.id}: ${message}`);
        }
      }
    } catch (error) {
      if (
        sessionId &&
        /no conversation found|session.*not found|could not find.*session/i.test(errorText(error))
      ) {
        await this.proc.close();
        const fresh = await this.start();
        return { ...fresh, restored: true };
      }
      throw error;
    }
    this.refusedTransport = false;
    // Images are eligible from connection: the init inventory is checked on
    // every turn, and a failing one revokes retrieval for the rest of that turn.
    this.registerImages();
    // Attempt then validate: the process initialized under the launch controls
    // above, so the built-in /compact route may be attempted on any CLI
    // identity. compact() accepts only a fresh manual boundary with a matching
    // user result, or the exact short-history no-op; anything else fails and
    // requires explicit recovery.
    this.nativeCompaction = true;
    return { sessionId: this.sessionId, restored: false };
  }
  private initialize(): Promise<{ models?: ClaudeModel[] }> {
    const proc = this.proc!;
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        proc.off('message', listener);
        proc.off('disconnect', disconnected);
      };
      const disconnected = (error: Error) => {
        cleanup();
        reject(error);
      };
      const listener = (m: any) => {
        if (m.type === 'control_response' && m.response?.request_id === id) {
          cleanup();
          m.response.subtype === 'error'
            ? reject(new Error(m.response.error))
            : resolve(m.response.response ?? {});
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(
          new Error(
            `Claude initialization timed out${proc.stderr ? ': ' + proc.stderr.slice(-600) : ''}`,
          ),
        );
      }, 30000);
      proc.on('message', listener);
      proc.on('disconnect', disconnected);
      proc.send({ type: 'control_request', request_id: id, request: { subtype: 'initialize' } });
    });
  }
  async maintain(request: MaintenanceRequest, signal: AbortSignal): Promise<MaintenanceResult> {
    this.historyTools!.setMaintenance(true);
    const result = (await this.execute(
      { messages: [], context: [], participants: [] },
      () => {},
      signal,
      request,
    )) as MaintenanceResult;
    signal.throwIfAborted();
    this.historyTools!.setMaintenance(false);
    return result;
  }
  async compact(
    _operationId: string,
    signal: AbortSignal,
    instructions?: string,
  ): Promise<CompactionResult> {
    const proc = this.proc;
    if (!proc || !this.sessionId || !this.nativeCompaction)
      throw new Error('Claude native compaction is unavailable');
    signal.throwIfAborted();
    if (this.compacting) throw new Error('Claude compaction is already running');
    this.compacting = true;
    this.historyTools!.setMaintenance(true);
    const requestUUID = randomUUID();
    const previousBoundaries = new Set(this.compactBoundaries);
    try {
      const result = await new Promise<CompactionResult>((resolve, reject) => {
        let boundary = false;
        const cleanup = () => {
          clearTimeout(timer);
          proc.off('message', listener);
          proc.off('disconnect', disconnected);
          signal.removeEventListener('abort', abort);
        };
        const fail = (error: Error) => {
          cleanup();
          reject(error);
        };
        const abort = () => fail(new Error('Claude compaction interrupted'));
        const disconnected = (error: Error) => fail(error);
        const listener = (m: any) => {
          if (m.session_id !== this.sessionId || m.parent_tool_use_id) return;
          if (m.type === 'system' && m.subtype === 'init') {
            const unexpected = (m.tools ?? []).filter(
              (name: string) =>
                !name.startsWith('mcp__chittr__') &&
                !['StructuredOutput', 'EndConversation'].includes(name),
            );
            if (unexpected.length)
              fail(
                new Error(
                  `Unexpected Claude tools would bypass room policy: ${unexpected.join(', ')}`,
                ),
              );
          }
          if (
            m.type === 'system' &&
            m.subtype === 'compact_boundary' &&
            m.compact_metadata?.trigger === 'manual' &&
            typeof m.uuid === 'string' &&
            !previousBoundaries.has(m.uuid)
          ) {
            boundary = true;
            this.compactBoundaries.add(m.uuid);
          }
          if (m.type !== 'result') return;
          if (!m.user_message_uuid && !m.user_message_uuids?.length) {
            fail(new Error('Claude compaction result lacks user-message UUID correlation'));
            return;
          }
          if (m.user_message_uuid !== requestUUID && !m.user_message_uuids?.includes(requestUUID))
            return;
          if (m.is_error || m.subtype !== 'success') {
            fail(new Error(m.errors?.join('; ') || m.result || 'Claude compaction failed'));
            return;
          }
          const noop = !boundary && m.result === 'Not enough messages to compact.';
          if (!boundary && !noop) {
            fail(new Error('Claude did not emit a manual compaction boundary'));
            return;
          }
          cleanup();
          resolve({ status: noop ? 'nothing-to-compact' : 'completed' });
        };
        const timer = setTimeout(() => fail(new Error('Claude compaction timed out')), 120000);
        proc.on('message', listener);
        proc.on('disconnect', disconnected);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) {
          abort();
          return;
        }
        proc.send({
          type: 'user',
          uuid: requestUUID,
          session_id: this.sessionId,
          message: {
            role: 'user',
            // The verified native command accepts a single physical line.
            // Keep the original focus in room state; normalize only this transport.
            content: instructions
              ? `/compact ${instructions.replace(/[\r\n\t\f\v\u0085\u2028\u2029]+/g, ' ')}`
              : '/compact',
          },
          parent_tool_use_id: null,
        });
      });
      signal.throwIfAborted();
      this.historyTools!.setMaintenance(false);
      return result;
    } catch (error) {
      await this.close().catch(() => {});
      throw error;
    } finally {
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
    const requestUUID = randomUUID();
    const prompt = maintenance
      ? maintenancePrompt(maintenance)
      : turnPrompt({ ...input, humanName: input.humanName ?? this.config.humanName });
    if (!proc || !this.sessionId) throw new Error('Claude is not connected');
    if (this.refusedTransport)
      throw new Error('Claude transport is unavailable after a provider refusal; reconnect first');
    const hasImages = !maintenance && input.messages.some((message) => message.attachments?.length);
    const support = this.imageSupport().initial;
    if (hasImages && !support.available) throw new Error(support.reason);
    const images = maintenance ? [] : claudeInitialContent(input.messages, this.attachments);
    const request = {
      type: 'user',
      uuid: requestUUID,
      session_id: this.sessionId,
      message: {
        role: 'user',
        content: images.length ? [{ type: 'text', text: prompt }, ...images] : prompt,
      },
      parent_tool_use_id: null,
    };
    if (images.length) assertClaudeFrame(request, 1);
    this.historyTools!.setHistory(input.history ?? input.context);
    if (!maintenance) this.historyTools!.beginTurn();
    return new Promise((resolve, reject) => {
      let structured: unknown;
      let buffer = '';
      let text = '';
      let structuredBlock = false;
      let settled = false;
      let latestUsage: ContextUsage | undefined;
      let latestModel: string | undefined;
      const turnModels = new Set<string>();
      const cleanup = () => {
        this.historyTools!.endTurn();
        clearTimeout(timer);
        proc.off('message', listener);
        proc.off('disconnect', disconnected);
        signal.removeEventListener('abort', abort);
      };
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        this.observedImageModel = !error && turnModels.size === 1 ? [...turnModels][0] : undefined;
        this.registerImages();
        if (error) reject(error);
        else {
          try {
            resolve(
              maintenance
                ? {
                    ...parseMaintenance(structured ?? buffer, maintenance.id, maintenance.kind),
                    sessionId: this.sessionId,
                  }
                : { outcomes: parseOutcomes(structured ?? buffer), sessionId: this.sessionId },
            );
          } catch (e) {
            reject(new Error(`Claude did not account for its messages: ${errorText(e)}`));
          }
        }
      };
      const abort = () => {
        void this.interrupt();
        finish(new Error('Interrupted'));
      };
      const disconnected = (error: Error) => finish(error);
      const refuse = (category: unknown, explanation: unknown) => {
        this.refusedTransport = true;
        void this.interrupt();
        finish(providerRefusal(category, explanation));
      };
      const listener = (m: any) => {
        if (m.session_id && m.session_id !== this.sessionId) return;
        if (m.parent_tool_use_id) return;
        if (m.type === 'system' && m.subtype === 'model_refusal_no_fallback') {
          if (m.refused_user_message_uuid && m.refused_user_message_uuid !== requestUUID) return;
          refuse(m.api_refusal_category, m.api_refusal_explanation);
          return;
        }
        if (
          m.type === 'assistant' &&
          m.is_api_error_message === true &&
          m.message?.stop_reason === 'refusal'
        ) {
          refuse(m.message.stop_details?.category, m.message.stop_details?.explanation);
          return;
        }
        if (
          m.type === 'assistant' &&
          !m.isApiErrorMessage &&
          typeof m.message?.model === 'string' &&
          m.message.model !== '<synthetic>'
        ) {
          turnModels.add(m.message.model.replace(/\[1m\]$/, ''));
        }
        if (m.type === 'system' && m.subtype === 'compact_boundary') {
          latestUsage = undefined;
          latestModel = undefined;
          event({ type: 'context' });
        }
        if (
          m.type === 'assistant' &&
          m.message?.usage &&
          m.message.model !== '<synthetic>' &&
          !m.isApiErrorMessage
        ) {
          const reported = m.message.usage;
          const counts = [
            reported.input_tokens,
            reported.cache_read_input_tokens ?? 0,
            reported.cache_creation_input_tokens ?? 0,
          ];
          // Cache hits and writes still occupy context. Result-level usage sums
          // multiple API calls and must not replace this latest-message reading.
          if (
            counts.every(
              (value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0,
            )
          ) {
            latestModel = typeof m.message.model === 'string' ? m.message.model : undefined;
            latestUsage = contextUsage(
              counts.reduce((sum, value) => sum + value, 0),
              latestModel ? this.contextWindows.get(latestModel) : undefined,
            );
            if (latestUsage) event({ type: 'context', usage: latestUsage });
          }
        }
        if (m.type === 'user' && !m.parent_tool_use_id && m.message?.role === 'user')
          event({ type: 'received' });
        if (m.type === 'system' && m.subtype === 'init') {
          const unexpected = (m.tools ?? []).filter(
            (name: string) =>
              !name.startsWith('mcp__chittr__') &&
              !['StructuredOutput', 'EndConversation'].includes(name),
          );
          const verified =
            unexpected.length === 0 &&
            Array.isArray(m.tools) &&
            m.tools.includes('mcp__chittr__read_attachment') &&
            m.tools.includes('mcp__chittr__read_conversation');
          this.imageInventoryVerified = verified;
          this.observedEffort =
            typeof m.effort === 'string' &&
            ['low', 'medium', 'high', 'xhigh', 'max'].includes(m.effort)
              ? m.effort
              : undefined;
          if (unexpected.length) {
            void this.interrupt();
            finish(
              new Error(
                `Unexpected Claude tools would bypass room policy: ${unexpected.join(', ')}`,
              ),
            );
          } else if (!verified)
            // Registration ends this turn's attachment authority, so no image
            // result is served for the rest of it. A passing inventory changes
            // nothing: re-registering would end the turn's valid authority too.
            this.registerImages();
        }
        if (m.type === 'stream_event') {
          const e = m.event;
          if (e.type === 'message_start') {
            text = '';
            event({ type: 'activity', activity: 'considering' });
          }
          if (e.type === 'content_block_start') {
            structuredBlock =
              e.content_block?.type === 'tool_use' && e.content_block.name === 'StructuredOutput';
            if (structuredBlock) buffer = '';
            else if (e.content_block?.type === 'tool_use')
              event({ type: 'activity', activity: 'working', detail: e.content_block.name });
          }
          if (
            e.type === 'content_block_delta' &&
            structuredBlock &&
            e.delta.type === 'input_json_delta'
          ) {
            buffer += e.delta.partial_json;
            if (maintenance && Buffer.byteLength(buffer) > 131072) {
              void this.interrupt();
              finish(new Error('Maintenance output exceeded its transport limit'));
              return;
            }
            const preview = previewText(buffer);
            if (preview) {
              event({ type: 'activity', activity: 'replying' });
              event({ type: 'text', text: preview });
            }
          }
          if (e.type === 'content_block_delta' && e.delta.type === 'text_delta') {
            text += e.delta.text;
            if (maintenance && Buffer.byteLength(text) > 131072) {
              void this.interrupt();
              finish(new Error('Maintenance output exceeded its transport limit'));
              return;
            }
            const preview = previewText(text);
            if (preview) event({ type: 'text', text: preview });
          }
        }
        if (m.type === 'assistant')
          for (const block of m.message?.content ?? [])
            if (block.type === 'tool_use' && block.name === 'StructuredOutput')
              structured = block.input;
        if (m.type === 'tool_progress')
          event({ type: 'activity', activity: 'working', detail: m.tool_name });
        if (m.type === 'result') {
          if (maintenance && !m.user_message_uuid && !m.user_message_uuids?.length) {
            finish(
              new Error(
                'Claude maintenance result lacks user-message UUID correlation; this CLI protocol is unsupported',
              ),
            );
            return;
          }
          if (
            maintenance &&
            m.user_message_uuid !== requestUUID &&
            !m.user_message_uuids?.includes(requestUUID)
          )
            return;
          if (latestUsage && latestModel) {
            // The API message omits [1m], while the CLI's usage key retains it.
            // Require one matching model so utility models or ambiguous variants
            // cannot supply the main conversation's context limit.
            const normalize = (model: string) => model.replace(/\[1m\]$/, '');
            const matches = Object.entries(m.modelUsage ?? {}).filter(
              ([model]) => normalize(model) === normalize(latestModel!),
            );
            const limit = matches.length === 1 ? (matches[0]![1] as any)?.contextWindow : undefined;
            const usage = contextUsage(latestUsage.usedTokens, limit);
            if (usage) {
              if (usage.maxTokens) this.contextWindows.set(latestModel, usage.maxTokens);
              else this.contextWindows.delete(latestModel);
              latestUsage = { ...usage, updatedAt: latestUsage.updatedAt };
              event({ type: 'context', usage: latestUsage });
            }
          }
          if (m.structured_output) structured = m.structured_output;
          if (m.result && !structured) {
            try {
              structured = JSON.parse(m.result);
            } catch {}
          }
          finish(m.is_error ? new Error(m.errors?.join('; ') || m.result || m.subtype) : undefined);
        }
      };
      const timer = setTimeout(() => {
        void this.interrupt();
        finish(
          new Error('Claude turn exceeded 10 minutes; pending messages require explicit retry'),
        );
      }, 600000);
      proc.on('message', listener);
      proc.on('disconnect', disconnected);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) {
        abort();
        return;
      }
      event({ type: 'activity', activity: 'considering' });
      if (settled || signal.aborted) return;
      try {
        proc.send(request);
      } catch (error) {
        finish(error instanceof Error ? error : new Error('Claude dispatch failed'));
      }
    });
  }
  async interrupt(): Promise<void> {
    this.historyTools?.interrupt();
    if (this.proc && !this.proc.closed)
      this.proc.send({
        type: 'control_request',
        request_id: randomUUID(),
        request: { subtype: 'interrupt' },
      });
  }
  async close(): Promise<void> {
    this.nativeCompaction = false;
    await this.interrupt().catch(() => {});
    await this.proc?.close();
    this.historyTools?.close();
    this.observedImageModel = undefined;
    this.imageCliVersion = '';
  }
}
