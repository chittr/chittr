import {
  checkpointChunks,
  checkpointPrompt,
  entriesSchema,
  validateEntries,
  reconstructionPrompt,
  bounded,
  contextBudgets,
  isMaintaining,
} from './checkpoint.js';
import { MaintenanceOutputError, normalizeOutcome, turnPrompt } from './protocol.js';
import {
  unansweredQuestions,
  freezeLegacyQuestions,
  consultationPending,
  consultationRounds,
} from './questions.js';
import type { Checkpoint, Handoff } from './types.js';
import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { basename } from 'node:path';
import { closeSync, rmSync } from 'node:fs';
import type {
  RoomConfig,
  Session,
  AgentState,
  AgentAdapter,
  AgentConfig,
  Message,
  Outcome,
  AdapterEvent,
  AttachmentMetadata,
  AttachmentSendOperation,
  PlanTurn,
  SkillAccess,
} from './types.js';
import {
  PlanState,
  checkedPlanFolder,
  checkedPlanPath,
  createPlanFile,
  listPlans,
  planFileMissing,
  planFolder,
  planTurn,
  resolvePlanArgument,
  tryPlanLock,
  withPlanLock,
} from './plan.js';
import type { Persistence } from './store.js';
import { attachmentLimits, validateAttachmentSet, type AttachmentAccess } from './attachments.js';
import { createAdapter } from './adapters/index.js';
import { errorText } from './process.js';
import { commandMode, commandAccessSummary } from './command-access.js';
import type { ImagePathSupport } from './image-support.js';
import { resolveMessageRecipients } from './recipient-resolution.js';
export { parseAddress } from './recipient-resolution.js';
interface MaintenanceOperation {
  id: string;
  controller: AbortController;
  promise: Promise<void>;
  resources: Set<AgentAdapter>;
  nativeStarted: boolean;
}
type Factory = (
  agent: AgentConfig,
  config: RoomConfig,
  environment: NodeJS.ProcessEnv,
  attachments?: AttachmentAccess,
) => AgentAdapter;
/** A reused attachment operation ID whose input differs from the committed record. */
export class AttachmentOperationConflictError extends Error {
  constructor() {
    super('Attachment operation ID was already used for different input');
  }
}
export interface AttachmentSendOptions {
  attachmentIds?: string[];
  operationId?: string;
  draft?: { clientId: string; version: number; baseRevision: number };
}
export interface DraftUpdate {
  text: string;
  attachmentIds?: string[];
  baseRevision?: number;
  clientId?: string;
  version?: number;
}
const now = () => new Date().toISOString();
const uuidIdentity = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i;
export function newSession(config: RoomConfig): Session {
  return {
    version: 1,
    id: randomUUID(),
    workspace: config.workspace,
    createdAt: now(),
    updatedAt: now(),
    messages: [],
    pinnedMessageIds: [],
    agents: {},
    exchanges: {},
    notices: [],
    paused: false,
    permissions: { ...config.permissions },
    commandMode: commandMode(config),
    configSources: [...config.sources],
    composerDraft: '',
    composerAttachments: [],
    composerDraftRevision: 0,
    composerDraftVersions: {},
  };
}
export class Room extends EventEmitter {
  session: Session;
  fatal?: string;
  private maintenance = new Map<string, MaintenanceOperation>();
  private checkpointTail = Promise.resolve();
  private adapters = new Map<string, AgentAdapter>();
  private runs = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  private connecting = new Set<string>();
  private connections = new Map<string, Promise<void>>();
  private scheduled = false;
  private startupSaved = false;
  private closed = false;
  private closing?: Promise<void>;
  private stops = new Set<Promise<void>>();
  private reloading = false;
  private persistTimer?: NodeJS.Timeout;
  /** Host-owned plan-mode state that tool services read at call time. */
  private plans = new PlanState();
  constructor(
    public config: RoomConfig,
    private persistence: Persistence,
    session?: Session,
    private factory: Factory = createAdapter,
    private environment: NodeJS.ProcessEnv = { ...process.env },
  ) {
    super();
    this.session = session ? structuredClone(session) : newSession(config);
    freezeLegacyQuestions(this.session.messages);
    if (this.session.plan)
      this.plans.set(this.session.plan.path, this.session.plan.hashes, this.skillBundles());
    if (session) {
      const savedMode = session.commandMode ?? (session.permissions.commands ? 'sandboxed' : 'off');
      const policyChanged =
        savedMode !== commandMode(config) ||
        JSON.stringify(session.permissions) !== JSON.stringify(config.permissions);
      // Selecting a saved conversation releases its saved manual holds.
      // Delivery statuses still prevent interrupted or failed work from replaying.
      this.session.paused = false;
      for (const state of Object.values(this.session.agents)) {
        if (isMaintaining(state.maintenance)) {
          state.maintenance!.status = 'failed';
          state.maintenance!.detail =
            'Interrupted by restart; reconnect explicitly. Native success was not assumed.';
          state.recoveryRequired = true;
          this.notice(
            `${state.id}: context maintenance was interrupted. The last committed provider reference and pending work were retained. Use /reconnect @${state.id}.`,
            false,
          );
        }
        if (policyChanged) {
          delete state.sessionId;
          delete state.contextUsage;
          state.contextThrough = 0;
          delete state.checkpointVersion;
          delete this.session.handoffs?.[state.id];
        }
        state.paused = false;
        state.stopped = false;
        state.connection = 'unavailable';
        state.activity = state.awaitingHuman ? 'waiting' : 'available';
        if (state.active) {
          for (const id of state.active.messageIds) {
            const delivery = this.message(id)?.deliveries[state.id];
            if (delivery && ['sent', 'received'].includes(delivery.status))
              delivery.status = 'interrupted';
          }
          delete state.active;
        }
      }
      this.notice(
        'Conversation resumed. Queued messages run as agents connect; interrupted or failed responses need /retry.',
        false,
      );
      if (this.session.plan)
        this.notice(
          `This conversation is still in plan mode with ${basename(this.session.plan.path)}. Run /plan off to leave it.`,
          false,
        );
    }
    this.session.permissions = { ...config.permissions };
    if (session?.commandMode === 'trusted' && commandMode(config) !== 'trusted')
      this.notice(
        'Previously trusted commands are no longer active. Access was recomputed from current settings for this launch.',
        false,
      );
    this.session.commandMode = commandMode(config);
    if (config.commandAccess?.source) this.notice(commandAccessSummary(config), false);
    this.session.configSources = [...config.sources];
    this.interruptDisabledConsultations();
  }
  enabledNames(): string[] {
    return Object.values(this.config.agents)
      .filter((a) => a.enabled)
      .map((a) => a.id);
  }
  message(id: string): Message | undefined {
    return this.session.messages.find((m) => m.id === id.replace(/^#/, ''));
  }
  pinnedMessages(): Message[] {
    const ids = new Set(this.session.pinnedMessageIds ?? []);
    return this.session.messages.filter((message) => ids.has(message.id));
  }
  setPinned(id: string, pinned: boolean): void {
    if (this.closed || this.fatal) throw new Error(this.fatal ?? 'Room is closed');
    const message = this.message(id);
    if (!message) throw new Error(`Unknown message #${id.replace(/^#/, '')}`);
    const ids = new Set(this.session.pinnedMessageIds ?? []);
    if (ids.has(message.id) === pinned) {
      this.notice(`Message #${message.id} is ${pinned ? 'already pinned' : 'not pinned'}.`);
      return;
    }
    if (pinned) ids.add(message.id);
    else ids.delete(message.id);
    this.session.pinnedMessageIds = [...ids];
    this.notice(`${pinned ? 'Pinned' : 'Unpinned'} #${message.id}.`);
  }
  /** The folder `plans.location` selects for this workspace's plans. */
  planFolder(): string {
    return this.config.plans?.folder ?? planFolder('user', this.config.workspace, homedir());
  }
  /** The attached plan for display, read fresh; undefined while plan mode is off. */
  planStatus(): { path: string; name: string; missing: boolean } | undefined {
    const path = this.session.plan?.path;
    return path ? { path, name: basename(path), missing: planFileMissing(path) } : undefined;
  }
  private assertPlanOff(): void {
    if (this.closed || this.fatal) throw new Error(this.fatal ?? 'Room is closed');
    const path = this.session.plan?.path;
    if (path) throw new Error(`Plan mode is already on with ${path}. Run /plan off first.`);
  }
  /** Every skill bundle discovered for any participant; no plan may live inside one. */
  private skillBundles(): SkillAccess[] {
    return Object.values(this.config.agents).flatMap((agent) =>
      (agent.skills?.bundles ?? []).map(({ path, root }) => ({ path, root })),
    );
  }
  /** `/plan`: create an empty plan file, attach it and turn plan mode on. */
  createPlan(): string {
    this.assertPlanOff();
    const folder = this.planFolder();
    const skills = this.skillBundles();
    // Check the folder by name first, then the created file's resolved path.
    checkedPlanFolder(folder, skills);
    const path = createPlanFile(folder);
    try {
      checkedPlanPath(path, skills);
    } catch (error) {
      rmSync(path, { force: true });
      throw error;
    }
    this.attachPlan(path, `Created ${path}. Plan mode is on; run /plan off to leave it.`);
    return path;
  }
  /** `/plan resume`: list this workspace's plans, or attach the one an argument names. */
  resumePlan(argument: string): string | undefined {
    this.assertPlanOff();
    const folder = this.planFolder();
    if (!argument) {
      const plans = listPlans(folder);
      this.notice(
        plans.length
          ? `Plans in ${folder}, newest first (${plans.length})\n\n${plans.join('\n')}\n\nUse /plan resume <name or path> to attach one.`
          : `No plans in ${folder}. Use /plan to create one.`,
      );
      return undefined;
    }
    const path = resolvePlanArgument(argument, {
      folder,
      workspace: this.config.workspace,
      home: homedir(),
      skills: this.skillBundles(),
    });
    this.attachPlan(path, `Plan mode is on with ${path}. Run /plan off to leave it.`);
    return path;
  }
  /** `/plan off`: detach the plan and end plan mode. */
  endPlan(): void {
    if (this.closed || this.fatal) throw new Error(this.fatal ?? 'Room is closed');
    const path = this.session.plan?.path;
    if (!path) {
      this.notice('Plan mode is already off.');
      return;
    }
    this.plans.set(undefined);
    delete this.session.plan;
    this.notice(`Plan mode is off. Detached ${path}; writes follow permissions.edits again.`);
  }
  private attachPlan(path: string, text: string): void {
    // Enforcement state first: tool services admit the plan from their next call.
    this.plans.set(path, {}, this.skillBundles());
    this.session.plan = { path, hashes: {} };
    this.notice(text);
  }
  /** Read recorded hashes back from the files tool services also write. */
  private syncPlan(): void {
    if (!this.session.plan) return;
    try {
      this.session.plan.hashes = this.plans.hashes();
    } catch {
      // After close the state is gone; the last read hashes stay. A stale hash only resends the plan.
    }
  }
  /**
   * The plan data for one agent's turn, read under the plan's lock so no turn sees a write in
   * progress, with the hash to record once the provider receives the turn. It waits while
   * another holder has the lock, until the turn is cancelled, and follows the attachment as it
   * stands once the lock is held: none after `/plan off`, the new plan after a switch.
   */
  private async planTurn(
    id: string,
    signal: AbortSignal,
  ): Promise<{ plan: PlanTurn; record?: string } | undefined> {
    for (;;) {
      const path = this.session.plan?.path;
      if (!path) return undefined;
      const read = () => {
        if (signal.aborted) throw new Error('Interrupted');
        if (this.session.plan?.path !== path) return undefined;
        return planTurn(path, this.plans.recorded(id));
      };
      // Read and release at once when the lock is free, so other agents' turns never wait on it.
      const lock = tryPlanLock(path);
      let prepared;
      if (lock === undefined)
        prepared = await withPlanLock(path, async () => read(), signal, Infinity);
      else
        try {
          prepared = read();
        } finally {
          closeSync(lock);
        }
      if (prepared) return prepared;
    }
  }
  private state(id: string): AgentState {
    const state = this.session.agents[id];
    if (!state) throw new Error(`Unknown agent @${id}`);
    return state;
  }
  notice(text: string, save = true): void {
    this.session.notices.push({ id: randomUUID(), text, createdAt: now() });
    if (save) this.changed();
  }
  private changed(save = true): void {
    if (save) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
      try {
        this.syncPlan();
        this.persistence.save(this.session);
      } catch (e) {
        this.fatal = `Session could not be saved: ${errorText(e)}. Work is paused.`;
        this.session.paused = true;
      }
    } else if (!this.persistTimer)
      this.persistTimer = setTimeout(() => {
        this.persistTimer = undefined;
        this.changed();
      }, 250);
    this.emit('change');
  }
  async start(): Promise<void> {
    // Commit the initial brief before any provider can receive its contents.
    this.changed();
    if (this.fatal || this.closed) return;
    this.startupSaved = true;
    await Promise.all(
      Object.values(this.config.agents).map((agent) => {
        let state = this.session.agents[agent.id];
        if (state?.recoveryRequired || this.session.recoveryRequired) {
          state ??= this.session.agents[agent.id] = {
            id: agent.id,
            connection: 'unavailable',
            activity: 'available',
            paused: false,
            fingerprint: this.participant(agent.id)!.fingerprint,
            contextThrough: 0,
            draft: '',
          };
          state.stopped = true;
          state.detail = 'Recovery hold; /reconnect or /continue reconnects';
          return Promise.resolve();
        }
        return this.connect(agent.id);
      }),
    );
    if (this.session.recoveryRequired)
      this.notice(
        'Room-wide recovery hold: saved maintenance could not be attributed safely. Use /reconnect @agent for individual agents, or /continue to reconnect all agents explicitly.',
      );
    this.changed();
    this.schedule();
  }
  private connect(id: string, hold?: boolean): Promise<void> {
    if (this.closed) return Promise.resolve();
    // A controller can reload before start(); that path needs the same first-save gate.
    if (!this.startupSaved) {
      this.changed();
      if (this.fatal || this.closed) return Promise.resolve();
      this.startupSaved = true;
    }
    const existing = this.connections.get(id);
    if (existing) return existing;
    const pending = this.connectAgent(id, hold).finally(() => {
      this.connections.delete(id);
    });
    this.connections.set(id, pending);
    return pending;
  }
  /** Keep the reusable base config free of session data and preserve legacy empty identity. */
  private participant(id: string, config = this.config): AgentConfig | undefined {
    const agent = config.agents[id];
    if (!agent) return undefined;
    const shared = config.instructions ?? '';
    const brief = this.session.launchBrief?.text ?? '';
    return {
      ...agent,
      conversationInstructions: brief,
      planState: this.plans.location(id),
      fingerprint:
        shared || brief
          ? createHash('sha256')
              .update(JSON.stringify([agent.fingerprint, shared, brief]))
              .digest('hex')
          : agent.fingerprint,
    };
  }
  private async connectAgent(id: string, hold?: boolean): Promise<void> {
    const agent = this.participant(id);
    if (!agent || this.connecting.has(id)) return;
    this.connecting.add(id);
    const previous = this.session.agents[id];
    const changed = Boolean(previous && previous.fingerprint !== agent.fingerprint);
    const state: AgentState = (this.session.agents[id] = {
      id,
      connection: 'connecting',
      activity: previous?.awaitingHuman ? 'waiting' : 'available',
      awaitingHuman: previous?.awaitingHuman,
      paused: hold ?? previous?.paused ?? false,
      fingerprint: agent.fingerprint,
      contextThrough: changed ? 0 : (previous?.contextThrough ?? 0),
      contextUsage: changed ? undefined : previous?.contextUsage,
      draft: previous?.draft ?? '',
      sessionId: changed ? undefined : previous?.sessionId,
      checkpointVersion: changed ? undefined : previous?.checkpointVersion,
      maintenance: changed ? undefined : previous?.maintenance,
      recoveryRequired: previous?.recoveryRequired,
    });
    if (!agent.enabled) {
      state.connection = 'unavailable';
      state.paused = true;
      state.detail = 'Disabled in config';
      this.connecting.delete(id);
      this.changed();
      return;
    }
    this.changed();
    let adapter: AgentAdapter | undefined;
    try {
      adapter = this.factory(
        agent,
        this.config,
        this.environment,
        this.persistence.attachmentAccess?.(this.session.id),
      );
      this.adapters.set(id, adapter);
      const requested = state.sessionId;
      const result = await adapter.start(requested);
      if (this.closed) {
        await adapter.close();
        return;
      }
      // A fresh provider session has not seen the plan: its next turn includes it again.
      if (!requested || result.restored || result.sessionId !== requested)
        this.plans.record(id, undefined);
      if (result.restored || !previous?.sessionId || result.sessionId !== previous.sessionId)
        state.contextUsage = undefined;
      if (result.restored && !changed && previous?.sessionId && this.session.messages.length) {
        const operation: MaintenanceOperation = {
          id: randomUUID(),
          controller: new AbortController(),
          resources: new Set([adapter]),
          promise: Promise.resolve(),
          nativeStarted: false,
        };
        this.maintenance.set(id, operation);
        state.maintenance = {
          id: operation.id,
          agent: id,
          route: 'replacement',
          purpose: 'recovery',
          status: 'running',
          startedAt: now(),
          detail: 'Waiting to read the chat history',
        };
        this.changed();
        operation.promise = this.replaceContext(id, operation, adapter)
          .then(() => {
            state.maintenance!.status = 'completed';
          })
          .catch((error) => {
            state.maintenance!.status = operation.controller.signal.aborted
              ? 'cancelled'
              : 'failed';
            state.maintenance!.detail = errorText(error);
            state.recoveryRequired = true;
            throw error;
          })
          .finally(async () => {
            await Promise.all(
              [...operation.resources].map((resource) => resource.close().catch(() => {})),
            );
            this.maintenance.delete(id);
          });
        await operation.promise;
      } else state.sessionId = result.sessionId;
      state.connection = 'ready';
      delete state.recoveryRequired;
      if (!this.enabledNames().some((name) => this.session.agents[name]?.recoveryRequired))
        delete this.session.recoveryRequired;
      state.stopped = false;
      if (changed || (result.restored && !state.checkpointVersion)) {
        state.contextThrough = 0;
        this.notice(
          `${id}: fresh provider session; context will be restored from the saved room conversation.`,
          false,
        );
      }
    } catch (e) {
      state.connection = 'unavailable';
      state.error = errorText(e);
      this.notice(`${id} unavailable: ${state.error}`, false);
      await adapter?.close().catch(() => {});
      this.adapters.delete(id);
    } finally {
      this.connecting.delete(id);
      this.changed();
      this.schedule();
    }
  }
  /** The message an attachment operation committed, by ID alone, regardless of its input. */
  committedAttachmentOperation(operationId: string): Message | undefined {
    return this.session.messages.find((message) => message.attachmentOperation?.id === operationId);
  }
  checkAttachmentOperation(
    raw: string,
    replyTo?: string,
    options: AttachmentSendOptions = {},
  ): Message | undefined {
    const attachmentIds = options.attachmentIds ?? [];
    if (options.operationId !== undefined) {
      if (!uuidIdentity.test(options.operationId))
        throw new Error('Attachment sends require a valid operation ID');
      if (new Set(attachmentIds).size !== attachmentIds.length)
        throw new Error('Attachment IDs must be unique and ordered');
      const attachmentInputHash = createHash('sha256')
        .update(JSON.stringify({ raw, replyTo: replyTo?.replace(/^#/, ''), attachmentIds }))
        .digest('hex');
      const previous = this.committedAttachmentOperation(options.operationId);
      if (previous) {
        if (previous.attachmentOperation!.inputHash !== attachmentInputHash)
          throw new AttachmentOperationConflictError();
        return previous;
      }
    }
    if (attachmentIds.length && !options.operationId)
      throw new Error('Attachment sends require a valid operation ID');
  }
  send(raw: string, replyTo?: string, options: AttachmentSendOptions = {}): Message {
    if (this.closed || this.fatal) throw new Error(this.fatal ?? 'Room is closed');
    if (Buffer.byteLength(raw) > 65536) throw new Error('Message exceeds the limit of 64 KiB');
    const attachmentIds = options.attachmentIds ?? [];
    const previous = this.checkAttachmentOperation(raw, replyTo, options);
    if (previous) return previous;
    const attachmentInputHash = options.operationId
      ? createHash('sha256')
          .update(JSON.stringify({ raw, replyTo: replyTo?.replace(/^#/, ''), attachmentIds }))
          .digest('hex')
      : undefined;
    const resolved = resolveMessageRecipients(
      raw,
      this.enabledNames(),
      this.session.messages,
      replyTo,
      attachmentIds.length > 0,
    );
    const { recipients, parent } = resolved;
    if (!attachmentIds.length) {
      const message = this.append(
        'human',
        resolved.text,
        [...recipients],
        parent ? [parent.id] : [],
      );
      this.session.exchanges[message.id] = { used: 0, allowance: this.config.followUpTurns };
      if (parent?.question) this.refreshQuestionState(parent.author);
      this.changed();
      this.schedule();
      return message;
    }
    const access = this.persistence.attachmentAccess?.(this.session.id);
    if (!access) throw new Error('Attachment storage is unavailable');
    const attachments = attachmentIds.map((id) => access.resolve(id).metadata);
    validateAttachmentSet(attachments);
    const operation: AttachmentSendOperation = {
      id: options.operationId!,
      inputHash: attachmentInputHash!,
    };
    this.syncPlan();
    const candidate = structuredClone(this.session);
    if (options.draft) {
      const versions = candidate.composerDraftVersions ?? {};
      if (
        !uuidIdentity.test(options.draft.clientId) ||
        !Number.isSafeInteger(options.draft.version) ||
        options.draft.version < 0
      )
        throw new Error('Invalid draft operation identity');
      if (!Object.hasOwn(versions, options.draft.clientId) && Object.keys(versions).length >= 1000)
        throw new Error('Too many draft writers for this session');
      if ((versions[options.draft.clientId] ?? -1) >= options.draft.version)
        throw new Error('Attachment draft send is stale');
      if ((candidate.composerDraftRevision ?? 0) !== options.draft.baseRevision)
        throw new Error('Draft changed; refresh before sending its attachments');
      if (
        JSON.stringify((candidate.composerAttachments ?? []).map((item) => item.id)) !==
        JSON.stringify(attachmentIds)
      )
        throw new Error('Draft attachments changed; refresh before sending');
      candidate.composerDraft = '';
      candidate.composerAttachments = [];
      candidate.composerDraftRevision = (candidate.composerDraftRevision ?? 0) + 1;
      candidate.composerDraftVersions = {
        ...versions,
        [options.draft.clientId]: options.draft.version,
      };
    }
    const committed = this.appendTo(
      candidate,
      'human',
      resolved.text,
      [...recipients],
      parent ? [parent.id] : [],
      attachments,
      operation,
    );
    candidate.exchanges[committed.id] = { used: 0, allowance: this.config.followUpTurns };
    this.persistence.save(candidate);
    const message = this.appendTo(
      this.session,
      'human',
      resolved.text,
      [...recipients],
      parent ? [parent.id] : [],
      attachments,
      operation,
    );
    this.session.exchanges[message.id] = { used: 0, allowance: this.config.followUpTurns };
    this.session.updatedAt = candidate.updatedAt;
    if (options.draft) {
      this.session.composerDraft = candidate.composerDraft;
      this.session.composerAttachments = [];
      this.session.composerDraftRevision = candidate.composerDraftRevision;
      this.session.composerDraftVersions = candidate.composerDraftVersions;
    }
    if (parent?.question) this.refreshQuestionState(parent.author);
    this.emit('change');
    this.schedule();
    return message;
  }
  unansweredQuestions(): Message[] {
    return unansweredQuestions(this.session.messages);
  }
  private refreshQuestionState(id: string): void {
    const state = this.session.agents[id];
    if (!state) return;
    state.awaitingHuman = this.unansweredQuestions().some((message) => message.author === id);
    if (!state.active) state.activity = state.awaitingHuman ? 'waiting' : 'available';
  }
  answer(questionId: string, text: string): Message {
    if (this.closed || this.fatal) throw new Error(this.fatal ?? 'Room is closed');
    const question = this.message(questionId);
    if (!question?.question) throw new Error('Choose a question from /questions');
    if (!this.unansweredQuestions().includes(question))
      throw new Error(`Question #${question.id} has already been answered`);
    if (!this.enabledNames().includes(question.author))
      throw new Error(`@${question.author} is no longer enabled; the question remains unanswered`);
    if (!text.trim()) throw new Error('Enter an answer');
    if (Buffer.byteLength(text) > 65536) throw new Error('Answer exceeds the limit of 64 KiB');
    // Answer text is literal. Neither slash commands nor leading @names are executable routing.
    const message = this.append('human', text, [question.author], [question.id]);
    message.finalAnswer = { questionId: question.id };
    this.session.exchanges[message.id] = { used: 0, allowance: this.config.followUpTurns };
    this.refreshQuestionState(question.author);
    this.changed();
    this.schedule();
    return message;
  }
  choose(questionId: string, choice: number): Message {
    const question = this.message(questionId);
    const text = question?.question?.choices[choice - 1];
    if (!Number.isSafeInteger(choice) || choice < 1 || text === undefined)
      throw new Error('Choose one of the numbered options in /questions');
    return this.answer(questionId, text);
  }
  private interruptDisabledConsultations(): void {
    const enabled = new Set(this.enabledNames());
    for (const message of this.session.messages) {
      if (!message.consultation) continue;
      for (const [id, delivery] of Object.entries(message.deliveries)) {
        if (delivery.status === 'queued' && !enabled.has(id)) {
          delivery.status = 'interrupted';
          delivery.rationale = 'Agent no longer enabled; re-enable and reconnect before retrying';
        }
      }
    }
  }
  askRoom(questionId: string): Message | undefined {
    if (this.closed || this.fatal) throw new Error(this.fatal ?? 'Room is closed');
    const question = this.message(questionId);
    if (!question?.question) throw new Error('Choose a question from /questions');
    if (!this.unansweredQuestions().includes(question))
      throw new Error(`Question #${question.id} has already been answered`);
    if (consultationRounds(this.session.messages, question.id).some(consultationPending))
      throw new Error('An opinion round is already pending for this question');
    const eligible = this.enabledNames().filter(
      (id) =>
        id !== question.author ||
        !this.session.messages.some(
          (m) => m.author === id && m.recommendation?.questionId === question.id,
        ),
    );
    if (!eligible.length) {
      this.notice('No eligible agents to ask. Existing advice remains available.');
      return;
    }
    const request = this.append(
      'human',
      `Please recommend an answer to question #${question.id}, or pass with a reason. This requests advice only, not execution or authorization.`,
      eligible,
      [question.id],
    );
    request.consultation = { questionId: question.id };
    this.session.exchanges[request.id] = { used: 0, allowance: this.config.followUpTurns };
    this.changed();
    this.schedule();
    return request;
  }
  private append(author: string, text: string, recipients: string[], replyTo: string[]): Message {
    return this.appendTo(this.session, author, text, recipients, replyTo);
  }
  private appendTo(
    session: Session,
    author: string,
    text: string,
    recipients: string[],
    replyTo: string[],
    attachments?: AttachmentMetadata[],
    attachmentOperation?: AttachmentSendOperation,
  ): Message {
    const sequence = session.messages.length + 1;
    const id = `m${sequence}`;
    const roots =
      author === 'human'
        ? [id]
        : [
            ...new Set(
              replyTo.flatMap(
                (parent) => session.messages.find((message) => message.id === parent)!.roots,
              ),
            ),
          ];
    const eligible = recipients.length
      ? recipients.filter((name) => name !== 'human')
      : this.enabledNames();
    const message: Message = {
      id,
      sequence,
      author,
      recipients,
      text,
      replyTo,
      roots,
      createdAt: now(),
      deliveries: Object.fromEntries(
        eligible
          .filter((name) => name !== author)
          .map((name) => [name, { status: 'queued' as const }]),
      ),
      ...(attachments?.length ? { attachments: structuredClone(attachments) } : {}),
      ...(attachmentOperation ? { attachmentOperation: { ...attachmentOperation } } : {}),
    };
    session.messages.push(message);
    return message;
  }
  private schedule(): void {
    if (this.scheduled || this.closed) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      if (this.closed || this.session.paused || this.fatal) return;
      if (this.reloading) return;
      for (const id of this.enabledNames()) {
        const state = this.session.agents[id];
        if (
          !state ||
          state.paused ||
          state.connection !== 'ready' ||
          state.active ||
          this.runs.has(id) ||
          this.maintenance.has(id) ||
          state.recoveryRequired ||
          this.session.recoveryRequired
        )
          continue;
        const adapter = this.adapters.get(id);
        if (!adapter) continue;
        const runnable = this.rejectUnsupportedImages(
          id,
          this.session.messages.filter(
            (message) =>
              message.deliveries[id]?.status === 'queued' &&
              (message.author === 'human' ||
                message.roots.every((root) => {
                  const budget = this.session.exchanges[root];
                  return budget && budget.used < budget.allowance;
                })),
          ),
        );
        const batch: Message[] = [];
        let bytes = 0;
        let attachmentBytes = 0;
        let attachmentCount = 0;
        for (const message of runnable) {
          const nextAttachmentBytes =
            message.attachments?.reduce((sum, attachment) => sum + attachment.byteSize, 0) ?? 0;
          const nextAttachmentCount = message.attachments?.length ?? 0;
          if (
            batch.length >= 32 ||
            (batch.length && bytes + Buffer.byteLength(message.text) > 65536) ||
            (batch.length &&
              (attachmentBytes + nextAttachmentBytes > attachmentLimits.aggregateBytes ||
                attachmentCount + nextAttachmentCount > attachmentLimits.imagesPerMessage))
          )
            break;
          batch.push(message);
          bytes += Buffer.byteLength(message.text);
          attachmentBytes += nextAttachmentBytes;
          attachmentCount += nextAttachmentCount;
        }
        if (batch.length) this.dispatch(id, batch);
      }
    });
  }
  /** Current initial-image status after connection precedence is applied. */
  initialImageSupport(id: string): ImagePathSupport | undefined {
    const configured = this.config.agents[id];
    if (!configured?.enabled) return undefined;
    const state = this.session.agents[id];
    const adapter = this.adapters.get(id);
    if (state?.connection !== 'ready' || !adapter) {
      const stateLabel = state?.connection ?? 'not connected';
      return {
        available: false,
        status: 'not_observed',
        reason: `Initial-image support for @${id} has not been observed while the participant is ${stateLabel}`,
      };
    }
    const support = adapter.imageSupport?.().initial;
    if (support) return support;
    const provider = this.config.agents[id]?.provider;
    return {
      available: false,
      status: 'unsupported',
      reason: `no initial-image route is enabled for @${id}${provider ? ` (${provider} adapter)` : ''} on this baseline`,
    };
  }
  /** Why this recipient's live adapter cannot take initial images now, or undefined. */
  private initialImageReason(id: string): string | undefined {
    const support = this.initialImageSupport(id);
    return support && !support.available ? support.reason : undefined;
  }
  /**
   * Deterministic per-recipient preflight. An unsupported image-bearing delivery
   * fails here with a persisted, byte-free reason, before any attempt is reserved,
   * any exchange budget is charged or the provider is called. The recipient stays
   * connected and its remaining text continues in order. Only an explicit retry
   * re-evaluates the live gate.
   */
  private rejectUnsupportedImages(id: string, runnable: Message[]): Message[] {
    const images = runnable.filter((message) => message.attachments?.length);
    if (!images.length) return runnable;
    const reason = this.initialImageReason(id);
    if (!reason) return runnable;
    for (const message of images) {
      message.deliveries[id] = {
        status: 'failed',
        rationale: `Image not delivered: ${reason}. Text chat with @${id} remains available. Retry this image only after that support or room policy changes.`,
      };
      this.notice(
        `${id}: image in #${message.id} was not delivered: ${reason}. @${id} stays connected and text chat continues. /retry #${message.id} @${id} is useful only after that support or room policy changes.`,
        false,
      );
    }
    this.changed();
    return runnable.filter((message) => !images.includes(message));
  }
  pending(id: string): { queued: number; capped: number; unresolved: number } {
    let queued = 0,
      capped = 0,
      unresolved = 0;
    for (const message of this.session.messages) {
      const status = message.deliveries[id]?.status;
      if (status === 'queued') {
        queued++;
        if (
          message.author !== 'human' &&
          message.roots.some(
            (root) => this.session.exchanges[root]!.used >= this.session.exchanges[root]!.allowance,
          )
        )
          capped++;
      }
      if (status === 'failed' || status === 'interrupted') unresolved++;
    }
    return { queued, capped, unresolved };
  }
  private dispatch(id: string, batch: Message[]): void {
    const state = this.state(id);
    const adapter = this.adapters.get(id)!;
    const chargedRoots = [
      ...new Set(batch.filter((m) => m.author !== 'human').flatMap((m) => m.roots)),
    ];
    for (const root of chargedRoots) this.session.exchanges[root]!.used++;
    const attempt = {
      id: randomUUID(),
      messageIds: batch.map((m) => m.id),
      chargedRoots,
      startedAt: now(),
    };
    state.active = attempt;
    this.refreshQuestionState(id);
    state.activity = 'considering';
    state.draft = '';
    state.detail = undefined;
    state.error = undefined;
    for (const message of batch) message.deliveries[id] = { status: 'sent', attemptId: attempt.id };
    const contextThrough = this.session.messages.at(-1)?.sequence ?? 0;
    const controller = new AbortController();
    // Persist the attempt and budget reservation BEFORE any provider work.
    this.changed();
    if (this.fatal) {
      controller.abort();
      for (const message of batch) message.deliveries[id]!.status = 'interrupted';
      delete state.active;
      return;
    }
    const onEvent = (event: AdapterEvent) => {
      if (state.active?.id !== attempt.id || this.closed) return;
      if (event.type === 'received')
        for (const message of batch)
          if (message.deliveries[id]?.status === 'sent')
            message.deliveries[id]!.status = 'received';
      if (
        event.type === 'activity' &&
        (state.activity !== event.activity || state.detail !== event.detail)
      ) {
        (this.session.activities ??= []).push({
          agent: id,
          attemptId: attempt.id,
          activity: event.activity,
          detail: event.detail,
          createdAt: now(),
        });
        state.activity = event.activity;
        state.detail = event.detail;
      }
      if (event.type === 'text') state.draft = event.text;
      if (event.type === 'context') state.contextUsage = event.usage;
      // A context event without a reading marks provider compaction: show the plan again.
      if (event.type === 'context' && !event.usage) this.plans.record(id, undefined);
      if (event.type === 'notice') this.notice(`${id}: ${event.text}`, false);
      this.changed(event.type !== 'text');
    };
    const context = this.session.messages.filter(
      (m) => m.sequence > state.contextThrough && !attempt.messageIds.includes(m.id),
    );
    const editsBefore = this.planEdits(id);
    const planPath = this.session.plan?.path;
    let shownPlan = false;
    const turn = {
      messages: structuredClone(batch),
      context: structuredClone(context),
      history: structuredClone(this.session.messages),
      participants: this.enabledNames(),
      humanName: this.config.humanName ?? 'You',
    };
    // schedule() already failed unsupported images for this recipient, so an
    // image reaching dispatch with a closed gate is an invariant failure. It must
    // still not reach a provider that would silently drop the pixels.
    const invocation =
      batch.some((message) => message.attachments?.length) && this.initialImageReason(id)
        ? Promise.reject(
            new Error(
              `Invariant violation: initial images for @${id} reached dispatch without passing the room preflight`,
            ),
          )
        : planPath
          ? // Plan data waits for the plan's lock; without plan mode the turn starts at once.
            this.planTurn(id, controller.signal).then((prepared) => {
              if (controller.signal.aborted || state.active?.id !== attempt.id)
                throw new Error('Interrupted');
              // Record the hash only as the provider receives the turn that carries the plan.
              if (prepared?.record !== undefined) this.plans.record(id, prepared.record);
              shownPlan = prepared?.plan.status === 'changed' && prepared.record !== undefined;
              return adapter.run(
                { ...turn, ...(prepared ? { plan: prepared.plan } : {}) },
                onEvent,
                controller.signal,
              );
            })
          : adapter.run(turn, onEvent, controller.signal);
    const promise = invocation
      .then((result) => {
        if (controller.signal.aborted || state.active?.id !== attempt.id)
          throw new Error('Interrupted');
        const outcomes = result.outcomes.map(normalizeOutcome);
        this.validateOutcomes(outcomes, attempt.messageIds, id);
        // Validate the complete result before publishing any message or marking outcomes.
        for (const outcome of outcomes) {
          if (outcome.kind === 'pass')
            for (const messageId of outcome.messageIds)
              this.message(messageId)!.deliveries[id] = {
                status: 'passed',
                attemptId: attempt.id,
                rationale: outcome.text,
              };
          else {
            const reply = this.append(id, outcome.text, outcome.recipients, outcome.messageIds);
            if (outcome.question) reply.question = structuredClone(outcome.question);
            if (outcome.recommendation)
              reply.recommendation = {
                ...outcome.recommendation,
                questionId:
                  outcome.recommendation.questionId === 'self'
                    ? reply.id
                    : outcome.recommendation.questionId,
              };
            for (const messageId of outcome.messageIds)
              this.message(messageId)!.deliveries[id] = {
                status: 'contributed',
                attemptId: attempt.id,
                responseIds: [reply.id],
              };
          }
        }
        state.sessionId = result.sessionId ?? state.sessionId;
        state.contextThrough = contextThrough;
        state.draft = '';
      })
      .catch((e) => {
        // A turn that did not complete may not have shown its new plan text: send it again.
        if (shownPlan)
          try {
            this.plans.record(id, undefined);
          } catch {}
        for (const message of batch)
          if (['sent', 'received'].includes(message.deliveries[id]?.status ?? ''))
            message.deliveries[id]!.status = controller.signal.aborted ? 'interrupted' : 'failed';
        if (!controller.signal.aborted) {
          state.connection = 'unavailable';
          state.error = errorText(e);
          this.notice(
            `${id} failed: ${state.error}. Pending messages are retained. Use /reconnect @${id}, then /retry #${attempt.messageIds[0]} @${id}. Repeat /retry for each failed response, then /continue @${id}. If the room is paused, also use /continue.`,
            false,
          );
          void adapter.close().catch(() => {});
        }
      })
      .finally(() => {
        if (this.planEdits(id) > editsBefore) this.notice(`${id} edited the plan.`, false);
        if (state.active?.id === attempt.id) delete state.active;
        this.refreshQuestionState(id);
        state.detail = undefined;
        this.runs.delete(id);
        this.changed();
        this.schedule();
      });
    this.runs.set(id, { controller, promise });
  }
  /** Successful plan writes this agent's tool services have counted. */
  private planEdits(id: string): number {
    try {
      return this.plans.edits(id);
    } catch {
      return 0;
    }
  }
  private validateOutcomes(outcomes: Outcome[], required: string[], author: string): void {
    const seen = new Set<string>();
    for (const outcome of outcomes) {
      if (
        !outcome.text.trim() ||
        !['pass', 'reply'].includes(outcome.kind) ||
        !outcome.messageIds.length
      )
        throw new Error('Invalid or empty message outcome');
      if (
        outcome.awaitingHuman &&
        (outcome.kind !== 'reply' ||
          outcome.recipients.length !== 1 ||
          outcome.recipients[0] !== 'human')
      )
        throw new Error('A human-input request must be a reply directed only to human');
      const requests = outcome.messageIds
        .map((id) => this.message(id))
        .filter((m) => m?.consultation);
      if (requests.length) {
        if (
          requests.length !== 1 ||
          outcome.messageIds.length !== 1 ||
          outcome.recipients.length !== 1 ||
          outcome.recipients[0] !== 'human' ||
          outcome.question
        )
          throw new Error('Consultation requires a separate human-only outcome');
        const request = requests[0]!;
        if (
          outcome.kind === 'reply' &&
          (!outcome.recommendation ||
            outcome.recommendation.questionId !== request.consultation!.questionId ||
            outcome.recommendation.requestId !== request.id)
        )
          throw new Error('Consultation reply requires a linked recommendation');
      }
      if (outcome.recommendation) {
        const rec = outcome.recommendation;
        if (
          outcome.kind !== 'reply' ||
          outcome.recipients.length !== 1 ||
          outcome.recipients[0] !== 'human'
        )
          throw new Error('Recommendations are human-only advice');
        if (
          !requests.length &&
          (!outcome.question || rec.questionId !== 'self' || rec.requestId !== undefined)
        )
          throw new Error(
            'Recommendation must accompany its own question or a consultation request',
          );
      }
      if (outcome.kind === 'pass' && outcome.recipients.length && !requests.length)
        throw new Error('A pass cannot have recipients');
      for (const recipient of outcome.recipients)
        if (recipient === author || !['human', ...this.enabledNames()].includes(recipient))
          throw new Error(`Invalid reply recipient: ${recipient}`);
      if (new Set(outcome.recipients).size !== outcome.recipients.length)
        throw new Error('Duplicate recipients in outcome');
      for (const id of outcome.messageIds) {
        if (!required.includes(id) || seen.has(id))
          throw new Error(`Duplicate or unsolicited outcome for ${id}`);
        seen.add(id);
      }
    }
    if (seen.size !== required.length)
      throw new Error('Provider omitted a required message outcome');
  }
  /** Register promptly so the controller remains available for input and stop. */
  compact(id: string, instructions?: string): string {
    instructions = this.compactionInstructions(instructions);
    if (this.closed || this.fatal) throw new Error(this.fatal ?? 'Room is closed');
    if (!this.config.agents[id]?.enabled) throw new Error(`Unknown or disabled agent @${id}`);
    const existing = this.maintenance.get(id);
    if (existing) {
      if (this.state(id).maintenance?.instructions !== instructions)
        throw new Error(`@${id} already has compaction pending with different instructions`);
      return existing.id;
    }
    const state = this.state(id);
    if (this.reloading || this.connections.has(id) || state.connection === 'connecting')
      throw new Error(`@${id} is connecting; retry /compact when it is ready`);
    if (
      state.connection !== 'ready' ||
      state.stopped ||
      state.recoveryRequired ||
      this.session.recoveryRequired
    )
      throw new Error(`Reconnect @${id} before compacting its context`);
    const adapter = this.adapters.get(id)!;
    const operation: MaintenanceOperation = {
      id: randomUUID(),
      controller: new AbortController(),
      resources: new Set(),
      promise: Promise.resolve(),
      nativeStarted: false,
    };
    this.maintenance.set(id, operation);
    state.maintenance = {
      id: operation.id,
      agent: id,
      status: 'requested',
      route: adapter.nativeCompaction && adapter.compact ? 'native' : 'replacement',
      purpose: 'compaction',
      startedAt: now(),
      instructions,
      instructionsSupported: Boolean(
        adapter.nativeCompaction && adapter.compact && adapter.nativeCompactionInstructions,
      ),
    };
    this.changed();
    operation.promise = Promise.resolve()
      .then(() => this.performCompaction(id, operation))
      .finally(() => {
        this.maintenance.delete(id);
        this.changed();
        this.schedule();
      });
    return operation.id;
  }
  private compactionInstructions(instructions?: string): string | undefined {
    const value = instructions?.trim() || undefined;
    if (value) bounded(value, 4096, 'Compaction instructions');
    return value;
  }
  compactAll(instructions?: string): void {
    instructions = this.compactionInstructions(instructions);
    if (this.closed || this.fatal) throw new Error(this.fatal ?? 'Room is closed');
    const requested: string[] = [];
    const skipped: string[] = [];
    for (const id of this.enabledNames()) {
      try {
        this.compact(id, instructions);
        requested.push(`@${id}`);
      } catch (error) {
        skipped.push(`@${id}: ${errorText(error)}`);
      }
    }
    this.notice(
      [
        requested.length
          ? `Compaction requested for ${requested.join(', ')}`
          : 'No agents are ready to compact',
        ...skipped.map((reason) => `Skipped ${reason}`),
      ].join('\n'),
    );
  }
  private assertMaintenance(operation: MaintenanceOperation): void {
    operation.controller.signal.throwIfAborted();
    if (this.closed || this.fatal) throw new Error(this.fatal ?? 'Room closed');
  }
  private async performCompaction(id: string, operation: MaintenanceOperation): Promise<void> {
    const state = this.state(id);
    const record = state.maintenance!;
    try {
      this.assertMaintenance(operation);
      const run = this.runs.get(id);
      if (run) {
        record.status = 'waiting';
        record.detail = 'Waiting for current turn';
        this.changed();
        await run.promise;
      }
      this.assertMaintenance(operation);
      if (state.connection !== 'ready') throw new Error(`Reconnect @${id} after its failed turn`);
      if (!this.session.messages.length) {
        record.status = 'nothing-to-compact';
        return;
      }
      record.status = 'running';
      // Compaction may drop the plan from context: the next turn includes it again.
      this.plans.record(id, undefined);
      const adapter = this.adapters.get(id)!;
      if (record.route === 'native') {
        record.detail = 'Native context compaction';
        delete state.contextUsage;
        this.changed();
        this.assertMaintenance(operation);
        operation.nativeStarted = true;
        const result = await adapter.compact!(
          operation.id,
          operation.controller.signal,
          record.instructionsSupported ? record.instructions : undefined,
        );
        this.assertMaintenance(operation);
        record.status = result.status;
      } else {
        record.detail = 'Native compaction unavailable; preparing checkpoint replacement';
        this.changed();
        await this.replaceContext(id, operation);
        this.assertMaintenance(operation);
        record.status = 'completed';
      }
      record.detail =
        record.status === 'nothing-to-compact'
          ? 'Nothing to compact'
          : 'Context compaction completed';
    } catch (error) {
      record.status = operation.controller.signal.aborted || this.closed ? 'cancelled' : 'failed';
      record.detail = errorText(error);
      if (operation.nativeStarted) {
        delete state.contextUsage;
        state.connection = 'unavailable';
        state.recoveryRequired = true;
        state.error =
          'Native context usability is uncertain. Reconnect explicitly before continuing.';
        await this.adapters
          .get(id)
          ?.close()
          .catch(() => {});
      }
      this.notice(`${id}: context compaction ${record.status}: ${record.detail}`, false);
    } finally {
      await Promise.all([...operation.resources].map((adapter) => adapter.close().catch(() => {})));
      operation.resources.clear();
    }
  }
  private async maintenanceAdapter(
    id: string,
    operation: MaintenanceOperation,
  ): Promise<AgentAdapter> {
    this.assertMaintenance(operation);
    const adapter = this.factory(
      this.participant(id)!,
      this.config,
      this.environment,
      this.persistence.attachmentAccess?.(this.session.id),
    );
    operation.resources.add(adapter);
    if (!adapter.maintain) throw new Error(`@${id} does not support safe checkpoint replacement`);
    await adapter.start();
    this.assertMaintenance(operation);
    return adapter;
  }
  private async replaceContext(
    id: string,
    operation: MaintenanceOperation,
    recovering?: AgentAdapter,
  ): Promise<void> {
    // Freeze inside the serialized writer, so a later writer always includes the
    // preceding accepted checkpoint and never overwrites it with stale output.
    let release!: () => void;
    const previous = this.checkpointTail;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.checkpointTail = previous.then(() => gate);
    const progress = (detail: string) => {
      this.assertMaintenance(operation);
      this.state(id).maintenance!.detail = detail;
      this.changed();
    };
    try {
      await new Promise<void>((resolve, reject) => {
        const signal = operation.controller.signal;
        const abort = () => {
          signal.removeEventListener('abort', abort);
          reject(new Error('Maintenance cancelled while waiting for checkpoint writer'));
        };
        signal.addEventListener('abort', abort, { once: true });
        void previous.then(() => {
          signal.removeEventListener('abort', abort);
          resolve();
        });
        if (signal.aborted) abort();
      });
      this.assertMaintenance(operation);
      const state = this.state(id);
      const oldAdapter = this.adapters.get(id)!;
      const snapshot = structuredClone(this.session.messages);
      const through = snapshot.at(-1)?.sequence ?? 0;
      if (!through) return;
      const previousCheckpoint = this.session.checkpoints?.at(-1);
      let entries = previousCheckpoint?.entries ?? [];
      const chunks = checkpointChunks(snapshot.slice(previousCheckpoint?.through ?? 0), entries);
      for (const [index, chunk] of chunks.entries()) {
        progress(
          chunks.length > 1
            ? `Summarizing earlier messages (${index + 1} of ${chunks.length})`
            : 'Summarizing earlier messages',
        );
        const summarizer = await this.maintenanceAdapter(id, operation);
        try {
          const result = await summarizer.maintain!(
            { id: randomUUID(), kind: 'checkpoint', prompt: checkpointPrompt(entries, chunk) },
            operation.controller.signal,
          );
          this.assertMaintenance(operation);
          bounded(result.text, contextBudgets.summarizerOutput, 'Checkpoint generation output');
          try {
            entries = entriesSchema.parse(JSON.parse(result.text)).entries;
          } catch (error) {
            throw new MaintenanceOutputError(
              `@${id} returned an invalid chat summary; chat context was not replaced`,
              { cause: error },
            );
          }
          validateEntries(entries, snapshot.slice(0, chunk.at(-1)!.sequence));
        } finally {
          await summarizer.close();
          operation.resources.delete(summarizer);
        }
      }
      const checkpoint: Checkpoint =
        previousCheckpoint && !chunks.length
          ? previousCheckpoint
          : {
              version: (previousCheckpoint?.version ?? 0) + 1,
              createdAt: now(),
              sourceAgent: id,
              through,
              messageId: snapshot.at(-1)!.id,
              entries,
            };
      bounded(JSON.stringify(checkpoint), contextBudgets.checkpoint, 'Checkpoint record');
      let handoff: Handoff = {
        agent: id,
        fingerprint: state.fingerprint,
        sessionId: state.sessionId,
        through: state.contextThrough,
        available: false,
        text: 'Continuation note unavailable',
      };
      if (!recovering && oldAdapter.sourceHandoff && oldAdapter.maintain) {
        progress('Saving notes from the current session');
        delete state.contextUsage;
        this.changed();
        try {
          const result = await oldAdapter.maintain(
            {
              id: randomUUID(),
              kind: 'handoff',
              prompt:
                'Write a concise attributed continuation note of unfinished checks, uncertainties and next steps from your existing context. Do not include private reasoning. Maximum 4096 UTF-8 bytes. Do not perform tasks.',
            },
            operation.controller.signal,
          );
          this.assertMaintenance(operation);
          handoff = {
            ...handoff,
            available: true,
            text: bounded(result.text, contextBudgets.handoff, 'Continuation note'),
          };
        } catch (error) {
          this.assertMaintenance(operation);
          // Completed invalid output does not make the source transport uncertain.
          // Other failures require recovery if preparing the replacement also fails.
          if (!(error instanceof MaintenanceOutputError)) {
            state.connection = 'unavailable';
            state.recoveryRequired = true;
          }
          handoff.text = `Continuation note unavailable: ${errorText(error)}`.slice(0, 1000);
        }
      } else if (recovering) {
        const saved = this.session.handoffs?.[id];
        if (
          saved?.fingerprint === state.fingerprint &&
          saved.consumedBySessionId === state.sessionId &&
          saved.through <= through
        )
          handoff = saved;
      }
      progress('Loading the chat context into a fresh session');
      const prepared = recovering ?? (await this.maintenanceAdapter(id, operation));
      if (recovering) operation.resources.add(prepared);
      const result = await prepared.maintain!(
        {
          id: operation.id,
          kind: 'seed',
          prompt: reconstructionPrompt(checkpoint, handoff, snapshot),
        },
        operation.controller.signal,
      );
      this.assertMaintenance(operation);
      if (result.text.trim() !== 'seed accepted' || !result.sessionId)
        throw new Error('Replacement did not acknowledge the bounded seed and provider reference');
      const required = this.session.messages
        .filter((message) => message.deliveries[id]?.status === 'queued')
        .slice(0, 32);
      bounded(
        turnPrompt({
          messages: required,
          context: this.session.messages.filter(
            (message) => message.sequence > through && !required.includes(message),
          ),
          history: this.session.messages,
          participants: this.enabledNames(),
        }),
        contextBudgets.nextTurn,
        'Next turn with exact required messages and reply targets',
      );
      // Save a candidate before touching the live provider reference or cursor.
      // No await separates validation, persistence and the in-memory commit.
      this.syncPlan();
      const candidate = structuredClone(this.session);
      if (checkpoint !== previousCheckpoint) (candidate.checkpoints ??= []).push(checkpoint);
      (candidate.handoffs ??= {})[id] = { ...handoff, consumedBySessionId: result.sessionId };
      const candidateState = candidate.agents[id]!;
      candidateState.sessionId = result.sessionId;
      candidateState.contextThrough = through;
      candidateState.checkpointVersion = checkpoint.version;
      candidateState.connection = 'ready';
      delete candidateState.recoveryRequired;
      delete candidateState.contextUsage;
      if (candidateState.maintenance) {
        candidateState.maintenance.status = 'completed';
        candidateState.maintenance.checkpointVersion = checkpoint.version;
        candidateState.maintenance.detail = recovering
          ? 'Caught up on the chat'
          : 'Checkpoint replacement committed';
      }
      this.assertMaintenance(operation);
      this.persistence.save(candidate);
      this.session.checkpoints = candidate.checkpoints;
      this.session.handoffs = candidate.handoffs;
      state.sessionId = candidateState.sessionId;
      state.contextThrough = through;
      state.checkpointVersion = checkpoint.version;
      state.connection = 'ready';
      delete state.contextUsage;
      delete state.recoveryRequired;
      if (state.maintenance) {
        state.maintenance.checkpointVersion = checkpoint.version;
        state.maintenance.detail = recovering
          ? 'Caught up on the chat'
          : 'Checkpoint replacement committed';
      }
      this.adapters.set(id, prepared);
      operation.resources.delete(prepared);
      if (oldAdapter !== prepared) await oldAdapter.close().catch(() => {});
    } finally {
      release();
    }
  }
  pause(id?: string): void {
    if (id) this.state(id).paused = true;
    else this.session.paused = true;
    this.changed();
  }
  stop(id?: string): Promise<void> {
    if (this.closed) return Promise.resolve();
    const pending = this.stopAgents(id).finally(() => {
      this.stops.delete(pending);
    });
    this.stops.add(pending);
    return pending;
  }
  private async stopAgents(id?: string): Promise<void> {
    this.pause(id);
    const ids = id ? [id] : Object.keys(this.session.agents);
    for (const name of ids) {
      this.runs.get(name)?.controller.abort();
      this.maintenance.get(name)?.controller.abort();
    }
    await Promise.all(
      ids.map(async (name) => {
        const maintenance = this.maintenance.get(name);
        await Promise.all(
          [...(maintenance?.resources ?? [])].map((adapter) => adapter.close().catch(() => {})),
        );
        await this.adapters
          .get(name)
          ?.close()
          .catch(() => {});
        await this.connections.get(name);
        await this.adapters
          .get(name)
          ?.close()
          .catch(() => {});
        await this.runs.get(name)?.promise;
        await maintenance?.promise;
        this.adapters.delete(name);
        const state = this.state(name);
        state.connection = 'unavailable';
        state.stopped = true;
        state.error = undefined;
        state.detail = 'Stopped; /continue reconnects';
      }),
    );
    this.changed();
  }
  async continue(id?: string): Promise<void> {
    if (id?.startsWith('#')) {
      const root = id.slice(1);
      const exchange = this.session.exchanges[root];
      if (!exchange) throw new Error('Use the initiating human message ID to extend an exchange');
      exchange.allowance += this.config.followUpTurns;
      this.changed();
      this.schedule();
      return;
    }
    const ids = id ? [id] : Object.keys(this.session.agents);
    if (id) this.state(id).paused = false;
    else this.session.paused = false;
    for (const name of ids)
      if (this.state(name).stopped) await this.connect(name, id ? false : this.state(name).paused);
    this.changed();
    this.schedule();
  }
  async reconnect(id: string): Promise<void> {
    if (!this.config.agents[id]) throw new Error(`Unknown agent @${id}`);
    if (this.maintenance.has(id)) throw new Error('Stop context maintenance before reconnecting');
    delete this.state(id).recoveryRequired;
    if (!this.enabledNames().some((name) => this.session.agents[name]?.recoveryRequired))
      delete this.session.recoveryRequired;
    if (this.runs.has(id)) throw new Error('Stop this agent before reconnecting it');
    await this.adapters
      .get(id)
      ?.close()
      .catch(() => {});
    await this.connect(id, true);
  }
  retry(messageId: string, id: string): void {
    const message = this.message(messageId);
    const delivery = message?.deliveries[id];
    if (!delivery || !['failed', 'interrupted'].includes(delivery.status))
      throw new Error('Only an interrupted or failed response can be retried');
    if (
      message?.consultation &&
      consultationRounds(this.session.messages, message.consultation.questionId).some(
        (round) => round.sequence > message.sequence && consultationPending(round),
      )
    )
      throw new Error('Cannot retry an older opinion round while a newer round is pending');
    if (message?.consultation && !this.enabledNames().includes(id))
      throw new Error(`Re-enable @${id} before retrying`);
    if (this.state(id).connection !== 'ready') throw new Error(`Reconnect @${id} before retrying`);
    message!.deliveries[id] = { status: 'queued' };
    this.changed();
    this.schedule();
  }
  isIdle(): boolean {
    return this.runs.size === 0 && this.connecting.size === 0 && this.maintenance.size === 0;
  }
  saveDraft(value: string | DraftUpdate): { revision: number; accepted: boolean } {
    const update: DraftUpdate = typeof value === 'string' ? { text: value } : value;
    if (Buffer.byteLength(update.text) > 65536) throw new Error('Draft exceeds 64 KiB');
    const versions = this.session.composerDraftVersions ?? {};
    if (update.clientId !== undefined || update.version !== undefined) {
      if (
        !update.clientId ||
        update.version === undefined ||
        !uuidIdentity.test(update.clientId) ||
        !Number.isSafeInteger(update.version) ||
        update.version < 0
      )
        throw new Error('Invalid draft operation identity');
      if ((versions[update.clientId] ?? -1) >= update.version)
        return { revision: this.session.composerDraftRevision ?? 0, accepted: false };
      if (!Object.hasOwn(versions, update.clientId) && Object.keys(versions).length >= 1000)
        throw new Error('Too many draft writers for this session');
    }
    let attachments = this.session.composerAttachments ?? [];
    if (update.attachmentIds !== undefined) {
      const revision = this.session.composerDraftRevision ?? 0;
      if (update.baseRevision === undefined || update.baseRevision !== revision)
        throw new Error('Draft changed; refresh before updating its attachments');
      if (new Set(update.attachmentIds).size !== update.attachmentIds.length)
        throw new Error('Attachment IDs must be unique and ordered');
      const access = this.persistence.attachmentAccess?.(this.session.id);
      if (!access && update.attachmentIds.length)
        throw new Error('Attachment storage is unavailable');
      attachments = update.attachmentIds.map((id) => access!.resolve(id).metadata);
      validateAttachmentSet(attachments);
    }
    const revision = (this.session.composerDraftRevision ?? 0) + 1;
    const nextVersions = { ...versions };
    if (update.clientId && update.version !== undefined)
      nextVersions[update.clientId] = update.version;
    if (update.attachmentIds !== undefined) {
      this.syncPlan();
      const candidate = structuredClone(this.session);
      candidate.composerDraft = update.text;
      candidate.composerAttachments = structuredClone(attachments);
      candidate.composerDraftRevision = revision;
      candidate.composerDraftVersions = nextVersions;
      this.persistence.save(candidate);
      this.session.updatedAt = candidate.updatedAt;
      this.session.composerDraft = update.text;
      this.session.composerAttachments = structuredClone(attachments);
      this.session.composerDraftRevision = revision;
      this.session.composerDraftVersions = nextVersions;
      this.emit('change');
    } else {
      this.session.composerDraft = update.text;
      this.session.composerDraftRevision = revision;
      this.session.composerDraftVersions = nextVersions;
      this.changed(false);
    }
    return { revision, accepted: true };
  }
  async reload(config: RoomConfig): Promise<void> {
    if (!this.isIdle())
      throw new Error('Config reload requires all agents to be idle. Use /pause or /stop first.');
    if (config.workspace !== this.config.workspace)
      throw new Error('Reload cannot change the launch directory');
    this.reloading = true;
    const permissionsChanged =
      JSON.stringify(config.permissions) !== JSON.stringify(this.config.permissions) ||
      commandMode(config) !== commandMode(this.config);
    const old = this.config;
    this.config = config;
    // The new config can discover other skill bundles; tool services exclude those too.
    if (this.session.plan)
      this.plans.set(this.session.plan.path, this.plans.hashes(), this.skillBundles());
    this.interruptDisabledConsultations();
    this.session.permissions = { ...config.permissions };
    this.session.commandMode = commandMode(config);
    this.session.configSources = [...config.sources];
    try {
      for (const id of new Set([...Object.keys(old.agents), ...Object.keys(config.agents)])) {
        const agent = this.participant(id, config);
        const previous = this.participant(id, old);
        if (!agent) {
          await this.adapters
            .get(id)
            ?.close()
            .catch(() => {});
          this.adapters.delete(id);
          const state = this.session.agents[id];
          if (state) {
            state.paused = true;
            state.connection = 'unavailable';
            state.detail = 'Removed from config';
          }
          continue;
        }
        if (
          !previous ||
          agent.fingerprint !== previous.fingerprint ||
          agent.enabled !== previous.enabled ||
          permissionsChanged
        ) {
          await this.adapters
            .get(id)
            ?.close()
            .catch(() => {});
          if (permissionsChanged && this.session.agents[id]) {
            // Start with current tool descriptions and instructions, restoring public history.
            delete this.session.agents[id]!.sessionId;
            delete this.session.agents[id]!.contextUsage;
            this.session.agents[id]!.contextThrough = 0;
            delete this.session.agents[id]!.checkpointVersion;
            delete this.session.handoffs?.[id];
          }
          await this.connect(id);
        }
      }
    } finally {
      this.reloading = false;
    }
    this.notice('Current config loaded. The room-wide permission policy is now in force.');
    if (config.commandAccess?.source || old.commandAccess?.source)
      this.notice(commandAccessSummary(config));
    this.schedule();
  }
  close(): Promise<void> {
    return (this.closing ??= this.closeRoom());
  }
  private async closeRoom(): Promise<void> {
    this.closed = true;
    this.session.paused = true;
    for (const run of this.runs.values()) run.controller.abort();
    for (const operation of this.maintenance.values()) operation.controller.abort();
    await Promise.all(
      [...this.maintenance.values()].flatMap((operation) =>
        [...operation.resources].map((adapter) => adapter.close().catch(() => {})),
      ),
    );
    await Promise.all([...this.adapters.values()].map((a) => a.close().catch(() => {})));
    await Promise.all([...this.connections.values()]);
    await Promise.all([...this.stops]);
    await Promise.all([...this.maintenance.values()].map((operation) => operation.promise));
    await Promise.all([...this.runs.values()].map((r) => r.promise));
    clearTimeout(this.persistTimer);
    this.changed();
    this.plans.close();
  }
}
