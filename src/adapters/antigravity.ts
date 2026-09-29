import { unavailableImageSupport } from '../image-support.js';
import type { MaintenanceRequest, MaintenanceResult } from '../types.js';
import { maintenancePrompt, parseMaintenance } from '../protocol.js';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { probeContent, type HookObservation } from '../antigravity-hook.js';
import type {
  AgentAdapter,
  AgentConfig,
  RoomConfig,
  TurnInput,
  TurnResult,
  AdapterEvent,
} from '../types.js';
import { JsonLinesProcess, errorText, providerEnv, runProcess } from '../process.js';
import {
  instructions,
  processOutputSchema as outputSchema,
  parseOutcomes,
  previewText,
  turnPrompt,
} from '../protocol.js';
import { builtFile, toolSpecs } from '../tools.js';
import { commandMode } from '../command-access.js';
import { IsolatedRuntime, roomToolNames } from './isolated.js';
import type { AttachmentAccess } from '../attachments.js';

export function antigravitySettings() {
  return {
    toolPermission: 'request-review',
    allowNonWorkspaceAccess: false,
    useG1Credits: false,
    enableTelemetry: false,
    permissions: {
      deny: [
        'read_file(*)',
        'write_file(*)',
        'command(*)',
        'unsandboxed(*)',
        'read_url(*)',
        'execute_url(*)',
      ],
      allow: roomToolNames.map((name) => `mcp(chittr/${name})`),
    },
  };
}

export function antigravityEnv(home: string): NodeJS.ProcessEnv {
  const env = providerEnv();
  for (const key of Object.keys(env))
    if (/^(AGY_|ANTIGRAVITY_|JETSKI_|GEMINI_|GOOGLE_)/.test(key)) delete env[key];
  return { ...env, HOME: home, AGY_CLI_DISABLE_AUTO_UPDATE: '1' };
}

/**
 * Where the room policy hook records each invocation: inside the isolated
 * native home, beside the generated hook configuration, never in the workspace.
 */
export function hookObservationFile(home: string): string {
  return join(home, '.gemini/config/chittr-hook-observations.jsonl');
}
/** Reads the byte-free hook records; malformed lines are ignored, never trusted. */
export function readHookObservations(path: string): HookObservation[] {
  let text = '';
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  const records: HookObservation[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line);
      if (
        typeof value?.tool === 'string' &&
        value.tool.length <= 64 &&
        (value.decision === 'allow' || value.decision === 'deny')
      )
        records.push({
          tool: value.tool,
          decision: value.decision,
          ...(typeof value.probeTarget === 'boolean' ? { probeTarget: value.probeTarget } : {}),
        });
    } catch {
      /* Not a record. */
    }
  }
  return records;
}
/**
 * The startup enforcement probe: one bounded maintenance turn, task tools
 * denied, before the room gets the session. The selected profile is asked to
 * call the native `write_file` tool once, on a host-named file inside the
 * isolated scratch directory. The enforcement contract is observed when the
 * room policy hook recorded exactly one `write_file` denial whose arguments
 * met the closed probe contract, the CLI's own result reported exactly that
 * denied write, the file does not exist afterwards and nothing else appeared
 * in the scratch directory: the live selected profile consulted the hook
 * before executing a native tool and honored the denial, and said so. A file
 * that exists, any other new entry, a write recorded against another target or
 * outside the contract, a second write, no `write_file` record, any task-tool
 * attempt, or a result whose denied-action report is not exactly that write
 * (a call the CLI rejected for its own reasons, or another denied call, is not
 * an honored denial of the probe write) refuses startup with that reason. A
 * hook invocation alone, for example on `finish`, is not enforcement evidence.
 */
export const antigravityProbeTool = 'write_file';
export function antigravityEnforcementProbe(marker: string): string {
  return (
    'Startup policy probe. Step 1: call the native write_file tool exactly once to create a file named ' +
    `${marker} in the current directory with the content "${probeContent}". Step 2: whether or not step 1 ` +
    'succeeded, call finish with the maintenance result text "policy probe". Do not call any other tool.'
  );
}
/** Mutable so deterministic tests can bound the wait; the product value is 60 s. */
export const antigravityEnforcement = { timeoutMs: 60000 };
/**
 * The CLI's own denied-action report must identify the single probe write and
 * nothing else. An entry is the probe write when it is the string
 * `write_file`, or a plain object whose name-like fields (`name`, `tool`,
 * `tool_name`, `toolName`, `action`) all equal `write_file` with at least one
 * present. Any other entry, an empty or malformed array, or more than one entry
 * is not that report: the format is not established on a live build, so an
 * unrecognized report yields no enforcement evidence.
 */
export function deniedProbeWriteReported(deniedActions: unknown): boolean {
  if (!Array.isArray(deniedActions) || deniedActions.length !== 1) return false;
  const entry = deniedActions[0];
  if (entry === antigravityProbeTool) return true;
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
  const names = ['name', 'tool', 'tool_name', 'toolName', 'action'].filter((key) =>
    Object.hasOwn(entry as object, key),
  );
  return (
    names.length > 0 &&
    names.every((key) => (entry as Record<string, unknown>)[key] === antigravityProbeTool)
  );
}

export class AntigravityAdapter implements AgentAdapter {
  private imageCliVersion = '';
  private hookObservations: HookObservation[] = [];
  private probeMarkerWritten?: boolean;
  private probeScratchAdditions?: number;
  private probeDeniedActions?: number;
  private probeDeniedWrite?: boolean;
  /** The one native tool the running probe expects to see attempted; undefined outside the probe. */
  private probeTool?: string;
  imageSupport() {
    return unavailableImageSupport('antigravity', this.imageCliVersion);
  }
  /** Byte-free startup evidence: what the hook recorded during the enforcement probe. */
  get enforcementEvidence() {
    return {
      cliVersion: this.imageCliVersion,
      hookObservations: [...this.hookObservations],
      probeMarkerWritten: this.probeMarkerWritten,
      probeScratchAdditions: this.probeScratchAdditions,
      deniedActionsReported: this.probeDeniedActions,
      deniedProbeWriteReported: this.probeDeniedWrite,
      enforcementObserved:
        this.probeMarkerWritten === false &&
        this.probeScratchAdditions === 0 &&
        this.probeDeniedWrite === true &&
        this.hookObservations.filter((record) => record.tool === antigravityProbeTool).length ===
          1 &&
        this.hookObservations.some(
          (record) =>
            record.tool === antigravityProbeTool &&
            record.decision === 'deny' &&
            record.probeTarget === true,
        ),
    };
  }
  readonly nativeCompaction = false;
  readonly sourceHandoff = false;
  private proc?: JsonLinesProcess;
  private runtime?: IsolatedRuntime;
  private sessionId?: string;
  constructor(
    private agent: AgentConfig,
    private config: RoomConfig,
    private environment = { ...process.env },
    private attachments?: AttachmentAccess,
  ) {}

  async start(previousSession?: string): Promise<{ sessionId: string; restored: boolean }> {
    try {
      if (process.platform !== 'darwin')
        throw new Error('Antigravity support currently requires macOS Keychain login');
      const version = await runProcess('agy', ['--version'], { env: providerEnv() });
      this.imageCliVersion = version.code === 0 ? version.stdout.trim() : '';
      this.hookObservations = [];
      this.probeMarkerWritten = undefined;
      this.probeScratchAdditions = undefined;
      this.probeDeniedActions = undefined;
      this.probeDeniedWrite = undefined;
      // The CLI identity is evidence only. Nothing below compares it: the init
      // event lists the global registry, not the selected agent's effective
      // tools, so profile enforcement is established on the live process by
      // the hook self-check and the enforcement probe instead of by a version.
      if (version.code || !version.stdout.trim())
        throw new Error('Antigravity CLI version could not be read from agy --version');
      const help = await runProcess('agy', ['--help'], { env: providerEnv() });
      for (const flag of [
        '--agent',
        '--input-format',
        '--output-format',
        '--json-schema',
        '--disable-slash-commands',
        ...(this.agent.effort ? ['--effort'] : []),
      ])
        if (help.code || !(help.stdout + help.stderr).includes(flag))
          throw new Error(`Antigravity CLI lacks ${flag}`);
      const runtime = (this.runtime = new IsolatedRuntime(
        this.agent,
        this.config,
        this.environment,
        this.attachments,
      ));
      await runtime.tools.check();
      runtime.tools.registerRetrievalBridge({ key: 'antigravity', report: this.imageSupport() });
      mkdirSync(join(runtime.home, 'Library'));
      // Preserve native OAuth in Keychain without inheriting CLI configuration,
      // plugins, workspaces, or credential files into the agent's tool scope.
      symlinkSync(join(homedir(), 'Library/Keychains'), join(runtime.home, 'Library/Keychains'));
      const nativeHome = join(runtime.home, '.gemini/antigravity-cli');
      const customizations = join(runtime.home, '.gemini/config');
      mkdirSync(nativeHome, { recursive: true });
      mkdirSync(join(customizations, 'agents/chittr'), { recursive: true });
      writeFileSync(join(nativeHome, 'settings.json'), JSON.stringify(antigravitySettings()));
      writeFileSync(
        join(customizations, 'mcp_config.json'),
        JSON.stringify({ mcpServers: { chittr: await runtime.mcp() } }),
      );
      const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
      const observations = hookObservationFile(runtime.home);
      writeFileSync(observations, '', { mode: 0o600 });
      // The host names the probe target before the hook exists, so the hook
      // can say whether a native write's destination is exactly that file,
      // by absolute path or bare name, without recording arguments.
      const probeMarker = `chittr-policy-probe-${randomUUID().slice(0, 8)}.txt`;
      const probeTarget = join(runtime.cwd, probeMarker);
      writeFileSync(
        join(customizations, 'hooks.json'),
        JSON.stringify({
          'chittr-policy': {
            PreToolUse: [
              {
                matcher: '*',
                hooks: [
                  {
                    type: 'command',
                    command: `${quote(process.execPath)} ${quote(builtFile('antigravity-hook.js'))} ${quote(observations)} ${quote(probeTarget)}`,
                    timeout: 10,
                  },
                ],
              },
            ],
          },
        }),
      );
      // Only the native completion tool is needed alongside inherited MCP.
      // Adding call_mcp_tool to tools causes an unknown-component executor error.
      writeFileSync(
        join(customizations, 'agents/chittr/agent.md'),
        `---
name: chittr
description: Chittr participant
mainAgent: true
subagent: false
tools: [finish]
inheritMcp: true
commandExecutionPolicy: off
skills: []
plugins: []
---
${instructions(this.agent, this.config)}
Use the native finish tool to return your final structured outcomes after completing tool work.
The chittr MCP tools operate on the real launch directory, regardless of the CLI's scratch cwd.
Do not inspect native tool schema files or look for other tools. Call call_mcp_tool with
ServerName=chittr, ToolName from the list below, and Arguments matching its inputSchema:
${JSON.stringify(toolSpecs(commandMode(this.config)))}
`,
      );
      const env = antigravityEnv(runtime.home);
      const hook = await runProcess(
        process.execPath,
        [builtFile('antigravity-hook.js'), observations, probeTarget],
        {
          cwd: runtime.cwd,
          env,
          input: JSON.stringify({ toolCall: { name: 'view_file' } }),
        },
      );
      let hookDecision: unknown;
      try {
        hookDecision = JSON.parse(hook.stdout).decision;
      } catch {
        /* Refuse a broken hook. */
      }
      if (hook.code || hookDecision !== 'deny')
        throw new Error(
          'Antigravity room policy hook is missing or invalid. Reinstall the same @chittr/cli package. In a source checkout, run npm run build.',
        );
      // The self-check also proves the hook records its invocations, which the
      // enforcement probe below depends on. The record is then cleared so only
      // the live process can write the next one.
      if (
        !readHookObservations(observations).some(
          (record) => record.tool === 'view_file' && record.decision === 'deny',
        )
      )
        throw new Error(
          'Antigravity room policy hook did not record its decision. Reinstall the same @chittr/cli package. In a source checkout, run npm run build.',
        );
      writeFileSync(observations, '', { mode: 0o600 });
      const models = await runProcess('agy', ['models'], { cwd: runtime.cwd, env });
      const availableModels = models.stdout
        .split(/\r?\n/)
        .filter((line) => /^[\w.-]+\t/.test(line))
        .map((line) => line.split('\t')[0]);
      if (models.code || !availableModels.length)
        throw new Error(
          'Antigravity subscription login could not be verified. Run agy and sign in first.',
        );
      if (this.agent.model && !availableModels.includes(this.agent.model))
        throw new Error(
          `Antigravity model ${this.agent.model} is unavailable. Run agy models for model IDs.`,
        );
      const proc = (this.proc = new JsonLinesProcess(
        'agy',
        [
          '--input-format',
          'stream-json',
          '--output-format',
          'stream-json',
          '--disable-slash-commands',
          '--agent',
          'chittr',
          '--json-schema',
          JSON.stringify(outputSchema),
          '--print-timeout',
          '10m',
          ...(this.agent.model ? ['--model', this.agent.model] : []),
          ...(this.agent.effort ? ['--effort', this.agent.effort] : []),
        ],
        runtime.cwd,
        env,
      ));
      this.sessionId = await new Promise<string>((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer);
          proc.off('message', listener);
          proc.off('disconnect', fail);
        };
        const fail = (error: Error) => {
          cleanup();
          reject(error);
        };
        const listener = (message: any) => {
          if (message.event !== 'init') return;
          if (
            message.init?.agent !== 'chittr' ||
            message.init?.permission_mode !== 'request-review' ||
            !message.init?.tools?.includes('call_mcp_tool') ||
            typeof message.conversation_id !== 'string'
          )
            return fail(new Error('Antigravity did not initialize the required room profile'));
          cleanup();
          resolve(message.conversation_id);
        };
        const timer = setTimeout(
          () => fail(new Error('Antigravity initialization timed out. Run agy and sign in first.')),
          30000,
        );
        proc.on('message', listener);
        proc.on('disconnect', fail);
      });
      await this.probeEnforcement(observations, runtime.cwd, probeMarker);
      return { sessionId: this.sessionId, restored: Boolean(previousSession) };
    } catch (error) {
      await this.close();
      throw error;
    }
  }
  /**
   * Selected-profile enforcement contract. The probe is a maintenance turn:
   * task tools are denied, no room history is supplied and no outcome can be
   * published. The selected profile is asked to attempt one native write inside
   * the isolated scratch directory. Enforcement is observed only when the hook
   * recorded its denial of that write and the file does not exist afterwards;
   * the CLI's own denied-action report is recorded as evidence. A file that
   * exists, a native tool other than the expected one, a missing denial record,
   * a failed turn without a denial, or a timeout refuses startup with that
   * reason, before the room ever dispatches a turn. Every other startup check
   * stays in place; this one is what a version string used to stand in for.
   */
  private async probeEnforcement(
    observations: string,
    cwd: string,
    probeMarker: string,
  ): Promise<void> {
    const marker = join(cwd, probeMarker);
    const before = new Set(readdirSync(cwd));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), antigravityEnforcement.timeoutMs);
    const proc = this.proc;
    const denials = (message: any) => {
      if (message?.event === 'result' && message.result?.conversation_id === this.sessionId) {
        this.probeDeniedActions = Array.isArray(message.result.denied_actions)
          ? message.result.denied_actions.length
          : 0;
        this.probeDeniedWrite = deniedProbeWriteReported(message.result.denied_actions);
      }
    };
    proc?.on('message', denials);
    this.probeTool = antigravityProbeTool;
    let failure: string | undefined;
    try {
      await this.maintain(
        {
          id: randomUUID(),
          kind: 'handoff',
          prompt: antigravityEnforcementProbe(basename(marker)),
        },
        controller.signal,
      );
    } catch (error) {
      failure = errorText(error);
    } finally {
      clearTimeout(timer);
      this.probeTool = undefined;
      proc?.off('message', denials);
      // A probe turn the CLI ends by the denial leaves maintain() without
      // releasing the shared task-tool gate; the room gets it released.
      this.runtime?.tools.setMaintenance(false);
    }
    if (controller.signal.aborted)
      throw new Error(
        'Antigravity policy enforcement probe timed out before room access; native tool enforcement is not established',
      );
    this.hookObservations = readHookObservations(observations);
    this.probeMarkerWritten = existsSync(marker);
    this.probeScratchAdditions = readdirSync(cwd).filter((name) => !before.has(name)).length;
    if (this.probeMarkerWritten || this.probeScratchAdditions)
      throw new Error(
        `Antigravity executed a native write during the policy enforcement probe despite the room policy hook (${this.probeMarkerWritten ? 'the probe target exists' : `${this.probeScratchAdditions} new scratch entries`}); native tool enforcement is not established for this CLI`,
      );
    const writes = this.hookObservations.filter((record) => record.tool === antigravityProbeTool);
    // Task tools are denied during the probe; an attempt on one is not part of
    // the contract and its denial could not stand in for the write's.
    const unexpected = this.hookObservations.filter(
      (record) => !['finish', antigravityProbeTool].includes(record.tool),
    );
    if (unexpected.length)
      throw new Error(
        `Antigravity attempted native tools during the policy enforcement probe: ${unexpected.map((record) => `${record.tool} (${record.decision})`).join(', ')}`,
      );
    if (writes.some((record) => record.probeTarget !== true) || writes.length > 1)
      throw new Error(
        `Antigravity attempted ${writes.length} native ${antigravityProbeTool} call(s) during the policy enforcement probe whose destination was not exactly the probe target; native tool enforcement is not established for this CLI`,
      );
    // A probe turn that failed, or whose process is gone, cannot admit the
    // session whatever the hook recorded: the failure explains itself.
    if (failure || this.proc?.closed !== false)
      throw new Error(
        `Antigravity policy enforcement probe failed before room access: ${failure ?? 'the native process closed'}`,
      );
    if (this.enforcementEvidence.enforcementObserved) return;
    if (writes.length === 1 && !this.probeDeniedWrite)
      throw new Error(
        `Antigravity did not report exactly the denied ${antigravityProbeTool} call the room policy hook denied (${this.probeDeniedActions ?? 0} denied action(s) reported); native tool enforcement is not established for this CLI`,
      );
    // The turn completed without a recorded denial: the selected profile never
    // routed the native call through the room policy hook.
    throw new Error(
      `Antigravity selected profile completed the policy probe without routing its native ${antigravityProbeTool} call through the room policy hook; native tool enforcement is not established for this CLI`,
    );
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
    if (!proc || !this.sessionId) throw new Error('Antigravity is not connected');
    this.runtime!.tools.setHistory(input.history ?? input.context);
    if (!maintenance) this.runtime!.tools.beginTurn();
    return new Promise((resolve, reject) => {
      let text = '',
        lastActivity = '',
        step: number | undefined;
      const activity = (value: 'considering' | 'working' | 'replying', detail?: string) => {
        const key = JSON.stringify([value, detail]);
        if (key !== lastActivity) {
          lastActivity = key;
          event({ type: 'activity', activity: value, detail });
        }
      };
      let received = false,
        settled = false;
      const finish = (error?: Error, result?: any) => {
        if (settled) return;
        settled = true;
        this.runtime!.tools.endTurn();
        clearTimeout(timer);
        proc.off('message', listener);
        proc.off('disconnect', fail);
        signal.removeEventListener('abort', abort);
        if (error) {
          void this.interrupt();
          reject(error);
        } else {
          try {
            const value = result.structured_output ?? result.response ?? text;
            resolve(
              maintenance
                ? {
                    ...parseMaintenance(value, maintenance.id, maintenance.kind),
                    sessionId: this.sessionId,
                  }
                : {
                    outcomes: parseOutcomes(value),
                    sessionId: this.sessionId,
                  },
            );
          } catch (error) {
            void this.interrupt();
            reject(error);
          }
        }
      };
      const fail = (error: Error) => finish(error);
      const abort = () => fail(new Error('Interrupted'));
      const listener = (message: any) => {
        const update = message.step_update;
        if (update?.conversation_id === this.sessionId) {
          if (!received && update.step_type === 'user_input') {
            received = true;
            event({ type: 'received' });
          }
          if (update.step_type === 'tool') {
            // MCP inheritance also exposes its resource discovery wrappers.
            // The policy hook denies these (the room has no MCP resources).
            // During the startup probe the one expected native attempt is
            // observed rather than aborted, so the hook's denial and the
            // absence of the file can be checked afterwards.
            if (
              !['call_mcp_tool', 'list_resources', 'read_resource', 'finish'].includes(
                update.tool_name,
              ) &&
              update.tool_name !== this.probeTool
            )
              return fail(
                new Error(`Antigravity attempted an unexpected native tool: ${update.tool_name}`),
              );
            if (update.tool_name === 'finish') activity('replying');
            else activity('working', update.tool_info?.parameters?.ToolName ?? 'room tool');
          }
          if (update.step_type === 'agent_response' && update.text_delta) {
            if (step !== update.step_index) {
              text = '';
              step = update.step_index;
            }
            text += update.text_delta;
            if (maintenance && Buffer.byteLength(text) > 131072)
              return fail(new Error('Maintenance output exceeded its transport limit'));
            const preview = previewText(text);
            if (preview) {
              activity('replying');
              event({ type: 'text', text: preview });
            }
          }
        }
        if (message.event === 'result' && message.result?.conversation_id === this.sessionId) {
          const result = message.result;
          // A denied action fails an ordinary turn. During the startup probe
          // the denial of its one requested native write is the expected
          // outcome, so a successful result that reports it completes the
          // probe; the hook record and the absent file are checked afterwards.
          const deniedProbe =
            Boolean(this.probeTool) &&
            result.status === 'SUCCESS' &&
            Array.isArray(result.denied_actions) &&
            result.denied_actions.length > 0;
          finish(
            result.status !== 'SUCCESS' || (result.denied_actions?.length && !deniedProbe)
              ? new Error(
                  result.error ||
                    'Antigravity could not complete the room turn; check CLI permissions and login',
                )
              : undefined,
            result,
          );
        }
      };
      const timer = setTimeout(
        () =>
          fail(
            new Error('Antigravity turn exceeded 10 minutes; explicitly retry pending messages'),
          ),
        600000,
      );
      proc.on('message', listener);
      proc.on('disconnect', fail);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) return abort();
      activity('considering');
      try {
        proc.send({
          event: 'user',
          message: {
            content: prompt,
          },
        });
      } catch (error) {
        fail(error as Error);
      }
    });
  }
  async interrupt(): Promise<void> {
    this.runtime?.tools.interrupt();
    await this.proc?.close();
  }
  async close(): Promise<void> {
    await this.interrupt();
    this.runtime?.close();
    this.runtime = undefined;
  }
}
