import type {
  Activity,
  AgentState,
  AttachmentMetadata,
  Checkpoint,
  CommandAccess,
  Exchange,
  Message,
  Notice,
  Permissions,
  RoomConfig,
  Session,
} from './types.js';
import type { ImagePathSupport } from './image-support.js';
import type { QuestionSession } from './questions.js';
import { commandAccessSummary, resolveCommandAccess } from './command-access.js';
import { participantStatus } from './participant-status.js';

/**
 * The public display contract. `docs/display-contract.md` documents every field,
 * default, ordering rule and aliasing guarantee; renderers work from that document
 * and these declarations, never from `Room` or the producer bodies below.
 */
export interface AgentSnapshot {
  id: string;
  /** Absent for a retained session-only agent that is no longer configured. */
  provider?: string;
  model: string;
  effort: string;
  enabled: boolean;
  connection: AgentState['connection'];
  activity: Activity;
  paused: boolean;
  stopped: boolean;
  recoveryRequired?: boolean;
  detail?: string;
  error?: string;
  contextUsage?: AgentState['contextUsage'];
  maintenance?: AgentState['maintenance'];
  draft: string;
  active?: { startedAt: string; messageIds: string[] };
  pending: { queued: number; capped: number; unresolved: number };
  initialImageSupport?: ImagePathSupport;
  /** Display status ladder output, derived once per projection. */
  status: string;
  statusDetail: string;
}
export interface SessionSnapshot {
  id: string;
  createdAt: string;
  paused: boolean;
  recoveryRequired?: boolean;
  composerDraft: string;
  composerAttachments: AttachmentMetadata[];
  composerDraftRevision: number;
  messages: Message[];
  pinnedMessageIds: string[];
  notices: Notice[];
  exchanges: Record<string, Exchange>;
  checkpoint?: Checkpoint;
}
/** The attached plan while plan mode is on. */
export interface PlanSnapshot {
  /** Resolved absolute path of the plan file. */
  path: string;
  /** File name of the plan. */
  name: string;
  /** True when the file is gone or is no longer a regular, unlinked file. */
  missing: boolean;
}
export interface RoomSnapshot {
  workspace: string;
  humanName: string;
  permissions: Permissions;
  commandAccess: CommandAccess;
  commandAccessDescription: string;
  idle: boolean;
  fatal?: string;
  session: SessionSnapshot;
  /** Config-first union of configured and session agents. */
  agents: AgentSnapshot[];
  /** Every session agent in insertion order, including removed agents. */
  sessionAgentIds: string[];
  /** Present only while plan mode is on. */
  plan?: PlanSnapshot;
}
export type TimelineEntry =
  { kind: 'message'; item: Message; pinned: boolean } | { kind: 'notice'; item: Notice };

/**
 * The engine surface the projection reads. `Room` satisfies it structurally; the
 * module never imports `Room`, so browser code can include these declarations.
 */
export interface RoomSource {
  config: RoomConfig;
  session: Session;
  fatal?: string;
  isIdle(): boolean;
  pending(id: string): { queued: number; capped: number; unresolved: number };
  initialImageSupport(id: string): ImagePathSupport | undefined;
  /** The attached plan, checked on the file system at read time; absent while plan mode is off. */
  planStatus?(): PlanSnapshot | undefined;
}

/** Narrow current-input facts for completion. */
export interface CompletionInputs {
  workspace: string;
  enabledAgentIds: string[];
}
/** Narrow current-input facts for vertical movement and history recall. */
export interface HistoryInputs {
  humanName: string;
  messages: Message[];
}

/** The nullish fallback shown for an unconfigured model or effort. */
export function providerDefault(value?: string): string {
  return value ?? 'provider default';
}

/** Full display state of the current room. Read again after state may have changed. */
export function projectRoom(room: RoomSource): RoomSnapshot {
  const { config, session } = room;
  const ids = new Set([...Object.keys(config.agents), ...Object.keys(session.agents)]);
  const plan = room.planStatus?.();
  return {
    workspace: config.workspace,
    humanName: config.humanName ?? 'You',
    permissions: session.permissions,
    commandAccess: config.commandAccess ?? resolveCommandAccess(config),
    commandAccessDescription: commandAccessSummary(config),
    idle: room.isIdle(),
    fatal: room.fatal,
    session: {
      id: session.id,
      createdAt: session.createdAt,
      paused: session.paused,
      recoveryRequired: session.recoveryRequired,
      composerDraft: session.composerDraft ?? '',
      composerAttachments: session.composerAttachments ?? [],
      composerDraftRevision: session.composerDraftRevision ?? 0,
      messages: session.messages,
      pinnedMessageIds: session.pinnedMessageIds ?? [],
      notices: session.notices,
      exchanges: session.exchanges,
      checkpoint: session.checkpoints?.at(-1),
    },
    agents: [...ids].map((id) => {
      const agent = config.agents[id];
      const state = session.agents[id];
      const projected = {
        id,
        provider: agent?.provider,
        model: providerDefault(agent?.model),
        effort: providerDefault(agent?.effort),
        enabled: agent?.enabled ?? false,
        connection: state?.connection ?? ('connecting' as const),
        activity: state?.activity ?? ('available' as const),
        paused: state?.paused ?? false,
        stopped: state?.stopped ?? false,
        recoveryRequired: state?.recoveryRequired,
        detail: state?.detail,
        error: state?.error,
        contextUsage: state?.contextUsage,
        maintenance: state?.maintenance,
        draft: state?.draft ?? '',
        active: state?.active && {
          startedAt: state.active.startedAt,
          messageIds: state.active.messageIds,
        },
        pending: room.pending(id),
        initialImageSupport: agent?.enabled ? room.initialImageSupport(id) : undefined,
      };
      const { status, detail } = participantStatus(projected);
      return { ...projected, status, statusDetail: detail };
    }),
    sessionAgentIds: Object.keys(session.agents),
    ...(plan ? { plan } : {}),
  };
}

/** Messages and notices in display order, with each message's pinned flag. */
export function timeline(
  session: Pick<SessionSnapshot, 'messages' | 'notices' | 'pinnedMessageIds'>,
): TimelineEntry[] {
  const pinned = new Set(session.pinnedMessageIds);
  return [
    ...session.messages.map((item): TimelineEntry => ({
      kind: 'message',
      item,
      pinned: pinned.has(item.id),
    })),
    ...session.notices.map((item): TimelineEntry => ({ kind: 'notice', item })),
  ].sort((a, b) => a.item.createdAt.localeCompare(b.item.createdAt));
}

/** Pinned messages in message sequence order, regardless of timestamps. */
export function pinnedMessages(
  session: Pick<SessionSnapshot, 'messages' | 'pinnedMessageIds'>,
): Message[] {
  const pinned = new Set(session.pinnedMessageIds);
  return session.messages.filter((message) => pinned.has(message.id));
}

/** Adapt a projection to the question helpers in `src/questions.ts`. */
export function questionSession(snapshot: RoomSnapshot): QuestionSession {
  return {
    messages: snapshot.session.messages,
    paused: snapshot.session.paused,
    recoveryRequired: snapshot.session.recoveryRequired,
    agents: Object.fromEntries(snapshot.agents.map((agent) => [agent.id, agent])),
  };
}

/** Current workspace and enabled agent ids in config order; no message or agent derivation. */
export function completionInputs(room: Pick<RoomSource, 'config'>): CompletionInputs {
  return {
    workspace: room.config.workspace,
    enabledAgentIds: Object.values(room.config.agents)
      .filter((agent) => agent.enabled)
      .map((agent) => agent.id),
  };
}

/** Current display name and message list for history recall; messages are borrowed. */
export function historyInputs(room: Pick<RoomSource, 'config' | 'session'>): HistoryInputs {
  return { humanName: room.config.humanName ?? 'You', messages: room.session.messages };
}

/** The current staged attachment list, or a fresh empty list when nothing is staged. */
export function stagedAttachments(room: Pick<RoomSource, 'session'>): AttachmentMetadata[] {
  return room.session.composerAttachments ?? [];
}
