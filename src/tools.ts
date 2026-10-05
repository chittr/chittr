import { registeredImageMapping, type RetrievalBridgeRegistration } from './image-support.js';
import { randomUUID } from 'node:crypto';
import { publicMessage } from './checkpoint.js';
import { AttachmentResult, attachmentFailure, retrievalUnavailable } from './attachment-result.js';
import {
  realpathSync,
  existsSync,
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  renameSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { Permissions, Message, CommandMode, PlanStateLocation } from './types.js';
import {
  checkedPlanPath,
  planHash,
  planStateRoot,
  readAgentPlan,
  readPlan,
  readPlanMode,
  recordAgentPlan,
  withPlanLock,
} from './plan.js';
import { runProcess } from './process.js';
import type { SkillAccess } from './skill-access.js';
import type { AttachmentAccess } from './attachments.js';
import {
  CommandBroker,
  commandBrokerRoot,
  commandInput,
  forwardCommand,
  type CommandEndpoint,
} from './command-broker.js';

export const toolInputs = {
  read_attachment: z.strictObject(
    { attachment_id: z.string().regex(/^att-[a-f0-9]{32}$/) },
    { error: 'Invalid attachment request' },
  ),
  read_file: z
    .object({
      path: z.string().min(1),
      offset: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(131072).optional(),
    })
    .strict(),
  list_files: z
    .object({
      path: z.string().optional(),
      recursive: z.boolean().optional(),
      limit: z.number().int().min(1).max(5000).optional(),
    })
    .strict(),
  write_file: z.object({ path: z.string().min(1), text: z.string().max(1024 * 1024) }).strict(),
  run_command: commandInput,
  fetch_url: z.object({ url: z.url().max(8000) }).strict(),
  read_conversation: z
    .object({
      message_id: z.string().optional(),
      offset: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(50).optional(),
    })
    .strict(),
};
export type ToolName = keyof typeof toolInputs;
type ToolInput = z.infer<(typeof toolInputs)[ToolName]>;
type PlanMode = ReturnType<typeof readPlanMode>;
export const toolDescriptions: Record<ToolName, string> = {
  read_attachment:
    'Read the pixels of an image by its attachment_id from public room history. Discover IDs in message attachments using read_conversation exact lookup or offset/limit pagination. No paths or URLs. Unverified provider bridges return unavailable.',
  read_file:
    'Read text inside the launch directory or a discovered read-only skill bundle. Byte offsets support large files. Skill symlinks are followed within the registered bundles; other workspace symlinks are not traversed.',
  list_files:
    'List workspace or discovered skill-bundle files, optionally recursively. Dotfiles are included. Skill symlinks are followed within registered bundles; other workspace symlinks are not traversed.',
  write_file:
    'Write a UTF-8 workspace file. Requires room permissions.edits=true; otherwise explain the missing permission and require a config change.',
  run_command:
    'Run a shell command in the launch directory under the room filesystem and network sandbox. Requires permissions.commands=true. Edits and network remain independent permissions.',
  fetch_url:
    'Fetch an HTTP(S) URL as text. Requires room permissions.network=true; otherwise require a config change.',
  read_conversation:
    'Read the public room conversation, including full messages omitted from a history digest. Use message_id for an exact message, or offset/limit for pagination. This exposes conversation context only, not filesystem paths.',
};
export function descriptionFor(name: ToolName, mode: CommandMode = 'sandboxed'): string {
  return name === 'run_command' && mode === 'trusted'
    ? "Run a trusted shell command in the launch directory with the launching user's exported environment and account access. Commands can read and write outside the workspace, modify skill bundles, use existing credentials and access the network. File-tool restrictions do not restrict these commands."
    : toolDescriptions[name];
}
export function toolSpecs(mode?: CommandMode) {
  return Object.entries(toolInputs).map(([name, schema]) => ({
    type: 'function' as const,
    name,
    description: descriptionFor(name as ToolName, mode),
    inputSchema: z.toJSONSchema(schema, { target: 'draft-7' }),
  }));
}
export function builtFile(name: string): string {
  const directory = dirname(fileURLToPath(import.meta.url));
  return existsSync(join(directory, name))
    ? join(directory, name)
    : resolve(directory, '..', 'dist', name);
}
const quote = (s: string) => JSON.stringify(s);
export function sandboxProfile(
  workspace: string,
  permissions: Permissions,
  scratch: string,
  worker = false,
  skills: SkillAccess[] = [],
  plan?: string,
): string {
  const nodeRoot = dirname(dirname(realpathSync(process.execPath)));
  const roots = [
    workspace,
    ...skills.map((skill) => skill.root),
    '/System/Library',
    '/usr/lib',
    '/usr/libexec',
    '/usr/share',
    '/usr/bin',
    '/bin',
    '/sbin',
    '/usr/sbin',
    '/Library/Apple',
    '/Library/Preferences',
    '/Library/Developer/CommandLineTools',
    '/private/var/db/dyld',
    '/private/var/db/timezone',
    '/opt/homebrew/Cellar',
    '/opt/homebrew/lib',
    nodeRoot,
    scratch,
  ];
  if (worker) roots.push(dirname(builtFile('tool-worker.js')));
  // Only a file-tool call on the attached plan admits that exact path. Commands never do.
  const planFile = worker && plan ? ` (literal ${quote(plan)})` : '';
  return `(version 1)
(deny default)
(allow process-exec process-fork process-info* sysctl-read file-map-executable)
(allow system-mac-syscall (mac-policy-name "vnguard"))
(allow system-mac-syscall (require-all (mac-policy-name "Sandbox") (mac-syscall-number 67)))
(allow signal (target self))
(allow file-read-metadata file-test-existence)
(allow mach-lookup)
(allow file-read* ${[...new Set(roots)].map((p) => `(subpath ${quote(p)})`).join(' ')}${planFile} (literal "/") (subpath "/dev/fd") (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random") (literal "/private/etc/passwd") (literal "/private/etc/localtime"))
(allow file-write* (literal "/dev/null") (subpath ${quote(scratch)}) ${permissions.edits ? `(subpath ${quote(workspace)})` : ''}${planFile})
${skills.length ? `(deny file-write* ${[...new Set(skills.flatMap((s) => [s.path, s.root]))].map((p) => `(subpath ${quote(p)})`).join(' ')})` : ''}
${permissions.network && !worker ? '(allow network-outbound network-inbound)' : '(deny network*)'}
(deny file-read* file-write* (subpath ${quote(commandBrokerRoot)}) (subpath ${quote(planStateRoot)}))
(deny network-outbound (remote unix-socket (subpath ${quote(commandBrokerRoot)})))`;
}
export type CommandRuntime =
  | { mode: CommandMode; environment: NodeJS.ProcessEnv; endpoint?: never }
  | { mode: CommandMode; endpoint: CommandEndpoint; environment?: never };
export class ToolService {
  readonly scratch: string;
  readonly historyFile: string;
  readonly maintenanceFile: string;
  readonly attachmentTurnFile: string;
  private ownsAttachmentTurn: boolean;
  private retrievalBridge = 'unavailable';
  private retrievalProvider?: string;
  private retrievalReason?: string;
  private controllers = new Set<AbortController>();
  private broker?: CommandBroker;
  private closed = false;
  private commandRuntime?: CommandRuntime;
  constructor(
    readonly workspace: string,
    readonly permissions: Permissions,
    historyFile?: string,
    readonly skillAccess: SkillAccess[] = [],
    commandRuntime?: CommandRuntime,
    maintenanceFile?: string,
    readonly attachmentAccess?: AttachmentAccess,
    attachmentTurnFile?: string,
    readonly planState?: PlanStateLocation,
  ) {
    if (commandRuntime?.mode === 'trusted' && !Object.values(permissions).every(Boolean))
      throw new Error('Trusted commands require edits, commands, and network enabled');
    this.commandRuntime = commandRuntime?.environment
      ? { mode: commandRuntime.mode, environment: { ...commandRuntime.environment } }
      : commandRuntime;
    this.permissions = { ...permissions };
    this.skillAccess = skillAccess.map(({ path, root }) => ({ path, root }));
    this.scratch = realpathSync(mkdtempSync(join(tmpdir(), 'chittr-tools-')));
    this.historyFile = historyFile ?? join(this.scratch, 'conversation.json');
    this.maintenanceFile = maintenanceFile ?? join(this.scratch, 'maintenance.json');
    this.ownsAttachmentTurn = !attachmentTurnFile;
    this.attachmentTurnFile = attachmentTurnFile ?? join(this.scratch, 'attachment-turn.json');
    if (this.ownsAttachmentTurn) this.endTurn();
    if (!maintenanceFile) this.setMaintenance(false);
    if (!historyFile) this.setHistory([]);
  }
  get commandMode(): CommandMode {
    return this.commandRuntime?.mode ?? (this.permissions.commands ? 'sandboxed' : 'off');
  }
  async mcpSettings(participant: string) {
    if (this.closed) throw new Error('Tool service closed');
    if (!this.broker) {
      this.broker = new CommandBroker(participant, (input, signal) =>
        this.call('run_command', input, signal),
      );
      await this.broker.start();
    }
    return {
      workspace: this.workspace,
      permissions: this.permissions,
      historyFile: this.historyFile,
      maintenanceFile: this.maintenanceFile,
      attachmentTurnFile: this.attachmentTurnFile,
      skillAccess: this.skillAccess,
      commandMode: this.commandMode,
      commandEndpoint: this.broker.endpoint,
      ...(this.attachmentAccess ? { attachmentStore: this.attachmentAccess.settings } : {}),
      ...(this.planState ? { planState: this.planState } : {}),
    };
  }
  setMaintenance(active: boolean): void {
    writeFileSync(this.maintenanceFile, JSON.stringify({ active }), { mode: 0o600 });
    if (active) this.interrupt();
  }
  setHistory(messages: Message[]): void {
    this.endTurn();
    const temporary = `${this.historyFile}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(messages.map(publicMessage)), { mode: 0o600 });
    renameSync(temporary, this.historyFile);
  }
  /** Host/adapter-only registration. Changes revoke all outstanding turn results. */
  registerRetrievalBridge({ key, report }: RetrievalBridgeRegistration): void {
    if (!this.ownsAttachmentTurn || this.closed) throw new Error('No active room tool host');
    this.endTurn();
    this.retrievalBridge =
      registeredImageMapping(key, report.provider) && report.retrieval.available === true
        ? key
        : 'unavailable';
    this.retrievalProvider = report.provider;
    this.retrievalReason =
      ['grok', 'claude', 'codex', 'antigravity'].includes(key) ||
      registeredImageMapping(key, report.provider)
        ? report.retrieval.available
          ? undefined
          : report.retrieval.reason
        : undefined;
  }
  beginTurn(): void {
    if (this.closed || !this.ownsAttachmentTurn) throw new Error('No active room tool host');
    this.writeAttachmentTurn(true);
  }
  endTurn(): void {
    if (this.ownsAttachmentTurn && !this.closed) this.writeAttachmentTurn(false);
    for (const controller of this.controllers) controller.abort();
  }
  private writeAttachmentTurn(active: boolean): void {
    const temporary = `${this.attachmentTurnFile}.${randomUUID()}.tmp`;
    writeFileSync(
      temporary,
      JSON.stringify({
        active,
        revision: randomUUID(),
        sessionId: this.attachmentAccess?.settings.sessionId,
        bridge: this.retrievalBridge,
        provider: this.retrievalProvider,
        retrievalReason: this.retrievalReason,
      }),
      { mode: 0o600 },
    );
    renameSync(temporary, this.attachmentTurnFile);
  }
  private attachmentTurn(): string {
    if (this.closed || JSON.parse(readFileSync(this.maintenanceFile, 'utf8')).active !== false)
      throw new Error('No active attachment turn');
    const raw = readFileSync(this.attachmentTurnFile, 'utf8');
    const state = JSON.parse(raw);
    if (
      state.active !== true ||
      !this.attachmentAccess ||
      state.sessionId !== this.attachmentAccess.settings.sessionId
    )
      throw new Error('No active attachment turn');
    return raw;
  }
  async check(): Promise<void> {
    if (process.platform !== 'darwin')
      throw new Error('Chittr requires macOS filesystem sandbox support');
    const result = await runProcess(
      '/usr/bin/sandbox-exec',
      [
        '-p',
        sandboxProfile(this.workspace, this.permissions, this.scratch, false, this.skillAccess),
        '/bin/echo',
        'sandbox-ready',
      ],
      { timeout: 5000 },
    );
    if (result.code !== 0 || result.stdout.trim() !== 'sandbox-ready')
      throw new Error(
        `Cannot enforce room permissions: ${result.stderr.trim() || 'sandbox probe failed'}`,
      );
    if (!existsSync(builtFile('tool-worker.js')))
      throw new Error(
        'Chittr file worker is missing. Reinstall the same @chittr/cli package. In a source checkout, run npm run build.',
      );
  }
  private assertCallable(): void {
    if (this.closed) throw new Error('Tool service closed');
    if (JSON.parse(readFileSync(this.maintenanceFile, 'utf8')).active !== false)
      throw new Error('Task tools are denied during context maintenance');
  }
  async call(tool: string, args: unknown, signal?: AbortSignal): Promise<unknown> {
    this.assertCallable();
    if (!Object.hasOwn(toolInputs, tool)) throw new Error(`Unknown task tool: ${tool}`);
    const name = tool as ToolName;
    const input = toolInputs[name].parse(args);
    // Plan mode is read at call time, so /plan and /plan off apply from the next call.
    const mode = this.planState ? readPlanMode(this.planState.directory) : undefined;
    const plan = mode?.path;
    const requested =
      'path' in input && typeof input.path === 'string'
        ? input.path.startsWith('~/')
          ? join(homedir(), input.path.slice(2))
          : input.path
        : undefined;
    const planFile =
      plan !== undefined &&
      (name === 'read_file' || name === 'write_file') &&
      resolve(this.workspace, requested!) === plan
        ? plan
        : undefined;
    if (plan !== undefined && name === 'write_file' && !planFile)
      throw new Error(
        `Plan mode is on: write_file can write only the attached plan ${plan}. Every other write is refused until the human runs /plan off.`,
      );
    const required =
      name === 'write_file'
        ? 'edits'
        : name === 'run_command'
          ? 'commands'
          : name === 'fetch_url'
            ? 'network'
            : undefined;
    if (required && !this.permissions[required] && !(planFile && name === 'write_file'))
      throw new Error(
        `Missing permission: permissions.${required}=true. Explain this to the human; a YAML config change and idle /reload are required. No temporary grant is available.`,
      );
    if (signal?.aborted) throw new Error('Interrupted');
    // Registered before any lock wait, so interrupt, close and maintenance cancel a queued call.
    const controller = new AbortController();
    this.controllers.add(controller);
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    try {
      if (!planFile) return await this.run(name, input, mode, undefined, controller, signal);
      return await this.planCall(name, input, mode!, planFile, controller, signal);
    } finally {
      signal?.removeEventListener('abort', abort);
      this.controllers.delete(controller);
    }
  }
  /**
   * A read or write of the attached plan. The plan's lock spans the guard, the worker and the
   * recorded hash, across agents, rooms and processes.
   */
  private planCall(
    name: ToolName,
    input: ToolInput,
    mode: NonNullable<PlanMode>,
    planFile: string,
    controller: AbortController,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const location = this.planState!;
    return withPlanLock(
      planFile,
      async (lock) => {
        // The call may have waited: lifecycle changes meanwhile still cancel it.
        this.assertCallable();
        if (controller.signal.aborted) throw new Error('Interrupted');
        // Bundles discovered for any participant, not only this one, exclude the plan.
        checkedPlanPath(planFile, [...this.skillAccess, ...mode.skills]);
        const bytes = readPlan(planFile);
        if (!bytes) throw new Error(`The plan file is missing: ${planFile}`);
        const current = planHash(bytes);
        if (name === 'write_file' && current !== readAgentPlan(location).hash)
          throw new Error(
            'The plan changed since you last received or read it. Reread it with read_file, then retry the write.',
          );
        // The worker inherits the lock, so it stays held for as long as the worker can write.
        const result = await this.run(name, input, mode, planFile, controller, signal, lock);
        if (name === 'write_file')
          recordAgentPlan(
            location,
            planHash((input as z.infer<typeof toolInputs.write_file>).text),
            true,
          );
        else recordAgentPlan(location, current);
        return result;
      },
      controller.signal,
    );
  }
  private async run(
    name: ToolName,
    input: ToolInput,
    mode: PlanMode,
    planFile: string | undefined,
    controller: AbortController,
    signal?: AbortSignal,
    lock?: number,
  ): Promise<unknown> {
    const plan = mode?.path;
    if (name === 'read_attachment') {
      try {
        const turn = this.attachmentTurn();
        const registration = JSON.parse(turn);
        if (
          typeof registration.provider !== 'string' ||
          !registeredImageMapping(registration.bridge, registration.provider)
        )
          return registration.bridge === 'unavailable' &&
            typeof registration.retrievalReason === 'string'
            ? {
                ...retrievalUnavailable,
                message: `${retrievalUnavailable.message} ${registration.retrievalReason}`,
              }
            : retrievalUnavailable;
        const id = (input as z.infer<typeof toolInputs.read_attachment>).attachment_id;
        const history = JSON.parse(readFileSync(this.historyFile, 'utf8')) as Message[];
        const message = history.find((item) =>
          item.attachments?.some((attachment) => attachment.id === id),
        );
        if (!message)
          return {
            error: 'attachment-not-found',
            message: 'Attachment is not in the current public history.',
          };
        const metadata = message.attachments!.find((attachment) => attachment.id === id)!;
        const resolved = this.attachmentAccess!.resolve(id);
        if (JSON.stringify(metadata) !== JSON.stringify(resolved.metadata))
          throw new Error('Attachment metadata mismatch');
        const assertCurrent = () => {
          if (controller.signal.aborted || signal?.aborted || this.attachmentTurn() !== turn)
            throw new Error('Attachment turn ended');
          const current = JSON.parse(readFileSync(this.historyFile, 'utf8')) as Message[];
          if (
            !current.some(
              (item) =>
                item.id === message.id &&
                item.attachments?.some(
                  (value) => JSON.stringify(value) === JSON.stringify(metadata),
                ),
            )
          )
            throw new Error('Attachment left current history');
        };
        assertCurrent();
        return new AttachmentResult(message.id, resolved, assertCurrent, registration.bridge);
      } catch (error) {
        return attachmentFailure(error);
      }
    }
    if (name === 'read_conversation') {
      const query = input as z.infer<typeof toolInputs.read_conversation>;
      const history = JSON.parse(readFileSync(this.historyFile, 'utf8')) as { id: string }[];
      if (query.message_id)
        return (
          history.find((message) => message.id === query.message_id) ?? {
            error: 'Message not found',
          }
        );
      const offset = query.offset ?? 0,
        limit = query.limit ?? 20;
      return {
        messages: history.slice(offset, offset + limit),
        nextOffset: offset + limit < history.length ? offset + limit : null,
        total: history.length,
      };
    }
    if (name === 'fetch_url') {
      const { url } = input as z.infer<typeof toolInputs.fetch_url>;
      if (!['http:', 'https:'].includes(new URL(url).protocol))
        throw new Error('Only HTTP(S) URLs are supported');
      const response = await fetch(url, {
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]),
      });
      const reader = response.body?.getReader();
      let bytes = 0;
      const chunks: Uint8Array[] = [];
      if (reader) {
        try {
          while (bytes < 65536) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value.subarray(0, 65536 - bytes));
            bytes += value.length;
          }
        } finally {
          await reader.cancel();
        }
      }
      return {
        url: response.url,
        status: response.status,
        text: Buffer.concat(chunks).toString('utf8'),
        truncated: bytes >= 65536,
      };
    }
    const worker = name !== 'run_command';
    const commandInput = input as z.infer<typeof toolInputs.run_command>;
    if (!worker && this.commandRuntime?.endpoint)
      return await forwardCommand(this.commandRuntime.endpoint, commandInput, controller.signal);
    // Plan mode sends trusted commands through the sandbox, without account access.
    if (!worker && this.commandMode === 'trusted' && plan === undefined) {
      const result = await runProcess('/bin/sh', ['-c', commandInput.command], {
        cwd: this.workspace,
        env: this.commandRuntime!.environment,
        signal: controller.signal,
        timeout: commandInput.timeout_ms ?? 30000,
      });
      return { exitCode: result.code, stdout: result.stdout, stderr: result.stderr };
    }
    const command = worker ? process.execPath : '/bin/sh';
    const args = worker ? [builtFile('tool-worker.js'), '--worker'] : ['-c', commandInput.command];
    const result = await runProcess(
      '/usr/bin/sandbox-exec',
      [
        '-p',
        sandboxProfile(
          this.workspace,
          plan === undefined ? this.permissions : { ...this.permissions, edits: false },
          this.scratch,
          worker,
          this.skillAccess,
          planFile,
        ),
        command,
        ...args,
      ],
      {
        cwd: this.workspace,
        signal: controller.signal,
        timeout: worker ? 10000 : (commandInput.timeout_ms ?? 30000),
        ...(worker && lock !== undefined ? { inheritFds: [lock] } : {}),
        env: {
          PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
          LANG: 'en_US.UTF-8',
          TMPDIR: this.scratch,
        },
        input: worker
          ? JSON.stringify({
              root: this.workspace,
              tool: name,
              args:
                'path' in input && typeof input.path === 'string' && input.path.startsWith('~/')
                  ? { ...input, path: join(homedir(), input.path.slice(2)) }
                  : input,
              skillAccess: this.skillAccess,
              ...(mode === undefined ? {} : { plan: mode.path, planSkills: mode.skills }),
            })
          : undefined,
      },
    );
    if (!worker) return { exitCode: result.code, stdout: result.stdout, stderr: result.stderr };
    if (result.code !== 0) throw new Error(result.stderr.trim() || 'Sandboxed file tool failed');
    const parsed = JSON.parse(result.stdout);
    if (parsed.error) throw new Error(parsed.error);
    return parsed.result;
  }
  interrupt(): void {
    this.endTurn();
  }
  close(): void {
    this.interrupt();
    this.closed = true;
    this.broker?.close();
    rmSync(this.scratch, { recursive: true, force: true });
  }
}
