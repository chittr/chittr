import type { Provider } from './providers.js';
export type { Provider } from './providers.js';
/**
 * Where one participant's tool services read plan mode at call time. The directory is
 * host-owned and lives outside the workspace and every tool scratch directory, so no
 * sandboxed command can rewrite the state that admits the plan path.
 */
export interface PlanStateLocation {
  directory: string;
  agent: string;
}
/** The plan object of a normal turn while plan mode is on. */
export interface PlanTurn {
  path: string;
  /** Whether the plan changed since this agent last received or read it, or is missing. */
  status: 'changed' | 'unchanged' | 'missing';
  /** Present only when the plan changed and is at most 32 KiB. */
  text?: string;
  rules: string[];
}
export interface SkillAccess {
  path: string;
  root: string;
}
export interface Skill extends SkillAccess {
  name: string;
  description: string;
  explicitOnly: boolean;
  digest: string;
}
export interface SkillCatalog {
  bundles: Skill[];
  warnings: string[];
}
export interface Permissions {
  edits: boolean;
  commands: boolean;
  network: boolean;
}
export type CommandMode = 'off' | 'sandboxed' | 'trusted';
export interface CommandAccess {
  mode: CommandMode;
  source?: string;
  blockedBy: { permission: keyof Permissions; source: string }[];
}
export interface AgentConfig {
  id: string;
  provider: Provider;
  enabled: boolean;
  model?: string;
  effort?: string;
  instructions: string;
  /** Session-owned guidance supplied by Room to adapters, never loaded from agent YAML. */
  conversationInstructions?: string;
  /** Room-owned plan-mode state for this participant's tool services; never fingerprinted. */
  planState?: PlanStateLocation;
  fingerprint: string;
  skills?: SkillCatalog;
}
export interface RoomConfig {
  workspace: string;
  /** Selected room-wide YAML instructions; no conversation-specific content. */
  instructions?: string;
  humanName?: string;
  permissions: Permissions;
  commandAccess?: CommandAccess;
  /** `plans.location` and the folder it selects for new plans in this workspace. */
  plans?: { location: string; folder: string };
  skills?: { enabled: boolean };
  followUpTurns: number;
  agents: Record<string, AgentConfig>;
  sources: string[];
  provenance: Record<string, string>;
}
export type Activity = 'available' | 'considering' | 'replying' | 'working' | 'waiting';
export type DeliveryStatus =
  'queued' | 'sent' | 'received' | 'contributed' | 'passed' | 'interrupted' | 'failed';
export interface Delivery {
  status: DeliveryStatus;
  attemptId?: string;
  rationale?: string;
  responseIds?: string[];
}
export interface Question {
  choices: string[];
  prompt?: string;
  intent?: 'decision' | 'free-text';
  /** Saved legacy questions only: immutable historical answer, or null for open. */
  frozenAnswerId?: string | null;
}
export interface Recommendation {
  questionId: string;
  requestId?: string;
  answer: string;
  reasoning: string;
}
export interface AttachmentMetadata {
  /** Opaque, host-issued identity scoped to one saved session. */
  id: string;
  /** Display data only; never a storage path or resolver authority. */
  filename: string;
  mediaType: 'image/png';
  byteSize: number;
  width: number;
  height: number;
}
export interface AttachmentSendOperation {
  id: string;
  inputHash: string;
}
export interface Message {
  id: string;
  sequence: number;
  author: string;
  recipients: string[];
  text: string;
  createdAt: string;
  replyTo: string[];
  roots: string[];
  deliveries: Record<string, Delivery>;
  question?: Question;
  consultation?: { questionId: string };
  finalAnswer?: { questionId: string };
  recommendation?: Recommendation;
  attachments?: AttachmentMetadata[];
  /** Present only on attachment-aware human sends. */
  attachmentOperation?: AttachmentSendOperation;
}
export interface Outcome {
  messageIds: string[];
  recipients: string[];
  kind: 'reply' | 'pass';
  text: string;
  awaitingHuman?: boolean;
  question?: { prompt: string; intent: 'decision' | 'free-text'; choices: string[] };
  recommendation?: Recommendation;
}
export interface TurnResult {
  outcomes: Outcome[];
  sessionId?: string;
}
/** Latest provider reading, never cumulative billed tokens. */
export interface ContextUsage {
  usedTokens: number;
  maxTokens?: number;
  updatedAt: string;
}
export type AdapterEvent =
  | { type: 'received' }
  | { type: 'activity'; activity: Activity; detail?: string }
  | { type: 'text'; text: string }
  | { type: 'context'; usage?: ContextUsage }
  | { type: 'notice'; text: string };
export interface TurnInput {
  messages: Message[];
  context: Message[];
  participants: string[];
  humanName?: string;
  summary?: string;
  history?: Message[];
  /** Present on normal turns while plan mode is on. */
  plan?: PlanTurn;
}
export interface MaintenanceRequest {
  id: string;
  kind: 'checkpoint' | 'handoff' | 'seed';
  prompt: string;
}
export interface MaintenanceResult {
  text: string;
  sessionId?: string;
}
export interface CompactionResult {
  status: 'completed' | 'nothing-to-compact';
}
export interface MaintenanceState {
  id: string;
  agent: string;
  status:
    | 'requested'
    | 'waiting'
    | 'running'
    | 'completed'
    | 'nothing-to-compact'
    | 'failed'
    | 'cancelled';
  route: 'native' | 'replacement';
  purpose?: 'recovery' | 'compaction';
  startedAt: string;
  instructions?: string;
  instructionsSupported?: boolean;
  detail?: string;
  checkpointVersion?: number;
}
export interface CheckpointEntry {
  category: 'objective' | 'correction' | 'decision' | 'disagreement' | 'pending-ask' | 'artifact';
  text: string;
  sources: { messageId: string; author: string }[];
}
export interface Checkpoint {
  version: number;
  createdAt: string;
  sourceAgent: string;
  through: number;
  messageId: string;
  entries: CheckpointEntry[];
}
export interface Handoff {
  consumedBySessionId?: string;
  agent: string;
  fingerprint: string;
  sessionId?: string;
  through: number;
  text: string;
  available: boolean;
}
export type {
  ImageSupportReport,
  ImagePathSupport as InitialImageSupport,
} from './image-support.js';
/** Provider lifecycle and caller obligations: see docs/adapter-contract.md. */
export interface AgentAdapter {
  start(sessionId?: string): Promise<{ sessionId?: string; restored: boolean }>;
  run(
    input: TurnInput,
    event: (event: AdapterEvent) => void,
    signal: AbortSignal,
  ): Promise<TurnResult>;
  /** Enabled native routes require the live evidence in docs/compatibility.md. */
  nativeCompaction?: boolean;
  nativeCompactionInstructions?: boolean;
  sourceHandoff?: boolean;
  /** Compatibility guard only, derived from imageSupport. Cannot authorize room dispatch. */
  nativeInitialImages?: boolean;
  /** Sole initial-image dispatch authority. Missing reports fail closed. */
  imageSupport?(): import('./image-support.js').ImageSupportReport;
  initialImageSupport?(): import('./image-support.js').ImagePathSupport;
  compact?(
    operationId: string,
    signal: AbortSignal,
    instructions?: string,
  ): Promise<CompactionResult>;
  maintain?(request: MaintenanceRequest, signal: AbortSignal): Promise<MaintenanceResult>;
  interrupt(): Promise<void>;
  close(): Promise<void>;
}
export interface AgentState {
  id: string;
  connection: 'connecting' | 'ready' | 'unavailable';
  activity: Activity;
  paused: boolean;
  stopped?: boolean;
  awaitingHuman?: boolean;
  detail?: string;
  error?: string;
  sessionId?: string;
  fingerprint: string;
  active?: Attempt;
  draft: string;
  contextThrough: number;
  contextUsage?: ContextUsage;
  checkpointVersion?: number;
  maintenance?: MaintenanceState;
  recoveryRequired?: boolean;
}
export interface Attempt {
  id: string;
  messageIds: string[];
  chargedRoots: string[];
  startedAt: string;
}
export interface Exchange {
  used: number;
  allowance: number;
}
export interface Notice {
  id: string;
  text: string;
  createdAt: string;
}
export interface LaunchBrief {
  text: string;
  /** Descriptive origin only; never read again on resume. */
  source: string;
}
/** Saved records, on-disk layout and load classification: see docs/saved-format-contract.md. */
export interface Session {
  version: 1;
  id: string;
  workspace: string;
  createdAt: string;
  updatedAt: string;
  messages: Message[];
  agents: Record<string, AgentState>;
  pinnedMessageIds?: string[];
  exchanges: Record<string, Exchange>;
  notices: Notice[];
  activities?: {
    agent: string;
    attemptId: string;
    activity: Activity;
    detail?: string;
    createdAt: string;
  }[];
  paused: boolean;
  permissions: Permissions;
  /** Historical display information only; never authorization on resume. */
  commandMode?: CommandMode;
  configSources: string[];
  launchBrief?: LaunchBrief;
  composerDraft?: string;
  composerAttachments?: AttachmentMetadata[];
  composerDraftRevision?: number;
  /** Persistent per-client clocks; omitted from browser snapshots. */
  composerDraftVersions?: Record<string, number>;
  summary?: string;
  summaryThrough?: number;
  checkpoints?: Checkpoint[];
  handoffs?: Record<string, Handoff>;
  recoveryRequired?: boolean;
  /** Present while plan mode is on: the attached plan and each agent's recorded plan hash. */
  plan?: SavedPlan;
}
export interface SavedPlan {
  /** The resolved absolute path of the attached plan file. */
  path: string;
  hashes: Record<string, string>;
}
