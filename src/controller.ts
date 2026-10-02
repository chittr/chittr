import { maintenanceLabel } from './participant-status.js';
import { checkpointView } from './checkpoint.js';
import { EventEmitter } from 'node:events';
import { loadConfig } from './config.js';
import { AttachmentOperationConflictError, Room } from './room.js';
import type { SessionStore } from './store.js';
import type { AttachmentMetadata, RoomConfig, Session } from './types.js';
import type { DraftUpdate } from './room.js';
import type { StageAttachmentInput } from './attachments.js';
import type {
  DraftSubmissionCommitment,
  DraftSubmissionDispatch,
  DraftSubmissionRecovery,
  DraftSubmissionResult,
} from './web-types.js';
import { formatContextUsage } from './context-usage.js';
import { questionDetails } from './questions.js';
import { projectRoom, providerDefault, type RoomSnapshot } from './snapshot.js';
import { parseReplyDraft } from './reply.js';

/** A queued action refused because the selected conversation is no longer the one it named. */
export class ConversationChangedError extends Error {
  constructor() {
    super('The conversation changed. Your message has not been sent.');
  }
}
/**
 * One composer submission. Each source keeps its existing capture points and queue
 * boundaries; see `submitDraft`. Terminal text carries no client identity.
 */
export type DraftSubmission =
  | { source: 'terminal-text'; line: string; sessionId: string }
  | {
      source: 'terminal-attachments';
      line: string;
      sessionId: string;
      attachmentIds: string[];
      operationId: string;
      draft: { clientId: string; version: number; baseRevision: number };
    }
  | {
      source: 'http';
      line: string;
      sessionId: string;
      attachmentIds?: string[];
      operationId: string;
      draft?: { clientId: string; version: number; baseRevision?: number };
    };
const sent: DraftSubmissionDispatch = { status: 'sent' };
const notNeeded: DraftSubmissionRecovery = { status: 'not-needed' };
const skipped = (reason: 'newer-draft' | 'conversation-changed' | 'ineligible') =>
  ({ status: 'skipped', reason }) satisfies DraftSubmissionRecovery;
const failed = (error: unknown): Extract<DraftSubmissionDispatch, { status: 'failed' }> => ({
  status: 'failed',
  failure:
    error instanceof AttachmentOperationConflictError ? 'operation-conflict' : 'command-error',
  error: String((error as Error).message ?? error),
});
/** Commands and conversation switching shared by terminal and browser clients. */
export class RoomController extends EventEmitter {
  room: Room;
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  private changed = () => this.emit('change');
  constructor(
    config: RoomConfig,
    readonly store: SessionStore,
    session: Session | undefined,
    private options: {
      help: string;
      quit: () => Promise<void>;
      createRoom?: (config: RoomConfig, store: SessionStore, session?: Session) => Room;
      loadConfig?: typeof loadConfig;
      environment?: NodeJS.ProcessEnv;
    },
  ) {
    super();
    this.options.environment = { ...(options.environment ?? process.env) };
    this.room = this.createRoom(config, session);
  }
  private createRoom(config: RoomConfig, session?: Session): Room {
    const room =
      this.options.createRoom?.(config, this.store, session) ??
      new Room(config, this.store, session, undefined, this.options.environment);
    room.on('change', this.changed);
    return room;
  }
  submit(
    line: string,
    sessionId?: string,
    options: {
      attachmentIds?: string[];
      operationId?: string;
      draft?: { clientId: string; version: number; baseRevision: number };
      /** Receives the Room the queued dispatch runs against, at the queue boundary. */
      executing?: (room: Room) => void;
    } = {},
  ): Promise<void> {
    const { executing, ...command } = options;
    return this.enqueue(() => {
      executing?.(this.room);
      return this.execute(line, command);
    }, sessionId);
  }
  validateCommandOperation(
    line: string,
    sessionId?: string,
    options: {
      attachmentIds?: string[];
      operationId?: string;
    } = {},
  ): Promise<void> {
    return this.enqueue(() => this.checkCommandOperation(line, options), sessionId);
  }
  updateDraft(value: string | DraftUpdate, sessionId: string) {
    return this.enqueue(() => this.room.saveDraft(value), sessionId);
  }
  /**
   * Submit composer intent and report a typed outcome. The controller owns operation
   * validation before clearing, capture of the original room and recovery facts, text-draft
   * clearing, dispatch through `submit`, commitment classification and guarded recovery.
   * Timings are the callers' previous ones, unchanged: HTTP validates, clears and submits as
   * three queued actions and queues a guarded recovery write after failure; terminal text
   * captures, clears and restores synchronously outside the queue, around one queued dispatch;
   * terminal attachments dispatch once with no pre-clear and no restoration.
   */
  submitDraft(input: DraftSubmission): Promise<DraftSubmissionResult> {
    if (input.source === 'terminal-text') return this.submitTerminalText(input);
    if (input.source === 'terminal-attachments') return this.submitTerminalAttachments(input);
    return this.submitHttp(input);
  }
  private submitTerminalText(
    input: Extract<DraftSubmission, { source: 'terminal-text' }>,
  ): Promise<DraftSubmissionResult> {
    const room = this.room;
    const revision = room.session.composerDraftRevision ?? 0;
    // Text commands can close/switch the room: clear synchronously before dispatch, outside the queue.
    room.saveDraft('');
    const commitment: DraftSubmissionCommitment = { status: 'not-applicable' };
    return this.submit(input.line, input.sessionId).then(
      () => ({ dispatch: sent, commitment, recovery: notNeeded, sessionId: this.room.session.id }),
      (error: unknown) => {
        let recovery: DraftSubmissionRecovery;
        const current = room.session.composerDraftRevision ?? 0;
        if (this.room !== room) recovery = skipped('conversation-changed');
        else if (current !== revision + 1)
          recovery = skipped(current > revision + 1 ? 'newer-draft' : 'ineligible');
        else
          try {
            room.saveDraft(input.line);
            recovery = { status: 'restored' };
          } catch (restoreError) {
            recovery = { status: 'failed', error: String((restoreError as Error).message) };
          }
        return { dispatch: failed(error), commitment, recovery, sessionId: this.room.session.id };
      },
    );
  }
  private async submitTerminalAttachments(
    input: Extract<DraftSubmission, { source: 'terminal-attachments' }>,
  ): Promise<DraftSubmissionResult> {
    const { line, sessionId, attachmentIds, operationId, draft } = input;
    let executed: Room | undefined;
    const classify = () => this.classifyCommitment(executed, sessionId, attachmentIds, operationId);
    try {
      await this.submit(line, sessionId, {
        attachmentIds,
        operationId,
        draft,
        executing: (room) => (executed = room),
      });
      return {
        dispatch: sent,
        commitment: classify(),
        recovery: notNeeded,
        sessionId: this.room.session.id,
      };
    } catch (error) {
      // The terminal never restores over a staged attachment draft; a committed operation is still reported.
      return {
        dispatch: failed(error),
        commitment: classify(),
        recovery: skipped('ineligible'),
        sessionId: this.room.session.id,
      };
    }
  }
  private async submitHttp(
    input: Extract<DraftSubmission, { source: 'http' }>,
  ): Promise<DraftSubmissionResult> {
    const { line, sessionId, attachmentIds, operationId, draft } = input;
    let executed: Room | undefined;
    const classify = () => this.classifyCommitment(executed, sessionId, attachmentIds, operationId);
    let commitment: DraftSubmissionCommitment;
    try {
      await this.validateCommandOperation(line, sessionId, { attachmentIds, operationId });
      // Attachment sends are cleared inside Room.send's atomic commit; text sends clear here, versioned.
      if (draft && !attachmentIds?.length)
        await this.updateDraft({ text: '', ...draft }, sessionId);
      await this.submit(line, sessionId, {
        attachmentIds,
        operationId,
        executing: (room) => (executed = room),
        ...(attachmentIds?.length && draft
          ? {
              draft: {
                clientId: draft.clientId,
                version: draft.version,
                baseRevision: draft.baseRevision!,
              },
            }
          : {}),
      });
      return {
        dispatch: sent,
        commitment: classify(),
        recovery: notNeeded,
        sessionId: this.room.session.id,
      };
    } catch (error) {
      const dispatch = failed(error);
      // Classify as soon as the dispatch settles, before the queued recovery can let a switch run.
      commitment = classify();
      let recovery: DraftSubmissionRecovery;
      if (dispatch.failure === 'operation-conflict' || !draft) recovery = skipped('ineligible');
      else if (sessionId !== this.room.session.id) recovery = skipped('conversation-changed');
      else {
        const recorded = this.room.session.composerDraftVersions?.[draft.clientId];
        if (recorded !== draft.version)
          recovery = skipped(
            recorded !== undefined && recorded > draft.version ? 'newer-draft' : 'ineligible',
          );
        else
          recovery = await this.recoverDraft(
            attachmentIds ? (this.room.session.composerDraft ?? '') : line,
            sessionId,
          );
      }
      return { dispatch, commitment, recovery, sessionId: this.room.session.id };
    }
  }
  /** The guarded HTTP recovery write: unversioned, queued, and refused if the conversation changed meanwhile. */
  private async recoverDraft(text: string, sessionId: string): Promise<DraftSubmissionRecovery> {
    try {
      await this.updateDraft(text, sessionId);
      return { status: 'restored' };
    } catch (error) {
      if (error instanceof ConversationChangedError) return skipped('conversation-changed');
      return { status: 'failed', error: String((error as Error).message ?? error) };
    }
  }
  private classifyCommitment(
    executed: Room | undefined,
    sessionId: string,
    attachmentIds: string[] | undefined,
    operationId: string | undefined,
  ): DraftSubmissionCommitment {
    if (!attachmentIds?.length || operationId === undefined) return { status: 'not-applicable' };
    // The Room the queued dispatch ran against is authoritative, whatever was selected before or
    // since. When the queue refused the dispatch before it ran, the fact still describes the target
    // session's record, which an earlier attempt may have written: a live room holding that session,
    // else the saved session. A record that cannot be read fails the submission; it is not evidence.
    const live = executed ?? (this.room.session.id === sessionId ? this.room : undefined);
    let committed: boolean;
    if (live) committed = live.committedAttachmentOperation(operationId) !== undefined;
    else
      try {
        committed =
          this.store
            .load(sessionId)
            ?.messages.some((message) => message.attachmentOperation?.id === operationId) ?? false;
      } catch (error) {
        throw new Error(
          `Could not read the saved conversation to classify attachment operation ${operationId}: ${String((error as Error).message ?? error)}`,
        );
      }
    return committed
      ? { status: 'committed', operationId }
      : { status: 'uncommitted', operationId };
  }
  stageAttachment(input: StageAttachmentInput): Promise<AttachmentMetadata> {
    return this.enqueue(() => this.store.stageAttachment(input), input.sessionId);
  }
  private enqueue<T>(action: () => T | Promise<T>, sessionId?: string): Promise<T> {
    const operation = this.tail.then(async () => {
      if (this.closed) throw new Error('The room has closed. Run chittr resume to continue it.');
      if (sessionId && sessionId !== this.room.session.id) throw new ConversationChangedError();
      return await action();
    });
    this.tail = operation.catch(() => {});
    return operation;
  }
  private async switchRoom(id?: string): Promise<void> {
    if (!this.room.isIdle())
      throw new Error('Pause or stop active agents before changing conversations');
    const session = id ? this.store.load(id) : undefined;
    const config = this.currentConfig();
    await this.room.close();
    if (this.closed) return;
    this.room.off('change', this.changed);
    this.room = this.createRoom(config, session);
    this.emit('room', this.room);
    this.emit('change');
    await this.room.start();
  }
  private currentConfig(): RoomConfig {
    if (!this.options.loadConfig && !this.room.config.sources.length) return this.room.config;
    const config = (this.options.loadConfig ?? loadConfig)(this.room.config.workspace);
    if (!config) throw new Error('No config found; the current room remains active');
    return config;
  }
  private checkCommandOperation(
    line: string,
    options: { attachmentIds?: string[]; operationId?: string },
  ): void {
    if (options.operationId === undefined) return;
    if (!line.startsWith('/') || line.startsWith('//')) {
      this.room.checkAttachmentOperation(
        line.startsWith('//') ? line.slice(1) : line,
        undefined,
        options,
      );
      return;
    }
    if (line.trim().split(/\s+/, 1)[0] === '/reply') {
      const reply = parseReplyDraft(line);
      if (reply.replyTo) {
        this.room.checkAttachmentOperation(reply.text, reply.replyTo, options);
        return;
      }
    }
    this.room.checkAttachmentOperation(line, undefined, options);
  }
  private async execute(
    line: string,
    attachmentOptions: {
      attachmentIds?: string[];
      operationId?: string;
      draft?: { clientId: string; version: number; baseRevision: number };
    },
  ): Promise<void> {
    this.checkCommandOperation(line, attachmentOptions);
    const hasAttachments = Boolean(attachmentOptions.attachmentIds?.length);
    if (!line.startsWith('/') || line.startsWith('//')) {
      this.room.send(line.startsWith('//') ? line.slice(1) : line, undefined, attachmentOptions);
      return;
    }
    const [command, ...args] = line.trim().split(/\s+/);
    const target = args[0]?.replace(/^@/, '');
    if (hasAttachments && command !== '/reply')
      throw new Error('Attachments can accompany messages and /reply only');
    const noArgs = () => {
      if (args.length) throw new Error(`Usage: ${command}`);
    };
    if (['/pause', '/stop', '/continue'].includes(command!)) {
      if (args.length > 1) throw new Error(`Usage: ${command} [@agent]`);
      if (command === '/pause') this.room.pause(target);
      else if (command === '/stop') await this.room.stop(target);
      else await this.room.continue(target);
      return;
    }
    if (command === '/reply') {
      const reply = parseReplyDraft(line);
      if (!reply.replyTo || (!reply.text.trim() && !hasAttachments))
        throw new Error('Usage: /reply #message-id [@agent ...] message');
      this.room.send(reply.text, reply.replyTo, attachmentOptions);
    } else if (command === '/answer') {
      const answer = /^\/answer\s+#?(m[1-9]\d*)\s([\s\S]+)$/.exec(line);
      if (!answer) throw new Error('Usage: /answer #question-id text');
      this.room.answer(answer[1]!, answer[2]!);
    } else if (command === '/choose') {
      if (args.length !== 2 || !/^#?m[1-9]\d*$/.test(args[0]!) || !/^[1-6]$/.test(args[1]!))
        throw new Error('Usage: /choose #question-id option-number');
      this.room.choose(args[0]!, Number(args[1]));
    } else if (command === '/ask-room') {
      if (args.length !== 1 || !/^#?m[1-9]\d*$/.test(args[0]!))
        throw new Error('Usage: /ask-room #question-id');
      this.room.askRoom(args[0]!);
    } else if (command === '/questions') {
      noArgs();
      const questions = this.room.unansweredQuestions();
      this.room.notice(
        questions.length
          ? `Unanswered questions (${questions.length})\n\n` +
              questions
                .map(
                  (message) =>
                    `#${message.id} · @${message.author}\n${questionDetails(this.room.session, message)}`,
                )
                .join('\n\n')
          : 'No unanswered questions.',
      );
    } else if (command === '/pin' || command === '/unpin') {
      if (args.length !== 1 || !/^#?m[1-9]\d*$/.test(args[0]!))
        throw new Error(`Usage: ${command} #message-id`);
      this.room.setPinned(args[0]!, command === '/pin');
    } else if (command === '/pins') {
      noArgs();
      const messages = this.room.pinnedMessages();
      const { humanName } = this.snapshot();
      this.room.notice(
        messages.length
          ? `Pinned messages (${messages.length})\n\n` +
              messages
                .map(
                  (message) =>
                    `#${message.id} · ${message.author === 'human' ? humanName + ' (@human)' : '@' + message.author}\n${message.text}`,
                )
                .join('\n\n')
          : 'No pinned messages. Use /pin #message-id to pin a message.',
      );
    } else if (command === '/retry') {
      if (args.length !== 2 || !args[1]?.startsWith('@'))
        throw new Error('Usage: /retry #message-id @agent');
      this.room.retry(args[0]!, args[1].slice(1));
    } else if (command === '/compact') {
      const rest = line.trim().slice(command.length).trim();
      if (/^--(?:\s|$)/.test(rest)) this.room.compactAll(rest.slice(2).trim());
      else if (rest.startsWith('@')) {
        const match = /^@([a-z][a-z0-9_-]*)(?:\s+([\s\S]*))?$/.exec(rest);
        if (!match || match[2]?.startsWith('@'))
          throw new Error('Usage: /compact [@agent] [instructions]');
        this.room.compact(match[1]!, match[2]?.replace(/^--(?:\s|$)/, '').trim());
      } else {
        if (rest === 'human' || Object.hasOwn(this.room.config.agents, rest))
          throw new Error(
            `Use /compact @${rest} to select an agent, or /compact -- ${rest} to use that name as focus for all agents`,
          );
        this.room.compactAll(rest);
      }
    } else if (command === '/checkpoint') {
      noArgs();
      this.room.notice(checkpointView(this.room.session.checkpoints?.at(-1)));
    } else if (command === '/reconnect') {
      if (args.length !== 1) throw new Error('Usage: /reconnect @agent');
      await this.room.reconnect(target!);
    } else if (command === '/sessions') {
      if (args.length > 1) throw new Error('Usage: /sessions [ID]');
      if (args.length) await this.switchRoom(args[0]);
      else
        this.room.notice(
          this.store
            .list()
            .map((s) => `${s.id}  ${s.count} messages  ${s.preview}`)
            .join('\n') || 'No saved conversations',
        );
    } else if (command === '/new') {
      noArgs();
      await this.switchRoom();
    } else if (command === '/reload') {
      noArgs();
      await this.room.reload(this.currentConfig());
    } else if (command === '/config') {
      noArgs();
      this.room.notice(JSON.stringify(this.configSummary(), null, 2));
    } else if (command === '/participants') {
      noArgs();
      const snapshot = this.snapshot();
      const agents = snapshot.agents.filter((agent) => agent.provider !== undefined);
      this.room.notice(
        [
          `Participants · room ${snapshot.session.paused ? 'paused' : 'open'}`,
          `${snapshot.humanName} (@human) · human`,
          ...agents.map((agent) =>
            [
              `@${agent.id} · ${agent.enabled ? 'enabled' : 'disabled'}`,
              `  Provider: ${agent.provider} · Model: ${agent.model} · Effort: ${agent.effort}`,
              `  Context: ${formatContextUsage(agent.contextUsage)}${agent.contextUsage ? ` · last reported ${agent.contextUsage.updatedAt}` : ''}`,
              `  Connection: ${agent.connection} · Status: ${agent.status}`,
              ...(agent.initialImageSupport
                ? [
                    `  Initial images: ${agent.initialImageSupport.status}${agent.initialImageSupport.available ? '' : ` · ${agent.initialImageSupport.reason}`}`,
                  ]
                : []),
              `  Paused: ${agent.paused ? 'yes' : 'no'} · Stopped: ${agent.stopped ? 'yes' : 'no'}`,
              `  Queue: ${agent.pending.queued} queued · ${agent.pending.capped} at follow-up limit · ${agent.pending.unresolved} unresolved`,
              ...(agent.maintenance
                ? [
                    `  ${maintenanceLabel(agent.maintenance)}: ${agent.maintenance.status} · ${agent.maintenance.route} · ${agent.maintenance.detail ?? ''}${agent.maintenance.instructions ? (agent.maintenance.instructionsSupported ? ' · custom focus requested' : ' · custom focus unsupported; using default') : ''}`,
                  ]
                : []),
              `  Detail: ${agent.statusDetail}`,
              ...(agent.error ? [`  Error: ${agent.error}`] : []),
            ].join('\n'),
          ),
          ...(!agents.length ? ['No agents configured.'] : []),
        ].join('\n\n'),
      );
    } else if (command === '/help') {
      noArgs();
      this.room.notice(this.options.help);
    } else if (command === '/quit') {
      noArgs();
      await this.options.quit();
    } else
      throw new Error(
        `Unknown command ${command}. Use /help, or // to send a leading slash as text.`,
      );
  }
  /** The public display projection of the current room; see docs/display-contract.md. */
  snapshot(): RoomSnapshot {
    return projectRoom(this.room);
  }
  configSummary() {
    const config = this.room.config;
    const { humanName, commandAccess, commandAccessDescription } = this.snapshot();
    return {
      human: { name: humanName },
      permissions: config.permissions,
      commandAccess,
      commandAccessDescription,
      skills: config.skills ?? { enabled: true },
      followUpTurns: config.followUpTurns,
      instructions: {
        room: {
          source: config.provenance.instructions ?? null,
          empty: !config.instructions,
        },
        launchBrief: this.room.session.launchBrief
          ? { source: this.room.session.launchBrief.source, saved: true }
          : null,
      },
      agents: Object.values(config.agents).map((a) => ({
        id: a.id,
        provider: a.provider,
        model: providerDefault(a.model),
        effort: providerDefault(a.effort),
        enabled: a.enabled,
        skills:
          a.skills?.bundles.map(({ name, path, root }) => ({ name, path, resolvedPath: root })) ??
          [],
        skillWarnings: a.skills?.warnings ?? [],
      })),
      sources: config.sources,
      provenance: config.provenance,
    };
  }
  async close(): Promise<void> {
    this.closed = true;
    await this.room.close();
    this.room.off('change', this.changed);
  }
}
