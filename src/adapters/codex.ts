import { codexImageBridge, codexImageSupport, type CodexImageTuple } from '../image-support.js';
import { version as packageVersion } from '../version.js';
import { codexToolResult, attachmentFailure, AttachmentResult } from '../attachment-result.js';
import { assertCodexFrame, codexInitialContent, codexSessionPolicy } from '../codex-images.js';
import type { MaintenanceRequest, MaintenanceResult } from '../types.js';
import {
  MaintenanceOutputError,
  maintenancePrompt,
  parseMaintenance,
  maintenanceOutputSchema,
} from '../protocol.js';
import type {
  AgentAdapter,
  AgentConfig,
  Permissions,
  RoomConfig,
  TurnInput,
  TurnResult,
  AdapterEvent,
} from '../types.js';
import { JsonLinesProcess, errorText, runProcess } from '../process.js';
import { instructions, outputSchema, parseOutcomes, previewText, turnPrompt } from '../protocol.js';
import { ToolService, toolSpecs } from '../tools.js';
import { randomUUID } from 'node:crypto';
import { realpathSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join, delimiter } from 'node:path';
import { homedir } from 'node:os';
import { effortError } from '../providers.js';
import { contextUsage } from '../context-usage.js';
import { commandMode } from '../command-access.js';
import type { AttachmentAccess } from '../attachments.js';

const disabledFeatures = [
  'hooks',
  'apps',
  'plugins',
  'remote_plugin',
  'browser_use',
  'computer_use',
  'multi_agent',
  'multi_agent_v2',
  'code_mode',
  'shell_tool',
  'memories',
  'tool_suggest',
  'skill_mcp_dependency_install',
  'request_permissions_tool',
  'view_image',
  'image_generation',
  'skill_search',
  'goals',
  'in_app_chat',
  'in_app_local_automation',
];
/**
 * The one required-capability minimum: app-server restricted-read support
 * arrived in 0.153. The comparison is forward-compatible and has no ceiling, so
 * a newer minor or a future major is accepted by version and then decided by
 * the actual startup checks below. Version order proves no policy enforcement.
 */
export const codexMinimumVersion = Object.freeze([0, 153, 0] as const);
/** `true`/`false` against the minimum, `undefined` when the identity is unreadable. */
export function codexVersionSatisfies(
  stdout: string,
  minimum: readonly [number, number, number] = codexMinimumVersion,
): boolean | undefined {
  const match = /^codex-cli (\d+)\.(\d+)\.(\d+)(?:\s|$)/.exec(stdout.trim());
  if (!match) return undefined;
  const parts = [Number(match[1]), Number(match[2]), Number(match[3])];
  for (let index = 0; index < 3; index++)
    if (parts[index] !== minimum[index]) return parts[index]! > minimum[index]!;
  return true;
}
export class CodexAdapter implements AgentAdapter {
  private imageCliVersion = '';
  private imageModel?: string;
  private imageEffort?: string;
  private nativeImagePolicyVerified?: boolean;
  private imagePolicy?: ReturnType<typeof codexSessionPolicy> & {
    workspaceReadOnly: boolean;
    noWriteGrants: boolean;
    reportedFilesystemMatches: boolean;
    reportedNetworkDisabled: boolean;
    temporaryRootsDenied: boolean;
    nativeFeaturesDisabled: boolean;
    webSearchDisabled: boolean;
    mcpOverridesDisabled: boolean;
    route: 'start' | 'resume' | 'resume-fallback';
  };
  private activeImageTurn = 0;
  /** Policy keys recorded as evidence only: the thread's environment projection and route. */
  private static readonly evidenceOnlyPolicy = [
    'route',
    'environmentCount',
    'projectedRootCount',
    'zeroEnvironments',
    'zeroProjectedRoots',
  ];
  /** Names of the required native policy observations that were missing or failed at start. */
  private nativeMaintenancePolicyFailures: string[] = [];
  get imageEvidence(): CodexImageTuple & {
    sessionId?: string;
    nativeCompaction: boolean;
    nativeMaintenancePolicyFailures: string[];
    skillBundleCount: number;
    permissions: Permissions;
    skillsEnabled: boolean;
    commandMode: 'off' | 'sandboxed' | 'trusted';
    commandModeSource?: string;
    sessionOrigin: 'fresh' | 'resumed' | 'unknown';
    policy?: CodexAdapter['imagePolicy'];
  } {
    return {
      cliVersion: this.imageCliVersion,
      requestedModel: this.agent.model ?? 'provider default',
      requestedEffort: this.agent.effort ?? 'provider default',
      observedModel: this.imageModel,
      observedEffort: this.imageEffort,
      permissions: { ...this.config.permissions },
      skillsEnabled: this.config.skills?.enabled !== false,
      commandMode: commandMode(this.config),
      commandModeSource: this.config.commandAccess?.source,
      nativePolicyVerified:
        this.nativeImagePolicyVerified === undefined || this.proc?.closed !== false
          ? undefined
          : this.nativeImagePolicyVerified,
      sessionOrigin: !this.imagePolicy
        ? 'unknown'
        : this.imagePolicy.route === 'resume'
          ? 'resumed'
          : 'fresh',
      policy: this.imagePolicy,
      nativeCompaction: this.nativeCompaction,
      nativeMaintenancePolicyFailures: [...this.nativeMaintenancePolicyFailures],
      sessionId: this.threadId,
      skillBundleCount:
        this.config.skills?.enabled === false ? 0 : (this.agent.skills?.bundles.length ?? 0),
    };
  }
  imageSupport() {
    return codexImageSupport(this.imageEvidence);
  }
  nativeCompaction = false;
  sourceHandoff = false;
  private retiredTurns = new Set<string>();
  private maintenanceId?: string;
  private maintenanceTurn?: string;
  private proc?: JsonLinesProcess;
  private threadId?: string;
  private turnId?: string;
  private authorizedToolTurn?: string;
  private tools: ToolService;
  private event?: (event: AdapterEvent) => void;
  private signal?: AbortSignal;
  private profile = `chittr_${randomUUID().replaceAll('-', '')}`;
  constructor(
    private agent: AgentConfig,
    private config: RoomConfig,
    environment = { ...process.env },
    private attachments?: AttachmentAccess,
  ) {
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
  async start(sessionId?: string): Promise<{ sessionId?: string; restored: boolean }> {
    this.activeImageTurn++;
    this.nativeImagePolicyVerified = undefined;
    this.imageModel = undefined;
    this.imageEffort = undefined;
    this.imagePolicy = undefined;
    this.nativeMaintenancePolicyFailures = [];
    await this.tools.check();
    const version = await runProcess('codex', ['--version']);
    this.imageCliVersion = version.code === 0 ? version.stdout.trim() : '';
    // No native route is enabled until this start completes; see the end of start().
    this.nativeCompaction = false;
    this.sourceHandoff = false;
    this.tools.registerRetrievalBridge({ key: codexImageBridge.key, report: this.imageSupport() });
    const satisfies = version.code === 0 ? codexVersionSatisfies(version.stdout) : undefined;
    if (satisfies === undefined)
      throw new Error(
        'Codex version could not be read from codex --version; Codex 0.153.0 or newer with app-server restricted-read support is required',
      );
    if (!satisfies)
      throw new Error('Codex 0.153.0 or newer with app-server restricted-read support is required');
    const executable = (process.env.PATH ?? '')
      .split(delimiter)
      .map((dir) => join(dir, 'codex'))
      .find((path) => existsSync(path));
    if (!executable) throw new Error('Codex executable not found');
    const runtimeExecutable = realpathSync(executable);
    const runtimeReads: Record<string, string> = {
      [dirname(executable)]: 'read',
      [dirname(dirname(runtimeExecutable))]: 'read',
    };
    const instructionFiles: string[] = [];
    const directories: string[] = [];
    for (let directory = this.config.workspace; ; directory = dirname(directory)) {
      directories.unshift(directory);
      if (dirname(directory) === directory) break;
    }
    for (const directory of [process.env.CODEX_HOME ?? join(homedir(), '.codex'), ...directories]) {
      const file = ['AGENTS.override.md', 'AGENTS.md']
        .map((name) => join(directory, name))
        .find((path) => existsSync(path));
      if (file && !instructionFiles.includes(file)) instructionFiles.push(file);
    }
    const nativeInstructions = instructionFiles
      .map((path) => `Native instructions from ${path}:\n${readFileSync(path, 'utf8')}`)
      .join('\n\n');
    // Native instructions are deliberate provider-runtime inputs, separate from task files.
    for (const path of [join(homedir(), '.codex', 'AGENTS.md')])
      if (existsSync(path)) runtimeReads[path] = 'read';
    for (let directory = this.config.workspace; ; directory = dirname(directory)) {
      const path = join(directory, 'AGENTS.md');
      if (existsSync(path)) runtimeReads[path] = 'read';
      if (dirname(directory) === directory) break;
    }
    const filesystem = {
      ':minimal': 'read',
      ':tmpdir': 'deny',
      ':slash_tmp': 'deny',
      [this.config.workspace]: 'read',
      ...runtimeReads,
    };
    this.proc = new JsonLinesProcess(
      // Resume invokes the binary again inside the restricted filesystem.
      // Launcher symlinks can cross unreadable paths before reaching this runtime.
      runtimeExecutable,
      [
        'app-server',
        ...(this.agent.effort
          ? ['-c', `model_reasoning_effort=${JSON.stringify(this.agent.effort)}`]
          : []),
        ...disabledFeatures.flatMap((name) => ['-c', `features.${name}=false`]),
        '-c',
        'features.code_mode_host=true',
        '-c',
        'web_search="disabled"',
        '-c',
        `permissions.${this.profile}.filesystem={ ${Object.entries(filesystem)
          .map(([path, access]) => `${JSON.stringify(path)} = ${JSON.stringify(access)}`)
          .join(', ')} }`,
        '-c',
        `permissions.${this.profile}.network.enabled=false`,
        // Newer CLIs refuse to load a config that defines permission profiles
        // without naming a default one. The default is the same restricted
        // profile every thread selects explicitly, so nothing widens; the
        // policy check below still requires that profile to be the active one.
        '-c',
        `default_permissions=${JSON.stringify(this.profile)}`,
      ],
      this.config.workspace,
    );
    this.proc.on('message', (message) => {
      if (message.method && message.id !== undefined) void this.answerRequest(message);
    });
    await this.proc.rpc('initialize', {
      clientInfo: { name: 'chittr', title: 'Chittr', version: packageVersion },
      capabilities: { experimentalApi: true },
    });
    this.proc.send({ method: 'initialized', params: {} });
    const account = await this.proc.rpc('account/read', { refreshToken: false });
    if (account.account?.type !== 'chatgpt')
      throw new Error(
        'Sign in to Codex with ChatGPT using codex login. Chittr requires subscription authentication.',
      );
    const cfg = await this.proc.rpc('config/read', {
      includeLayers: false,
      cwd: this.config.workspace,
    });
    for (const key of disabledFeatures)
      if (cfg.config.features?.[key] === true)
        throw new Error(
          `Codex policy overrides features.${key}; cannot enforce the room tool policy`,
        );
    const overrides: Record<string, unknown> = { web_search: 'disabled' };
    for (const key of Object.keys(cfg.config.mcp_servers || {}))
      overrides[`mcp_servers.${key}.enabled`] = false;
    const params = {
      cwd: this.config.workspace,
      runtimeWorkspaceRoots: [this.config.workspace],
      environments: [],
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      permissions: this.profile,
      config: overrides,
      ...(this.agent.model ? { model: this.agent.model } : {}),
      developerInstructions: [
        cfg.config.developer_instructions,
        nativeInstructions,
        instructions(this.agent, this.config),
      ]
        .filter(Boolean)
        .join('\n\n'),
      dynamicTools: toolSpecs(commandMode(this.config)),
    };
    let result: any;
    let restored = false;
    if (sessionId) {
      try {
        result = await this.proc.rpc('thread/resume', { ...params, threadId: sessionId });
      } catch (error) {
        // 0.153.4 does not expose environments on thread/resume. Its native
        // AGENTS loader can fail under restricted reads even though thread/start
        // with environments=[] works. Restore public history in a fresh thread;
        // never widen permissions to make native resume work.
        if (
          !/not found|no rollout|does not exist|unknown thread|failed to load.*thread|failed to load AGENTS\.md instructions.*fs sandbox helper/i.test(
            errorText(error),
          )
        )
          throw error;
        restored = true;
      }
    }
    if (!result) result = await this.proc.rpc('thread/start', params);
    this.threadId = result.thread.id;
    this.imageModel = typeof result.model === 'string' ? result.model : undefined;
    this.imageEffort =
      typeof result.reasoningEffort === 'string' ? result.reasoningEffort : undefined;
    const reportedProfile = cfg.config.permissions?.[this.profile];
    const reportedFilesystem = reportedProfile?.filesystem;
    this.imagePolicy = {
      ...codexSessionPolicy(result, this.config.workspace, this.profile),
      workspaceReadOnly: filesystem[this.config.workspace] === 'read',
      noWriteGrants: Object.values(filesystem).every(
        (access) => access === 'read' || access === 'deny',
      ),
      reportedFilesystemMatches:
        !!reportedFilesystem &&
        reportedProfile.extends === null &&
        Object.entries(filesystem).every(([path, access]) => reportedFilesystem[path] === access) &&
        Object.entries(reportedFilesystem).every(
          ([path, access]) => access === null || filesystem[path] === access,
        ),
      reportedNetworkDisabled: reportedProfile?.network?.enabled === false,
      temporaryRootsDenied: filesystem[':tmpdir'] === 'deny' && filesystem[':slash_tmp'] === 'deny',
      nativeFeaturesDisabled: disabledFeatures.every((key) => cfg.config.features?.[key] === false),
      webSearchDisabled: cfg.config.web_search === 'disabled',
      mcpOverridesDisabled: Object.keys(cfg.config.mcp_servers ?? {}).every(
        (key) => overrides[`mcp_servers.${key}.enabled`] === false,
      ),
      route: sessionId ? (restored ? 'resume-fallback' : 'resume') : 'start',
    };
    if (this.agent.effort) await this.validateEffort(result.model);
    // Attempt then validate. Images, the native compaction route and the
    // source-context handoff may be attempted on any CLI identity once the
    // thread's observed policy passed every required check: the named
    // restricted profile, never approvals with the user as reviewer, a
    // read-only sandbox without network, the direct read-only workspace grant,
    // the reported profile and network state, denied temporary roots, disabled
    // native features, web search and MCP servers. The thread's environment
    // projection and route are evidence only, so a resumed thread is decided by
    // the same checks as a fresh one. Neither flag claims the operation will
    // succeed: compact() requires its correlated compaction item and turn
    // completion, the handoff requires a valid maintenance result, and a
    // failure retains the saved reference and requires explicit recovery. A
    // missing or failed observation refuses startup below and names the
    // observation.
    this.nativeMaintenancePolicyFailures = Object.entries(this.imagePolicy)
      .filter(([key, value]) => !CodexAdapter.evidenceOnlyPolicy.includes(key) && value !== true)
      .map(([key]) => key);
    this.nativeImagePolicyVerified = !this.nativeMaintenancePolicyFailures.length;
    this.tools.registerRetrievalBridge({ key: codexImageBridge.key, report: this.imageSupport() });
    // A required observation that failed or is missing means the room cannot
    // enforce its policy on this thread at all, so startup refuses with the
    // observations named rather than continuing on any route.
    if (this.nativeMaintenancePolicyFailures.length) {
      const failed = this.nativeMaintenancePolicyFailures.join(', ');
      await this.proc.close();
      this.threadId = undefined;
      this.tools.registerRetrievalBridge({
        key: codexImageBridge.key,
        report: this.imageSupport(),
      });
      throw new Error(
        `Codex native policy checks failed on the started thread: ${failed}; the room cannot enforce its policy`,
      );
    }
    this.nativeCompaction = true;
    this.sourceHandoff = true;
    return { sessionId: this.threadId, restored };
  }
  private async validateEffort(model: string): Promise<void> {
    let cursor: string | undefined;
    do {
      const page = await this.proc!.rpc('model/list', {
        includeHidden: true,
        ...(cursor ? { cursor } : {}),
      });
      const entry = page.data?.find((item: any) => item.model === model || item.id === model);
      if (entry) {
        if (Array.isArray(entry.supportedReasoningEfforts)) {
          const accepted = entry.supportedReasoningEfforts.map((item: any) => item.reasoningEffort);
          const message = effortError('codex', this.agent.effort!, accepted, model);
          if (message) throw new Error(`@${this.agent.id}: ${message}`);
        }
        return;
      }
      cursor = page.nextCursor;
    } while (cursor);
    // Custom models may not appear in the catalogue. Config validation still
    // enforces the provider's effort vocabulary; the CLI handles unknown models.
  }
  private async answerRequest(message: any): Promise<void> {
    const proc = this.proc;
    if (!proc || proc.closed) return;
    try {
      if (message.method === 'item/tool/call') {
        const turnRevision = this.activeImageTurn;
        const signal = this.signal;
        const assertCurrent = () => {
          if (
            !signal ||
            !this.authorizedToolTurn ||
            signal.aborted ||
            this.signal !== signal ||
            this.activeImageTurn !== turnRevision ||
            message.params.threadId !== this.threadId ||
            message.params.turnId !== this.authorizedToolTurn ||
            this.proc !== proc ||
            proc.closed
          )
            throw new Error('No active room turn');
        };
        this.event?.({ type: 'activity', activity: 'working', detail: message.params.tool });
        let result: unknown;
        try {
          assertCurrent();
          result = await this.tools.call(message.params.tool, message.params.arguments, signal);
        } catch (error) {
          proc.send({
            id: message.id,
            result: {
              success: false,
              contentItems: [
                {
                  type: 'inputText',
                  text:
                    message.params.tool === 'read_attachment'
                      ? JSON.stringify(attachmentFailure(error))
                      : errorText(error),
                },
              ],
            },
          });
          return;
        }
        if (result instanceof AttachmentResult) {
          try {
            assertCurrent();
            const support = this.imageSupport().retrieval;
            if (!support.available) throw new Error('Native image retrieval is unavailable');
            result.dispatchCodex(message.id, (response, validate) =>
              proc.send(response, (serialized) => {
                validate(serialized);
                assertCurrent();
                if (!this.imageSupport().retrieval.available)
                  throw new Error('Native image retrieval is unavailable');
              }),
            );
          } catch (error) {
            proc.send({
              id: message.id,
              result: { ...codexToolResult(attachmentFailure(error)), success: false },
            });
          }
          return;
        }
        proc.send({
          id: message.id,
          result: codexToolResult(result),
        });
      } else if (/requestApproval$/.test(message.method))
        proc.send({ id: message.id, result: { decision: 'decline' } });
      else if (message.method === 'item/tool/requestUserInput')
        proc.send({ id: message.id, result: { answers: {} } });
      else
        proc.send({
          id: message.id,
          error: {
            code: -32601,
            message: 'Unavailable in Chittr. Use the room protocol and configured task tools.',
          },
        });
    } catch {
      /* A concurrent stop may close the transport. */
    }
  }
  async maintain(request: MaintenanceRequest, signal: AbortSignal): Promise<MaintenanceResult> {
    this.tools.setMaintenance(true);
    let result: MaintenanceResult;
    try {
      result = (await this.execute(
        { messages: [], context: [], participants: [] },
        () => {},
        signal,
        request,
      )) as MaintenanceResult;
    } catch (error) {
      if (error instanceof MaintenanceOutputError && !signal.aborted)
        this.tools.setMaintenance(false);
      throw error;
    }
    signal.throwIfAborted();
    this.tools.setMaintenance(false);
    return result;
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
    if (!proc || !this.threadId) throw new Error('Codex is not connected');
    const threadId = this.threadId;
    const hasImages = !maintenance && input.messages.some((message) => message.attachments?.length);
    if (hasImages) {
      const support = this.imageSupport().initial;
      if (!support.available) throw new Error(support.reason);
    }
    const nativeImages = hasImages ? codexInitialContent(input.messages, this.attachments) : [];
    const imageRevision = ++this.activeImageTurn;
    this.event = event;
    this.signal = maintenance ? undefined : signal;
    this.authorizedToolTurn = undefined;
    this.tools.setHistory(input.history ?? input.context);
    if (!maintenance) {
      this.tools.registerRetrievalBridge({
        key: codexImageBridge.key,
        report: this.imageSupport(),
      });
      this.tools.beginTurn();
    }
    return new Promise<TurnResult | MaintenanceResult>((resolve, reject) => {
      let text = '';
      let final = '';
      let outputError: unknown;
      let settled = false;
      let acceptedTurn: string | undefined;
      let earlyEvents: any[] = [];
      const cleanup = () => {
        this.activeImageTurn++;
        this.tools.endTurn();
        clearTimeout(timeout);
        proc.off('message', listener);
        proc.off('disconnect', disconnected);
        signal.removeEventListener('abort', abort);
        this.event = undefined;
        this.signal = undefined;
        this.authorizedToolTurn = undefined;
        if (this.turnId) this.retiredTurns.add(this.turnId);
        this.turnId = undefined;
      };
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else {
          try {
            if (maintenance && outputError) throw outputError;
            resolve(
              maintenance
                ? {
                    ...parseMaintenance(final || text, maintenance.id, maintenance.kind),
                    sessionId: this.threadId,
                  }
                : { outcomes: parseOutcomes(final || text), sessionId: this.threadId },
            );
          } catch (e) {
            reject(
              maintenance
                ? new MaintenanceOutputError(`Codex maintenance output invalid: ${errorText(e)}`)
                : new Error(`Codex did not account for its messages: ${errorText(e)}`),
            );
          }
        }
      };
      const abort = () => {
        void this.interrupt();
        finish(new Error('Interrupted'));
      };
      const disconnected = (error: Error) => finish(error);
      const listener = (m: any) => {
        if (maintenance && m.params?.threadId !== threadId) return;
        if (m.params?.threadId && m.params.threadId !== this.threadId) return;
        const eventTurn = m.params?.turnId ?? m.params?.turn?.id;
        if (eventTurn && this.retiredTurns.has(eventTurn)) return;
        if (!acceptedTurn) {
          if (earlyEvents.length >= 128)
            return finish(new Error('Too many events before turn acceptance'));
          earlyEvents.push(m);
          return;
        }
        if (eventTurn && eventTurn !== acceptedTurn) return;
        if (m.method === 'thread/tokenUsage/updated' && m.params?.threadId === this.threadId) {
          // `total` accumulates repeated API calls; only `last` describes context occupancy.
          const usage = contextUsage(
            m.params.tokenUsage?.last?.totalTokens,
            m.params.tokenUsage?.modelContextWindow,
          );
          if (usage) event({ type: 'context', usage });
        }
        if (m.method === 'item/started' && m.params.item?.type === 'contextCompaction')
          event({ type: 'context' });
        if (m.method === 'turn/started') {
          this.turnId = m.params.turn.id;
          event({ type: 'activity', activity: 'considering' });
        }
        if (m.method === 'item/agentMessage/delta') {
          text += m.params.delta;
          if (maintenance && Buffer.byteLength(text) > 131072) {
            void this.interrupt();
            finish(new Error('Maintenance output exceeded its transport limit'));
            return;
          }
          const preview = previewText(text);
          if (preview) {
            event({ type: 'activity', activity: 'replying' });
            event({ type: 'text', text: preview });
          }
        }
        if (m.method === 'item/started' && /Call|Execution|Change/.test(m.params.item?.type ?? ''))
          event({
            type: 'activity',
            activity: 'working',
            detail: m.params.item.tool ?? m.params.item.type,
          });
        if (m.method === 'item/completed' && m.params.item?.type === 'agentMessage') {
          const value = m.params.item.text;
          try {
            if (maintenance) parseMaintenance(value, maintenance.id, maintenance.kind);
            else parseOutcomes(value);
            final = value;
            outputError = undefined;
          } catch (error) {
            if (maintenance) outputError = error;
          }
          text = '';
        }
        if (m.method === 'turn/completed')
          finish(
            m.params.turn.status === 'completed'
              ? undefined
              : new Error(m.params.turn.error?.message || `Codex turn ${m.params.turn.status}`),
          );
      };
      const timeout = setTimeout(() => {
        void this.interrupt();
        finish(
          new Error('Codex turn exceeded 10 minutes; pending messages require explicit retry'),
        );
      }, 600000);
      proc.on('message', listener);
      proc.on('disconnect', disconnected);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) {
        abort();
        return;
      }
      proc
        .rpc(
          'turn/start',
          {
            threadId: this.threadId,
            environments: [],
            input: [
              {
                type: 'text',
                text: prompt,
              },
              ...nativeImages,
            ],
            approvalPolicy: 'never',
            ...(this.agent.effort ? { effort: this.agent.effort } : {}),
            outputSchema: maintenance ? maintenanceOutputSchema : outputSchema,
          },
          30000,
          (serialized) => {
            if (nativeImages.length) {
              assertCodexFrame(serialized);
              signal.throwIfAborted();
              if (
                this.activeImageTurn !== imageRevision ||
                this.signal !== signal ||
                !this.imageSupport().initial.available
              )
                throw new Error('Attachment turn ended');
            }
          },
        )
        .then((result) => {
          if (settled) {
            this.retiredTurns.add(result.turn.id);
            // An abort before acknowledgement still owns this native turn.
            if (!proc.closed)
              void proc
                .rpc('turn/interrupt', { threadId, turnId: result.turn.id }, 3000)
                .catch(() => {});
            return;
          }
          this.turnId = result.turn.id;
          acceptedTurn = result.turn.id;
          if (!maintenance) this.authorizedToolTurn = acceptedTurn;
          const events = earlyEvents;
          earlyEvents = [];
          for (const message of events) {
            if (!settled) listener(message);
          }
          if (!settled) event({ type: 'received' });
        })
        .catch((e) => finish(e));
    });
  }
  async interrupt(): Promise<void> {
    this.activeImageTurn++;
    this.authorizedToolTurn = undefined;
    this.tools.interrupt();
    if (this.proc && this.threadId && this.turnId && !this.proc.closed)
      await this.proc
        .rpc('turn/interrupt', { threadId: this.threadId, turnId: this.turnId }, 3000)
        .catch(() => {});
  }
  async compact(
    operationId: string,
    signal: AbortSignal,
  ): Promise<import('../types.js').CompactionResult> {
    const proc = this.proc;
    const threadId = this.threadId;
    if (!proc || !threadId || proc.closed) throw new Error('Codex is not connected');
    if (this.signal || this.maintenanceId) throw new Error('Codex already has an active operation');
    signal.throwIfAborted();
    this.maintenanceId = operationId;
    this.tools.setMaintenance(true);
    try {
      return await new Promise((resolve, reject) => {
        let settled = false;
        let itemId: string | undefined;
        let itemCompleted = false;
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          proc.off('message', listener);
          proc.off('disconnect', disconnected);
          signal.removeEventListener('abort', abort);
          if (error) reject(error);
          else resolve({ status: 'completed' });
        };
        const cancel = async () => {
          if (this.maintenanceTurn)
            await proc
              .rpc('turn/interrupt', { threadId, turnId: this.maintenanceTurn }, 3000)
              .catch(() => {});
          // Cancellation cannot establish that native history was rolled back.
          await proc.close();
        };
        const abort = () => {
          finish(new Error('Compaction cancelled; reconnect before continuing'));
          void cancel();
        };
        const disconnected = (error: Error) => finish(error);
        const listener = (message: any) => {
          const p = message.params;
          if (p?.threadId !== threadId || this.maintenanceId !== operationId) return;
          if (
            message.method === 'turn/started' &&
            !this.maintenanceTurn &&
            !this.retiredTurns.has(p.turn?.id)
          )
            this.maintenanceTurn = p.turn?.id;
          if (!this.maintenanceTurn) return;
          if (
            message.method === 'item/started' &&
            p.turnId === this.maintenanceTurn &&
            p.item?.type === 'contextCompaction'
          )
            itemId = p.item.id;
          if (
            message.method === 'item/completed' &&
            p.turnId === this.maintenanceTurn &&
            p.item?.type === 'contextCompaction' &&
            itemId &&
            p.item.id === itemId
          )
            itemCompleted = true;
          if (message.method === 'turn/completed' && p.turn?.id === this.maintenanceTurn) {
            if (p.turn.status !== 'completed')
              finish(new Error(p.turn.error?.message ?? `Codex compaction ${p.turn.status}`));
            else if (itemCompleted) finish();
            else finish(new Error('Codex did not confirm compaction completion'));
          }
        };
        const timer = setTimeout(() => {
          finish(new Error('Codex compaction timed out; reconnect before continuing'));
          void cancel();
        }, 120000);
        proc.on('message', listener);
        proc.on('disconnect', disconnected);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) return abort();
        void proc.rpc('thread/compact/start', { threadId }).catch((error: Error) => finish(error));
      });
    } finally {
      this.maintenanceId = undefined;
      if (this.maintenanceTurn) this.retiredTurns.add(this.maintenanceTurn);
      this.maintenanceTurn = undefined;
      // No room work may run after an ambiguous failure until explicit recovery.
      if (!signal.aborted && !proc.closed) this.tools.setMaintenance(false);
    }
  }
  async close(): Promise<void> {
    this.nativeCompaction = false;
    this.sourceHandoff = false;
    await this.interrupt();
    await this.proc?.close();
    this.tools.close();
  }
}
